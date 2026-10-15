const cds = require('@sap/cds');
const { SELECT } = cds.ql;

const PERIOD_MS = Object.freeze({
  '1H': 60 * 60 * 1000,
  '24H': 24 * 60 * 60 * 1000,
  '7D': 7 * 24 * 60 * 60 * 1000,
  '30D': 30 * 24 * 60 * 60 * 1000
});

function entities() {
  return cds.entities('job.monitor');
}

// HANA returns NCLOB (LargeString) columns as Buffers; convert them to plain text.
function asText(value) {
  if (value === null || value === undefined) return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value?.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data).toString('utf8');
  return value;
}

function textRows(rows) {
  for (const row of rows || []) {
    for (const field of ['errorText', 'description', 'raw']) {
      if (field in row) row[field] = asText(row[field]);
    }
  }
  return rows;
}

async function read(query) {
  const result = await cds.db.run(query);
  return Array.isArray(result) ? textRows(result) : (result ? textRows([result])[0] : result);
}

function runTime(run) {
  return new Date(run.finishedAt || run.startedAt || run.lastUpdatedAt || 0).valueOf();
}

function compareRuns(left, right) {
  return runTime(right) - runTime(left) || String(left.sourceRunKey).localeCompare(String(right.sourceRunKey));
}

function toJob(run) {
  const started = run.startedAt ? new Date(run.startedAt) : null;
  const finished = run.finishedAt ? new Date(run.finishedAt) : null;
  return {
    ID: `${run.sourceRunKey.slice(0, 8)}-${run.sourceRunKey.slice(8, 12)}-${run.sourceRunKey.slice(12, 16)}-${run.sourceRunKey.slice(16, 20)}-${run.sourceRunKey.slice(20, 32)}`,
    jobId: run.jobId,
    jobName: run.jobName,
    status: run.statusGroup,
    application: run.application,
    system: run.system,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationSeconds: started && finished ? Math.max(0, Math.round((finished - started) / 1000)) : null,
    errorSummary: String(run.errorText || '').slice(0, 5000),
    schedulerName: run.schedulerName || '',
    schedulerEmail: run.schedulerEmail || '',
    raw: run.raw
  };
}

async function failedJobs(top = 100) {
  const limit = Math.min(Math.max(Number(top) || 100, 1), 500);
  const rows = await read(SELECT.from(entities().JobRuns).where({ statusGroup: 'Error' }));
  return rows.sort(compareRuns).slice(0, limit).map(toJob);
}

// Error reasons come from the job runs; each run holds the S/4HANA job-log messages captured during sync.
async function jobErrors(jobId) {
  const runs = await read(SELECT.from(entities().JobRuns).where({ jobId, statusGroup: 'Error' }));
  return runs.filter((run) => run.errorText).sort(compareRuns).map((run) => ({
    ID: `${run.sourceRunKey.slice(0, 8)}-${run.sourceRunKey.slice(8, 12)}-${run.sourceRunKey.slice(12, 16)}-${run.sourceRunKey.slice(16, 20)}-${run.sourceRunKey.slice(20, 32)}`,
    jobId,
    occurredAt: run.finishedAt || run.startedAt || run.lastUpdatedAt,
    severity: run.criticality || 'Error',
    code: '',
    description: String(run.errorText || '').slice(0, 5000),
    raw: run.raw
  }));
}

function rankedCounts(rows, keyOf) {
  const counts = new Map();
  for (const row of rows) {
    const key = String(keyOf(row) || 'Unknown').trim() || 'Unknown';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

async function summary(period = '24H', asOfInput) {
  const normalizedPeriod = String(period || '').toUpperCase();
  if (!PERIOD_MS[normalizedPeriod]) throw Object.assign(new Error('period must be one of 1H, 24H, 7D, or 30D.'), { statusCode: 400 });
  const asOf = asOfInput ? new Date(asOfInput) : new Date();
  if (Number.isNaN(asOf.valueOf())) throw Object.assign(new Error('asOf must be an ISO-8601 timestamp.'), { statusCode: 400 });
  const since = asOf.valueOf() - PERIOD_MS[normalizedPeriod];
  const allRuns = await read(SELECT.from(entities().JobRuns));
  const runs = allRuns.filter((run) => {
    const timestamp = runTime(run);
    return timestamp >= since && timestamp <= asOf.valueOf();
  });
  const failures = runs.filter((run) => run.statusGroup === 'Error').sort(compareRuns);
  const statusCount = (status) => runs.filter((run) => run.statusGroup === status).length;
  const errors = rankedCounts(failures.filter((run) => run.errorText), (run) => run.errorText);
  const sync = await read(SELECT.one.from(entities().SyncRuns).orderBy('startedAt desc'));
  const result = {
    period: normalizedPeriod,
    asOf: asOf.toISOString(),
    totalRuns: runs.length,
    successCount: statusCount('Success'),
    errorCount: failures.length,
    warningCount: statusCount('Warning'),
    inProcessCount: statusCount('InProcess'),
    successRate: (statusCount('Success') + failures.length + statusCount('Warning'))
      ? Number(((statusCount('Success') / (statusCount('Success') + failures.length + statusCount('Warning'))) * 100).toFixed(2))
      : 100,
    topError: String(errors[0]?.name || '').slice(0, 5000),
    failuresByJob: rankedCounts(failures, (run) => run.jobName || run.jobId),
    failuresByApplication: rankedCounts(failures, (run) => run.application),
    latestFailedJobs: failures.slice(0, 10).map(toJob),
    lastSyncAt: sync?.finishedAt || sync?.startedAt || null,
    lastSyncStatus: sync?.status || 'NEVER'
  };
  return result;
}

async function connectionStatus() {
  const sync = await read(SELECT.one.from(entities().SyncRuns).orderBy('startedAt desc'));
  if (!sync) return { connected: false, message: 'No Cloud ALM synchronization has completed yet.' };
  const connected = sync.status === 'SUCCESS';
  return {
    connected,
    message: connected
      ? `Persisted Cloud ALM data last synchronized at ${new Date(sync.finishedAt || sync.startedAt).toISOString()}.`
      : `The latest Cloud ALM synchronization ended with status ${sync.status}.`
  };
}

// ---------------------------------------------------------------- dashboard (Fiori custom page)

const STATUS_KEY = { Success: 'success', Error: 'error', Warning: 'warning', InProcess: 'inProcess' };
const BUCKET = { '1H': 'minute10', '24H': 'hour', '7D': 'day', '30D': 'day' };

function normalizePeriod(period) {
  const value = String(period || '24H').toUpperCase();
  if (!PERIOD_MS[value]) throw Object.assign(new Error('period must be one of 1H, 24H, 7D, or 30D.'), { statusCode: 400 });
  return value;
}

async function runsInPeriod(period) {
  const since = Date.now() - PERIOD_MS[normalizePeriod(period)];
  const rows = await read(SELECT.from(entities().JobRuns)
    .columns('sourceRunKey', 'jobName', 'jobId', 'application', 'statusGroup', 'startedAt', 'finishedAt', 'lastUpdatedAt', 'errorText'));
  return rows.filter((run) => runTime(run) >= since);
}

function bucketOf(time, kind) {
  const date = new Date(time);
  if (kind === 'day') return date.toISOString().slice(0, 10);
  if (kind === 'hour') return `${date.toISOString().slice(0, 13)}:00`;
  date.setUTCMinutes(Math.floor(date.getUTCMinutes() / 10) * 10, 0, 0);
  return date.toISOString().slice(0, 16);
}

async function kpis(period) {
  const runs = await runsInPeriod(period);
  const result = { total: runs.length, success: 0, error: 0, warning: 0, inProcess: 0 };
  for (const run of runs) if (STATUS_KEY[run.statusGroup]) result[STATUS_KEY[run.statusGroup]] += 1;
  const finished = result.success + result.error + result.warning;
  result.successRate = finished ? Math.round((result.success / finished) * 10000) / 100 : 100;
  const sync = await read(SELECT.one.from(entities().SyncRuns).orderBy('startedAt desc'));
  if (sync) {
    result.lastSyncAt = sync.finishedAt || sync.startedAt;
    result.lastSyncOk = sync.status === 'SUCCESS';
    result.lastSyncInfo = sync.status === 'SUCCESS' ? `${sync.recordsRead || 0} records read` : String(sync.errorText || sync.status).slice(0, 500);
  }
  result.dataSource = "SAP Cloud ALM (Job & Automation Monitoring) + S/4HANA job log via BTP destination 'CLOUD_ALM_API'";
  return result;
}

async function trend(period) {
  const normalized = normalizePeriod(period);
  const kind = BUCKET[normalized];
  const from = Date.now() - PERIOD_MS[normalized];
  const step = kind === 'day' ? 86400000 : kind === 'hour' ? 3600000 : 600000;
  const buckets = new Map();
  for (let time = from; time <= Date.now(); time += step) {
    const key = bucketOf(time, kind);
    buckets.set(key, { bucket: key, success: 0, error: 0, warning: 0, inProcess: 0 });
  }
  for (const run of await runsInPeriod(normalized)) {
    const bucket = buckets.get(bucketOf(runTime(run), kind));
    if (bucket && STATUS_KEY[run.statusGroup]) bucket[STATUS_KEY[run.statusGroup]] += 1;
  }
  return [...buckets.values()];
}

async function byJob(period) {
  const groups = new Map();
  for (const run of await runsInPeriod(period)) {
    const name = run.jobName || run.jobId || '(none)';
    const entry = groups.get(name) || { jobName: name, success: 0, error: 0, warning: 0, inProcess: 0, total: 0 };
    if (STATUS_KEY[run.statusGroup]) entry[STATUS_KEY[run.statusGroup]] += 1;
    entry.total += 1;
    groups.set(name, entry);
  }
  // Failing jobs first, then by volume; the chart shows the top 10.
  return [...groups.values()].sort((left, right) => right.error - left.error || right.total - left.total).slice(0, 10);
}

async function topErrors(period) {
  const groups = new Map();
  for (const run of await runsInPeriod(period)) {
    if (run.statusGroup !== 'Error' || !run.errorText) continue;
    const reason = String(run.errorText).split('\n')[0];
    const key = `${run.jobName}\u0000${reason}`;
    const entry = groups.get(key) || { jobName: run.jobName, errorText: reason, count: 0 };
    entry.count += 1;
    groups.set(key, entry);
  }
  return [...groups.values()].sort((left, right) => right.count - left.count).slice(0, 10);
}

async function saveAnalysis(sourceRunKey, analysis) {
  await cds.db.run(cds.ql.UPDATE(entities().JobRuns).set({ aiAnalysis: analysis, aiAnalyzedAt: new Date() }).where({ sourceRunKey }));
}

module.exports = { PERIOD_MS, byJob, connectionStatus, failedJobs, jobErrors, kpis, saveAnalysis, summary, topErrors, trend };
