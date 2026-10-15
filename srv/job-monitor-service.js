const cds = require('@sap/cds');
const store = require('./job-store');
const agent = require('./job-failure-agent');
const s4JobLog = require('./s4-job-log');
const sync = require('./cloud-alm-sync');

const MESSAGE_TYPE = {
  A: { text: 'Abort', criticality: 1 },
  X: { text: 'Exit', criticality: 1 },
  E: { text: 'Error', criticality: 1 },
  W: { text: 'Warning', criticality: 2 },
  S: { text: 'Success', criticality: 3 },
  I: { text: 'Info', criticality: 0 }
};

const STATUS_GROUPS = [
  { code: 'Success', text: 'Success' },
  { code: 'Error', text: 'Error' },
  { code: 'Warning', text: 'Warning' },
  { code: 'InProcess', text: 'In Process' }
];

// HANA returns LargeString columns as Buffers; Fiori needs plain strings.
function asText(value) {
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value?.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data).toString('utf8');
  return value;
}

// Resolves the parent run key for JobRuns(...)/logMessages navigation or a sourceRunKey filter.
function runKeyOf(request) {
  const param = request.params?.[0];
  if (param) return typeof param === 'object' ? param.sourceRunKey : param;
  const from = request.query.SELECT.from?.ref?.[0];
  const navKey = from?.where?.[2]?.val;
  if (navKey) return navKey;
  const where = request.query.SELECT.where || [];
  const index = where.findIndex((part) => part?.ref?.[0] === 'sourceRunKey');
  return index >= 0 ? where[index + 2]?.val : null;
}

function fail(request, error) {
  return request.error(error.statusCode || 502, error.message);
}

module.exports = (service) => {
  const { JobRuns, JobLogMessages, StatusGroups } = service.entities;

  // ------------------------------------------------------------ Fiori list / object page
  service.before('READ', JobRuns, (request) => {
    const query = request.query.SELECT;
    if (query.one) return;
    const userSort = (query.orderBy || []).some((order) => order.ref && order.ref.at(-1) !== 'sourceRunKey');
    if (!userSort) query.orderBy = [{ ref: ['startedAt'], sort: 'desc' }, { ref: ['sourceRunKey'], sort: 'asc' }];
  });

  service.after('READ', JobRuns, (rows) => {
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      if (!row) continue;
      for (const field of ['errorText', 'aiAnalysis']) if (field in row) row[field] = asText(row[field]);
    }
  });

  service.on('READ', StatusGroups, () => STATUS_GROUPS);

  // Job log is read live from S/4HANA so the object page always shows the complete, current log.
  service.on('READ', JobLogMessages, async (request) => {
    const key = runKeyOf(request);
    if (!key) return [];
    const run = await SELECT.one.from(JobRuns).columns('s4JobName', 's4JobRunCount').where({ sourceRunKey: key });
    if (!run?.s4JobName || !run?.s4JobRunCount) return [];
    try {
      const log = await s4JobLog.readRunLog(run.s4JobName, run.s4JobRunCount);
      return (log?.messages || []).map((message, index) => ({
        sourceRunKey: key,
        sequenceNo: index + 1,
        msgType: message.type,
        typeText: MESSAGE_TYPE[message.type]?.text || message.type,
        criticality: MESSAGE_TYPE[message.type]?.criticality ?? 0,
        messageId: message.id,
        text: message.text
      }));
    } catch (error) {
      console.warn('[JOB_LOG] Live job log read failed.', { status: error.response?.status || error.cause?.response?.status });
      return [];
    }
  });

  service.on('analyzeWithAI', JobRuns, async (request) => {
    const key = request.params[0]?.sourceRunKey || request.params[0];
    const run = await SELECT.one.from(JobRuns).columns('sourceRunKey', 'jobId', 'jobName').where({ sourceRunKey: key });
    if (!run) return request.error(404, 'Job run not found.');
    try {
      const result = await agent.analyze(run.jobId, run.jobName);
      await store.saveAnalysis(key, result.analysis);
      return SELECT.one.from(JobRuns).where({ sourceRunKey: key });
    } catch (error) {
      return fail(request, error);
    }
  });

  // ------------------------------------------------------------ dashboard
  service.on('getKpis', (request) => store.kpis(request.data.period).catch((error) => fail(request, error)));
  service.on('getTrend', (request) => store.trend(request.data.period).catch((error) => fail(request, error)));
  service.on('getByJob', (request) => store.byJob(request.data.period).catch((error) => fail(request, error)));
  service.on('getTopErrors', (request) => store.topErrors(request.data.period).catch((error) => fail(request, error)));

  service.on('syncNow', async () => {
    try {
      const result = await sync.synchronize();
      return { success: true, message: `Pulled from Cloud ALM: ${result.recordsRead} records read, ${result.runsWritten} job runs updated.` };
    } catch (error) {
      return { success: false, message: String(error.message).slice(0, 500) };
    }
  });

  // ------------------------------------------------------------ existing API (A2A, scheduler)
  service.on('failedJobs', (request) => store.failedJobs(request.data.top).catch((error) => fail(request, error)));

  service.on('jobErrors', async (request) => {
    if (!request.data.jobId) return request.error(400, 'jobId is required.');
    return store.jobErrors(request.data.jobId).catch((error) => fail(request, error));
  });

  service.on('testConnection', (request) => store.connectionStatus().catch((error) => fail(request, error)));

  service.on('summary', async (request) => {
    try {
      const result = await store.summary(request.data.period, request.data.asOf);
      return {
        ...result,
        failuresByJob: JSON.stringify(result.failuresByJob),
        failuresByApplication: JSON.stringify(result.failuresByApplication),
        latestFailedJobs: JSON.stringify(result.latestFailedJobs)
      };
    } catch (error) {
      return fail(request, error);
    }
  });

  service.on('analyzeJob', async (request) => {
    if (!request.data.jobId) return request.error(400, 'jobId is required.');
    return agent.analyze(request.data.jobId, request.data.jobName).catch((error) => fail(request, error));
  });

  service.on('sendSchedulerDigest', (request) =>
    agent.sendDigest(request.data.schedulerName, request.data.schedulerEmail, request.data.failedJobs).catch((error) => fail(request, error)));
};

const { SELECT } = cds.ql;
