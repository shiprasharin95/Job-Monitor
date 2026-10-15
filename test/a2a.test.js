// A2A contract tests: real @a2a-js/sdk JSON-RPC server + real JWT validation against a local JWKS
// that stands in for the IAS tenant. Run: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const AUDIENCE = 'job-monitor-a2a-test-client';
let issuerServer;
let agentServer;
let agentUrl;
let keys;

const fakeReport = async (question) => ({
  text: `**2 failed job run(s)** for: ${question}`,
  data: { type: 'failed_job_report', period: '24H', counts: { total: 5, success: 3, error: 2, warning: 0, inProcess: 0 }, hasFailures: true }
});

before(async () => {
  const jose = await import('jose');
  keys = await jose.generateKeyPair('RS256');
  const jwk = { ...(await jose.exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };

  issuerServer = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise((resolve) => issuerServer.listen(0, resolve));
  const issuer = `http://localhost:${issuerServer.address().port}`;

  process.env.IAS_ISSUER = issuer;
  process.env.IAS_AUDIENCE = AUDIENCE;
  process.env.IAS_JWKS_URL = `${issuer}/oauth2/certs`;
  process.env.A2A_PUBLIC_URL = 'http://localhost';

  const { mountA2A } = require('../srv/a2a');
  const app = express();
  mountA2A(app, { loadReport: fakeReport });
  agentServer = http.createServer(app);
  await new Promise((resolve) => agentServer.listen(0, resolve));
  agentUrl = `http://localhost:${agentServer.address().port}`;
});

after(() => { agentServer?.close(); issuerServer?.close(); });

async function token(claims, audience = AUDIENCE) {
  const jose = await import('jose');
  return new jose.SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(process.env.IAS_ISSUER).setAudience(audience).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
}

async function send(bearer, text = 'How many jobs have failed today?') {
  const response = await fetch(`${agentUrl}/a2a`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(bearer && { authorization: `Bearer ${bearer}` }) },
    body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'message/send', params: { message: { kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'text', text }] } } })
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test('agent card is public and describes the A2A endpoint', async () => {
  const card = await (await fetch(`${agentUrl}/.well-known/agent-card.json`)).json();
  assert.equal(card.protocolVersion, '0.3.0');
  assert.equal(card.preferredTransport, 'JSONRPC');
  assert.match(card.url, /\/a2a$/);
  assert.equal(card.skills[0].id, 'failed_job_report');
  assert.ok(card.securitySchemes.ias);
});

test('viewer user token gets a completed task with text + data artifact', async () => {
  const { status, body } = await send(await token({ sub: 'u1', email: 'viewer@bearingpoint.com', groups: ['JobMonitor_Viewer'] }));
  assert.equal(status, 200);
  assert.equal(body.result.status.state, 'completed');
  const parts = body.result.artifacts[0].parts;
  assert.equal(parts[0].kind, 'text');
  assert.equal(parts[1].kind, 'data');
  assert.equal(parts[1].data.type, 'failed_job_report');
});

test('admin group is also accepted', async () => {
  const { body } = await send(await token({ sub: 'u2', email: 'admin@bearingpoint.com', groups: ['JobMonitor_Admin'] }));
  assert.equal(body.result.status.state, 'completed');
});

test('user without the group is rejected without reading data', async () => {
  const { body } = await send(await token({ sub: 'u3', email: 'nogroup@bearingpoint.com', groups: ['Other'] }));
  assert.equal(body.result.status.state, 'rejected');
  assert.match(body.result.artifacts[0].parts[0].text, /JobMonitor_Viewer/);
});

test('technical token (no user) is rejected', async () => {
  const { body } = await send(await token({ sub: 'client', azp: 'client', groups: ['JobMonitor_Viewer'] }));
  assert.equal(body.result.status.state, 'rejected');
});

test('wrong audience gets 401', async () => {
  const { status } = await send(await token({ sub: 'u1', email: 'a@b.com', groups: ['JobMonitor_Viewer'] }, 'some-other-app'));
  assert.equal(status, 401);
});

test('missing token gets 401', async () => {
  const { status } = await send(null);
  assert.equal(status, 401);
});
