const quotaSync = require('./services/quota-sync');

quotaSync.syncAllAccountUsage()
  .then(results => {
    const success = results.filter(item => item.success).length;
    const failed = results.filter(item => item.success === false && !item.skipped).length;
    console.log(`[SyncQuota] Completed. Success: ${success}, Failed: ${failed}`);
    process.exit(0);
  })
  .catch(err => {
    console.error('[SyncQuota] Failed:', err);
    process.exit(1);
  });
