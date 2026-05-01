const db = require('../db');
const workspaceMembers = require('./workspace-members');
const workspaceSync = require('./workspace-sync');
const { canonicalCdkTasksCte } = require('./cdk-source');

const SETTING_KEY = 'untracked_members_auto_kick_enabled';
const DEFAULT_LIMIT = 100;

function normalizeConcurrency(value, fallback = 2, max = 6) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.floor(parsed), max));
}

function getCleanupWorkspaceConcurrency() {
  return normalizeConcurrency(
    process.env.UNTRACKED_CLEANUP_WORKSPACE_CONCURRENCY || process.env.MEMBER_REMOVAL_WORKSPACE_CONCURRENCY,
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
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(SETTING_KEY);
  return row?.value === 'true';
}

function normalizeSearch(value) {
  return String(value || '').trim().toLowerCase();
}

function canHandleItem(item) {
  if (item?.item_type === 'pending') {
    return Boolean(item.account_id && item.workspace_id && item.email);
  }

  return Boolean(!Number(item?.is_owner || 0) && item?.account_id && item?.workspace_id && item?.user_id);
}

function buildUntrackedMemberQuery({ search = '' } = {}) {
  const normalizedSearch = normalizeSearch(search);
  const searchLike = `%${normalizedSearch}%`;
  const searchWhere = normalizedSearch
    ? `AND (
        LOWER(m.email) LIKE ?
        OR LOWER(COALESCE(m.name, '')) LIKE ?
        OR LOWER(COALESCE(m.account_email, '')) LIKE ?
        OR LOWER(COALESCE(m.workspace_name, '')) LIKE ?
        OR LOWER(COALESCE(m.workspace_id, '')) LIKE ?
      )`
    : '';
  const params = normalizedSearch
    ? [searchLike, searchLike, searchLike, searchLike, searchLike]
    : [];

  const sourceCte = `
    WITH untracked_items AS (
      SELECT
        'member' AS item_type,
        wm.id,
        LOWER(TRIM(wm.email)) AS email_key,
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
        '' AS invited_at,
        '' AS remote_invite_id,
        wm.source_cdk_task_id,
        wm.source_cdk_id,
        wm.source_cdk_code,
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

      UNION ALL

      SELECT
        'pending' AS item_type,
        wp.id,
        LOWER(TRIM(wp.email)) AS email_key,
        wp.account_id,
        a.email AS account_email,
        w.id AS workspace_row_id,
        wp.workspace_id,
        w.workspace_name,
        w.plan_type,
        '' AS user_id,
        '' AS account_user_id,
        wp.email,
        '' AS name,
        '' AS role,
        '' AS seat_type,
        0 AS is_owner,
        '' AS joined_at,
        wp.invited_at,
        wp.remote_invite_id,
        wp.source_cdk_task_id,
        wp.source_cdk_id,
        wp.source_cdk_code,
        wp.last_synced_at
      FROM workspace_pending_invites wp
      JOIN workspaces w ON w.workspace_id = wp.workspace_id AND w.account_id = wp.account_id
      JOIN accounts a ON a.id = wp.account_id
      WHERE a.status = 'active'
        AND a.access_token IS NOT NULL
        AND a.access_token != ''
        AND COALESCE(wp.email, '') != ''
    ),
    ${canonicalCdkTasksCte},
    raw_cdk_sources AS (
      SELECT DISTINCT
        t.id AS task_id,
        LOWER(TRIM(i.target_email)) AS email_key,
        i.workspace_id AS workspace_key,
        COALESCE(i.remote_invite_id, '') AS remote_invite_id,
        1 AS source_priority,
        datetime(COALESCE(NULLIF(t.completed_at, ''), t.updated_at, t.created_at)) AS source_at
      FROM invites i
      JOIN canonical_cdk_tasks t ON t.id = i.cdk_task_id
      WHERE COALESCE(i.target_email, '') != ''
        AND COALESCE(t.account_email, '') != ''
        AND LOWER(TRIM(i.target_email)) = LOWER(TRIM(t.account_email))
        AND COALESCE(i.workspace_id, '') != ''
        AND COALESCE(i.status, '') IN ('sent', 'accepted')
        AND COALESCE(i.failure_category, '') = ''
      UNION
      SELECT DISTINCT task_id, email_key, workspace_key, remote_invite_id, source_priority, source_at
      FROM (
        SELECT
          t.id AS task_id,
          LOWER(TRIM(t.account_email)) AS email_key,
          COALESCE(
            NULLIF(json_extract(t.invite_result_json, '$.workspace_id'), ''),
            NULLIF(json_extract(t.invite_result_json, '$.workspaceId'), '')
          ) AS workspace_key,
          '' AS remote_invite_id,
          2 AS source_priority,
          datetime(COALESCE(NULLIF(t.completed_at, ''), t.updated_at, t.created_at)) AS source_at
        FROM canonical_cdk_tasks t
        WHERE COALESCE(t.account_email, '') != ''
          AND COALESCE(t.invite_result_json, '') != ''
          AND json_valid(t.invite_result_json)
          AND COALESCE(json_extract(t.invite_result_json, '$.failure_category'), '') = ''
      )
      WHERE COALESCE(workspace_key, '') != ''
      UNION
      SELECT DISTINCT
        t.id AS task_id,
        LOWER(TRIM(t.account_email)) AS email_key,
        '' AS workspace_key,
        '' AS remote_invite_id,
        3 AS source_priority,
        datetime(COALESCE(NULLIF(t.completed_at, ''), t.updated_at, t.created_at)) AS source_at
      FROM canonical_cdk_tasks t
      WHERE COALESCE(t.account_email, '') != ''
    ),
    exact_known_sources AS (
      SELECT DISTINCT
        m.item_type,
        m.id,
        s.task_id
      FROM untracked_items m
      JOIN raw_cdk_sources s
        ON s.email_key = m.email_key
       AND s.workspace_key = m.workspace_id
      WHERE COALESCE(s.email_key, '') != ''
        AND COALESCE(s.workspace_key, '') != ''
        AND (
          COALESCE(s.remote_invite_id, '') = ''
          OR COALESCE(m.remote_invite_id, '') = ''
          OR s.remote_invite_id = m.remote_invite_id
        )
    ),
    exact_matched_cdk_tasks AS (
      SELECT DISTINCT task_id
      FROM exact_known_sources
    ),
    ranked_unmatched_items AS (
      SELECT
        m.*,
        ROW_NUMBER() OVER (
          PARTITION BY m.email_key
          ORDER BY
            datetime(COALESCE(NULLIF(m.joined_at, ''), NULLIF(m.invited_at, ''), m.last_synced_at, '1970-01-01')) ASC,
            m.item_type ASC,
            m.id ASC
        ) AS source_rank
      FROM untracked_items m
      LEFT JOIN exact_known_sources exact
        ON exact.item_type = m.item_type
       AND exact.id = m.id
      WHERE exact.task_id IS NULL
        AND COALESCE(m.email_key, '') != ''
    ),
    ranked_remaining_cdk_tasks AS (
      SELECT
        s.*,
        ROW_NUMBER() OVER (
          PARTITION BY s.email_key
          ORDER BY datetime(COALESCE(NULLIF(s.source_at, ''), '1970-01-01')) ASC, s.source_priority ASC, s.task_id ASC
        ) AS source_rank
      FROM (
        SELECT DISTINCT task_id, email_key, source_priority, source_at
        FROM raw_cdk_sources
        WHERE COALESCE(email_key, '') != ''
          AND COALESCE(workspace_key, '') = ''
      ) s
      LEFT JOIN exact_matched_cdk_tasks used ON used.task_id = s.task_id
      WHERE used.task_id IS NULL
    ),
    fallback_known_sources AS (
      SELECT
        m.item_type,
        m.id,
        s.task_id
      FROM ranked_unmatched_items m
      JOIN ranked_remaining_cdk_tasks s
        ON s.email_key = m.email_key
       AND s.source_rank = m.source_rank
    ),
    known_cdk_sources AS (
      SELECT DISTINCT item_type, id FROM exact_known_sources
      UNION
      SELECT DISTINCT item_type, id FROM fallback_known_sources
    )
  `;

  const fromSql = `
    FROM untracked_items m
    LEFT JOIN known_cdk_sources cs
      ON cs.item_type = m.item_type
     AND cs.id = m.id
    WHERE cs.id IS NULL
      ${searchWhere}
  `;

  return { sourceCte, fromSql, params, normalizedSearch };
}

function getUntrackedMembers(filters = {}) {
  const { sourceCte, fromSql, params, normalizedSearch } = buildUntrackedMemberQuery(filters);
  const count = db.prepare(`${sourceCte} SELECT COUNT(*) AS count ${fromSql}`).get(...params)?.count || 0;
  const items = db.prepare(`
    ${sourceCte}
    SELECT
      m.*,
      CASE
        WHEN m.item_type = 'pending' THEN '没有匹配到有效 CDK 激活来源；待邀请应撤销'
        ELSE '没有匹配到有效 CDK 激活来源；成员应移出'
      END AS source_message
    ${fromSql}
    ORDER BY
      datetime(COALESCE(NULLIF(m.invited_at, ''), NULLIF(m.joined_at, ''), m.last_synced_at)) DESC,
      LOWER(m.email) ASC,
      m.workspace_name ASC
  `).all(...params);

  return {
    filters: { search: normalizedSearch },
    summary: {
      total: count,
      members: items.filter(item => item.item_type !== 'pending').length,
      pending: items.filter(item => item.item_type === 'pending').length,
      removable_members: items.filter(item => item.item_type !== 'pending' && canHandleItem(item)).length,
      revocable_pending: items.filter(item => item.item_type === 'pending' && canHandleItem(item)).length,
      workspaces: new Set(items.map(item => item.workspace_id).filter(Boolean)).size,
      accounts: new Set(items.map(item => item.account_id).filter(Boolean)).size,
    },
    items,
  };
}

function markMemberRemoved(item) {
  db.prepare(`
    UPDATE workspace_members
    SET deactivated_time = datetime('now'),
        last_synced_at = datetime('now')
    WHERE id = ?
  `).run(item.id);
}

function markPendingInviteRevoked(item) {
  db.prepare(`
    DELETE FROM workspace_pending_invites
    WHERE id = ?
  `).run(item.id);
}

function groupItemsByWorkspace(items = []) {
  const groups = new Map();

  for (const item of items) {
    const key = `${item.account_id || 0}:${item.workspace_id || ''}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(item);
  }

  return Array.from(groups.values());
}

function logCleanup(accountId, message) {
  db.prepare(`
    INSERT INTO check_logs (account_id, status, message)
    VALUES (?, ?, ?)
  `).run(accountId, 'active', message);
}

async function removeUntrackedMember(item, options = {}) {
  if (!canHandleItem(item) || item.item_type === 'pending') {
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
      item_type: 'member',
      email: item.email || '',
      workspace_id: item.workspace_id || '',
      workspace_name: item.workspace_name || '',
      account_id: item.account_id,
      account_email: item.account_email || '',
      message: result.message || 'Remove member failed',
    };
  }

  markMemberRemoved(item);
  logCleanup(
    item.account_id,
    `[untracked-member-auto-kick] ${item.email || item.user_id} from ${item.workspace_name || item.workspace_id || '-'}`
  );

  return {
    success: true,
    item_type: 'member',
    email: item.email || '',
    workspace_row_id: item.workspace_row_id || 0,
    workspace_id: item.workspace_id || '',
    workspace_name: item.workspace_name || '',
    account_id: item.account_id,
    account_email: item.account_email || '',
    message: 'Removed member',
  };
}

async function removeUntrackedMembersWithSharedPages(members) {
  const results = [];
  const workspaceRows = new Set();
  let removed = 0;
  let failed = 0;

  await runWithConcurrency(groupItemsByWorkspace(members), getCleanupWorkspaceConcurrency(), async group => {
    const first = group[0];
    const account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(first.account_id);

    if (!account?.access_token) {
      for (const member of group) {
        failed += 1;
        results.push({
          success: false,
          item_type: 'member',
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
            item_type: 'member',
            email: item.email || '',
            message: item.message || 'Member not found after remove',
          });
          continue;
        }

        if (item.success) {
          markMemberRemoved(member);
          logCleanup(
            member.account_id,
            `[untracked-member-auto-kick] ${member.email || member.user_id} from ${member.workspace_name || member.workspace_id || '-'}`
          );
          removed += 1;
          if (member.workspace_row_id) {
            workspaceRows.add(Number(member.workspace_row_id));
          }
          results.push({
            success: true,
            item_type: 'member',
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
            item_type: 'member',
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
          item_type: 'member',
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

async function revokeUntrackedPendingInvitesWithSharedPages(invites) {
  const results = [];
  const workspaceRows = new Set();
  let revoked = 0;
  let failed = 0;

  await runWithConcurrency(groupItemsByWorkspace(invites), getCleanupWorkspaceConcurrency(), async group => {
    const first = group[0];
    const account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(first.account_id);

    if (!account?.access_token) {
      for (const invite of group) {
        failed += 1;
        results.push({
          success: false,
          item_type: 'pending',
          email: invite.email || '',
          workspace_id: invite.workspace_id || '',
          workspace_name: invite.workspace_name || '',
          account_id: invite.account_id,
          account_email: invite.account_email || '',
          message: 'Account is not authorized, cannot revoke pending invite',
        });
      }
      return;
    }

    try {
      await workspaceMembers.withWorkspacePage(async page => {
      for (const invite of group) {
        const result = await workspaceMembers.revokePendingInvite(account, {
          email: invite.email || '',
          remoteInviteId: invite.remote_invite_id || '',
          workspaceId: invite.workspace_id || '',
          workspaceName: invite.workspace_name || invite.workspace_id || '',
          planType: invite.plan_type || '',
        }, {
          workspaceId: invite.workspace_id || '',
          workspaceName: invite.workspace_name || invite.workspace_id || '',
          planType: invite.plan_type || '',
          page,
        });

        if (result.success) {
          markPendingInviteRevoked(invite);
          logCleanup(
            invite.account_id,
            `[untracked-pending-invite-auto-revoke] ${invite.email || '-'} from ${invite.workspace_name || invite.workspace_id || '-'}`
          );
          revoked += 1;
          if (invite.workspace_row_id) {
            workspaceRows.add(Number(invite.workspace_row_id));
          }
          results.push({
            success: true,
            item_type: 'pending',
            email: invite.email || '',
            workspace_row_id: invite.workspace_row_id || 0,
            workspace_id: invite.workspace_id || '',
            workspace_name: invite.workspace_name || '',
            account_id: invite.account_id,
            account_email: invite.account_email || '',
            message: result.found === false ? 'Pending invite no longer exists' : 'Revoked pending invite',
          });
        } else {
          failed += 1;
          results.push({
            success: false,
            item_type: 'pending',
            email: invite.email || '',
            workspace_id: invite.workspace_id || '',
            workspace_name: invite.workspace_name || '',
            account_id: invite.account_id,
            account_email: invite.account_email || '',
            message: result.message || 'Revoke pending invite failed',
          });
        }
      }
      });
    } catch (err) {
      for (const invite of group) {
        failed += 1;
        results.push({
          success: false,
          item_type: 'pending',
          email: invite.email || '',
          workspace_id: invite.workspace_id || '',
          workspace_name: invite.workspace_name || '',
          account_id: invite.account_id,
          account_email: invite.account_email || '',
          message: err.message || 'Revoke pending invite failed',
        });
      }
    }
  });

  return { results, revoked, failed, workspaceRows };
}

async function autoKickUntrackedMembers(options = {}) {
  if (!isAutoKickEnabled()) {
    return {
      enabled: false,
      success: true,
      removed: 0,
      revoked: 0,
      failed: 0,
      results: [],
    };
  }

  const limit = Math.max(1, Math.min(Number(options.limit || DEFAULT_LIMIT) || DEFAULT_LIMIT, 500));
  const data = getUntrackedMembers({});
  const candidates = data.items
    .filter(canHandleItem)
    .slice(0, limit);
  const members = candidates.filter(item => item.item_type !== 'pending');
  const pendingInvites = candidates.filter(item => item.item_type === 'pending');

  const memberResult = members.length > 0
    ? await removeUntrackedMembersWithSharedPages(members)
    : { results: [], removed: 0, failed: 0, workspaceRows: new Set() };
  const pendingResult = pendingInvites.length > 0
    ? await revokeUntrackedPendingInvitesWithSharedPages(pendingInvites)
    : { results: [], revoked: 0, failed: 0, workspaceRows: new Set() };

  const workspaceRows = new Set([
    ...memberResult.workspaceRows,
    ...pendingResult.workspaceRows,
  ]);

  await runWithConcurrency(Array.from(workspaceRows), getCleanupSyncConcurrency(), async workspaceRowId => {
    await workspaceSync.syncWorkspaceByRowId(workspaceRowId).catch(err => {
      console.warn(`[UntrackedMemberCleanup] sync workspace ${workspaceRowId} failed after auto cleanup:`, err.message);
    });
  });

  const removed = memberResult.removed || 0;
  const revoked = pendingResult.revoked || 0;
  const failed = (memberResult.failed || 0) + (pendingResult.failed || 0);
  const results = [...memberResult.results, ...pendingResult.results];

  if (removed > 0 || revoked > 0 || failed > 0) {
    console.log(`[UntrackedMemberCleanup] auto cleanup complete: removed=${removed}, revoked=${revoked}, failed=${failed}`);
  }

  return {
    enabled: true,
    success: failed === 0,
    scanned: data.summary.total,
    removable: members.length,
    revocable: pendingInvites.length,
    removed,
    revoked,
    failed,
    results,
  };
}

module.exports = {
  SETTING_KEY,
  isAutoKickEnabled,
  getUntrackedMembers,
  removeUntrackedMember,
  autoKickUntrackedMembers,
};
