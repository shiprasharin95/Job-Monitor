// Reads application job log messages from SAP S/4HANA Cloud (communication scenario SAP_COM_0326,
// service BC_EXT_APPJOB_MANAGEMENT;v=0002). Cloud ALM identifies a run by schedule_id (= S/4 JobName)
// and run id (= S/4 JobRunCount); the job log holds the actual failure reason.
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

const DESTINATION = process.env.S4_JOB_LOG_DESTINATION || 'S4HC_JournalEntry';
const BASE = '/sap/opu/odata/sap/BC_EXT_APPJOB_MANAGEMENT;v=0002';

function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function odata(path) {
  const separator = path.includes('?') ? '&' : '?';
  const response = await executeHttpRequest({ destinationName: DESTINATION }, {
    method: 'get',
    url: `${BASE}${path}${separator}$format=json`,
    headers: { accept: 'application/json' },
    timeout: 30000
  }, { fetchCsrfToken: false });
  const data = response.data?.d;
  return data?.results ?? (data ? [data] : []);
}

// Returns { reason, messages[], createdBy } for one job run, or null when the run has no log.
async function readRunLog(jobName, runCount) {
  const jobKey = `JobName=${quote(jobName)},JobRunCount=${quote(runCount)}`;
  const [header] = await odata(`/JobHeaderSet(${jobKey})?$select=JobText,JobCreatedBy,JobCreatedByFormattedName`).catch(() => []);
  const steps = await odata(`/JobHeaderSet(${jobKey})/JobStepSet`);
  const messages = [];
  for (const step of steps) {
    const stepKey = `${jobKey},StepNumber=${step.StepNumber}`;
    const logs = await odata(`/JobStepSet(${stepKey})/JobStepLogInfoSet`);
    for (const log of logs) {
      const logKey = `${stepKey},LogHandle=${encodeURIComponent(quote(log.LogHandle))}`;
      for (const message of await odata(`/JobStepLogInfoSet(${logKey})/JobLogMessageSet`)) {
        if (message.MsgText) messages.push({ type: message.MsgType, text: message.MsgText, id: `${message.MsgId}/${message.MsgNo}` });
      }
    }
  }
  if (!messages.length) return null;
  // Error and abort messages are the failure reason; fall back to warnings, then all messages.
  const pick = (types) => messages.filter((message) => types.includes(message.type));
  const reasonMessages = pick(['A', 'E', 'X']).length ? pick(['A', 'E', 'X']) : (pick(['W']).length ? pick(['W']) : messages);
  return {
    reason: [...new Set(reasonMessages.map((message) => message.text))].join('\n'),
    messages,
    createdBy: header?.JobCreatedByFormattedName || header?.JobCreatedBy || ''
  };
}

module.exports = { readRunLog };
