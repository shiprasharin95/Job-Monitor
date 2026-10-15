const { randomUUID } = require('node:crypto');
const { isAuthorized, REQUIRED_GROUPS } = require('./auth');
const { buildReport } = require('./report');

// Joule waits at most 60 s for a synchronous message/send reply.
const REPORT_TIMEOUT_MS = Number(process.env.A2A_REPORT_TIMEOUT_MS || 55000);

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Report took longer than ${Math.round(ms / 1000)} seconds.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Read-only executor: role check first, then HANA only. Never calls Cloud ALM, never changes data.
class JobMonitorExecutor {
  constructor({ loadReport = buildReport } = {}) {
    this.loadReport = loadReport;
  }

  async execute(requestContext, eventBus) {
    const { taskId, contextId, userMessage, task } = requestContext;
    const status = (state, text, final) => ({
      kind: 'status-update',
      taskId,
      contextId,
      final,
      status: {
        state,
        timestamp: new Date().toISOString(),
        ...(text && { message: { kind: 'message', messageId: randomUUID(), role: 'agent', taskId, contextId, parts: [{ kind: 'text', text }] } })
      }
    });
    const textArtifact = (name, text) => ({
      kind: 'artifact-update', taskId, contextId, lastChunk: true,
      artifact: { artifactId: randomUUID(), name, parts: [{ kind: 'text', text }] }
    });

    try {
      if (!task) {
        eventBus.publish({ kind: 'task', id: taskId, contextId, status: { state: 'submitted', timestamp: new Date().toISOString() }, history: [userMessage] });
      }

      const caller = requestContext.context?.user;
      if (!isAuthorized(caller)) {
        const reason = caller?.hasUserIdentity ? 'missing-group' : 'no-user';
        console.warn(JSON.stringify({ event: 'a2a-request-rejected', reason, taskId }));
        const text = `You are not authorized to view job monitoring data. Ask your administrator to add you to the IAS group ${REQUIRED_GROUPS.join(' or ')}.`;
        // Failed/rejected tasks also carry a text artifact so Joule functions can always read body['artifacts'].
        eventBus.publish(textArtifact('failed_job_report_error', text));
        eventBus.publish(status('rejected', text, true));
        return;
      }

      eventBus.publish(status('working', null, false));
      const question = (userMessage?.parts || []).filter((part) => part.kind === 'text').map((part) => part.text).join('\n');
      const report = await withTimeout(this.loadReport(question), REPORT_TIMEOUT_MS);
      console.log(JSON.stringify({ event: 'a2a-report-complete', taskId, period: report.data.period, failed: report.data.counts.error }));

      eventBus.publish({
        kind: 'artifact-update',
        taskId,
        contextId,
        lastChunk: true,
        artifact: {
          artifactId: randomUUID(),
          name: 'failed_job_report',
          // parts[0].text: Markdown summary with dashboard link. parts[1].data: structured figures.
          parts: [
            { kind: 'text', text: report.text },
            { kind: 'data', data: report.data }
          ]
        }
      });
      eventBus.publish(status('completed', null, true));
    } catch (error) {
      console.error(JSON.stringify({ event: 'a2a-report-failed', taskId, error: String(error.message).slice(0, 300) }));
      const text = `Could not load the failed job report: ${String(error.message).slice(0, 300)}`;
      eventBus.publish(textArtifact('failed_job_report_error', text));
      eventBus.publish(status('failed', text, true));
    } finally {
      eventBus.finished();
    }
  }

  async cancelTask(taskId, eventBus) {
    eventBus.publish({ kind: 'status-update', taskId, contextId: taskId, final: true, status: { state: 'canceled', timestamp: new Date().toISOString() } });
    eventBus.finished();
  }
}

module.exports = { JobMonitorExecutor };
