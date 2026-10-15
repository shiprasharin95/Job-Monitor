// Read-only, deterministic failed-job report for the A2A agent. Reads only the HANA tables the
// Cloud ALM sync fills (same functions as the dashboard), never calls Cloud ALM, never writes.
const store = require('../job-store');

const MAX_TABLE_ROWS = Number(process.env.A2A_MAX_TABLE_ROWS || 10);
const PERIOD_TEXT = { '1H': 'last hour', '24H': 'last 24 hours', '7D': 'last 7 days', '30D': 'last 30 days' };

// Same rules as the IDoc agent: 1H, 24H (default), 7D or 30D derived from the question.
function periodFrom(question) {
  const text = String(question || '').toLowerCase();
  if (/\b(30\s*d|30\s*days?|month|monthly)\b/.test(text)) return '30D';
  if (/\b(7\s*d|7\s*days?|week|weekly)\b/.test(text)) return '7D';
  if (/\b(1\s*h|1\s*hour|last\s+hour|past\s+hour|this\s+hour)\b/.test(text)) return '1H';
  return '24H';
}

function dashboardUrl(period) {
  const base = (process.env.DASHBOARD_URL || '').replace(/\/+$/, '') || 'https://job-failure-monitor.cfapps.eu20-001.hana.ondemand.com/job-monitor/webapp/index.html';
  return `${base}${base.includes('?') ? '&' : '?'}period=${period}`;
}

const cell = (value) => String(value ?? '').replace(/\s+/g, ' ').replace(/\|/g, '/').trim() || '-';
const time = (value) => (value ? `${new Date(value).toISOString().replace('T', ' ').slice(0, 16)} UTC` : '-');

function markdownTable(rows) {
  return [
    '| Job | Failed in hour | Error reason | Scheduled by |',
    '|---|---|---|---|',
    ...rows.map((row) => `| **${cell(row.jobName)}** | ${cell(row.failedAt)} | ${cell(row.errorText)} | ${cell(row.schedulerName)} |`)
  ].join('\n');
}

async function buildReport(question) {
  const period = periodFrom(question);
  const summary = await store.summary(period, new Date().toISOString());
  const counts = {
    total: summary.totalRuns,
    success: summary.successCount,
    error: summary.errorCount,
    warning: summary.warningCount,
    inProcess: summary.inProcessCount
  };
  const latest = summary.latestFailedJobs.slice(0, MAX_TABLE_ROWS).map((job) => ({
    jobName: job.jobName,
    failedAt: time(job.startedAt),
    errorText: String(job.errorSummary || '').split('\n')[0].slice(0, 300),
    schedulerName: job.schedulerName || ''
  }));
  const url = dashboardUrl(period);
  const syncLine = summary.lastSyncAt
    ? `Last Cloud ALM sync: ${time(summary.lastSyncAt)}${summary.lastSyncStatus === 'SUCCESS' ? '' : ' (failed)'}`
    : 'Last Cloud ALM sync: not yet run';
  const byJob = summary.failuresByJob.slice(0, 5).map((entry) => `${entry.name} (${entry.count})`).join(', ');

  const lines = [
    `**${counts.error} failed job run(s)** in the ${PERIOD_TEXT[period]} (system my409865)`,
    '',
    `- **Successful:** ${counts.success} · **Failed:** ${counts.error} · **Warnings:** ${counts.warning} · **Success rate:** ${Number(summary.successRate).toFixed(2)}%`
  ];
  if (byJob) lines.push(`- **Failures by job:** ${byJob}`);
  if (summary.topError) lines.push(`- **Most frequent error:** ${String(summary.topError).split('\n')[0].slice(0, 300)}`);
  lines.push(`- ${syncLine}`);
  if (summary.latestFailedJobs.length > MAX_TABLE_ROWS) lines.push('', `The table shows the latest ${MAX_TABLE_ROWS} of ${summary.latestFailedJobs.length} failed runs.`);
  lines.push('', `[Open the Job Failure Monitor for the ${PERIOD_TEXT[period]}](${url})`);

  return {
    text: lines.join('\n'),
    data: {
      type: 'failed_job_report',
      period,
      counts,
      successRate: Number(summary.successRate),
      topError: summary.topError || null,
      failuresByJob: summary.failuresByJob.slice(0, 10),
      lastSyncAt: summary.lastSyncAt,
      lastSyncStatus: summary.lastSyncStatus,
      dashboardUrl: url,
      hasFailures: counts.error > 0,
      latestFailedJobs: latest,
      markdownTable: latest.length ? markdownTable(latest) : ''
    }
  };
}

module.exports = { buildReport, periodFrom, dashboardUrl };
