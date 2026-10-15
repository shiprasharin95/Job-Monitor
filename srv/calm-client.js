const { getDestination } = require('@sap-cloud-sdk/connectivity');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const s4JobLog = require('./s4-job-log');

const DESTINATION_NAME = 'CLOUD_ALM_API';
const MAX_RAW_WINDOW_MS = 60 * 60 * 1000 - 1000;

function cloudAlmTimestamp(value) {
  return new Date(value).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function destinationProperty(destination, name) {
  if (destination[name] !== undefined) return destination[name];
  if (destination.originalProperties?.[name] !== undefined) return destination.originalProperties[name];
  const matchingKey = Object.keys(destination.originalProperties || {}).find((key) => key.toLowerCase() === name.toLowerCase());
  return matchingKey ? destination.originalProperties[matchingKey] : undefined;
}

async function config() {
  const destination = await getDestination({ destinationName: DESTINATION_NAME });
  if (!destination) throw new Error(`BTP destination '${DESTINATION_NAME}' was not found.`);
  return {
    destination,
    rawPath: destinationProperty(destination, 'CloudAlmRawJobLogPath') || '/calm-logs/v1/logs',
    rawProvider: destinationProperty(destination, 'CloudAlmRawJobLogProvider') || 'jam',
    rawCategories: String(destinationProperty(destination, 'CloudAlmRawJobLogCategories') || destinationProperty(destination, 'CloudAlmRawJobLogCategory') || 'run,run_step')
      .split(',').map((value) => value.trim()).filter(Boolean),
    rawLimit: Number(destinationProperty(destination, 'CloudAlmRawJobLogLimit') || 1000),
    serviceIds: String(destinationProperty(destination, 'CloudAlmServiceIds') || '').split(',').map((value) => value.trim()).filter(Boolean),
    analyticsProvider: destinationProperty(destination, 'CloudAlmAnalyticsProvider') || 'DP_JOB_MONITORING',
    analyticsDataPath: destinationProperty(destination, 'CloudAlmAnalyticsDataPath') || '/calm-analytics/v1/analytics/providers/data',
    analyticsPath: destinationProperty(destination, 'CloudAlmJobsPath'),
    analyticsFilter: destinationProperty(destination, 'CloudAlmSyncFilter'),
    fromParameter: destinationProperty(destination, 'CloudAlmFromParameter') || 'from',
    toParameter: destinationProperty(destination, 'CloudAlmToParameter') || 'to'
  };
}

function withQuery(path, query) {
  const [base, existing = ''] = path.split('?');
  const params = new URLSearchParams(existing);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, value);
  }
  const encoded = params.toString();
  return encoded ? `${base}?${encoded}` : base;
}

function interpolate(path, values) {
  let result = path;
  for (const [name, value] of Object.entries(values)) {
    result = result.replaceAll(`{${name}}`, encodeURIComponent(value || ''));
  }
  return result;
}

async function request(destination, path, method = 'get', data) {
  try {
    const response = await executeHttpRequest(destination, {
      method,
      url: path,
      headers: { accept: 'application/json', ...(data ? { 'content-type': 'application/json' } : {}) },
      data
    }, { fetchCsrfToken: false });
    return response.data;
  } catch (error) {
    const response = error.response;
    const body = response?.data || {};
    const message = body.error?.message?.value || body.error?.message || body.message || body.error?.code || error.message || 'Unknown error';
    const wrapped = new Error(`Cloud ALM API request failed${response?.status ? ` (${response.status})` : ''} [${method.toUpperCase()} ${String(path).split('?')[0]}]: ${message}`);
    wrapped.status = response?.status;
    throw wrapped;
  }
}

function tableRows(body) {
  const series = Array.isArray(body) ? body[0] : body;
  if (!series?.columns || !Array.isArray(series.rows)) return [];
  const names = series.columns.map((column) => column.text || column.name);
  return series.rows.map((row) => Object.fromEntries(names.map((name, index) => [name, row[index]])));
}

async function discoverServices(settings, from, to) {
  const allowed = allowedServiceIds();
  if (allowed.length) return allowed.map((serviceId) => ({ serviceId, serviceName: serviceId }));
  if (settings.serviceIds.length) return settings.serviceIds.map((serviceId) => ({ serviceId, serviceName: serviceId }));
  const data = {
    format: 'table',
    timestampFormat: 'unix',
    timeRange: { from: cloudAlmTimestamp(from), to: cloudAlmTimestamp(to) },
    resolution: 'D',
    timezone: '+00:00',
    queries: [{
      name: 'jobs',
      provider: settings.analyticsProvider,
      version: 'V1',
      columns: {
        dimensions: ['serviceId', 'serviceName', 'serviceType'],
        metrics: [{ measure: 'count' }]
      },
      filters: []
    }]
  };
  const rows = tableRows(await request(settings.destination, settings.analyticsDataPath, 'post', data));
  const services = new Map();
  for (const row of rows) {
    const serviceId = row.serviceId || row.ServiceId || row['Service ID'];
    if (serviceId && !services.has(serviceId)) {
      services.set(serviceId, {
        serviceId: String(serviceId),
        serviceName: String(row.serviceName || row.ServiceName || row['Service Name'] || serviceId),
        serviceType: String(row.serviceType || row.ServiceType || row['Service Type'] || '')
      });
    }
  }
  if (!services.size) throw new Error(`Cloud ALM analytics provider '${settings.analyticsProvider}' returned no managed services. Set CloudAlmServiceIds on the destination if service discovery is not enabled.`);
  return [...services.values()];
}

function anyValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return value;
  for (const name of ['stringValue', 'boolValue', 'intValue', 'doubleValue', 'bytesValue']) {
    if (value[name] !== undefined) return value[name];
  }
  if (value.arrayValue?.values) return value.arrayValue.values.map(anyValue);
  if (value.kvlistValue?.values) return Object.fromEntries(value.kvlistValue.values.map((entry) => [entry.key, anyValue(entry.value)]));
  return value;
}

function attributes(entries = []) {
  return Object.fromEntries(entries.map((entry) => [entry.key, anyValue(entry.value)]));
}

function otlpRecords(body) {
  const records = [];
  for (const resourceLog of body?.resourceLogs || []) {
    const resourceAttributes = attributes(resourceLog.resource?.attributes);
    for (const scopeLog of resourceLog.scopeLogs || resourceLog.instrumentationLibraryLogs || []) {
      for (const logRecord of scopeLog.logRecords || []) {
        records.push({
          ...resourceAttributes,
          ...attributes(logRecord.attributes),
          body: anyValue(logRecord.body),
          severityText: logRecord.severityText,
          severityNumber: logRecord.severityNumber,
          timeUnixNano: logRecord.timeUnixNano,
          observedTimeUnixNano: logRecord.observedTimeUnixNano,
          traceId: logRecord.traceId,
          spanId: logRecord.spanId,
          _otlp: logRecord
        });
      }
    }
  }
  return records;
}

function records(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.resourceLogs)) return otlpRecords(body);
  for (const candidate of [body.value, body.results, body.items, body.logs, body.records, body.data, body.d?.results]) {
    if (Array.isArray(candidate)) return candidate;
  }
  if (body.data && typeof body.data === 'object') return records(body.data);
  return [];
}

function allowedServiceIds() {
  return String(process.env.CLOUD_ALM_SERVICE_IDS || '').split(',').map((value) => value.trim()).filter(Boolean);
}

// Reads hourly job-execution aggregates from the Cloud ALM Job Monitoring analytics provider.
// Each (hour, service, job, outcome) becomes one persisted record so dashboard figures stay deterministic.
async function fetchAnalyticsRecords(settings, requestedFrom, to) {
  // Align to full hours so every hourly bucket is recomputed completely on each run.
  const from = new Date(Math.floor(requestedFrom.valueOf() / 3600000) * 3600000);
  const allowed = allowedServiceIds();
  const dataPath = withQuery(settings.analyticsDataPath, { provider: settings.analyticsProvider });
  const rows = [];
  // One-day chunks keep each hourly raw response below the provider's 5,000-row limit.
  for (let start = from.valueOf(); start < to.valueOf(); start += 86400000) {
    const end = new Date(Math.min(start + 86400000, to.valueOf()));
    rows.push(...tableRows(await request(settings.destination, dataPath, 'post', analyticsQuery(settings, new Date(start), end)))
      .filter((row) => !allowed.length || allowed.includes(String(row.serviceId))));
  }
  const records = analyticsRowsToRecords(rows);
  await enrichFailureReasons(settings, records);
  return records;
}

// --- Raw Data Outbound Logs (provider jam.run): per-execution status and failure reason ---

function otlpAttributes(list) {
  const result = {};
  for (const attribute of list || []) {
    const value = attribute.value || {};
    result[attribute.key] = value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue ?? '';
  }
  return result;
}

function otlpRecords(body) {
  const records = [];
  for (const resourceLog of body?.resourceLogs || []) {
    for (const scopeLog of resourceLog.scopeLogs || []) {
      for (const logRecord of scopeLog.logRecords || []) records.push(otlpAttributes(logRecord.attributes));
    }
  }
  return records;
}

async function rawJobRuns(settings, serviceId, jobId, from, to) {
  const query = {
    provider: 'jam.run',
    serviceId,
    format: 'protobuf-json',
    from: cloudAlmTimestamp(from),
    to: cloudAlmTimestamp(to),
    limit: '200'
  };
  // Job-level filter keeps the response below the Logs API size limit.
  if (jobId) query.filter = `sap.jam.run.job_id eq '${jobId}'`;
  try {
    return otlpRecords(await request(settings.destination, withQuery('/calm-logs/v1/logs', query)));
  } catch (error) {
    if (!jobId || error.status !== 400) throw error;
    // Filter syntax not accepted: read the hour unfiltered and match the job locally.
    delete query.filter;
    return otlpRecords(await request(settings.destination, withQuery('/calm-logs/v1/logs', query)))
      .filter((run) => run['sap.jam.run.job_id'] === jobId);
  }
}

// Cloud ALM text fields only; used when the S/4HANA job log is not reachable.
function statusReason(run) {
  const parts = [
    run['sap.jam.run.status_text_long'],
    run['sap.jam.run.appl_status_text'],
    run['sap.jam.run.appl_status_long_text']
  ].map((value) => String(value || '').trim()).filter(Boolean);
  return [...new Set(parts)].join(' - ');
}

function isFailedRun(run) {
  return Number(run['sap.jam.run.status_rating']) >= 3 || Number(run['sap.jam.run.appl_status_rating']) >= 3;
}

const reasonCache = new Map();

// For each failed hourly bucket: find the failed executions in Cloud ALM raw logs (jam.run), then read
// their application job log from S/4HANA (SAP_COM_0326) to obtain the real failure reason.
async function enrichFailureReasons(settings, records) {
  const failed = records.filter((record) => record.status === 'Failed');
  for (const record of failed) {
    const cacheKey = record.runId;
    if (reasonCache.has(cacheKey)) {
      Object.assign(record, reasonCache.get(cacheKey));
      continue;
    }
    try {
      const from = new Date(record.startedAt);
      const to = new Date(from.valueOf() + MAX_RAW_WINDOW_MS);
      const runs = (await rawJobRuns(settings, record.serviceId, record.jobId, from, to)).filter(isFailedRun);
      if (!runs.length) continue;
      const reasons = [];
      let createdBy = '';
      for (const run of runs.slice(0, 5)) {
        try {
          const log = await s4JobLog.readRunLog(run['sap.jam.run.schedule_id'], run['sap.jam.run.id']);
          if (log) {
            reasons.push(log.reason);
            createdBy = createdBy || log.createdBy;
            continue;
          }
        } catch (error) {
          console.warn('[CLOUD_ALM_SYNC] S/4HANA job log read failed.', { jobId: record.jobId, status: error.response?.status || error.cause?.response?.status });
        }
        const fallback = statusReason(run);
        if (fallback) reasons.push(fallback);
      }
      const latest = runs[runs.length - 1];
      const enrichment = {
        errorText: reasons.length ? [...new Set(reasons)].join('\n') : record.errorText,
        executionId: latest['sap.jam.run.id'],
        schedulerName: createdBy,
        s4JobName: latest['sap.jam.run.schedule_id'],
        s4JobRunCount: latest['sap.jam.run.id']
      };
      reasonCache.set(cacheKey, enrichment);
      Object.assign(record, enrichment);
    } catch (error) {
      console.warn('[CLOUD_ALM_SYNC] Failure reason lookup failed.', { jobId: record.jobId, status: error.status });
    }
  }
  if (reasonCache.size > 5000) reasonCache.clear();
}

function analyticsQuery(settings, from, to) {
  return {
    format: 'table',
    tableType: 'raw',
    timestampFormat: 'unix',
    timeRange: { from: cloudAlmTimestamp(from), to: cloudAlmTimestamp(to) },
    resolution: 'H',
    timezone: '+00:00',
    queries: [{
      name: 'jobs',
      provider: settings.analyticsProvider,
      version: 'V1',
      columns: {
        dimensions: ['serviceId', 'serviceName', 'jobId', 'jobName', 'jobType'],
        metrics: [
          { measure: 'executions' }, { measure: 'success' }, { measure: 'aborted' },
          { measure: 'applicationError' }, { measure: 'applicationWarning' }
        ]
      },
      filters: []
    }]
  };
}

function analyticsRowsToRecords(rows) {
  const records = [];
  for (const row of rows) {
    const hourStart = Number(row.timestamp);
    if (!Number.isFinite(hourStart)) continue;
    const hourEnd = new Date(hourStart + 3600000 - 1000).toISOString();
    const base = {
      jobId: row.jobId || row.jobName,
      jobName: row.jobName || row.jobId,
      system: row.serviceName || row.serviceId,
      application: row.jobType || '',
      startedAt: new Date(hourStart).toISOString(),
      finishedAt: hourEnd,
      lastUpdatedAt: new Date().toISOString(),
      serviceId: row.serviceId
    };
    const runId = (outcome) => `${row.serviceId}|${row.jobId || row.jobName}|${hourStart}|${outcome}`;
    const aborted = Number(row.aborted) || 0;
    const appError = Number(row.applicationError) || 0;
    const warning = Number(row.applicationWarning) || 0;
    const success = Number(row.success) || 0;
    if (aborted + appError > 0) {
      const parts = [];
      if (aborted) parts.push(`${aborted} execution(s) aborted`);
      if (appError) parts.push(`${appError} execution(s) ended with application errors`);
      records.push({ ...base, runId: runId('error'), status: 'Failed', errorText: `${parts.join(', ')} between ${base.startedAt.slice(11, 16)} and ${hourEnd.slice(11, 16)} UTC.` });
    }
    if (warning > 0) records.push({ ...base, runId: runId('warning'), status: 'Warning', severity: 'Warning', body: `${warning} execution(s) ended with application warnings.` });
    if (success > 0) records.push({ ...base, runId: runId('success'), status: 'Success' });
  }
  return records;
}

async function fetchSourceRecords(from, to) {
  const settings = await config();
  if ((process.env.CLOUD_ALM_SOURCE_MODE || 'ANALYTICS').toUpperCase() === 'ANALYTICS') {
    return { mode: 'ANALYTICS', rows: await fetchAnalyticsRecords(settings, from, to) };
  }
  if (settings.rawPath) {
    try {
      const rows = [];
      const services = await discoverServices(settings, from, to);
      for (const service of services) {
        for (const category of settings.rawCategories) {
          for (let start = from.valueOf(); start < to.valueOf(); start += MAX_RAW_WINDOW_MS + 1000) {
            const end = Math.min(start + MAX_RAW_WINDOW_MS, to.valueOf());
            const values = {
              from: cloudAlmTimestamp(start),
              to: cloudAlmTimestamp(end),
              provider: settings.rawProvider,
              category,
              serviceId: service.serviceId
            };
            const rawPath = interpolate(settings.rawPath, values);
            const query = {};
            if (!settings.rawPath.includes('{from}')) query[settings.fromParameter] = values.from;
            if (!settings.rawPath.includes('{to}')) query[settings.toParameter] = values.to;
            if (!settings.rawPath.includes('{provider}')) query.provider = settings.rawProvider;
            if (!settings.rawPath.includes('{category}')) query.category = category;
            if (!settings.rawPath.includes('{serviceId}')) query.serviceId = service.serviceId;
            query.format = 'protobuf-json';
            query.limit = String(settings.rawLimit);
            query.onLimit = 'TRUNCATE';
            const windowRows = records(await request(settings.destination, withQuery(rawPath, query)));
            rows.push(...windowRows.map((row) => ({ serviceId: service.serviceId, serviceName: service.serviceName, serviceType: service.serviceType, ...row })));
          }
        }
      }
      return { mode: 'RAW_LOG', rows };
    } catch (error) {
      if (![404, 405, 410, 501].includes(error.status)) throw error;
    }
  }
  if (!settings.analyticsPath) {
    throw new Error(`Destination '${DESTINATION_NAME}' must define CloudAlmRawJobLogPath or fallback CloudAlmJobsPath.`);
  }
  const analyticsPath = withQuery(settings.analyticsPath, {
    '$top': 500,
    '$filter': settings.analyticsFilter,
    [settings.fromParameter]: from.toISOString(),
    [settings.toParameter]: to.toISOString()
  });
  return { mode: 'ANALYTICS_FALLBACK', rows: records(await request(settings.destination, analyticsPath)) };
}

module.exports = { DESTINATION_NAME, cloudAlmTimestamp, fetchSourceRecords };
