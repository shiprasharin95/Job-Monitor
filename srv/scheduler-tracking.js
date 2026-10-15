const cds = require('@sap/cds');
const { createHash } = require('node:crypto');
const { SELECT, INSERT, UPDATE } = cds.ql;

function entities() {
  return cds.entities('job.monitor');
}

function addWorkingDays(date, days) {
  const result = new Date(date);
  let remaining = days;
  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + 1);
    const day = result.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return result;
}

function repeatDays() {
  const value = Number(process.env.NOTIFICATION_REPEAT_WORKING_DAYS || 5);
  return Number.isInteger(value) && value > 0 ? value : 5;
}

function failureKey(job) {
  return [job.system, job.application, job.jobId, job.finishedAt || job.startedAt || job.errorSummary]
    .map((value) => String(value || 'unknown').trim())
    .join('|');
}

function idempotencyKey(key, lastNotified) {
  return createHash('sha256').update(`${key}\u0000${lastNotified ? new Date(lastNotified).toISOString() : 'first'}`).digest('hex');
}

function isEligible(log, now = new Date()) {
  return !log || (!log.resolved && (!log.lastNotified || now >= addWorkingDays(new Date(log.lastNotified), repeatDays())));
}

async function eligible(job, schedulerEmail, now = new Date()) {
  if (!cds.db) throw new Error('Notification persistence is unavailable because no database is bound.');
  const key = failureKey(job);
  const log = await cds.db.run(SELECT.one.from(entities().FAILURE_NOTIFICATION_LOG).where({ failureKey: key }));
  return { key, eligible: isEligible(log, now), lastNotified: log?.lastNotified || null };
}

async function claim(key, schedulerEmail, lastNotified) {
  const claimKey = idempotencyKey(key, lastNotified);
  try {
    await cds.db.run(INSERT.into(entities().FAILURE_NOTIFICATION_CLAIM).entries({
      idempotencyKey: claimKey,
      failureKey: key,
      schedulerEmail,
      status: 'CLAIMED'
    }));
    return claimKey;
  } catch (error) {
    const existing = await cds.db.run(SELECT.one.from(entities().FAILURE_NOTIFICATION_CLAIM).where({ idempotencyKey: claimKey })).catch(() => null);
    if (existing) return null;
    throw error;
  }
}

async function complete(claimKey, status, outcomeCode = null) {
  await cds.db.run(UPDATE(entities().FAILURE_NOTIFICATION_CLAIM).set({ status, outcomeCode, completedAt: new Date() }).where({ idempotencyKey: claimKey, status: 'CLAIMED' }));
}

async function record(key, schedulerEmail, now = new Date()) {
  const existing = await cds.db.run(SELECT.one.from(entities().FAILURE_NOTIFICATION_LOG).where({ failureKey: key }));
  if (!existing) {
    await cds.db.run(INSERT.into(entities().FAILURE_NOTIFICATION_LOG).entries({ failureKey: key, schedulerEmail, firstNotified: now, lastNotified: now, resolved: false }));
    return;
  }
  await cds.db.run(UPDATE(entities().FAILURE_NOTIFICATION_LOG).set({ schedulerEmail, lastNotified: now, resolved: false, resolvedAt: null }).where({ failureKey: key }));
}

module.exports = { claim, complete, eligible, failureKey, record };
