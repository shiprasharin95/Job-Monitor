const { getDestination } = require('@sap-cloud-sdk/connectivity');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const store = require('./job-store');

const AI_DESTINATIONS = [process.env.JOB_FAILURE_AI_DESTINATION, 'JOB_FAILURE_AI_AGENT', 'GENERATIVE_AI_HUB'].filter(Boolean);
const MAIL_DESTINATIONS = [process.env.JOB_FAILURE_MAIL_DESTINATION, 'JOB_FAILURE_MAIL', 'AzureMailService'].filter(Boolean);

const SYSTEM_PROMPT = `You are an SAP S/4HANA Public Cloud Support Consultant specializing in Application Jobs, standard business processes, troubleshooting, and root cause analysis.

Use only official SAP documentation from help.sap.com. Never invent causes, resolutions, SAP Notes, configuration activities, apps, transactions, tables, APIs, or troubleshooting steps. If documentation is not available, explicitly say so. Return short, human-readable Markdown using exactly these sections:

### Job Overview
- Job Name:
- Business Purpose:
- Related SAP Application:

## Documented Failure Causes

## Most Likely Root Causes
Description:
- Why it happens:
- How to verify:
- SAP documented resolution:
- Confidence Level:

## Recommended Investigation Steps
- List

Never provide more than two likely causes.`;

function property(destination, name) {
  if (destination[name]) return destination[name];
  if (destination.originalProperties?.[name]) return destination.originalProperties[name];
  const key = Object.keys(destination.originalProperties || {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? destination.originalProperties[key] : undefined;
}

async function destination(names) {
  for (const name of names) {
    const result = await getDestination({ destinationName: name });
    if (result) return { name, value: result };
  }
  throw new Error(`No BTP destination was found from: ${names.join(', ')}.`);
}

async function analyze(jobId, jobName) {
  const errors = await store.jobErrors(jobId);
  const errorText = errors.map((item) => item.description).join('\n') || 'No execution error text was returned by the configured error source.';
  const resolved = await destination(AI_DESTINATIONS);
  const target = resolved.value;
  // SAP AI Core foundation-model deployment (OpenAI-compatible chat completions).
  const chatPath = property(target, 'AiChatPath')
    || `/v2/inference/deployments/${process.env.AI_DEPLOYMENT_ID || 'd4da60fb50a82e0d'}/chat/completions?api-version=${process.env.AI_API_VERSION || '2024-10-21'}`;
  const resourceGroup = property(target, 'AiResourceGroup') || property(target, 'URL.headers.AI-Resource-Group') || 'default';

  try {
    const response = await executeHttpRequest(target, {
      method: 'post',
      url: chatPath,
      headers: { 'content-type': 'application/json', 'AI-Resource-Group': resourceGroup },
      data: {
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Job Name: ${jobName || jobId}\nJob ID: ${jobId}\n\nError details:\n${errorText}` }
        ],
        temperature: 0.1
      }
    }, { fetchCsrfToken: false });
    const analysis = response.data?.choices?.[0]?.message?.content || response.data?.content || response.data?.result;
    if (!analysis) throw new Error('The AI agent response did not contain analysis text.');
    return { jobId, jobName: jobName || jobId, analysis };
  } catch (error) {
    const response = error.cause?.response || error.response;
    const message = response?.data?.error?.message || response?.data?.message || error.message;
    throw new Error(`Job failure analysis failed: ${String(message).slice(0, 300)}`);
  }
}

function digest(schedulerName, schedulerEmail, failedJobs) {
  let jobs;
  try {
    jobs = JSON.parse(failedJobs);
  } catch {
    throw new Error('failedJobs must be a JSON array.');
  }
  if (!Array.isArray(jobs) || !jobs.length) throw new Error('failedJobs must contain at least one job.');

  const lines = jobs.map((job, index) => [
    `${index + 1}. ${job.jobName || job.jobId || 'Unnamed job'}`,
    `Job ID: ${job.jobId || 'Not available'}`,
    `System: ${job.system || 'Not available'}`,
    `Failed at: ${job.startedAt ? new Date(job.startedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'Not available'}`,
    `Error reason (job log): ${job.errorSummary || job.errorDescription || 'No error description returned'}`,
    job.analysis ? `AI summary: ${job.analysis}` : null
  ].filter(Boolean).join('\n')).join('\n\n');
  const subject = `[Action required] ${jobs.length} SAP batch job failure${jobs.length === 1 ? '' : 's'} for ${schedulerName || 'your schedule'}`;
  const text = `Hello ${schedulerName || ''},\n\n${jobs.length} batch job(s) scheduled by you failed.\n\n${lines}\n\nThe resolution steps are AI-generated from official SAP documentation. Please validate them before applying changes.\n\nIf you did not schedule these jobs, you may disregard this e-mail.`;
  const html = `<p>Hello ${escapeHtml(schedulerName || '')},</p><p><b>${jobs.length}</b> batch job(s) scheduled by you failed.</p><pre>${escapeHtml(lines)}</pre><p><i>The resolution steps are AI-generated from official SAP documentation. Please validate them before applying changes.</i></p><p>If you did not schedule these jobs, you may disregard this e-mail.</p>`;
  return { recipient: schedulerEmail, jobCount: jobs.length, subject, text, html };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

async function sendDigest(schedulerName, schedulerEmail, failedJobs) {
  if (!schedulerEmail) throw new Error('schedulerEmail is required.');
  const result = digest(schedulerName, schedulerEmail, failedJobs);
  const resolved = await destination(MAIL_DESTINATIONS);
  const target = resolved.value;
  const sender = property(target, 'MailSenderUser') || process.env.MAIL_FROM || 'cap-notifications@bearingpoint.com';
  const basePath = property(target, 'GraphApiBasePath') || (/\/v1\.0\/?$/i.test(target.url || '') ? '' : '/v1.0');

  try {
    await executeHttpRequest(target, {
      method: 'post',
      url: `${basePath}/users/${encodeURIComponent(sender)}/sendMail`,
      headers: { 'content-type': 'application/json' },
      data: {
        message: {
          subject: result.subject,
          body: { contentType: 'HTML', content: result.html },
          toRecipients: [{ emailAddress: { address: schedulerEmail } }]
        },
        saveToSentItems: true
      }
    });
    return result;
  } catch (error) {
    const message = error.response?.data?.error?.message || error.response?.data?.message || error.message;
    throw new Error(`Scheduler digest e-mail failed: ${message}`);
  }
}

module.exports = { analyze, sendDigest };
