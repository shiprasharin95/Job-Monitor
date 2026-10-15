const store = require('./job-store');
const agent = require('./job-failure-agent');
const tracking = require('./scheduler-tracking');

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function allowedRecipient(email) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
  const domains = (process.env.ALLOWED_NOTIFICATION_DOMAINS || 'bearingpoint.com,sap.com').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  const allowList = (process.env.ALLOWED_NOTIFICATION_RECIPIENTS || '').split(',').map(normalizeEmail).filter(Boolean);
  return allowList.includes(email) || domains.some((domain) => email.endsWith(`@${domain}`));
}

function groupByScheduler(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    // Cloud ALM analytics carries no scheduler identity; fall back to the configured operations mailbox.
    const email = normalizeEmail(job.schedulerEmail || process.env.DEFAULT_SCHEDULER_EMAIL);
    if (!allowedRecipient(email)) continue;
    const name = job.schedulerEmail ? job.schedulerName : (process.env.DEFAULT_SCHEDULER_NAME || job.schedulerName);
    const group = groups.get(email) || { schedulerEmail: email, schedulerName: name || email, jobs: [] };
    group.jobs.push(job);
    groups.set(email, group);
  }
  return [...groups.values()];
}

async function runScheduledWarnings() {
  const jobs = await store.failedJobs(Number(process.env.SCHEDULER_MAX_JOBS || 200));
  const result = { inspected: jobs.length, skippedWithoutRecipient: 0, schedulerDigests: 0, failures: [] };
  const groups = groupByScheduler(jobs);
  result.skippedWithoutRecipient = jobs.length - groups.reduce((count, group) => count + group.jobs.length, 0);

  for (const group of groups) {
    const claimed = [];
    for (const job of group.jobs) {
      const candidate = await tracking.eligible(job, group.schedulerEmail);
      if (!candidate.eligible) continue;
      const claimKey = await tracking.claim(candidate.key, group.schedulerEmail, candidate.lastNotified);
      if (claimKey) claimed.push({ job, key: candidate.key, claimKey });
    }
    if (!claimed.length) continue;

    try {
      const enriched = [];
      for (const candidate of claimed) {
        try {
          const analysis = await agent.analyze(candidate.job.jobId, candidate.job.jobName);
          enriched.push({ ...candidate.job, analysis: analysis.analysis });
        } catch (error) {
          enriched.push({ ...candidate.job, analysis: `AI analysis unavailable: ${error.message}` });
        }
      }
      await agent.sendDigest(group.schedulerName, group.schedulerEmail, JSON.stringify(enriched));
      for (const candidate of claimed) {
        await tracking.record(candidate.key, group.schedulerEmail);
        await tracking.complete(candidate.claimKey, 'SENT');
      }
      result.schedulerDigests += 1;
    } catch (error) {
      for (const candidate of claimed) await tracking.complete(candidate.claimKey, 'FAILED', String(error.code || error.name || 'MAIL_ERROR').slice(0, 80));
      result.failures.push({ schedulerEmail: group.schedulerEmail, message: error.message });
    }
  }
  return result;
}

module.exports = { runScheduledWarnings };
