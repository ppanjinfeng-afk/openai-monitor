const db = require('../db');
const workspaceMembers = require('./workspace-members');
const workspaceSync = require('./workspace-sync');

const SETTING_KEY = 'untracked_members_auto_kick_enabled';
const DEFAULT_LIMIT = 100;

function isAutoKickEnabled() {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(SETTING_KEY);
  return row?.value === 'true';
}

function normalizeSearch(value) {
  return String(value || '').trim().toLowerCase();
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
    WITH active_members AS (
      SELECT
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
    ),
    known_sources AS (
      SELECT DISTINCT LOWER(TRIM(assigned_email)) AS email_key
      FROM cdk_cards
      WHERE COALESCE(assigned_email, '') != ''
      UNION
      SELECT DISTINCT LOWER(TRIM(buyer_email)) AS email_key
      FROM cdk_cards
      WHERE COALESCE(buyer_email, '') != ''
      UNION
      SELECT DISTINCT LOWER(TRIM(target_email)) AS email_key
      FROM cdk_order_items
      WHERE COALESCE(target_email, '') != ''
      UNION
      SELECT DISTINCT LOWER(TRIM(account_email)) AS email_key
      FROM cdk_tasks
      WHERE COALESCE(account_email, '') != ''
      UNION
      SELECT DISTINCT LOWER(TRIM(target_email)) AS email_key
      FROM invites
      WHERE COALESCE(target_email, '') != ''
        AND COALESCE(status, '') != 'error'
        AND COALESCE(failure_category, '') = ''
    )
  `;

  const fromSql = `
    FROM active_members m
    LEFT JOIN known_sources s ON s.email_key = m.email_key
    WHERE s.email_key IS NULL
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
      '没有匹配到 CDK、订单、激活任务或平台邀请记录' AS source_message
    ${fromSql}
    ORDER BY datetime(m.joined_at) DESC, LOWER(m.email) ASC, m.workspace_name ASC
  `).all(...params);

  return {
    filters: { search: normalizedSearch },
    summary: {
      total: count,
      members: items.length,
      removable_members: items.filter(item => !Number(item.is_owner || 0) && item.account_id && item.user_id).length,
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

async function removeUntrackedMember(item, options = {}) {
  if (!item?.account_id || !item?.user_id || Number(item.is_owner || 0) === 1) {
    return {
      success: false,
      email: item?.email || '',
      message: '成员不可移出',
    };
  }

  const account = options.account || db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(item.account_id);
  if (!account?.access_token) {
    return {
      success: false,
      email: item.email || '',
      message: '账号未授权，无法移出成员',
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
      message: result.message || '移出成员失败',
    };
  }

  markMemberRemoved(item);
  db.prepare(`
    INSERT INTO check_logs (account_id, status, message)
    VALUES (?, ?, ?)
  `).run(
    item.account_id,
    'active',
    `[untracked-member-auto-kick] ${item.email || item.user_id} from ${item.workspace_name || item.workspace_id || '-'}`
  );

  return {
    success: true,
    email: item.email || '',
    workspace_row_id: item.workspace_row_id || 0,
    workspace_id: item.workspace_id || '',
    workspace_name: item.workspace_name || '',
    account_id: item.account_id,
    account_email: item.account_email || '',
    message: '已移出成员',
  };
}

async function removeUntrackedMembersWithSharedPages(members) {
  const results = [];
  const workspaceRows = new Set();
  let removed = 0;
  let failed = 0;

  for (const group of groupMembersForRemoval(members)) {
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
      continue;
    }

    await workspaceMembers.withWorkspacePage(async page => {
      for (const member of group) {
        try {
          const result = await removeUntrackedMember(member, { account, page });
          results.push(result);
          if (result.success) {
            removed += 1;
            if (result.workspace_row_id) {
              workspaceRows.add(Number(result.workspace_row_id));
            }
          } else {
            failed += 1;
          }
        } catch (err) {
          failed += 1;
          results.push({
            success: false,
            email: member.email || '',
            workspace_id: member.workspace_id || '',
            workspace_name: member.workspace_name || '',
            account_id: member.account_id,
            account_email: member.account_email || '',
            message: err.message,
          });
        }
      }
    });
  }

  return { results, removed, failed, workspaceRows };
}

async function autoKickUntrackedMembers(options = {}) {
  if (!isAutoKickEnabled()) {
    return {
      enabled: false,
      success: true,
      removed: 0,
      failed: 0,
      results: [],
    };
  }

  const limit = Math.max(1, Math.min(Number(options.limit || DEFAULT_LIMIT) || DEFAULT_LIMIT, 500));
  const data = getUntrackedMembers({});
  const members = data.items
    .filter(item => !Number(item.is_owner || 0) && item.account_id && item.user_id)
    .slice(0, limit);

  const { results, removed, failed, workspaceRows } = await removeUntrackedMembersWithSharedPages(members);

  for (const workspaceRowId of workspaceRows) {
    await workspaceSync.syncWorkspaceByRowId(workspaceRowId).catch(err => {
      console.warn(`[UntrackedMemberCleanup] sync workspace ${workspaceRowId} failed after auto kick:`, err.message);
    });
  }

  if (removed > 0 || failed > 0) {
    console.log(`[UntrackedMemberCleanup] auto kick complete: removed=${removed}, failed=${failed}`);
  }

  return {
    enabled: true,
    success: failed === 0,
    scanned: data.summary.total,
    removable: members.length,
    removed,
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
