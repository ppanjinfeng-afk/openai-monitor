const fetch = require('node-fetch');
const db = require('../db');
const quotaSync = require('./quota-sync');
const workspaceSync = require('./workspace-sync');
const workspaceMembers = require('./workspace-members');

const WORKSPACE_MEMBER_LIMIT = 8;

let rebalanceRunning = false;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeWorkspaceId(workspaceId) {
  return String(workspaceId || '').trim();
}

function getInternalBaseUrl() {
  return process.env.INTERNAL_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
}

function isMemberAlreadyAbsent(result = {}) {
  const message = String(result?.message || '').toLowerCase();
  return message.includes('http 404') && message.includes('no user found with that id');
}

function logAction(accountId, status, message) {
  db.prepare(`
    INSERT INTO check_logs (account_id, status, message)
    VALUES (?, ?, ?)
  `).run(accountId, status, message);
}

function getWorkspaceLocalPendingInviteCount(workspaceId = '') {
  const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
  if (!normalizedWorkspaceId) {
    return 0;
  }

  const row = db.prepare(`
    SELECT COUNT(DISTINCT LOWER(target_email)) AS count
    FROM invites
    WHERE COALESCE(workspace_id, '') = ?
      AND status IN ('sent', 'pending')
      AND COALESCE(failure_category, '') = ''
      AND COALESCE(remote_state, '') NOT IN ('member', 'accepted', 'missing')
  `).get(normalizedWorkspaceId);

  return Number(row?.count || 0);
}

function getOverflowWorkspaces(limit = 20) {
  return db.prepare(`
    SELECT
      w.*,
      a.email AS account_email,
      a.access_token,
      a.status AS account_status,
      a.invite_total,
      a.quota_workspace_id,
      a.quota_workspace_name,
      a.quota_plan_type,
      a.quota_sync_status,
      a.quota_total_users,
      a.quota_member_seats,
      a.quota_pending_invites
    FROM workspaces w
    JOIN accounts a ON a.id = w.account_id
    WHERE w.sync_status = 'success'
      AND MAX(
        COALESCE(w.member_count, 0),
        COALESCE(w.occupied_seats, 0) + COALESCE(w.pending_invites, 0)
      ) > ?
      AND a.status = 'active'
      AND a.access_token IS NOT NULL
      AND a.access_token != ''
    ORDER BY (
      MAX(
        COALESCE(w.member_count, 0),
        COALESCE(w.occupied_seats, 0) + COALESCE(w.pending_invites, 0)
      ) - ?
    ) DESC, datetime(w.updated_at) ASC, w.id ASC
    LIMIT ?
  `).all(WORKSPACE_MEMBER_LIMIT, WORKSPACE_MEMBER_LIMIT, limit);
}

function getOverflowMembers(workspace) {
  return db.prepare(`
    SELECT *
    FROM workspace_members
    WHERE account_id = ?
      AND workspace_id = ?
      AND COALESCE(deactivated_time, '') = ''
      AND COALESCE(is_owner, 0) = 0
      AND COALESCE(email, '') != ''
    ORDER BY
      CASE WHEN COALESCE(joined_at, '') = '' THEN 1 ELSE 0 END ASC,
      joined_at ASC,
      id ASC
  `).all(workspace.account_id, workspace.workspace_id);
}

function getHistoricalWorkspaceIdsForEmail(memberEmail = '') {
  const normalizedEmail = normalizeEmail(memberEmail);
  if (!normalizedEmail) {
    return [];
  }

  const inviteRows = db.prepare(`
    SELECT DISTINCT COALESCE(workspace_id, '') AS workspace_id
    FROM invites
    WHERE LOWER(target_email) = LOWER(?)
      AND COALESCE(workspace_id, '') != ''
      AND COALESCE(failure_category, '') = ''
      AND (
        COALESCE(status, '') = 'accepted'
        OR COALESCE(remote_state, '') = 'member'
      )
  `).all(normalizedEmail);

  const memberRows = db.prepare(`
    SELECT DISTINCT COALESCE(workspace_id, '') AS workspace_id
    FROM workspace_members
    WHERE LOWER(email) = LOWER(?)
      AND COALESCE(workspace_id, '') != ''
  `).all(normalizedEmail);

  return Array.from(new Set(
    [...inviteRows, ...memberRows]
      .map(row => normalizeWorkspaceId(row.workspace_id))
      .filter(Boolean)
  ));
}

function findMigrationTarget(memberEmail, sourceWorkspace) {
  const normalizedEmail = normalizeEmail(memberEmail);
  if (!normalizedEmail) {
    return null;
  }

  const historicalWorkspaceIds = new Set(getHistoricalWorkspaceIdsForEmail(normalizedEmail));

  const rows = db.prepare(`
    SELECT
      w.*,
      a.email AS account_email,
      a.invite_total,
      a.status AS account_status,
      COALESCE((
        SELECT COUNT(DISTINCT LOWER(i.target_email))
        FROM invites i
        WHERE COALESCE(i.workspace_id, '') = COALESCE(w.workspace_id, '')
          AND i.status IN ('sent', 'pending')
          AND COALESCE(i.failure_category, '') = ''
          AND COALESCE(i.remote_state, '') NOT IN ('member', 'accepted', 'missing')
      ), 0) AS local_pending_invites,
      EXISTS (
        SELECT 1
        FROM workspace_members wm
        WHERE wm.account_id = w.account_id
          AND wm.workspace_id = w.workspace_id
          AND LOWER(wm.email) = LOWER(?)
          AND COALESCE(wm.deactivated_time, '') = ''
      ) AS has_member,
      EXISTS (
        SELECT 1
        FROM workspace_pending_invites wp
        WHERE wp.account_id = w.account_id
          AND wp.workspace_id = w.workspace_id
          AND LOWER(wp.email) = LOWER(?)
      ) AS has_pending
    FROM workspaces w
    JOIN accounts a ON a.id = w.account_id
    WHERE w.sync_status = 'success'
      AND a.status = 'active'
      AND a.access_token IS NOT NULL
      AND a.access_token != ''
      AND COALESCE(w.invite_locked, 0) = 0
      AND COALESCE(w.auto_invite_locked, 0) = 0
      AND w.account_id != ?
      AND COALESCE(w.workspace_id, '') != ''
      AND COALESCE(w.workspace_id, '') != ?
    ORDER BY
      COALESCE(w.projected_remaining_seats, 0) DESC,
      COALESCE(w.remaining_seats, 0) DESC,
      COALESCE(w.member_count, 0) ASC,
      datetime(w.updated_at) DESC,
      w.id ASC
  `).all(normalizedEmail, normalizedEmail, sourceWorkspace.account_id, normalizeWorkspaceId(sourceWorkspace.workspace_id));

  for (const row of rows) {
    if (historicalWorkspaceIds.has(normalizeWorkspaceId(row.workspace_id))) {
      continue;
    }

    if (Number(row.has_member || 0) === 1 || Number(row.has_pending || 0) === 1) {
      continue;
    }

    const inviteTotal = Number(row.invite_total_hint || row.invite_total || 0);
    const memberSeats = Number(row.occupied_seats || 0);
    const memberTotal = Number(row.member_count || 0);
    const syncedPendingInvites = Number(row.pending_invites || 0);
    const localPendingInvites = Number(row.local_pending_invites || 0);
    const pendingInvites = Math.max(syncedPendingInvites, localPendingInvites);
    const reservedSeats = memberSeats + pendingInvites;
    const projectedMemberTotal = memberTotal + pendingInvites;

    if (inviteTotal <= 0) {
      continue;
    }

    if (reservedSeats >= inviteTotal) {
      continue;
    }

    if (projectedMemberTotal >= WORKSPACE_MEMBER_LIMIT) {
      continue;
    }

    return {
      account_id: row.account_id,
      account_email: row.account_email,
      workspace_id: row.workspace_id,
      workspace_name: row.workspace_name,
      plan_type: row.plan_type,
      invite_total: inviteTotal,
      member_total: memberTotal,
      pending_invites: pendingInvites,
      projected_member_total: projectedMemberTotal,
    };
  }

  return null;
}

async function requestAutoInvite(email, sourceWorkspace, targetWorkspace) {
  const response = await fetch(`${getInternalBaseUrl()}/api/accounts/auto-invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      prefer_fresh_workspace: true,
      exclude_account_ids: [Number(sourceWorkspace.account_id || 0)],
      exclude_workspace_ids: [normalizeWorkspaceId(sourceWorkspace.workspace_id)],
      preferred_account_id: Number(targetWorkspace.account_id || 0),
      preferred_workspace_id: normalizeWorkspaceId(targetWorkspace.workspace_id),
      preferred_workspace_name: String(targetWorkspace.workspace_name || ''),
      allow_preferred_workspace_fallback: true,
      rebalance_reason: 'overflow_member',
    }),
  });

  const raw = await response.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    return {
      success: false,
      message: data?.error || raw || `Invite request failed with HTTP ${response.status}`,
      payload: data,
    };
  }

  return {
    success: true,
    data: data || {},
  };
}

function normalizeTargetWorkspace(target = {}) {
  return {
    account_email: String(target.account_email || target.used_account || '').trim(),
    workspace_id: normalizeWorkspaceId(target.workspace_id || ''),
    workspace_name: String(target.workspace_name || '').trim(),
  };
}

async function syncSourceWorkspaceState(account) {
  try {
    await quotaSync.syncSingleAccountUsage(account);
  } catch (err) {
    logAction(account.id, 'error', `[overflow-rebalance][quota-sync] ${err.message}`);
  }

  try {
    await workspaceSync.syncAccountWorkspaces(account);
  } catch (err) {
    logAction(account.id, 'error', `[overflow-rebalance][workspace-sync] ${err.message}`);
  }
}

async function rebalanceWorkspace(workspace) {
  const memberCount = Number(workspace.member_count || 0);
  const reservedSeats = Number(workspace.occupied_seats || 0) + Number(workspace.pending_invites || 0);
  const memberOverflowCount = Math.max(0, memberCount - WORKSPACE_MEMBER_LIMIT);
  const reservedOverflowCount = Math.max(0, reservedSeats - WORKSPACE_MEMBER_LIMIT);
  const overflowCount = Math.max(memberOverflowCount, reservedOverflowCount);
  if (overflowCount <= 0) {
    return {
      workspace_id: workspace.workspace_id,
      account_email: workspace.account_email,
      overflow_count: 0,
      member_overflow_count: 0,
      reserved_overflow_count: 0,
      moved: 0,
      skipped: 0,
      failed: 0,
      items: [],
    };
  }

  const sourceAccount = db.prepare(`
    SELECT *
    FROM accounts
    WHERE id = ?
  `).get(workspace.account_id);

  if (!sourceAccount || !sourceAccount.access_token || sourceAccount.status !== 'active') {
    return {
      workspace_id: workspace.workspace_id,
      account_email: workspace.account_email,
      overflow_count: overflowCount,
      moved: 0,
      skipped: overflowCount,
      failed: 0,
      items: [],
    };
  }

  const members = getOverflowMembers(workspace).slice(0, overflowCount);
  const items = [];
  let moved = 0;
  let skipped = 0;
  let failed = 0;

  for (const member of members) {
    const email = normalizeEmail(member.email);
    if (!email) {
      skipped += 1;
      items.push({
        email: member.email || '',
        status: 'skipped',
        reason: 'missing_email',
      });
      continue;
    }

    const targetWorkspace = findMigrationTarget(email, workspace);
    if (!targetWorkspace) {
      const removeResult = await workspaceMembers.removeMember(sourceAccount, member.user_id, {
        workspaceId: workspace.workspace_id,
        workspaceName: workspace.workspace_name,
        planType: workspace.plan_type,
      });

      if (!removeResult.success && isMemberAlreadyAbsent(removeResult)) {
        failed += 1;
        items.push({
          email,
          status: 'failed',
          reason: 'removed_without_target',
          message: 'member was already absent from source workspace, and no target workspace was available',
        });
        logAction(
          sourceAccount.id,
          'error',
          `[overflow-rebalance] removed ${email} from ${workspace.account_email}/${workspace.workspace_name || workspace.workspace_id} without target workspace; migration failed`
        );
        continue;
      }

      if (!removeResult.success) {
        failed += 1;
        items.push({
          email,
          status: 'failed',
          reason: 'remove_failed_no_target',
          message: removeResult.message,
        });
        logAction(
          sourceAccount.id,
          'error',
          `[overflow-rebalance] removed ${email} without target failed from ${workspace.account_email}/${workspace.workspace_name || workspace.workspace_id}: ${removeResult.message}`
        );
        continue;
      }

      failed += 1;
      items.push({
        email,
        status: 'failed',
        reason: 'removed_without_target',
        message: 'member removed to keep workspace within limit, but no target workspace was available',
      });
      logAction(
        sourceAccount.id,
        'error',
        `[overflow-rebalance] removed ${email} from ${workspace.account_email}/${workspace.workspace_name || workspace.workspace_id} without target workspace; migration failed`
      );
      continue;
    }

    const inviteResult = await requestAutoInvite(email, workspace, targetWorkspace);
    if (!inviteResult.success) {
      failed += 1;
      items.push({
        email,
        status: 'failed',
        reason: 'invite_failed',
        message: inviteResult.message,
        target_workspace_id: targetWorkspace.workspace_id,
        target_account_email: targetWorkspace.account_email,
      });
      logAction(
        sourceAccount.id,
        'error',
        `[overflow-rebalance] invite ${email} to ${targetWorkspace.account_email}/${targetWorkspace.workspace_name || targetWorkspace.workspace_id} failed: ${inviteResult.message}`
      );
      continue;
    }

    const actualTargetWorkspace = normalizeTargetWorkspace({
      account_email: inviteResult.data?.used_account || targetWorkspace.account_email,
      workspace_id: inviteResult.data?.workspace_id || targetWorkspace.workspace_id,
      workspace_name: inviteResult.data?.workspace_name || targetWorkspace.workspace_name,
    });

    const removeResult = await workspaceMembers.removeMember(sourceAccount, member.user_id, {
      workspaceId: workspace.workspace_id,
      workspaceName: workspace.workspace_name,
      planType: workspace.plan_type,
    });

    if (!removeResult.success && isMemberAlreadyAbsent(removeResult)) {
      moved += 1;
      items.push({
        email,
        status: 'moved',
        target_workspace_id: actualTargetWorkspace.workspace_id,
        target_workspace_name: actualTargetWorkspace.workspace_name,
        target_account_email: actualTargetWorkspace.account_email,
      });
      logAction(
        sourceAccount.id,
        'active',
        `[overflow-rebalance] moved ${email} from ${workspace.account_email}/${workspace.workspace_name || workspace.workspace_id} to ${actualTargetWorkspace.account_email}/${actualTargetWorkspace.workspace_name || actualTargetWorkspace.workspace_id}`
      );
      continue;
    }

    if (!removeResult.success) {
      failed += 1;
      items.push({
        email,
        status: 'failed',
        reason: 'remove_failed',
        message: removeResult.message,
        target_workspace_id: actualTargetWorkspace.workspace_id,
        target_workspace_name: actualTargetWorkspace.workspace_name,
        target_account_email: actualTargetWorkspace.account_email,
      });
      logAction(
        sourceAccount.id,
        'error',
        `[overflow-rebalance] invited ${email} to ${actualTargetWorkspace.account_email}/${actualTargetWorkspace.workspace_name || actualTargetWorkspace.workspace_id} but failed to remove from source workspace: ${removeResult.message}`
      );
      continue;
    }

    moved += 1;
    items.push({
      email,
      status: 'moved',
      target_workspace_id: actualTargetWorkspace.workspace_id,
      target_workspace_name: actualTargetWorkspace.workspace_name,
      target_account_email: actualTargetWorkspace.account_email,
    });
    logAction(
      sourceAccount.id,
      'active',
      `[overflow-rebalance] moved ${email} from ${workspace.account_email}/${workspace.workspace_name || workspace.workspace_id} to ${actualTargetWorkspace.account_email}/${actualTargetWorkspace.workspace_name || actualTargetWorkspace.workspace_id}`
    );
  }

  if (moved > 0 || failed > 0) {
    await syncSourceWorkspaceState(sourceAccount);
  }

  return {
    workspace_id: workspace.workspace_id,
    workspace_name: workspace.workspace_name,
    account_email: workspace.account_email,
    overflow_count: overflowCount,
    member_overflow_count: memberOverflowCount,
    reserved_overflow_count: reservedOverflowCount,
    moved,
    skipped,
    failed,
    items,
  };
}

async function rebalanceOverflowMembers(options = {}) {
  if (rebalanceRunning) {
    return {
      success: false,
      skipped: true,
      message: 'overflow rebalance already running',
      summary: {
        workspaces: 0,
        moved: 0,
        skipped: 0,
        failed: 0,
      },
      results: [],
    };
  }

  rebalanceRunning = true;

  try {
    const workspaceLimit = Math.max(1, parseInt(options.limitWorkspaces || '20', 10) || 20);
    const overflowWorkspaces = getOverflowWorkspaces(workspaceLimit);
    const results = [];
    let moved = 0;
    let skipped = 0;
    let failed = 0;

    for (const workspace of overflowWorkspaces) {
      const result = await rebalanceWorkspace(workspace);
      results.push(result);
      moved += Number(result.moved || 0);
      skipped += Number(result.skipped || 0);
      failed += Number(result.failed || 0);
    }

    return {
      success: true,
      summary: {
        workspaces: overflowWorkspaces.length,
        moved,
        skipped,
        failed,
      },
      results,
    };
  } finally {
    rebalanceRunning = false;
  }
}

module.exports = {
  rebalanceOverflowMembers,
};
