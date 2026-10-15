const cds = require('@sap/cds');
const { createHash, randomUUID } = require('node:crypto');
const { SELECT, INSERT, UPDATE, UPSERT } = cds.ql;
const calm = require('./calm-client');

// Versioned key: earlier builds advanced the watermark while saving no rows, so a new key forces a fresh backfill.
const SOURCE = 'CLOUD_ALM_API_V2';
let inFlight = null;
let timer = null;

function entities() {
  return cds.entities('job.monitor');
}

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function value(record, ...names) {
  const body = record.body && typeof record.body === 'object' && !Array.isArray(record.body) ? record.body : {};
  const sources = [record, body];
  for (const source of sources) {
    for (const name of names) {
      if (source[name] !== undefined && source[name] !== null && source[name] !== '') return source[name];
      const key = Object.keys(source).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
      if (key && source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
    }
  }
  return null;
}

function timestamp(input) {
  if (!input) return null;
  if (/^\d{16,}$/.test(String(input))) {
    try {
      const milliseconds = Number(BigInt(String(input)) / 1000000n);
      return new Date(milliseconds).toISOString();
    } catch {
      return null;
    }
  }
  const date = new Date(input);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function text(input) {
  if (input === null || input === undefined) return '';
  return typeof input === 'string' ? input : JSON.stringify(input);
}

function statusGroup(sourceStatus, severity, errorText) {
  const status = `${sourceStatus || ''} ${severity || ''}`.toLowerCase();
  if (/fail|error|fatal|abort|cancel/.test(status) || errorText) return 'Error';
  if (/warn|degrad|partial/.test(status)) return 'Warning';
  if (/running|process|pending|queued|scheduled|start/.test(status)) return 'InProcess';
  return 'Success';
}

function normalize(record) {
  const jobId = text(value(record, 'jobId', 'JobId', 'job.id', 'job_id', 'ID', 'id')) || 'unknown';
  const jobName = text(value(record, 'jobName', 'JobName', 'job.name', 'name')) || jobId;
  const application = text(value(record, 'application', 'Application', 'ApplicationName', 'service.name', 'app'));
  const system = text(value(record, 'system', 'System', 'SystemId', 'ManagedSystem', 'system.id'));
  const startedAt = timestamp(value(record, 'startedAt', 'StartedAt', 'StartTime', 'startTime', 'start_time'));
  const finishedAt = timestamp(value(record, 'finishedAt', 'FinishedAt', 'EndTime', 'endTime', 'end_time'));
  const occurredAt = timestamp(value(record, 'occurredAt', 'OccurredAt', 'Timestamp', 'timestamp', 'timeUnixNano', 'observedTimeUnixNano')) || finishedAt || startedAt;
  const sourceStatus = text(value(record, 'status', 'Status', 'ExecutionStatus', 'job.status'));
  const severity = text(value(record, 'severity', 'Severity', 'severityText', 'level'));
  const errorLike = /fail|error|fatal|abort|cancel/i.test(`${sourceStatus} ${severity}`);
  const explicitError = text(value(record, 'errorText', 'ErrorText', 'ErrorMessage', 'errorMessage', 'ErrorSummary'));
  const errorText = explicitError || (errorLike ? text(value(record, 'description', 'message') || record.body) : '');
  const explicitRunId = text(value(record, 'runId', 'RunId', 'executionId', 'ExecutionId', 'jobRunId', 'correlationId', 'traceId'));
  const sourceRunId = explicitRunId || [system, application, jobId, startedAt || occurredAt || finishedAt || hash(JSON.stringify(record))].join('|');
  const sourceRunKey = hash(sourceRunId);
  const lastUpdatedAt = timestamp(value(record, 'lastUpdatedAt', 'LastUpdatedAt', 'updatedAt', 'UpdatedAt')) || occurredAt || finishedAt || startedAt || new Date().toISOString();
  const run = {
    sourceRunKey,
    sourceRunId: sourceRunId.slice(0, 512),
    jobId: jobId.slice(0, 255),
    jobName: jobName.slice(0, 500),
    application: application.slice(0, 255),
    system: system.slice(0, 255),
    statusGroup: statusGroup(sourceStatus, severity, errorText),
    sourceStatus: sourceStatus.slice(0, 80),
    criticality: (text(value(record, 'criticality', 'Criticality')) || severity).slice(0, 40),
    startedAt,
    finishedAt,
    errorText,
    schedulerName: text(value(record, 'schedulerName', 'SchedulerName', 'ScheduledBy', 'OwnerName')).slice(0, 500),
    schedulerEmail: text(value(record, 'schedulerEmail', 'SchedulerEmail', 'ScheduledByEmail', 'OwnerEmail')).slice(0, 320),
    lastUpdatedAt,
    s4JobName: text(record.s4JobName).slice(0, 64) || null,
    s4JobRunCount: text(record.s4JobRunCount).slice(0, 32) || null,
    raw: JSON.stringify(record)
  };
  const eventDescription = errorText || (/warn/i.test(severity) ? text(record.body) : '');
  const event = eventDescription ? {
    eventKey: hash(`${sourceRunKey}\u0000${occurredAt || ''}\u0000${eventDescription}\u0000${severity}`),
    sourceRunKey,
    jobId: run.jobId,
    occurredAt,
    severity: (severity || run.criticality || 'Error').slice(0, 80),
    code: text(value(record, 'code', 'Code', 'ErrorCode', 'errorCode')).slice(0, 255),
    description: eventDescription,
    raw: run.raw
  } : null;
  return { run, event };
}

function isPlaceholder(text) {
  return /^\d+ execution\(s\) (aborted|ended with application errors)/.test(String(text || ''));
}

function mergeRun(current, next) {
  if (!current) return next;
  const newer = new Date(next.lastUpdatedAt || 0) >= new Date(current.lastUpdatedAt || 0) ? next : current;
  const older = newer === next ? current : next;
  return {
    ...older,
    ...newer,
    startedAt: newer.startedAt || older.startedAt,
    finishedAt: newer.finishedAt || older.finishedAt,
    // Keep a real job-log reason; the analytics count text is only a placeholder.
    errorText: (isPlaceholder(newer.errorText) && older.errorText && !isPlaceholder(older.errorText)) ? older.errorText : (newer.errorText || older.errorText),
    schedulerName: newer.schedulerName || older.schedulerName,
    schedulerEmail: newer.schedulerEmail || older.schedulerEmail,
    s4JobName: newer.s4JobName || older.s4JobName,
    s4JobRunCount: newer.s4JobRunCount || older.s4JobRunCount,
    // AI analysis is written by the UI action, never by the sync; always preserve it.
    aiAnalysis: older.aiAnalysis || newer.aiAnalysis,
    aiAnalyzedAt: older.aiAnalyzedAt || newer.aiAnalyzedAt
  };
}

function overlapMilliseconds() {
  const seconds = Number(process.env.CLOUD_ALM_SYNC_OVERLAP_SECONDS || 300);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 300000;
}

function initialLookbackMilliseconds() {
  const days = Number(process.env.CLOUD_ALM_INITIAL_LOOKBACK_DAYS || 30);
  return Number.isFinite(days) && days > 0 ? days * 86400000 : 30 * 86400000;
}

async function executeSync() {
  if (!cds.db) throw new Error('Cloud ALM synchronization requires a database binding.');
  const ID = randomUUID();
  const startedAt = new Date();
  const state = await cds.db.run(SELECT.one.from(entities().SyncState).where({ source: SOURCE }));
  const from = new Date((state?.watermark ? new Date(state.watermark).valueOf() : startedAt.valueOf() - initialLookbackMilliseconds()) - overlapMilliseconds());
  const to = new Date();
  await cds.db.run(INSERT.into(entities().SyncRuns).entries({ ID, source: SOURCE, status: 'RUNNING', startedAt, windowFrom: from, windowTo: to }));
  try {
    const source = await calm.fetchSourceRecords(from, to);
    const runs = new Map();
    const events = new Map();
    for (const row of source.rows) {
      const normalized = normalize(row);
      runs.set(normalized.run.sourceRunKey, mergeRun(runs.get(normalized.run.sourceRunKey), normalized.run));
      if (normalized.event) events.set(normalized.event.eventKey, normalized.event);
    }
    await cds.tx(async (tx) => {
      for (const [key, run] of runs) {
        const existing = await tx.run(SELECT.one.from(entities().JobRuns).where({ sourceRunKey: key }));
        await tx.run(UPSERT.into(entities().JobRuns).entries(mergeRun(existing, run)));
      }
      if (events.size) await tx.run(UPSERT.into(entities().JobRunEvents).entries([...events.values()]));
      await tx.run(UPSERT.into(entities().SyncState).entries({ source: SOURCE, watermark: to, lastSuccessfulAt: new Date(), lastSyncRun_ID: ID }));
      await tx.run(UPDATE(entities().SyncRuns).set({
        status: 'SUCCESS', finishedAt: new Date(), recordsRead: source.rows.length, runsWritten: runs.size,
        eventsWritten: events.size, sourceMode: source.mode
      }).where({ ID }));
    });
    return { ID, recordsRead: source.rows.length, runsWritten: runs.size, eventsWritten: events.size, sourceMode: source.mode };
  } catch (error) {
    await cds.db.run(UPDATE(entities().SyncRuns).set({ status: 'FAILED', finishedAt: new Date(), errorText: String(error.message || error) }).where({ ID })).catch(() => {});
    throw error;
  }
}

function synchronize() {
  if (inFlight) return inFlight;
  inFlight = executeSync().finally(() => { inFlight = null; });
  return inFlight;
}

function startSynchronization() {
  if (timer) return;
  setImmediate(() => synchronize().catch((error) => console.error('[CLOUD_ALM_SYNC] Initial synchronization failed.', error.message)));
  const seconds = Math.max(60, Number(process.env.CLOUD_ALM_SYNC_INTERVAL_SECONDS || 60));
  timer = setInterval(() => synchronize().catch((error) => console.error('[CLOUD_ALM_SYNC] Synchronization failed.', error.message)), seconds * 1000);
  timer.unref();
}

module.exports = { normalize, startSynchronization, synchronize };
