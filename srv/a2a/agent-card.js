const { issuer } = require('./auth');

const A2A_PATH = '/a2a';
const CARD_PATH = '/.well-known/agent-card.json';

function publicBaseUrl() {
  if (process.env.A2A_PUBLIC_URL) return process.env.A2A_PUBLIC_URL.replace(/\/+$/, '');
  try {
    const uris = JSON.parse(process.env.VCAP_APPLICATION || '{}').application_uris || [];
    const publicUri = uris.find((uri) => !uri.endsWith('.apps.internal'));
    if (publicUri) return `https://${publicUri}`;
  } catch {
    // fall through to the local default
  }
  return `http://localhost:${process.env.PORT || 4004}`;
}

function buildAgentCard() {
  const url = `${publicBaseUrl()}${A2A_PATH}`;
  const card = {
    name: 'Job Monitor Agent',
    description: 'Reports failed SAP S/4HANA Cloud application jobs (system my409865) synchronized from SAP Cloud ALM Job & Automation Monitoring: counts, success rate, failures by job, the most frequent error and the latest failed jobs with their job-log error reason. Read-only and deterministic; figures match the Job Failure Monitor dashboard.',
    version: '1.0.0',
    protocolVersion: '0.3.0',
    url,
    preferredTransport: 'JSONRPC',
    additionalInterfaces: [{ url, transport: 'JSONRPC' }],
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: [{
      id: 'failed_job_report',
      name: 'Failed job report',
      description: 'Summarizes failed application jobs for the last hour, 24 hours, 7 days or 30 days, with error reasons and a dashboard link.',
      tags: ['jobs', 'application jobs', 'batch', 'failed', 'Cloud ALM'],
      examples: ['How many jobs have failed?', 'Which jobs failed this week?', 'Show failed jobs in the last hour']
    }]
  };
  if (issuer) {
    card.securitySchemes = { ias: { type: 'openIdConnect', openIdConnectUrl: `${issuer}/.well-known/openid-configuration` } };
    card.security = [{ ias: [] }];
  }
  return card;
}

module.exports = { buildAgentCard, A2A_PATH, CARD_PATH };
