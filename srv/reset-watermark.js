// Operational task: clears the sync watermark so the next sync re-reads CLOUD_ALM_INITIAL_LOOKBACK_DAYS.
const cds = require('@sap/cds');

(async () => {
  const db = await cds.connect.to('db');
  await db.run('DELETE FROM job_monitor_SyncState');
  console.log('[RESET] watermark cleared');
  process.exit(0);
})().catch((e) => { console.log('[RESET] error', e.message); process.exit(1); });
