const { DefaultRequestHandler, InMemoryTaskStore } = require('@a2a-js/sdk/server');
const { agentCardHandler, jsonRpcHandler } = require('@a2a-js/sdk/server/express');
const { iasAuthMiddleware, userBuilder } = require('./auth');
const { buildAgentCard, A2A_PATH, CARD_PATH } = require('./agent-card');
const { JobMonitorExecutor } = require('./executor');

// Mounts the A2A server (protocol 0.3.0, JSON-RPC message/send). The agent card is public and holds no
// data; POST /a2a requires an IAS token and an IDoc-style group (JobMonitor_Viewer / JobMonitor_Admin).
function mountA2A(app, { loadReport } = {}) {
  const agentCard = buildAgentCard();
  const requestHandler = new DefaultRequestHandler(agentCard, new InMemoryTaskStore(), new JobMonitorExecutor({ loadReport }));
  app.use(CARD_PATH, agentCardHandler({ agentCardProvider: requestHandler }));
  app.use(A2A_PATH, iasAuthMiddleware, jsonRpcHandler({ requestHandler, userBuilder }));
  return agentCard;
}

module.exports = { mountA2A };
