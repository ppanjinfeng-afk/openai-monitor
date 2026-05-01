const db = require('../db');
const { withBrowserPage } = require('./browser');
const { listAccountWorkspaces } = require('./account-workspaces');
const { buildStrictCdkSourceAssignments, makeAssignmentKey } = require('./cdk-source');
const WORKSPACE_MEMBER_LIMIT = 8;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeConcurrency(value, fallback = 2, max = 4) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.max(1, Math.min(Math.floor(parsed), max));
}

function getWorkspaceSyncConcurrency() {
  return normalizeConcurrency(
    process.env.WORKSPACE_SYNC_CONCURRENCY || process.env.SYNC_CONCURRENCY,
    2,
    4
  );
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function csvEscape(value) {
  const text = String(value == null ? '' : value);
  if (!text.includes('"') && !text.includes(',') && !text.includes('\n')) {
    return text;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function computeHealthScore(account, snapshot, recentErrorCount) {
  let score = 100;

  if (!account.access_token) score -= 40;
  if (account.status !== 'active') score -= 55;
  if (!snapshot.success) score -= 35;

  const projectedRemaining = Number(snapshot.projectedRemainingSeats || 0);
  if (projectedRemaining < 0) {
    score -= 25;
  } else if (projectedRemaining === 0) {
    score -= 15;
  } else if (projectedRemaining <= 1) {
    score -= 8;
  }

  score -= Math.min(Number(recentErrorCount || 0) * 6, 30);
  score = Math.max(0, Math.min(100, score));

  let label = '故障';
  if (score >= 85) label = '优秀';
  else if (score >= 65) label = '稳定';
  else if (score >= 40) label = '风险';

  return { score, label };
}

async function withWorkspacePage(work) {
  return withBrowserPage(work);
}

async function fetchWorkspaceSnapshot(page, account, workspace) {
  return page.evaluate(async ({ accessToken, workspaceId }) => {
    const getHeaders = extraHeaders => ({
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'OAI-Language': 'en-US',
      'ChatGPT-Account-Id': workspaceId,
      ...extraHeaders,
    });

    const parseResponse = async response => {
      const text = await response.text();
      try {
        return { text, data: JSON.parse(text) };
      } catch {
        return { text, data: null };
      }
    };

    const extractErrorMessage = (payload, fallbackText, status) => {
      const candidates = [
        payload?.error_description,
        payload?.message,
        payload?.detail,
        payload?.error?.message,
        payload?.error,
      ];

      for (const candidate of candidates) {
        if (candidate == null) continue;
        if (typeof candidate === 'string' && candidate.trim()) {
          return candidate.trim();
        }

        try {
          const json = JSON.stringify(candidate);
          if (json && json !== 'null') {
            return json;
          }
        } catch {}
      }

      return fallbackText || `HTTP ${status}`;
    };

    const fetchUsers = async () => {
      const limit = 100;
      let offset = 0;
      let total = 0;
      const members = [];

      while (true) {
        const response = await fetch(
          `https://chatgpt.com/backend-api/accounts/${workspaceId}/users?limit=${limit}&offset=${offset}&query=`,
          { headers: getHeaders() }
        );
        const parsed = await parseResponse(response);

        if (!response.ok) {
          return {
            success: false,
            message: `获取成员失败 (HTTP ${response.status}): ${extractErrorMessage(parsed.data, parsed.text, response.status)}`,
          };
        }

        const items = Array.isArray(parsed.data?.items) ? parsed.data.items : [];
        total = Number(parsed.data?.total || items.length || 0);
        members.push(...items.map(item => ({
          user_id: item?.id || '',
          account_user_id: item?.account_user_id || '',
          email: item?.email || '',
          name: item?.name || '',
          role: item?.role || '',
          seat_type: item?.seat_type || '',
          is_owner: item?.role === 'account-owner',
          deactivated_time: item?.deactivated_time || '',
          joined_at: item?.created_time || '',
        })));

        offset += items.length;
        if (items.length === 0 || offset >= total) {
          break;
        }
      }

      return { success: true, members, total };
    };

    const fetchInvites = async () => {
      const limit = 100;
      let offset = 0;
      let total = 0;
      const invites = [];

      while (true) {
        const response = await fetch(
          `https://chatgpt.com/backend-api/accounts/${workspaceId}/invites?limit=${limit}&offset=${offset}&query=`,
          { headers: getHeaders() }
        );
        const parsed = await parseResponse(response);

        if (!response.ok) {
          return {
            success: false,
            message: `获取待邀请失败 (HTTP ${response.status}): ${extractErrorMessage(parsed.data, parsed.text, response.status)}`,
          };
        }

        const items = Array.isArray(parsed.data?.items) ? parsed.data.items : [];
        total = Number(parsed.data?.total || items.length || 0);
        invites.push(...items.map(item => ({
          remote_invite_id: item?.id || '',
          email: item?.email_address || '',
          invited_at: item?.created_time || item?.created_at || '',
        })));

        offset += items.length;
        if (items.length === 0 || offset >= total) {
          break;
        }
      }

      return { success: true, invites, total };
    };

    const usersResult = await fetchUsers();
    if (!usersResult.success) {
      return usersResult;
    }

    const invitesResult = await fetchInvites();
    if (!invitesResult.success) {
      return invitesResult;
    }

    const occupiedSeats = usersResult.members.filter(member => member.seat_type === 'default' && !member.deactivated_time).length;

    return {
      success: true,
      members: usersResult.members,
      pendingInvites: invitesResult.invites,
      memberCount: usersResult.total,
      occupiedSeats,
      pendingInviteCount: invitesResult.total,
    };
  }, {
    accessToken: account.access_token,
    workspaceId: workspace.id,
  });
}

function getRecentErrorCount(accountId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM check_logs
    WHERE account_id = ?
      AND status = 'error'
      AND checked_at >= datetime('now', '-7 days')
  `).get(accountId);

  return Number(row?.count || 0);
}

function shouldAutoInviteLock({ inviteTotal, occupiedSeats, pendingInvites }) {
  const totalSeats = Number(inviteTotal || 0);
  const reservedSeats = Number(occupiedSeats || 0) + Number(pendingInvites || 0);

  return totalSeats <= 0
    || reservedSeats >= WORKSPACE_MEMBER_LIMIT;
}

function isWorkspaceGoneMessage(message) {
  const normalized = String(message || '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized.includes('deactivated_workspace')
    || normalized.includes('workspace_not_found')
    || normalized.includes('no_workspace_found')
    || normalized.includes('workspace not found')
    || normalized.includes('no workspace found')
    || normalized.includes('deactivated workspace')
    || (normalized.includes('http 404') && normalized.includes('workspace'))
    || (normalized.includes('http 402') && normalized.includes('workspace'))
  );
}

function upsertWorkspace(account, workspace, snapshot, syncMessage = '') {
  const inviteTotal = Number(account.invite_total || 0);
  const occupiedSeats = Number(snapshot.occupiedSeats || 0);
  const pendingInvites = Number(snapshot.pendingInviteCount || 0);
  const memberCount = Number(snapshot.memberCount || 0);
  const remainingSeats = inviteTotal - occupiedSeats;
  const projectedRemainingSeats = inviteTotal - occupiedSeats - pendingInvites;
  const autoInviteLocked = shouldAutoInviteLock({
    inviteTotal,
    occupiedSeats,
    pendingInvites,
  }) ? 1 : 0;
  const recentErrorCount = getRecentErrorCount(account.id);
  const health = computeHealthScore(account, {
    success: snapshot.success,
    projectedRemainingSeats,
  }, recentErrorCount);

  db.prepare(`
    INSERT INTO workspaces (
      account_id,
      workspace_id,
      workspace_name,
      plan_type,
      member_count,
      occupied_seats,
      pending_invites,
      invite_total_hint,
      remaining_seats,
      projected_remaining_seats,
      sync_status,
      sync_message,
      last_synced_at,
      health_score,
      health_label,
      recent_error_count,
      auto_invite_locked,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(account_id, workspace_id) DO UPDATE SET
      workspace_name = excluded.workspace_name,
      plan_type = excluded.plan_type,
      member_count = excluded.member_count,
      occupied_seats = excluded.occupied_seats,
      pending_invites = excluded.pending_invites,
      invite_total_hint = excluded.invite_total_hint,
      remaining_seats = excluded.remaining_seats,
      projected_remaining_seats = excluded.projected_remaining_seats,
      sync_status = excluded.sync_status,
      sync_message = excluded.sync_message,
      last_synced_at = excluded.last_synced_at,
      health_score = excluded.health_score,
      health_label = excluded.health_label,
      recent_error_count = excluded.recent_error_count,
      auto_invite_locked = excluded.auto_invite_locked,
      updated_at = datetime('now')
  `).run(
    account.id,
    workspace.id,
    workspace.name || workspace.id,
    workspace.plan_type || '',
    memberCount,
    occupiedSeats,
    pendingInvites,
    inviteTotal,
    remainingSeats,
    projectedRemainingSeats,
    snapshot.success ? 'success' : 'error',
    syncMessage || '',
    nowIso(),
    health.score,
    health.label,
    recentErrorCount
    ,
    autoInviteLocked
  );

  return db.prepare(`
    SELECT *
    FROM workspaces
    WHERE account_id = ?
      AND workspace_id = ?
  `).get(account.id, workspace.id);
}

function upsertWorkspaceError(account, workspace, message) {
  const recentErrorCount = getRecentErrorCount(account.id);
  const health = computeHealthScore(account, {
    success: false,
    projectedRemainingSeats: 0,
  }, recentErrorCount);

  db.prepare(`
    INSERT INTO workspaces (
      account_id,
      workspace_id,
      workspace_name,
      plan_type,
      member_count,
      occupied_seats,
      pending_invites,
      invite_total_hint,
      remaining_seats,
      projected_remaining_seats,
      sync_status,
      sync_message,
      last_synced_at,
      health_score,
      health_label,
      recent_error_count,
      updated_at
    ) VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, ?, 'error', ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(account_id, workspace_id) DO UPDATE SET
      workspace_name = excluded.workspace_name,
      plan_type = excluded.plan_type,
      invite_total_hint = excluded.invite_total_hint,
      remaining_seats = excluded.remaining_seats,
      projected_remaining_seats = excluded.projected_remaining_seats,
      sync_status = 'error',
      sync_message = excluded.sync_message,
      last_synced_at = excluded.last_synced_at,
      health_score = excluded.health_score,
      health_label = excluded.health_label,
      recent_error_count = excluded.recent_error_count,
      updated_at = datetime('now')
  `).run(
    account.id,
    workspace.id,
    workspace.name || workspace.id,
    workspace.plan_type || '',
    Number(account.invite_total || 0),
    Number(account.invite_total || 0),
    Number(account.invite_total || 0),
    message || '',
    nowIso(),
    health.score,
    health.label,
    recentErrorCount
  );
}

function replaceWorkspaceMembers(account, workspaceId, members) {
  const remove = db.prepare(`
    DELETE FROM workspace_members
    WHERE account_id = ?
      AND workspace_id = ?
  `);
  const insert = db.prepare(`
    INSERT INTO workspace_members (
      account_id,
      workspace_id,
      user_id,
      account_user_id,
      email,
      name,
      role,
      seat_type,
      is_owner,
      deactivated_time,
      joined_at,
      source_cdk_task_id,
      source_cdk_id,
      source_cdk_code,
      last_synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const sourceRows = members.map((member, index) => ({
    item_type: 'member',
    id: `sync-member-${workspaceId}-${index}`,
    workspace_id: workspaceId,
    email: member.email || '',
    remote_invite_id: '',
    joined_at: member.joined_at || '',
    invited_at: '',
    last_synced_at: '',
  }));
  const sourceAssignments = buildStrictCdkSourceAssignments(sourceRows);

  const transact = db.transaction(() => {
    remove.run(account.id, workspaceId);
    for (const [index, member] of members.entries()) {
      const source = sourceAssignments.get(makeAssignmentKey(sourceRows[index]));

      insert.run(
        account.id,
        workspaceId,
        member.user_id || '',
        member.account_user_id || '',
        member.email || '',
        member.name || '',
        member.role || '',
        member.seat_type || '',
        member.is_owner ? 1 : 0,
        member.deactivated_time || '',
        member.joined_at || '',
        source?.source_cdk_task_id || '',
        source?.source_cdk_id ?? null,
        source?.source_cdk_code || '',
        nowIso()
      );
    }
  });

  transact();
}

function replaceWorkspacePendingInvites(account, workspaceId, pendingInvites) {
  const remove = db.prepare(`
    DELETE FROM workspace_pending_invites
    WHERE account_id = ?
      AND workspace_id = ?
  `);
  const insert = db.prepare(`
    INSERT INTO workspace_pending_invites (
      account_id,
      workspace_id,
      remote_invite_id,
      email,
      invited_at,
      source_cdk_task_id,
      source_cdk_id,
      source_cdk_code,
      last_synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const sourceRows = pendingInvites.map((invite, index) => ({
    item_type: 'pending',
    id: `sync-pending-${workspaceId}-${index}`,
    workspace_id: workspaceId,
    email: invite.email || '',
    remote_invite_id: invite.remote_invite_id || '',
    joined_at: '',
    invited_at: invite.invited_at || '',
    last_synced_at: '',
  }));
  const sourceAssignments = buildStrictCdkSourceAssignments(sourceRows);

  const transact = db.transaction(() => {
    remove.run(account.id, workspaceId);
    for (const [index, invite] of pendingInvites.entries()) {
      const source = sourceAssignments.get(makeAssignmentKey(sourceRows[index]));

      insert.run(
        account.id,
        workspaceId,
        invite.remote_invite_id || '',
        invite.email || '',
        invite.invited_at || '',
        source?.source_cdk_task_id || '',
        source?.source_cdk_id ?? null,
        source?.source_cdk_code || '',
        nowIso()
      );
    }
  });

  transact();
}

function removeMissingWorkspaceSnapshots(accountId, workspaceIds = []) {
  const placeholders = workspaceIds.map(() => '?').join(',');
  const params = [accountId, ...workspaceIds];

  if (workspaceIds.length === 0) {
    db.prepare(`DELETE FROM workspace_members WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM workspace_pending_invites WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM workspaces WHERE account_id = ?`).run(accountId);
    db.prepare(`
      UPDATE accounts
      SET quota_workspace_id = '',
          quota_workspace_name = '',
          updated_at = datetime('now')
      WHERE id = ?
        AND COALESCE(quota_workspace_id, '') != ''
    `).run(accountId);
    return;
  }

  db.prepare(`
    DELETE FROM workspace_members
    WHERE account_id = ?
      AND workspace_id NOT IN (${placeholders})
  `).run(...params);

  db.prepare(`
    DELETE FROM workspace_pending_invites
    WHERE account_id = ?
      AND workspace_id NOT IN (${placeholders})
  `).run(...params);

  db.prepare(`
    DELETE FROM workspaces
    WHERE account_id = ?
      AND workspace_id NOT IN (${placeholders})
  `).run(...params);

  db.prepare(`
    UPDATE accounts
    SET quota_workspace_id = '',
        quota_workspace_name = '',
        updated_at = datetime('now')
    WHERE id = ?
      AND COALESCE(quota_workspace_id, '') != ''
      AND COALESCE(quota_workspace_id, '') NOT IN (${placeholders})
  `).run(...params);
}

function removeWorkspaceSnapshot(accountId, workspaceId) {
  if (!accountId || !workspaceId) {
    return;
  }

  const transact = db.transaction(() => {
    db.prepare(`
      DELETE FROM workspace_members
      WHERE account_id = ?
        AND workspace_id = ?
    `).run(accountId, workspaceId);

    db.prepare(`
      DELETE FROM workspace_pending_invites
      WHERE account_id = ?
        AND workspace_id = ?
    `).run(accountId, workspaceId);

    db.prepare(`
      DELETE FROM workspaces
      WHERE account_id = ?
        AND workspace_id = ?
    `).run(accountId, workspaceId);

    db.prepare(`
      UPDATE accounts
      SET quota_workspace_id = '',
          quota_workspace_name = '',
          updated_at = datetime('now')
      WHERE id = ?
        AND COALESCE(quota_workspace_id, '') = ?
    `).run(accountId, workspaceId);
  });

  transact();
}

function reconcileInviteRecords(account, workspaceId, snapshot) {
  const seenAt = nowIso();
  const memberEmails = new Set(
    (snapshot.members || [])
      .map(member => normalizeEmail(member.email))
      .filter(Boolean)
  );
  const pendingMap = new Map(
    (snapshot.pendingInvites || [])
      .map(item => [normalizeEmail(item.email), item])
      .filter(([email]) => Boolean(email))
  );

  const invites = db.prepare(`
    SELECT *
    FROM invites
    WHERE account_id = ?
      AND COALESCE(workspace_id, '') = ?
  `).all(account.id, workspaceId);

  const setAccepted = db.prepare(`
    UPDATE invites
    SET status = 'accepted',
        remote_state = 'member',
        remote_last_seen_at = ?,
        failure_category = '',
        updated_at = datetime('now')
    WHERE id = ?
  `);
  const setPending = db.prepare(`
    UPDATE invites
    SET status = 'sent',
        remote_state = 'pending',
        remote_last_seen_at = ?,
        remote_invite_id = CASE
          WHEN COALESCE(remote_invite_id, '') = '' THEN ?
          ELSE remote_invite_id
        END,
        failure_category = '',
        updated_at = datetime('now')
    WHERE id = ?
  `);
  const setMissing = db.prepare(`
    UPDATE invites
    SET remote_state = 'missing',
        remote_last_seen_at = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `);

  const transact = db.transaction(() => {
    for (const invite of invites) {
      const email = normalizeEmail(invite.target_email);
      if (!email) continue;

      if (memberEmails.has(email)) {
        setAccepted.run(seenAt, invite.id);
        continue;
      }

      if (pendingMap.has(email)) {
        const pending = pendingMap.get(email);
        setPending.run(seenAt, pending.remote_invite_id || '', invite.id);
        continue;
      }

      setMissing.run(seenAt, invite.id);
    }
  });

  transact();
}

async function syncAccountWorkspacesWithPage(page, account) {
  const discovery = await listAccountWorkspaces(account, { page });
  if (!discovery.success) {
    if (discovery.code === 'no_workspace_found') {
      removeMissingWorkspaceSnapshots(account.id, []);
    }
    return {
      success: false,
      accountId: account.id,
      email: account.email,
      message: discovery.message,
    };
  }

  const results = [];

  for (const workspace of discovery.workspaces || []) {
    const snapshot = await fetchWorkspaceSnapshot(page, account, workspace);
    if (!snapshot.success) {
      if (isWorkspaceGoneMessage(snapshot.message)) {
        removeWorkspaceSnapshot(account.id, workspace.id);

        results.push({
          success: true,
          removed: true,
          accountId: account.id,
          accountEmail: account.email,
          workspaceId: workspace.id,
          workspaceName: workspace.name || workspace.id,
          message: snapshot.message,
        });
        continue;
      }

      upsertWorkspaceError(account, workspace, snapshot.message);

      results.push({
        success: false,
        accountId: account.id,
        accountEmail: account.email,
        workspaceId: workspace.id,
        workspaceName: workspace.name || workspace.id,
        message: snapshot.message,
      });
      continue;
    }

    const workspaceRow = upsertWorkspace(account, workspace, snapshot);
    reconcileInviteRecords(account, workspace.id, snapshot);
    replaceWorkspaceMembers(account, workspace.id, snapshot.members || []);
    replaceWorkspacePendingInvites(account, workspace.id, snapshot.pendingInvites || []);

    results.push({
      success: true,
      workspaceRowId: workspaceRow.id,
      accountId: account.id,
      accountEmail: account.email,
      workspaceId: workspace.id,
      workspaceName: workspace.name || workspace.id,
      memberCount: Number(snapshot.memberCount || 0),
      occupiedSeats: Number(snapshot.occupiedSeats || 0),
      pendingInvites: Number(snapshot.pendingInviteCount || 0),
      remainingSeats: workspaceRow.remaining_seats,
      projectedRemainingSeats: workspaceRow.projected_remaining_seats,
      healthScore: workspaceRow.health_score,
    });
  }

  removeMissingWorkspaceSnapshots(account.id, (discovery.workspaces || []).map(item => item.id));

  return {
    success: true,
    accountId: account.id,
    email: account.email,
    workspaceCount: discovery.workspaces?.length || 0,
    results,
  };
}

async function syncAccountWorkspaces(account, options = {}) {
  if (!account || !account.access_token || account.status !== 'active') {
    if (account?.id) {
      removeMissingWorkspaceSnapshots(account.id, []);
    }
    return {
      success: false,
      skipped: true,
      removed: true,
      accountId: account?.id || null,
      email: account?.email || '',
      message: '账号未授权或不处于活跃状态',
    };
  }

  if (options.page) {
    return syncAccountWorkspacesWithPage(options.page, account);
  }

  return withWorkspacePage(page => syncAccountWorkspacesWithPage(page, account));
}

async function syncAllWorkspaceSnapshots() {
  const accounts = db.prepare(`
    SELECT *
    FROM accounts
    ORDER BY id ASC
  `).all();

  if (accounts.length === 0) {
    return [];
  }

  const results = [];
  let nextIndex = 0;
  const workerCount = Math.min(getWorkspaceSyncConcurrency(), accounts.length);

  const workers = Array.from({ length: workerCount }, () => withWorkspacePage(async page => {
    while (true) {
      const account = accounts[nextIndex];
      nextIndex += 1;

      if (!account) {
        break;
      }

      try {
        if (account.status === 'active' && account.access_token) {
          results.push(await syncAccountWorkspacesWithPage(page, account));
        } else {
          results.push(await syncAccountWorkspaces(account, { page }));
        }
      } catch (err) {
        results.push({
          success: false,
          accountId: account.id,
          email: account.email,
          message: err.message,
        });
      }

      await sleep(150);
    }
  }));

  await Promise.all(workers);
  return results;
}

async function syncWorkspaceByRowId(rowId) {
  const workspaceRow = db.prepare(`
    SELECT w.*
    FROM workspaces w
    WHERE w.id = ?
  `).get(rowId);

  if (!workspaceRow) {
    throw new Error('Workspace not found');
  }

  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(workspaceRow.account_id);
  const result = await syncAccountWorkspaces(account);
  if (!result.success) {
    return result;
  }

  const match = (result.results || []).find(item => item.workspaceId === workspaceRow.workspace_id);
  if (!match) {
    return {
      success: false,
      message: '指定工作区未在本次同步结果中返回',
    };
  }

  return {
    success: true,
    ...match,
  };
}

async function syncWorkspaceByRowIdSafe(rowId) {
  const result = await syncWorkspaceByRowId(rowId);
  if (result?.success) {
    return result;
  }

  const workspaceRow = db.prepare(`
    SELECT w.*, a.email AS account_email
    FROM workspaces w
    JOIN accounts a ON a.id = w.account_id
    WHERE w.id = ?
  `).get(rowId);

  if (workspaceRow) {
    return result;
  }

  return {
    success: true,
    removed: true,
    message: '工作区已失效，已从本地快照移除',
  };
}

function summarizeWorkspaceSync(results = []) {
  const accountTotal = results.length;
  const syncedAccounts = results.filter(item => item.success).length;
  const failedAccounts = results.filter(item => item.success === false && !item.skipped).length;
  const skippedAccounts = results.filter(item => item.skipped).length;
  const workspaceResults = results.flatMap(item => item.results || []);

  return {
    accountTotal,
    syncedAccounts,
    failedAccounts,
    skippedAccounts,
    workspaceTotal: workspaceResults.length,
    syncedWorkspaces: workspaceResults.filter(item => item.success).length,
    failedWorkspaces: workspaceResults.filter(item => item.success === false).length,
  };
}

function exportWorkspaceCsv(rowId) {
  const workspace = db.prepare(`
    SELECT w.*, a.email AS account_email
    FROM workspaces w
    JOIN accounts a ON w.account_id = a.id
    WHERE w.id = ?
  `).get(rowId);

  if (!workspace) {
    throw new Error('Workspace not found');
  }

  const members = db.prepare(`
    SELECT *
    FROM workspace_members
    WHERE workspace_id = ?
    ORDER BY is_owner DESC, role ASC, email ASC
  `).all(workspace.workspace_id);

  const pending = db.prepare(`
    SELECT *
    FROM workspace_pending_invites
    WHERE workspace_id = ?
    ORDER BY email ASC
  `).all(workspace.workspace_id);

  const lines = [
    ['workspace_name', 'workspace_id', 'account_email', 'section', 'email', 'name', 'role', 'seat_type', 'joined_at', 'remote_invite_id'].map(csvEscape).join(','),
  ];

  for (const member of members) {
    lines.push([
      workspace.workspace_name,
      workspace.workspace_id,
      workspace.account_email,
      'member',
      member.email,
      member.name,
      member.role,
      member.seat_type,
      member.joined_at,
      '',
    ].map(csvEscape).join(','));
  }

  for (const invite of pending) {
    lines.push([
      workspace.workspace_name,
      workspace.workspace_id,
      workspace.account_email,
      'pending',
      invite.email,
      '',
      '',
      '',
      invite.invited_at,
      invite.remote_invite_id,
    ].map(csvEscape).join(','));
  }

  return {
    filename: `${workspace.workspace_name || workspace.workspace_id}-members.csv`,
    csv: lines.join('\n'),
  };
}

module.exports = {
  syncAllWorkspaceSnapshots,
  syncAccountWorkspaces,
  syncWorkspaceByRowId: syncWorkspaceByRowIdSafe,
  summarizeWorkspaceSync,
  exportWorkspaceCsv,
};
