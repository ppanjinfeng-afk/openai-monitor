const cron = require('node-cron');
const db = require('../db');
const checker = require('./checker');
const quotaSync = require('./quota-sync');
const workspaceSync = require('./workspace-sync');
const memberOverflowRebalance = require('./member-overflow-rebalance');
const untrackedMemberCleanup = require('./untracked-member-cleanup');
const staleMemberCleanup = require('./stale-member-cleanup');
const { releaseStaleProcessingCdks } = require('./cdk-processing-timeout');
const telegram = require('./telegram');

let checkTask = null;
let memberCleanupTask = null;
let cdkTimeoutTask = null;
let dailySummaryTask = null;
let checkCycleRunning = false;
let memberCleanupRunning = false;

function getInterval() {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get('check_interval_minutes');
  return parseInt(row?.value || '5', 10);
}

function normalizeIntervalMinutes(value, fallback = 5) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.max(1, Math.min(parsed, 60));
}

function getMemberCleanupInterval() {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get('member_cleanup_interval_minutes');
  return normalizeIntervalMinutes(row?.value || process.env.MEMBER_CLEANUP_INTERVAL_MINUTES, getInterval());
}

function getDailySummaryHour() {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get('daily_summary_hour');
  return parseInt(row?.value || '9', 10);
}

function isDailySummaryEnabled() {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get('daily_summary_enabled');
  return row?.value === 'true';
}

async function runCheckCycle(trigger = 'manual') {
  if (checkCycleRunning) {
    console.log(`[Scheduler] Skip ${trigger} check: previous cycle still running`);
    return false;
  }

  checkCycleRunning = true;
  console.log(`[Scheduler] Running ${trigger} check at ${new Date().toISOString()}`);

  try {
    releaseStaleProcessingCdks({ log: true });
    await checker.checkAllAccounts();
    await workspaceSync.syncAllWorkspaceSnapshots();
    await runMemberCleanupCycle(`${trigger}-after-sync`);
    await memberOverflowRebalance.rebalanceOverflowMembers();
    await quotaSync.syncAllAccountUsage();
    return true;
  } catch (err) {
    console.error(`[Scheduler] ${trigger} check failed:`, err.message);
    return false;
  } finally {
    checkCycleRunning = false;
  }
}

async function runMemberCleanupCycle(trigger = 'manual') {
  if (memberCleanupRunning) {
    console.log(`[Scheduler] Skip ${trigger} member cleanup: previous cleanup still running`);
    return false;
  }

  memberCleanupRunning = true;
  console.log(`[Scheduler] Running ${trigger} member cleanup at ${new Date().toISOString()}`);

  try {
    await untrackedMemberCleanup.autoKickUntrackedMembers();
    await staleMemberCleanup.autoKickStaleMembers();
    return true;
  } catch (err) {
    console.error(`[Scheduler] ${trigger} member cleanup failed:`, err.message);
    return false;
  } finally {
    memberCleanupRunning = false;
  }
}

function runCdkTimeoutRelease(trigger = 'manual') {
  try {
    releaseStaleProcessingCdks({ log: true });
    return true;
  } catch (err) {
    console.error(`[Scheduler] ${trigger} CDK timeout release failed:`, err.message);
    return false;
  }
}

function startScheduler() {
  const intervalMinutes = getInterval();

  // Stop existing task if any
  if (checkTask) {
    checkTask.stop();
  }

  // Schedule periodic checks
  checkTask = cron.schedule(`*/${intervalMinutes} * * * *`, async () => {
    await runCheckCycle('periodic');
  });

  console.log(`[Scheduler] Check task scheduled every ${intervalMinutes} minutes`);

  if (memberCleanupTask) {
    memberCleanupTask.stop();
  }

  const memberCleanupIntervalMinutes = getMemberCleanupInterval();
  memberCleanupTask = cron.schedule(`*/${memberCleanupIntervalMinutes} * * * *`, async () => {
    await runMemberCleanupCycle('periodic');
  });

  console.log(`[Scheduler] Member cleanup scheduled every ${memberCleanupIntervalMinutes} minutes`);

  if (cdkTimeoutTask) {
    cdkTimeoutTask.stop();
  }

  cdkTimeoutTask = cron.schedule('* * * * *', () => {
    runCdkTimeoutRelease('periodic');
  });

  console.log('[Scheduler] CDK processing timeout release scheduled every 1 minute');

  setTimeout(async () => {
    console.log('[Scheduler] Running initial full check');
    try {
      await runCheckCycle('initial');
    } catch (err) {
      console.error('[Scheduler] Initial full check failed:', err.message);
    }
  }, 1500);

  // Schedule daily summary
  if (dailySummaryTask) {
    dailySummaryTask.stop();
  }

  const hour = getDailySummaryHour();
  if (isDailySummaryEnabled()) {
    dailySummaryTask = cron.schedule(`0 ${hour} * * *`, async () => {
      console.log(`[Scheduler] Sending daily summary`);
      try {
        const stats = checker.getStats();
        await telegram.sendDailySummary(stats);
      } catch (err) {
        console.error('[Scheduler] Daily summary failed:', err.message);
      }
    });
    console.log(`[Scheduler] Daily summary scheduled at ${hour}:00`);
  }
}

function restartScheduler() {
  console.log('[Scheduler] Restarting...');
  startScheduler();
}

function stopScheduler() {
  if (checkTask) {
    checkTask.stop();
    checkTask = null;
  }
  if (memberCleanupTask) {
    memberCleanupTask.stop();
    memberCleanupTask = null;
  }
  if (cdkTimeoutTask) {
    cdkTimeoutTask.stop();
    cdkTimeoutTask = null;
  }
  if (dailySummaryTask) {
    dailySummaryTask.stop();
    dailySummaryTask = null;
  }
  console.log('[Scheduler] Stopped');
}

module.exports = {
  startScheduler,
  restartScheduler,
  stopScheduler,
  runCheckCycle,
  runMemberCleanupCycle,
  runCdkTimeoutRelease,
};
