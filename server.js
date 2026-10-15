const cds = require('@sap/cds');
const { randomUUID } = require('node:crypto');
const { runScheduledWarnings } = require('./srv/scheduled-warning-runner');
const { startSynchronization } = require('./srv/cloud-alm-sync');
const { mountA2A } = require('./srv/a2a');

function requireJobRunner(req, res, next) {
  const user = req.user || cds.context?.user;
  if (!user || typeof user.is !== 'function' || !user.is('JobRunner')) {
    return res.status(403).json({ status: 'ERROR', message: 'JobRunner scope required.' });
  }
  return next();
}

const DASHBOARD_PATH = '/job-monitor/webapp/index.html';

cds.on('bootstrap', (app) => {
  // Root and the retired plain UI open the Fiori dashboard.
  app.get(['/', '/index.html'], (req, res) => {
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    res.redirect(`${DASHBOARD_PATH}${query}`);
  });

  // A2A agent (protocol 0.3.0, @a2a-js/sdk): public agent card + IAS-protected POST /a2a.
  mountA2A(app);

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
});

cds.on('served', startSynchronization);

async function startServer() {
  return cds.server();
}

module.exports = startServer;
module.exports.requireJobRunner = requireJobRunner;

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Failed to start Job Failure Warning Agent.', {
      errorCode: String(error.code || error.name || 'STARTUP_ERROR').slice(0, 80)
    });
    process.exit(1);
  });
}
