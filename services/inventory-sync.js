const db = require('../db');
const quotaSync = require('./quota-sync');
const workspaceSync = require('./workspace-sync');

const INVENTORY_SYNC_MAX_AGE_MINUTES = Math.max(
  1,
  Number.parseInt(process.env.TEAM_INVENTORY_SYNC_MAX_AGE_MINUTES || '5', 10) || 5
);
const INVENTORY_SYNC_COOLDOWN_MS = Math.max(
  10000,
  Number.parseInt(process.env.TEAM_INVENTORY_SYNC_COOLDOWN_MS || '45000', 10) || 45000
);

let refreshInFlight = null;
let lastRefreshAttemptAt = 0;
let lastRefreshError = '';

function getInventorySyncState(maxAgeMinutes = INVENTORY_SYNC_MAX_AGE_MINUTES) {
  const quotaRow = db.prepare(`
    SELECT MAX(datetime(quota_last_synced_at)) AS last_synced_at
    FROM accounts
    WHERE status = 'active'
      AND COALESCE(access_token, '') != ''
      AND quota_sync_status = 'success'
  `).get();

  const workspaceRow = db.prepare(`
    SELECT MAX(datetime(updated_at)) AS last_synced_at
    FROM workspaces
    WHERE sync_status = 'success'
  `).get();

  const staleThreshold = `-${maxAgeMinutes} minutes`;
  const quotaIsFresh = Boolean(db.prepare(`
    SELECT 1
    FROM accounts
    WHERE status = 'active'
      AND COALESCE(access_token, '') != ''
      AND quota_sync_status = 'success'
      AND datetime(quota_last_synced_at) >= datetime('now', ?)
    LIMIT 1
  `).get(staleThreshold));

  const workspaceIsFresh = Boolean(db.prepare(`
    SELECT 1
    FROM workspaces
    WHERE sync_status = 'success'
      AND datetime(updated_at) >= datetime('now', ?)
    LIMIT 1
  `).get(staleThreshold));

  return {
    maxAgeMinutes,
    quotaLastSyncedAt: quotaRow?.last_synced_at || '',
    workspaceLastSyncedAt: workspaceRow?.last_synced_at || '',
    quotaIsFresh,
    workspaceIsFresh,
    isStale: !quotaIsFresh || !workspaceIsFresh,
    lastRefreshError,
  };
}

async function ensureInventoryFreshness(options = {}) {
  const maxAgeMinutes = Math.max(
    1,
    Number.parseInt(options.maxAgeMinutes || INVENTORY_SYNC_MAX_AGE_MINUTES, 10) || INVENTORY_SYNC_MAX_AGE_MINUTES
  );
  const force = Boolean(options.force);
  const stateBefore = getInventorySyncState(maxAgeMinutes);

  if (!force && !stateBefore.isStale) {
    return {
      refreshed: false,
      skipped: true,
      reason: 'fresh',
      ...stateBefore,
    };
  }

  if (refreshInFlight) {
    return refreshInFlight;
  }

  const now = Date.now();
  if (!force && now - lastRefreshAttemptAt < INVENTORY_SYNC_COOLDOWN_MS) {
    return {
      refreshed: false,
      skipped: true,
      reason: 'cooldown',
      ...stateBefore,
    };
  }

  lastRefreshAttemptAt = now;
  refreshInFlight = (async () => {
    try {
      await quotaSync.syncAllAccountUsage();
      await workspaceSync.syncAllWorkspaceSnapshots();
      lastRefreshError = '';
    } catch (err) {
      lastRefreshError = err.message;
      console.error('[InventorySync] Refresh failed:', err.message);
    }

    return {
      refreshed: true,
      skipped: false,
      ...getInventorySyncState(maxAgeMinutes),
    };
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

function refreshInventoryInBackground(options = {}) {
  ensureInventoryFreshness(options).catch(err => {
    lastRefreshError = err.message;
    console.error('[InventorySync] Background refresh failed:', err.message);
  });
}

module.exports = {
  INVENTORY_SYNC_MAX_AGE_MINUTES,
  ensureInventoryFreshness,
  refreshInventoryInBackground,
  getInventorySyncState,
};
