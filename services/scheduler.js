const cron = require('node-cron');
const db = require('../db');
const checker = require('./checker');
const quotaSync = require('./quota-sync');
const workspaceSync = require('./workspace-sync');
const memberOverflowRebalance = require('./member-overflow-rebalance');
const telegram = require('./telegram');

let checkTask = null;
let dailySummaryTask = null;
let checkCycleRunning = false;

function getInterval() {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get('check_interval_minutes');
  return parseInt(row?.value || '5', 10);
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
    await checker.checkAllAccounts();
    await workspaceSync.syncAllWorkspaceSnapshots();
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
};
