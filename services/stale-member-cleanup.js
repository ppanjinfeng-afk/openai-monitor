const db = require('../db');
const workspaceMembers = require('./workspace-members');
const workspaceSync = require('./workspace-sync');

const ENABLED_SETTING_KEY = 'stale_members_auto_kick_enabled';
const HOURS_SETTING_KEY = 'stale_members_auto_kick_hours';
const DEFAULT_HOURS = 26;
const DEFAULT_LIMIT = 100;
const MAX_HOURS = 720;

function normalizeHours(value) {
  const hours = Number.parseFloat(value);
  if (!Number.isFinite(hours)) {
    return DEFAULT_HOURS;
  }

  return Math.max(1, Math.min(hours, MAX_HOURS));
}

function normalizeConcurrency(value, fallback = 2, max = 6) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.floor(parsed), max));
}

function getCleanupWorkspaceConcurrency() {
  return normalizeConcurrency(
    process.env.STALE_CLEANUP_WORKSPACE_CONCURRENCY || process.env.MEMBER_REMOVAL_WORKSPACE_CONCURRENCY,
    2,
    6
  );
}

function getCleanupSyncConcurrency() {
  return normalizeConcurrency(
    process.env.MEMBER_CLEANUP_SYNC_CONCURRENCY || process.env.MEMBER_REMOVAL_WORKSPACE_CONCURRENCY,
    2,
    6
  );
}

async function runWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const workerCount = Math.min(Math.max(1, limit), list.length);
  let index = 0;

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (index < list.length) {
      const currentIndex = index;
      index += 1;
      await worker(list[currentIndex], currentIndex);
    }
  }));
}

function isAutoKickEnabled() {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(ENABLED_SETTING_KEY);
  return row?.value === 'true';
}

function getAutoKickHours() {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(HOURS_SETTING_KEY);
  return normalizeHours(row?.value || DEFAULT_HOURS);
}

function markMemberRemoved(item) {
  db.prepare(`
    UPDATE workspace_members
    SET deactivated_time = datetime('now'),
        last_synced_at = datetime('now')
    WHERE id = ?
  `).run(item.id);
}

function groupMembersForRemoval(members = []) {
  const groups = new Map();

  for (const member of members) {
    const key = `${member.account_id || 0}:${member.workspace_id || ''}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(member);
  }

  return Array.from(groups.values());
}

function getStaleMembers(options = {}) {
  const hours = normalizeHours(options.hours || getAutoKickHours());
  const threshold = `-${hours} hours`;

  const items = db.prepare(`
    SELECT
      wm.id,
      wm.account_id,
      a.email AS account_email,
      w.id AS workspace_row_id,
      wm.workspace_id,
      w.workspace_name,
      w.plan_type,
      wm.user_id,
      wm.account_user_id,
      wm.email,
      wm.name,
      wm.role,
      wm.seat_type,
      wm.is_owner,
      wm.joined_at,
      wm.last_synced_at
    FROM workspace_members wm
    JOIN workspaces w ON w.workspace_id = wm.workspace_id AND w.account_id = wm.account_id
    JOIN accounts a ON a.id = wm.account_id
    WHERE a.status = 'active'
      AND a.access_token IS NOT NULL
      AND a.access_token != ''
      AND COALESCE(wm.deactivated_time, '') = ''
      AND COALESCE(wm.email, '') != ''
      AND COALESCE(wm.is_owner, 0) = 0
      AND COALESCE(wm.joined_at, '') != ''
      AND datetime(wm.joined_at) <= datetime('now', ?)
    ORDER BY datetime(wm.joined_at) ASC, LOWER(wm.email) ASC, w.workspace_name ASC
  `).all(threshold);

  return {
    filters: { hours },
    summary: {
      total: items.length,
      removable_members: items.filter(item => item.account_id && item.user_id).length,
      workspaces: new Set(items.map(item => item.workspace_id).filter(Boolean)).size,
      accounts: new Set(items.map(item => item.account_id).filter(Boolean)).size,
    },
    items,
  };
}

async function removeStaleMember(item, options = {}) {
  if (!item?.account_id || !item?.user_id || Number(item.is_owner || 0) === 1) {
    return {
      success: false,
      email: item?.email || '',
      message: 'Member cannot be removed',
    };
  }

  const account = options.account || db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(item.account_id);
  if (!account?.access_token) {
    return {
      success: false,
      email: item.email || '',
      message: 'Account is not authorized, cannot remove member',
    };
  }

  const result = await workspaceMembers.removeMember(account, item.user_id, {
    workspaceId: item.workspace_id || '',
    workspaceName: item.workspace_name || item.workspace_id || '',
    planType: item.plan_type || '',
    page: options.page,
  });

  if (!result.success) {
    return {
      success: false,
      email: item.email || '',
      workspace_id: item.workspace_id || '',
      workspace_name: item.workspace_name || '',
      account_id: item.account_id,
      account_email: item.account_email || '',
      message: result.message || 'Remove member failed',
    };
  }

  markMemberRemoved(item);
  db.prepare(`
    INSERT INTO check_logs (account_id, status, message)
    VALUES (?, ?, ?)
  `).run(
    item.account_id,
    'active',
    `[stale-member-auto-kick] ${item.email || item.user_id} from ${item.workspace_name || item.workspace_id || '-'}`
  );

  return {
    success: true,
    email: item.email || '',
    workspace_row_id: item.workspace_row_id || 0,
    workspace_id: item.workspace_id || '',
    workspace_name: item.workspace_name || '',
    account_id: item.account_id,
    account_email: item.account_email || '',
    message: 'Removed member',
  };
}

async function removeStaleMembersWithSharedPages(members) {
  const results = [];
  const workspaceRows = new Set();
  let removed = 0;
  let failed = 0;

  await runWithConcurrency(groupMembersForRemoval(members), getCleanupWorkspaceConcurrency(), async group => {
    const first = group[0];
    const account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(first.account_id);

    if (!account?.access_token) {
      for (const member of group) {
        failed += 1;
        results.push({
          success: false,
          email: member.email || '',
          workspace_id: member.workspace_id || '',
          workspace_name: member.workspace_name || '',
          account_id: member.account_id,
          account_email: member.account_email || '',
          message: 'Account is not authorized, cannot remove member',
        });
      }
      return;
    }

    try {
      await workspaceMembers.withWorkspacePage(async page => {
        const batchResult = await workspaceMembers.removeMembers(
          account,
          group.map((member, index) => ({
            clientIndex: index,
            userId: member.user_id,
            email: member.email || '',
          })),
          {
            workspaceId: first.workspace_id || '',
            workspaceName: first.workspace_name || first.workspace_id || '',
            planType: first.plan_type || '',
            page,
            concurrency: Number(process.env.MEMBER_REMOVAL_MEMBER_CONCURRENCY || 4) || 4,
          }
        );

        const batchItems = Array.isArray(batchResult.results) && batchResult.results.length > 0
          ? batchResult.results
          : group.map((member, index) => ({
              clientIndex: index,
              userId: member.user_id,
              email: member.email || '',
              success: false,
              message: batchResult.message || 'Remove member failed',
            }));

        for (const item of batchItems) {
          const member = group[Number(item.clientIndex || 0)] || group.find(row => row.user_id === item.userId);
          if (!member) {
            failed += 1;
            results.push({
              success: false,
              email: item.email || '',
              message: item.message || 'Member not found after remove',
            });
            continue;
          }

          if (item.success) {
            markMemberRemoved(member);
            db.prepare(`
              INSERT INTO check_logs (account_id, status, message)
              VALUES (?, ?, ?)
            `).run(
              member.account_id,
              'active',
              `[stale-member-auto-kick] ${member.email || member.user_id} from ${member.workspace_name || member.workspace_id || '-'}`
            );
            removed += 1;
            if (member.workspace_row_id) {
              workspaceRows.add(Number(member.workspace_row_id));
            }
            results.push({
              success: true,
              email: member.email || '',
              workspace_row_id: member.workspace_row_id || 0,
              workspace_id: member.workspace_id || '',
              workspace_name: member.workspace_name || '',
              account_id: member.account_id,
              account_email: member.account_email || '',
              message: 'Removed member',
            });
          } else {
            failed += 1;
            results.push({
              success: false,
              email: member.email || '',
              workspace_id: member.workspace_id || '',
              workspace_name: member.workspace_name || '',
              account_id: member.account_id,
              account_email: member.account_email || '',
              message: item.message || 'Remove member failed',
            });
          }
        }
      });
    } catch (err) {
      for (const member of group) {
        failed += 1;
        results.push({
          success: false,
          email: member.email || '',
          workspace_id: member.workspace_id || '',
          workspace_name: member.workspace_name || '',
          account_id: member.account_id,
          account_email: member.account_email || '',
          message: err.message || 'Remove member failed',
        });
      }
    }
  });

  return { results, removed, failed, workspaceRows };
}

async function autoKickStaleMembers(options = {}) {
  if (!isAutoKickEnabled() && !options.force) {
    return {
      enabled: false,
      success: true,
      hours: getAutoKickHours(),
      removed: 0,
      failed: 0,
      results: [],
    };
  }

  const hours = normalizeHours(options.hours || getAutoKickHours());
  const limit = Math.max(1, Math.min(Number(options.limit || DEFAULT_LIMIT) || DEFAULT_LIMIT, 500));
  const data = getStaleMembers({ hours });
  const members = data.items
    .filter(item => !Number(item.is_owner || 0) && item.account_id && item.user_id)
    .slice(0, limit);

  const { results, removed, failed, workspaceRows } = await removeStaleMembersWithSharedPages(members);

  await runWithConcurrency(Array.from(workspaceRows), getCleanupSyncConcurrency(), async workspaceRowId => {
    await workspaceSync.syncWorkspaceByRowId(workspaceRowId).catch(err => {
      console.warn(`[StaleMemberCleanup] sync workspace ${workspaceRowId} failed after auto kick:`, err.message);
    });
  });

  if (removed > 0 || failed > 0) {
    console.log(`[StaleMemberCleanup] auto kick complete: hours=${hours}, removed=${removed}, failed=${failed}`);
  }

  return {
    enabled: true,
    success: failed === 0,
    hours,
    scanned: data.summary.total,
    removable: members.length,
    removed,
    failed,
    results,
  };
}

module.exports = {
  ENABLED_SETTING_KEY,
  HOURS_SETTING_KEY,
  DEFAULT_HOURS,
  MAX_HOURS,
  normalizeHours,
  isAutoKickEnabled,
  getAutoKickHours,
  getStaleMembers,
  removeStaleMember,
  autoKickStaleMembers,
};
