const cds = require('@sap/cds');
const { randomUUID } = require('node:crypto');
const { runScheduledWarnings } = require('./srv/scheduled-warning-runner');
const { startSynchronization } = require('./srv/cloud-alm-sync');
const store = require('./srv/job-store');

function requireJobRunner(req, res, next) {
  const user = req.user || cds.context?.user;
  if (!user || typeof user.is !== 'function' || !user.is('JobRunner')) {
    return res.status(403).json({ status: 'ERROR', message: 'JobRunner scope required.' });
  }
  return next();
}

function requireA2AClient(req, res, next) {
  const user = req.user || cds.context?.user;
  if (!user || typeof user.is !== 'function' || !user.is('A2AClient')) {
    return res.status(403).json({ status: 'ERROR', message: 'A2AClient scope required.' });
  }
  return next();
}

function questionFrom(body) {
  if (typeof body === 'string') return body;
  if (typeof body?.question === 'string') return body.question;
  if (typeof body?.text === 'string') return body.text;
  if (typeof body?.message === 'string') return body.message;
  const parts = body?.message?.parts || body?.params?.message?.parts || [];
  return parts.map((part) => part.text || part?.root?.text || '').filter(Boolean).join(' ');
}

function periodFrom(question) {
  const text = String(question || '').toLowerCase();
  if (/\b(30\s*d|30\s*days?|month)\b/.test(text)) return '30D';
  if (/\b(7\s*d|7\s*days?|week)\b/.test(text)) return '7D';
  if (/\b(1\s*h|1\s*hour|last\s+hour)\b/.test(text)) return '1H';
  if (/\b(24\s*h|24\s*hours?|day|today)\b/.test(text)) return '24H';
  return '24H';
}

function summaryText(summary) {
  const topError = summary.topError ? ` The most frequent error is: ${summary.topError}` : '';
  return `${summary.period} ending ${summary.asOf}: ${summary.totalRuns} runs, ${summary.successCount} successful, ${summary.errorCount} failed, ${summary.warningCount} warnings, and ${summary.inProcessCount} in process. Success rate: ${summary.successRate.toFixed(2)}%.${topError}`;
}

const DASHBOARD_PATH = '/job-monitor/webapp/index.html';

cds.on('bootstrap', (app) => {
  // Root and the retired plain UI open the Fiori dashboard.
  app.get(['/', '/index.html'], (req, res) => {
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    res.redirect(`${DASHBOARD_PATH}${query}`);
  });

  app.get('/.well-known/agent-card.json', (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({
      name: 'Cloud ALM Job Monitor',
      description: 'Read-only deterministic SAP Cloud ALM job-run summaries.',
      url: `${baseUrl}/a2a`,
      version: '1.0.0',
      capabilities: { streaming: false, pushNotifications: false },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain', 'application/json'],
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      security: [{ bearer: [] }],
      skills: [{ id: 'job-run-summary', name: 'Job run summary', description: 'Summarizes persisted job runs for 1H, 24H, 7D, or 30D.', tags: ['SAP Cloud ALM', 'jobs'] }]
    });
  });

  // Custom Express routes must run CAP context and authentication middleware first.
  app.post('/run', ...cds.middlewares.before, requireJobRunner, async (req, res) => {
    try {
      return res.status(200).json({ status: 'OK', source: 'job-scheduler', ...(await runScheduledWarnings()) });
    } catch (error) {
      const incidentId = randomUUID();
      console.error('[SCHEDULER] Warning run failed.', { incidentId, errorCode: String(error.code || error.name || 'SCHEDULER_ERROR').slice(0, 80) });
      return res.status(500).json({ status: 'ERROR', message: 'Scheduled warning workflow failed. Contact support with the incident ID.', incidentId });
    }
  });

  app.post('/a2a', ...cds.middlewares.before, requireA2AClient, async (req, res) => {
    try {
      const question = questionFrom(req.body);
      if (!question.trim()) return res.status(400).json({ status: 'ERROR', message: 'A natural-language question is required.' });
      const period = periodFrom(question);
      const asOf = new Date().toISOString();
      const data = await store.summary(period, asOf);
      const dashboardBase = process.env.DASHBOARD_URL || `${req.protocol}://${req.get('host')}${DASHBOARD_PATH}`;
      const separator = dashboardBase.includes('?') ? '&' : '?';
      return res.status(200).json({
        period,
        asOf,
        text: summaryText(data),
        data,
        dashboardUrl: `${dashboardBase}${separator}period=${period}&asOf=${encodeURIComponent(asOf)}`
      });
    } catch (error) {
      const incidentId = randomUUID();
      console.error('[A2A] Summary request failed.', { incidentId, errorCode: String(error.code || error.name || 'A2A_ERROR').slice(0, 80) });
      return res.status(error.statusCode || 500).json({ status: 'ERROR', message: error.statusCode ? error.message : 'Summary request failed.', incidentId });
    }
  });
});

cds.on('served', startSynchronization);

async function startServer() {
  return cds.server();
}

module.exports = startServer;
module.exports.requireJobRunner = requireJobRunner;
module.exports.requireA2AClient = requireA2AClient;

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Failed to start Job Failure Warning Agent.', {
      errorCode: String(error.code || error.name || 'STARTUP_ERROR').slice(0, 80)
    });
    process.exit(1);
  });
}
