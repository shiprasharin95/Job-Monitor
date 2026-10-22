// Daily failed-job report: one e-mail per scheduler with all of that scheduler's failed jobs from the
// last 24 hours, each with the job-log error reason and an AI-generated possible resolution.
// Triggered by SAP Job Scheduling (POST /run) or on demand (OData action sendDailyReport).
const store = require('./job-store');
const agent = require('./job-failure-agent');
const tracking = require('./scheduler-tracking');

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function allowedRecipient(email) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
  const domains = (process.env.ALLOWED_NOTIFICATION_DOMAINS || 'bearingpoint.com,sap.com').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
  const allowList = (process.env.ALLOWED_NOTIFICATION_RECIPIENTS || '').split(',').map(normalizeEmail).filter(Boolean);
  return allowList.includes(email) || domains.some((domain) => email.endsWith(`@${domain}`));
}

// Groups failed jobs by the scheduler's e-mail (from S/4HANA Business User - Read). Jobs whose
// scheduler has no e-mail go to the operations mailbox (DEFAULT_SCHEDULER_EMAIL) in one mail.
function groupByScheduler(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    const resolved = normalizeEmail(job.schedulerEmail);
    const email = resolved || normalizeEmail(process.env.DEFAULT_SCHEDULER_EMAIL);
    if (!allowedRecipient(email)) continue;
    const name = resolved ? (job.schedulerName || email) : (process.env.DEFAULT_SCHEDULER_NAME || 'Operations');
    const group = groups.get(email) || { schedulerEmail: email, schedulerName: name, jobs: [] };
    group.jobs.push(job);
    groups.set(email, group);
  }
  return [...groups.values()];
}

async function failedJobsLast(hours) {
  const since = Date.now() - hours * 3600000;
  const jobs = await store.failedJobs(Number(process.env.SCHEDULER_MAX_JOBS || 500));
  return jobs.filter((job) => new Date(job.finishedAt || job.startedAt).valueOf() >= since);
}

async function withAnalysis(job) {
  try {
    const result = await agent.analyze(job.jobId, job.jobName);
    return { ...job, analysis: result.analysis };
  } catch (error) {
    return { ...job, analysis: `AI analysis unavailable: ${String(error.message).slice(0, 200)}` };
  }
}

/**
 * options.hours      lookback window (default 24)
 * options.dryRun     build the mails but do not send (returns previews)
 * options.suppress   skip jobs already notified within NOTIFICATION_REPEAT_WORKING_DAYS (default true)
 * options.recipient  send every mail to this address instead (test mode)
 */
async function sendDailyReport(options = {}) {
  const hours = Number(options.hours || 24);
  const suppress = options.suppress !== false;
  const jobs = await failedJobsLast(hours);
  const groups = groupByScheduler(jobs);
  const result = { hours, inspected: jobs.length, schedulers: groups.length, mailsSent: 0, previews: [], failures: [] };

  for (const group of groups) {
    let candidates = group.jobs.map((job) => ({ job, key: null, claimKey: null }));
    if (suppress) {
      candidates = [];
      for (const job of group.jobs) {
        const check = await tracking.eligible(job, group.schedulerEmail);
        if (!check.eligible) continue;
        const claimKey = await tracking.claim(check.key, group.schedulerEmail, check.lastNotified);
        if (claimKey) candidates.push({ job, key: check.key, claimKey });
      }
    }
    if (!candidates.length) continue;

    try {
      const enriched = [];
      for (const candidate of candidates) enriched.push(await withAnalysis(candidate.job));
      const to = options.recipient || group.schedulerEmail;
      const mail = agent.digest(group.schedulerName, to, JSON.stringify(enriched));
      if (options.dryRun) {
        result.previews.push({ to, scheduler: group.schedulerName, jobCount: mail.jobCount, subject: mail.subject, text: mail.text });
        for (const c of candidates) if (c.claimKey) await tracking.release(c.claimKey);
        continue;
      }
      await agent.sendDigest(group.schedulerName, to, JSON.stringify(enriched));
      for (const c of candidates) {
        if (c.key) await tracking.record(c.key, group.schedulerEmail);
        if (c.claimKey) await tracking.complete(c.claimKey, 'SENT');
      }
      result.mailsSent += 1;
      result.previews.push({ to, scheduler: group.schedulerName, jobCount: mail.jobCount, subject: mail.subject });
    } catch (error) {
      for (const c of candidates) if (c.claimKey) await tracking.complete(c.claimKey, 'FAILED', String(error.code || error.name || 'MAIL_ERROR').slice(0, 80));
      result.failures.push({ scheduler: group.schedulerName, to: group.schedulerEmail, message: String(error.message).slice(0, 300) });
    }
  }
  return result;
}

module.exports = { sendDailyReport, groupByScheduler };
