const express = require('express');
const db = require('../db');
const quotaSync = require('../services/quota-sync');
const workspaceSync = require('../services/workspace-sync');
const memberOverflowRebalance = require('../services/member-overflow-rebalance');
const untrackedMemberCleanup = require('../services/untracked-member-cleanup');
const { listAccountWorkspaces } = require('../services/account-workspaces');
const { classifyFailure } = require('../services/failure-utils');
const {
  completeCdkTeamTask,
  scheduleCdkTeamTaskCompletionRetry,
} = require('../services/cdk-team-task-sync');

const router = express.Router();
const WORKSPACE_RESERVED_SEATS_SQL = `
  COALESCE((
    SELECT MAX(COALESCE(workspaces.occupied_seats, 0) + COALESCE(workspaces.pending_invites, 0))
    FROM workspaces
    WHERE workspaces.account_id = accounts.id
      AND workspaces.sync_status = 'success'
  ), 0)
`;
const PROJECTED_SEATS_SQL = `
  CASE
    WHEN quota_sync_status = 'success' THEN MAX(
      COALESCE(quota_member_seats, 0) + COALESCE(quota_pending_invites, 0),
      ${WORKSPACE_RESERVED_SEATS_SQL}
    )
    ELSE MAX(COALESCE(invited_count, 0), ${WORKSPACE_RESERVED_SEATS_SQL})
  END
`;

function shouldRunPostQuotaMaintenance(results = []) {
  return (Array.isArray(results) ? results : [results]).some(result =>
    result?.success && (
      result.overQuota ||
      result.projectedOverQuota ||
      Number(result.projectedRemainingSeats || 0) < 0
    )
  );
}

async function runPostQuotaMaintenance(results = []) {
  const normalizedResults = Array.isArray(results) ? results : [results];
  if (!shouldRunPostQuotaMaintenance(normalizedResults)) {
    return {
      triggered: false,
      reason: 'no_overflow_detected',
    };
  }

  const accountIds = Array.from(new Set(
    normalizedResults
      .filter(result => result?.success && (
        result.overQuota ||
        result.projectedOverQuota ||
        Number(result.projectedRemainingSeats || 0) < 0
      ))
      .map(result => Number(result.accountId || 0))
      .filter(Boolean)
  ));

  const workspaceResults = [];
  for (const accountId of accountIds) {
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    if (!account) {
      workspaceResults.push({
        success: false,
        accountId,
        message: 'Account not found during post-quota maintenance',
      });
      continue;
    }

    try {
      workspaceResults.push(await workspaceSync.syncAccountWorkspaces(account));
    } catch (err) {
      workspaceResults.push({
        success: false,
        accountId,
        email: account.email,
        message: err.message,
      });
    }
  }

  const untrackedCleanup = await untrackedMemberCleanup.autoKickUntrackedMembers({ limit: 500 });
  const rebalance = await memberOverflowRebalance.rebalanceOverflowMembers();

  return {
    triggered: true,
    account_ids: accountIds,
    workspace_sync: {
      summary: workspaceSync.summarizeWorkspaceSync(workspaceResults),
      results: workspaceResults,
    },
    untracked_cleanup: untrackedCleanup,
    rebalance,
  };
}
const INVITE_FAILURE_WINDOW_HOURS = 24;
const INVITE_DEGRADED_THRESHOLD = 3;
const INVITE_SEVERE_DEGRADED_THRESHOLD = 5;
const WORKSPACE_MEMBER_LIMIT = 8;
const RECENT_MATERIALIZE_FAILURES_SQL = `
  COALESCE((
    SELECT COUNT(*)
    FROM invites
    WHERE invites.account_id = accounts.id
      AND (
        invites.failure_category = 'invite_not_materialized'
        OR (
          invites.failure_category = 'generic_error'
          AND LOWER(COALESCE(invites.message, '')) LIKE '%unable to invite user due to an error%'
        )
      )
      AND invites.updated_at >= datetime('now', '-${INVITE_FAILURE_WINDOW_HOURS} hours')
  ), 0)
`;
const RECENT_RETRY_FAILURES_SQL = `
  COALESCE((
    SELECT COUNT(*)
    FROM invites
    WHERE invites.account_id = accounts.id
      AND invites.failure_category IN ('revoke_failed', 'resend_failed')
      AND invites.updated_at >= datetime('now', '-${INVITE_FAILURE_WINDOW_HOURS} hours')
  ), 0)
`;
const RECENT_INVITE_SUCCESSES_SQL = `
  COALESCE((
    SELECT COUNT(*)
    FROM invites
    WHERE invites.account_id = accounts.id
      AND invites.status = 'sent'
      AND invites.updated_at >= datetime('now', '-${INVITE_FAILURE_WINDOW_HOURS} hours')
  ), 0)
`;
const LAST_INVITE_SUCCESS_AT_SQL = `
  COALESCE((
    SELECT MAX(invites.updated_at)
    FROM invites
    WHERE invites.account_id = accounts.id
      AND invites.status = 'sent'
  ), '')
`;
const INVITE_DEGRADED_CONDITION_SQL = `
  (
    (${RECENT_MATERIALIZE_FAILURES_SQL} >= ${INVITE_DEGRADED_THRESHOLD} AND ${RECENT_INVITE_SUCCESSES_SQL} = 0)
    OR ${RECENT_MATERIALIZE_FAILURES_SQL} >= ${INVITE_SEVERE_DEGRADED_THRESHOLD}
  )
`;
const INVITE_HEALTH_STATUS_SQL = `
  CASE
    WHEN COALESCE(invite_paused, 0) = 1 THEN 'paused'
    WHEN ${INVITE_DEGRADED_CONDITION_SQL} THEN 'degraded'
    WHEN ${RECENT_RETRY_FAILURES_SQL} > 0 THEN 'warning'
    ELSE 'healthy'
  END
`;
const INVITE_HEALTH_LABEL_SQL = `
  CASE
    WHEN ${INVITE_DEGRADED_CONDITION_SQL} THEN '坏号'
    WHEN ${RECENT_RETRY_FAILURES_SQL} > 0 THEN '待观察'
    ELSE '正常'
  END
`;
const ACCOUNT_INVITE_HEALTH_SELECT_SQL = `
  accounts.*,
  (${PROJECTED_SEATS_SQL}) AS projected_seats,
  invite_total - (${PROJECTED_SEATS_SQL}) AS projected_remaining,
  ${RECENT_MATERIALIZE_FAILURES_SQL} AS recent_materialize_failures,
  ${RECENT_RETRY_FAILURES_SQL} AS recent_retry_failures,
  ${RECENT_INVITE_SUCCESSES_SQL} AS recent_invite_successes,
  ${LAST_INVITE_SUCCESS_AT_SQL} AS last_invite_success_at,
  COALESCE((
    SELECT workspaces.member_count
    FROM workspaces
    WHERE workspaces.account_id = accounts.id
      AND workspaces.sync_status = 'success'
    ORDER BY datetime(workspaces.updated_at) DESC
    LIMIT 1
  ), 0) AS workspace_member_count,
  COALESCE((
    SELECT workspaces.occupied_seats
    FROM workspaces
    WHERE workspaces.account_id = accounts.id
      AND workspaces.sync_status = 'success'
    ORDER BY datetime(workspaces.updated_at) DESC
    LIMIT 1
  ), 0) AS workspace_occupied_seats,
  COALESCE((
    SELECT workspaces.pending_invites
    FROM workspaces
    WHERE workspaces.account_id = accounts.id
      AND workspaces.sync_status = 'success'
    ORDER BY datetime(workspaces.updated_at) DESC
    LIMIT 1
  ), 0) AS workspace_pending_invites,
  COALESCE((
    SELECT workspaces.invite_total_hint
    FROM workspaces
    WHERE workspaces.account_id = accounts.id
      AND workspaces.sync_status = 'success'
    ORDER BY datetime(workspaces.updated_at) DESC
    LIMIT 1
  ), 0) AS workspace_invite_total_hint,
  COALESCE((
    SELECT MAX(MAX(COALESCE(workspaces.member_count, 0) - ${WORKSPACE_MEMBER_LIMIT}, 0))
    FROM workspaces
    WHERE workspaces.account_id = accounts.id
      AND workspaces.sync_status = 'success'
  ), 0) AS workspace_overflow_count,
  COALESCE((
    SELECT check_logs.status
    FROM check_logs
    WHERE check_logs.account_id = accounts.id
      AND check_logs.message LIKE '[overflow-rebalance]%'
      AND check_logs.message NOT LIKE '[overflow-rebalance] invite attempt %; trying next target workspace'
    ORDER BY datetime(check_logs.checked_at) DESC, check_logs.id DESC
    LIMIT 1
  ), '') AS overflow_rebalance_status,
  COALESCE((
    SELECT check_logs.message
    FROM check_logs
    WHERE check_logs.account_id = accounts.id
      AND check_logs.message LIKE '[overflow-rebalance]%'
      AND check_logs.message NOT LIKE '[overflow-rebalance] invite attempt %; trying next target workspace'
    ORDER BY datetime(check_logs.checked_at) DESC, check_logs.id DESC
    LIMIT 1
  ), '') AS overflow_rebalance_message,
  COALESCE((
    SELECT check_logs.checked_at
    FROM check_logs
    WHERE check_logs.account_id = accounts.id
      AND check_logs.message LIKE '[overflow-rebalance]%'
      AND check_logs.message NOT LIKE '[overflow-rebalance] invite attempt %; trying next target workspace'
    ORDER BY datetime(check_logs.checked_at) DESC, check_logs.id DESC
    LIMIT 1
  ), '') AS overflow_rebalance_checked_at,
  ${INVITE_HEALTH_STATUS_SQL} AS invite_health_status,
  ${INVITE_HEALTH_LABEL_SQL} AS invite_health_label
`;
const inviteWorkspaceReservations = new Map();
const inviteEmailWorkspaceReservations = new Map();
const postInviteSyncQueue = [];
const postInviteSyncByAccountId = new Map();
let postInviteSyncRunning = false;

function normalizeEmail(email) {
  return String(email || '').trim();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

function normalizeWorkspaceId(workspaceId) {
  return String(workspaceId || '').trim();
}

function normalizeWorkspaceName(workspaceName) {
  return String(workspaceName || '').trim();
}

function getEmailWorkspaceReservationKey(email) {
  return normalizeEmail(email).toLowerCase();
}

function parseJsonSafely(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isWorkspaceInviteLocked(workspaceId, accountId = 0) {
  const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
  const normalizedAccountId = parseInt(accountId, 10);
  if (!normalizedWorkspaceId) {
    return false;
  }

  if (Number.isInteger(normalizedAccountId) && normalizedAccountId > 0) {
    const row = db.prepare(`
      SELECT
        COALESCE(invite_locked, 0) AS invite_locked,
        COALESCE(auto_invite_locked, 0) AS auto_invite_locked
      FROM workspaces
      WHERE account_id = ?
        AND workspace_id = ?
      LIMIT 1
    `).get(normalizedAccountId, normalizedWorkspaceId);
    return Number(row?.invite_locked || 0) === 1 || Number(row?.auto_invite_locked || 0) === 1;
  }

  const row = db.prepare(`
    SELECT
      COALESCE(invite_locked, 0) AS invite_locked,
      COALESCE(auto_invite_locked, 0) AS auto_invite_locked
    FROM workspaces
    WHERE workspace_id = ?
    LIMIT 1
  `).get(normalizedWorkspaceId);

  return Number(row?.invite_locked || 0) === 1 || Number(row?.auto_invite_locked || 0) === 1;
}

function parseOverflowRebalanceMessage(message = '', fallbackAccountEmail = '') {
  const rawMessage = String(message || '').trim();
  const base = {
    type: 'other',
    member_email: '',
    source_account_email: String(fallbackAccountEmail || '').trim(),
    source_workspace: '',
    target_account_email: '',
    target_workspace: '',
    detail: '',
    summary: rawMessage.replace(/^\[overflow-rebalance\]\s*/i, '').trim() || '迁移记录',
  };

  if (!rawMessage) {
    return base;
  }

  let match = rawMessage.match(/^\[overflow-rebalance\]\s+moved\s+(\S+)\s+from\s+([^/]+)\/(.+?)\s+to\s+([^/]+)\/(.+)$/i);
  if (match) {
    return {
      ...base,
      type: 'moved',
      member_email: match[1],
      source_account_email: match[2],
      source_workspace: match[3],
      target_account_email: match[4],
      target_workspace: match[5],
      summary: `${match[1]} 已迁移到 ${match[4]}`,
    };
  }

  match = rawMessage.match(/^\[overflow-rebalance\]\s+invite attempt\s+(\S+)\s+to\s+([^/]+)\/(.+?)\s+failed:\s+(.+?);\s+trying next target workspace$/i);
  if (match) {
    return {
      ...base,
      type: 'invite_attempt_failed',
      member_email: match[1],
      target_account_email: match[2],
      target_workspace: match[3],
      detail: match[4],
      summary: `${match[1]} 目标空间尝试失败，继续换下一个空间`,
    };
  }

  match = rawMessage.match(/^\[overflow-rebalance\]\s+invite\s+(\S+)\s+to\s+([^/]+)\/(.+?)\s+failed:\s+(.+)$/i);
  if (match) {
    return {
      ...base,
      type: 'invite_failed',
      member_email: match[1],
      target_account_email: match[2],
      target_workspace: match[3],
      detail: match[4],
      summary: `${match[1]} 迁移邀请失败`,
    };
  }

  match = rawMessage.match(/^\[overflow-rebalance\]\s+invited\s+(\S+)\s+to\s+([^/]+)\/(.+?)\s+but failed to remove from source workspace:\s+(.+)$/i);
  if (match) {
    return {
      ...base,
      type: 'remove_failed',
      member_email: match[1],
      target_account_email: match[2],
      target_workspace: match[3],
      detail: match[4],
      summary: `${match[1]} 新邀请已发出，但源工作区移除失败`,
    };
  }

  match = rawMessage.match(/^\[overflow-rebalance\]\s+(\S+)\s+has no available target workspace from\s+([^/]+)\/(.+)$/i);
  if (match) {
    return {
      ...base,
      type: 'no_target_workspace',
      member_email: match[1],
      source_account_email: match[2],
      source_workspace: match[3],
      summary: `${match[1]} 暂无可迁移目标`,
      detail: '当前没有其它可用账号可承接这个成员',
    };
  }

  match = rawMessage.match(/^\[overflow-rebalance\]\s+removed\s+(\S+)\s+from\s+([^/]+)\/(.+?)\s+after all invite targets failed:\s+(.+)$/i);
  if (match) {
    return {
      ...base,
      type: 'removed_after_invite_failed',
      member_email: match[1],
      source_account_email: match[2],
      source_workspace: match[3],
      detail: match[4],
      summary: `${match[1]} 已移出源空间，但所有目标邀请都失败`,
    };
  }

  match = rawMessage.match(/^\[overflow-rebalance\]\s+removed\s+(\S+)\s+from\s+([^/]+)\/(.+?)\s+without target workspace;\s+migration failed$/i);
  if (match) {
    return {
      ...base,
      type: 'removed_without_target',
      member_email: match[1],
      source_account_email: match[2],
      source_workspace: match[3],
      summary: `${match[1]} 已移出，但迁移失败`,
      detail: '为保证工作区成员不超过 8 人，系统已先移出该成员；当前没有可用目标空间承接',
    };
  }

  match = rawMessage.match(/^\[overflow-rebalance\]\s+removed\s+(\S+)\s+without target failed from\s+([^/]+)\/(.+?):\s+(.+)$/i);
  if (match) {
    return {
      ...base,
      type: 'remove_failed_no_target',
      member_email: match[1],
      source_account_email: match[2],
      source_workspace: match[3],
      detail: match[4],
      summary: `${match[1]} 移出失败`,
    };
  }

  match = rawMessage.match(/^\[overflow-rebalance\]\[(quota-sync|workspace-sync)\]\s+(.+)$/i);
  if (match) {
    const syncType = String(match[1] || '').toLowerCase();
    return {
      ...base,
      type: syncType === 'quota-sync' ? 'quota_sync_error' : 'workspace_sync_error',
      detail: match[2],
      summary: syncType === 'quota-sync' ? '迁移后名额同步失败' : '迁移后工作区同步失败',
    };
  }

  return base;
}

function overflowRebalanceRecordTone(type = '', status = '') {
  const normalizedType = String(type || '').trim().toLowerCase();
  const normalizedStatus = String(status || '').trim().toLowerCase();

  if (normalizedType === 'moved') {
    return 'success';
  }
  if (normalizedType === 'removed_without_target' || normalizedType === 'remove_failed_no_target' || normalizedType === 'removed_after_invite_failed') {
    return 'danger';
  }
  if (normalizedType === 'no_target_workspace' || normalizedType === 'invite_attempt_failed') {
    return 'warning';
  }
  if (normalizedStatus === 'active') {
    return 'accent';
  }
  if (normalizedStatus === 'error') {
    return 'danger';
  }
  return 'neutral';
}

function overflowRebalanceRecordLabel(type = '', status = '') {
  const normalizedType = String(type || '').trim().toLowerCase();
  const normalizedStatus = String(status || '').trim().toLowerCase();

  switch (normalizedType) {
    case 'moved':
      return '已迁移';
    case 'invite_attempt_failed':
      return '尝试换空间';
    case 'invite_failed':
      return '邀请失败';
    case 'remove_failed':
      return '移除失败';
    case 'removed_after_invite_failed':
      return '已移出未邀请';
    case 'removed_without_target':
      return '迁移失败';
    case 'remove_failed_no_target':
      return '移出失败';
    case 'no_target_workspace':
      return '暂无目标';
    case 'quota_sync_error':
      return '名额同步异常';
    case 'workspace_sync_error':
      return '工作区同步异常';
    default:
      return normalizedStatus === 'error' ? '迁移异常' : '迁移记录';
  }
}

function findOverflowRebalanceActualTarget(memberEmail = '', checkedAt = '', sourceAccountId = 0) {
  const normalizedEmail = normalizeEmail(memberEmail).toLowerCase();
  const normalizedCheckedAt = String(checkedAt || '').trim();
  const normalizedSourceAccountId = parseInt(sourceAccountId, 10) || 0;

  if (!normalizedEmail || !normalizedCheckedAt) {
    return null;
  }

  const autoInviteLog = db.prepare(`
    SELECT
      cl.account_id,
      accounts.email AS account_email
    FROM check_logs cl
    JOIN accounts ON accounts.id = cl.account_id
    WHERE cl.account_id != ?
      AND cl.message IN (?, ?)
      AND datetime(cl.checked_at) <= datetime(?)
      AND datetime(cl.checked_at) >= datetime(?, '-5 minutes')
    ORDER BY datetime(cl.checked_at) DESC, cl.id DESC
    LIMIT 1
  `).get(
    normalizedSourceAccountId,
    `[auto-invite] invite sent to ${normalizedEmail}`,
    `[invite] invite sent to ${normalizedEmail}`,
    normalizedCheckedAt,
    normalizedCheckedAt
  );

  if (autoInviteLog) {
    const matchedInvite = db.prepare(`
      SELECT
        invites.account_id,
        accounts.email AS account_email,
        COALESCE(invites.workspace_id, '') AS workspace_id,
        COALESCE(invites.workspace_name, '') AS workspace_name,
        invites.updated_at
      FROM invites
      JOIN accounts ON accounts.id = invites.account_id
      WHERE LOWER(invites.target_email) = LOWER(?)
        AND invites.account_id = ?
      ORDER BY ABS(strftime('%s', invites.updated_at) - strftime('%s', ?)) ASC, invites.id DESC
      LIMIT 1
    `).get(normalizedEmail, autoInviteLog.account_id, normalizedCheckedAt);

    return {
      account_email: String(matchedInvite?.account_email || autoInviteLog.account_email || '').trim(),
      workspace_id: String(matchedInvite?.workspace_id || '').trim(),
      workspace_name: String(matchedInvite?.workspace_name || '').trim(),
    };
  }

  const fallbackInvite = db.prepare(`
    SELECT
      invites.account_id,
      accounts.email AS account_email,
      COALESCE(invites.workspace_id, '') AS workspace_id,
      COALESCE(invites.workspace_name, '') AS workspace_name,
      invites.updated_at
    FROM invites
    JOIN accounts ON accounts.id = invites.account_id
    WHERE LOWER(invites.target_email) = LOWER(?)
      AND invites.account_id != ?
      AND datetime(invites.updated_at) >= datetime(?, '-30 minutes')
      AND datetime(invites.updated_at) <= datetime(?, '+2 hours')
    ORDER BY ABS(strftime('%s', invites.updated_at) - strftime('%s', ?)) ASC, invites.id DESC
    LIMIT 1
  `).get(
    normalizedEmail,
    normalizedSourceAccountId,
    normalizedCheckedAt,
    normalizedCheckedAt,
    normalizedCheckedAt
  );

  if (!fallbackInvite) {
    return null;
  }

  return {
    account_email: String(fallbackInvite.account_email || '').trim(),
    workspace_id: String(fallbackInvite.workspace_id || '').trim(),
    workspace_name: String(fallbackInvite.workspace_name || '').trim(),
  };
}

function buildOverflowRebalanceRecord(row = {}) {
  const parsed = parseOverflowRebalanceMessage(row.message, row.account_email);
  const shouldResolveActualTarget = ['moved', 'invite_failed', 'remove_failed'].includes(parsed.type);
  const actualTarget = shouldResolveActualTarget
    ? findOverflowRebalanceActualTarget(parsed.member_email, row.checked_at, row.account_id)
    : null;
  const targetAccountEmail = String(actualTarget?.account_email || parsed.target_account_email || '').trim();
  const targetWorkspace = String(actualTarget?.workspace_name || actualTarget?.workspace_id || parsed.target_workspace || '').trim();
  const tone = overflowRebalanceRecordTone(parsed.type, row.status);

  return {
    id: Number(row.id || 0),
    account_id: Number(row.account_id || 0),
    account_email: String(row.account_email || '').trim(),
    status: String(row.status || '').trim(),
    checked_at: String(row.checked_at || '').trim(),
    message: String(row.message || '').trim(),
    ...parsed,
    target_account_email: targetAccountEmail,
    target_workspace: targetWorkspace,
    summary: parsed.type === 'moved' && parsed.member_email && targetAccountEmail
      ? `${parsed.member_email} 已迁移到 ${targetAccountEmail}`
      : parsed.summary,
    tone,
    status_label: overflowRebalanceRecordLabel(parsed.type, row.status),
  };
}

function normalizeIntegerIdList(values = []) {
  const source = Array.isArray(values) ? values : [values];
  return Array.from(new Set(
    source
      .map(value => parseInt(value, 10))
      .filter(value => Number.isInteger(value) && value > 0)
  ));
}

function normalizeWorkspaceIdList(values = []) {
  const source = Array.isArray(values) ? values : [values];
  return Array.from(new Set(
    source
      .map(value => normalizeWorkspaceId(value))
      .filter(Boolean)
  ));
}

function getWorkspaceMemberLimit() {
  return WORKSPACE_MEMBER_LIMIT;
}

function prioritizeWorkspaceCandidates(candidates = [], preferredWorkspaceId = '', preferredAccountId = 0) {
  const normalizedWorkspaceId = normalizeWorkspaceId(preferredWorkspaceId);
  const normalizedAccountId = parseInt(preferredAccountId, 10);
  if (!normalizedWorkspaceId || !Array.isArray(candidates) || candidates.length === 0) {
    return Array.isArray(candidates) ? candidates : [];
  }

  const index = candidates.findIndex(candidate =>
    normalizeWorkspaceId(candidate?.workspaceId) === normalizedWorkspaceId
    && (!Number.isInteger(normalizedAccountId) || normalizedAccountId <= 0 || Number(candidate?.account?.id || 0) === normalizedAccountId)
  );

  if (index <= 0) {
    return candidates;
  }

  return [candidates[index], ...candidates.slice(0, index), ...candidates.slice(index + 1)];
}

function getWorkspaceReservationCount(workspaceId) {
  const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
  if (!normalizedWorkspaceId) {
    return 0;
  }

  return Number(inviteWorkspaceReservations.get(normalizedWorkspaceId) || 0);
}

function getEmailReservedWorkspaceIds(email) {
  const key = getEmailWorkspaceReservationKey(email);
  const reservations = key ? inviteEmailWorkspaceReservations.get(key) : null;
  if (!reservations) {
    return [];
  }

  return [...reservations.keys()].filter(Boolean);
}

function isWorkspaceReservedForEmail(email, workspaceId) {
  const key = getEmailWorkspaceReservationKey(email);
  const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
  if (!key || !normalizedWorkspaceId) {
    return false;
  }

  return Number(inviteEmailWorkspaceReservations.get(key)?.get(normalizedWorkspaceId) || 0) > 0;
}

function reserveEmailWorkspace(email, workspaceId) {
  const key = getEmailWorkspaceReservationKey(email);
  const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
  if (!key || !normalizedWorkspaceId) {
    return null;
  }

  const reservations = inviteEmailWorkspaceReservations.get(key) || new Map();
  reservations.set(normalizedWorkspaceId, Number(reservations.get(normalizedWorkspaceId) || 0) + 1);
  inviteEmailWorkspaceReservations.set(key, reservations);

  return { emailKey: key, workspaceId: normalizedWorkspaceId };
}

function releaseEmailWorkspace(reservation) {
  const key = String(reservation?.emailKey || '').trim();
  const normalizedWorkspaceId = normalizeWorkspaceId(reservation?.workspaceId);
  if (!key || !normalizedWorkspaceId) {
    return;
  }

  const reservations = inviteEmailWorkspaceReservations.get(key);
  if (!reservations) {
    return;
  }

  const currentCount = Number(reservations.get(normalizedWorkspaceId) || 0);
  if (currentCount <= 1) {
    reservations.delete(normalizedWorkspaceId);
  } else {
    reservations.set(normalizedWorkspaceId, currentCount - 1);
  }

  if (reservations.size === 0) {
    inviteEmailWorkspaceReservations.delete(key);
  }
}

function reserveWorkspaceSlot(workspaceId, email = '') {
  const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
  if (!normalizedWorkspaceId) {
    return null;
  }

  inviteWorkspaceReservations.set(
    normalizedWorkspaceId,
    getWorkspaceReservationCount(normalizedWorkspaceId) + 1
  );

  return {
    workspaceId: normalizedWorkspaceId,
    emailWorkspaceReservation: reserveEmailWorkspace(email, normalizedWorkspaceId),
  };
}

function releaseWorkspaceSlot(reservation) {
  const normalizedWorkspaceId = normalizeWorkspaceId(reservation?.workspaceId);
  if (!normalizedWorkspaceId) {
    return;
  }

  releaseEmailWorkspace(reservation.emailWorkspaceReservation);

  const currentCount = getWorkspaceReservationCount(normalizedWorkspaceId);
  if (currentCount <= 1) {
    inviteWorkspaceReservations.delete(normalizedWorkspaceId);
    return;
  }

  inviteWorkspaceReservations.set(normalizedWorkspaceId, currentCount - 1);
}

function applyStatusFilter(conditions, params, status) {
  if (!status || status === 'all') {
    return;
  }

  if (status === 'invite_degraded') {
    conditions.push(`${INVITE_HEALTH_STATUS_SQL} IN ('paused', 'degraded')`);
    return;
  }

  if (status === 'banned') {
    conditions.push(`status = 'banned'`);
    return;
  }

  conditions.push('status = ?');
  params.push(status);
}

function applyAccountsVisibilityFilter(conditions, options = {}) {
  const hasSearch = String(options.search || '').trim().length > 0;
  if (hasSearch) {
    return;
  }

  conditions.push(`status != 'invalid_credentials'`);
}

function getInviteCooldownMinutes() {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get('invite_cooldown_minutes');
  return Math.max(0, parseInt(row?.value || '5', 10) || 0);
}

function findRecentInviteWithinCooldown(accountId, email, workspaceId = '') {
  const minutes = getInviteCooldownMinutes();
  if (minutes <= 0) {
    return null;
  }

  return db.prepare(`
    SELECT *
    FROM invites
    WHERE account_id = ?
      AND LOWER(target_email) = LOWER(?)
      AND COALESCE(workspace_id, '') = ?
      AND updated_at >= datetime('now', ?)
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(accountId, normalizeEmail(email), normalizeWorkspaceId(workspaceId), `-${minutes} minutes`);
}

function findInviteRecord(accountId, email, workspaceId = '') {
  return db.prepare(`
    SELECT *
    FROM invites
    WHERE account_id = ?
      AND LOWER(target_email) = LOWER(?)
      AND COALESCE(workspace_id, '') = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(accountId, normalizeEmail(email), normalizeWorkspaceId(workspaceId));
}

function getInviteHistoryByEmail(email) {
  const targetEmail = normalizeEmail(email);
  if (!targetEmail) {
    return [];
  }

  const inviteRows = db.prepare(`
    SELECT
      account_id,
      requested_account_id,
      workspace_id,
      workspace_name,
      status,
      remote_state,
      failure_category
    FROM invites
    WHERE LOWER(target_email) = LOWER(?)
      AND COALESCE(failure_category, '') = ''
      AND COALESCE(status, '') IN ('sent', 'pending', 'accepted')
    ORDER BY datetime(updated_at) DESC, id DESC
  `).all(targetEmail);

  const taskRows = db.prepare(`
    SELECT
      id,
      invite_result_json,
      updated_at
    FROM cdk_tasks
    WHERE LOWER(account_email) = LOWER(?)
      AND task_type = 'team_invite'
      AND status = 'SUCCESS'
      AND COALESCE(invite_result_json, '') != ''
    ORDER BY datetime(updated_at) DESC
  `).all(targetEmail)
    .map(row => {
      const result = parseJsonSafely(row.invite_result_json);
      const workspaceId = normalizeWorkspaceId(result?.workspace_id || result?.workspaceId);
      if (!workspaceId) {
        return null;
      }

      return {
        account_id: Number(result?.used_account_id || result?.account_id || 0),
        requested_account_id: Number(result?.requested_account_id || 0),
        workspace_id: workspaceId,
        workspace_name: normalizeWorkspaceName(result?.workspace_name || result?.workspaceName),
        status: 'sent',
        remote_state: '',
        failure_category: '',
      };
    })
    .filter(Boolean);

  return [...inviteRows, ...taskRows];
}

function getHistoricalWorkspaceMemberships(email) {
  const targetEmail = normalizeEmail(email);
  if (!targetEmail) {
    return [];
  }

  const inviteRows = db.prepare(`
    SELECT
      account_id,
      requested_account_id,
      workspace_id,
      workspace_name,
      updated_at
    FROM invites
    WHERE LOWER(target_email) = LOWER(?)
      AND COALESCE(workspace_id, '') != ''
      AND COALESCE(failure_category, '') = ''
      AND (
        COALESCE(status, '') = 'accepted'
        OR COALESCE(remote_state, '') = 'member'
      )
    ORDER BY datetime(updated_at) DESC, id DESC
  `).all(targetEmail);

  const memberRows = db.prepare(`
    SELECT
      account_id,
      account_id AS requested_account_id,
      workspace_id,
      '' AS workspace_name,
      last_synced_at AS updated_at
    FROM workspace_members
    WHERE LOWER(email) = LOWER(?)
      AND COALESCE(workspace_id, '') != ''
    ORDER BY datetime(last_synced_at) DESC, id DESC
  `).all(targetEmail);

  const deduped = new Map();
  for (const row of [...inviteRows, ...memberRows]) {
    const workspaceId = normalizeWorkspaceId(row.workspace_id);
    if (!workspaceId || deduped.has(workspaceId)) {
      continue;
    }

    deduped.set(workspaceId, {
      account_id: Number(row.account_id || 0),
      requested_account_id: Number(row.requested_account_id || 0),
      workspace_id: workspaceId,
      workspace_name: normalizeWorkspaceName(row.workspace_name),
      updated_at: String(row.updated_at || '').trim(),
    });
  }

  return [...deduped.values()];
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

function getAccountWorkspaceInviteSummary(accountId = 0) {
  const normalizedAccountId = parseInt(accountId, 10);
  if (!Number.isInteger(normalizedAccountId) || normalizedAccountId <= 0) {
    return {
      inviteable_workspace_names: '',
      locked_workspace_names: '',
      full_locked_workspace_names: '',
    };
  }

  const rows = db.prepare(`
    SELECT
      COALESCE(workspace_name, '') AS workspace_name,
      COALESCE(workspace_id, '') AS workspace_id,
      COALESCE(invite_locked, 0) AS invite_locked,
      COALESCE(auto_invite_locked, 0) AS auto_invite_locked,
      COALESCE(occupied_seats, 0) AS occupied_seats,
      COALESCE(pending_invites, 0) AS pending_invites,
      COALESCE(invite_total_hint, 0) AS invite_total_hint
    FROM workspaces
    WHERE account_id = ?
      AND sync_status = 'success'
      AND COALESCE(workspace_id, '') != ''
    ORDER BY id ASC
  `).all(normalizedAccountId);

  const inviteable = [];
  const locked = [];
  const fullLocked = [];

  for (const row of rows) {
    const label = normalizeWorkspaceName(row.workspace_name) || normalizeWorkspaceId(row.workspace_id);
    if (!label) {
      continue;
    }

    const reservedSeats = Number(row.occupied_seats || 0) + Number(row.pending_invites || 0);
    const inviteTotal = Number(row.invite_total_hint || 0);
    const isManuallyLocked = Number(row.invite_locked || 0) === 1;
    const isAutoLocked = Number(row.auto_invite_locked || 0) === 1;
    const isInviteable = !isManuallyLocked && !isAutoLocked && inviteTotal > 0 && reservedSeats < inviteTotal && reservedSeats < WORKSPACE_MEMBER_LIMIT;

    if (isInviteable) {
      inviteable.push(label);
    }

    if (isManuallyLocked || isAutoLocked) {
      locked.push(label);
    }

    if (isAutoLocked) {
      fullLocked.push(label);
    }
  }

  return {
    inviteable_workspace_names: Array.from(new Set(inviteable)).join('|'),
    locked_workspace_names: Array.from(new Set(locked)).join('|'),
    full_locked_workspace_names: Array.from(new Set(fullLocked)).join('|'),
  };
}

function getInviteCandidateAccounts(excludedIds = [], options = {}) {
  const includeDegraded = Boolean(options.includeDegraded);
  const includePaused = Boolean(options.includePaused);
  let query = `
    SELECT
      accounts.*,
      (${PROJECTED_SEATS_SQL}) AS projected_seats,
      invite_total - (${PROJECTED_SEATS_SQL}) AS projected_remaining,
      COALESCE((
        SELECT COUNT(*)
        FROM invites
        WHERE invites.account_id = accounts.id
          AND (
            invites.failure_category = 'invite_not_materialized'
            OR (
              invites.failure_category = 'generic_error'
              AND LOWER(COALESCE(invites.message, '')) LIKE '%unable to invite user due to an error%'
            )
          )
          AND invites.updated_at >= datetime('now', '-${INVITE_FAILURE_WINDOW_HOURS} hours')
      ), 0) AS recent_materialize_failures,
      COALESCE((
        SELECT COUNT(*)
        FROM invites
        WHERE invites.account_id = accounts.id
          AND invites.failure_category IN ('revoke_failed', 'resend_failed')
          AND invites.updated_at >= datetime('now', '-${INVITE_FAILURE_WINDOW_HOURS} hours')
      ), 0) AS recent_retry_failures,
      COALESCE((
        SELECT COUNT(*)
        FROM invites
        WHERE invites.account_id = accounts.id
          AND invites.status = 'sent'
          AND invites.updated_at >= datetime('now', '-${INVITE_FAILURE_WINDOW_HOURS} hours')
      ), 0) AS recent_invite_successes
    FROM accounts
    WHERE status = 'active'
      AND access_token IS NOT NULL
      AND access_token != ''
      AND (${PROJECTED_SEATS_SQL}) < invite_total
  `;
  const params = [];

  if (!includePaused) {
    query += ` AND COALESCE(invite_paused, 0) = 0`;
  }

  if (excludedIds.length > 0) {
    query += ` AND id NOT IN (${excludedIds.map(() => '?').join(',')})`;
    params.push(...excludedIds);
  }

  query += `
    ORDER BY
      projected_remaining DESC,
      recent_materialize_failures ASC,
      recent_retry_failures ASC,
      CASE WHEN quota_sync_status = 'success' THEN 0 ELSE 1 END ASC,
      recent_invite_successes DESC,
      updated_at DESC
  `;

  const candidates = db.prepare(query).all(...params);
  const healthyCandidates = candidates.filter(account =>
    Number(account.invite_paused || 0) === 0 && !isInviteDegraded(account)
  );

  if (includeDegraded) {
    return candidates;
  }

  return healthyCandidates;
}

function getFallbackAccounts(excludedIds = []) {
  return getInviteCandidateAccounts(excludedIds);
}

function compareWorkspaceCandidatePriority(left, right) {
  return Number(right?.projectedRemainingMemberSlots || 0) - Number(left?.projectedRemainingMemberSlots || 0)
    || Number(right?.remainingMemberSlots || 0) - Number(left?.remainingMemberSlots || 0)
    || Number(right?.projectedRemainingSeats || 0) - Number(left?.projectedRemainingSeats || 0)
    || Number(right?.remainingSeats || 0) - Number(left?.remainingSeats || 0)
    || Number(left?.account?.recent_materialize_failures || 0) - Number(right?.account?.recent_materialize_failures || 0)
    || Number(left?.account?.recent_retry_failures || 0) - Number(right?.account?.recent_retry_failures || 0)
    || Number(right?.account?.recent_invite_successes || 0) - Number(left?.account?.recent_invite_successes || 0)
    || String(right?.workspaceUpdatedAt || '').localeCompare(String(left?.workspaceUpdatedAt || ''))
    || Number(left?.account?.id || 0) - Number(right?.account?.id || 0);
}

function buildWorkspaceCandidate(account, workspace, excludedWorkspaceIds = new Set()) {
  if (!account || !workspace) {
    return null;
  }

  const workspaceId = normalizeWorkspaceId(workspace.workspace_id);
  if (!workspaceId || excludedWorkspaceIds.has(workspaceId)) {
    return null;
  }

  const inviteTotal = Number(workspace.invite_total_hint || account.invite_total || 0);
  const memberSeats = Number(workspace.occupied_seats || 0);
  const memberTotal = Number(workspace.member_count || 0);
  const syncedPendingInvites = Number(workspace.pending_invites || 0);
  const localPendingInvites = getWorkspaceLocalPendingInviteCount(workspaceId);
  const transientReservations = getWorkspaceReservationCount(workspaceId);
  const pendingInvites = Math.max(syncedPendingInvites, localPendingInvites) + transientReservations;
  const reservedSeats = memberSeats + pendingInvites;
  const remainingSeats = inviteTotal - memberSeats;
  const projectedRemainingSeats = inviteTotal - reservedSeats;
  const memberLimit = getWorkspaceMemberLimit();
  const projectedMemberTotal = memberTotal + pendingInvites;
  const remainingMemberSlots = memberLimit - memberTotal;
  const projectedRemainingMemberSlots = memberLimit - projectedMemberTotal;

  if (
    inviteTotal <= 0
    || memberLimit <= 0
    || reservedSeats >= inviteTotal
    || reservedSeats >= memberLimit
  ) {
    return null;
  }

  return {
    account,
    workspaceId,
    workspaceName: normalizeWorkspaceName(workspace.workspace_name),
    inviteTotal,
    memberSeats,
    pendingInvites,
    reservedSeats,
    remainingSeats,
    projectedRemainingSeats,
    memberTotal,
    memberLimit,
    remainingMemberSlots,
    projectedRemainingMemberSlots,
    workspaceUpdatedAt: workspace.updated_at || '',
  };
}

function getInviteWorkspaceCandidates(excludedIds = [], options = {}) {
  const candidateAccounts = getInviteCandidateAccounts(excludedIds, options);
  if (candidateAccounts.length === 0) {
    return [];
  }

  const excludedWorkspaceIds = new Set(
    (Array.isArray(options.excludedWorkspaceIds) ? options.excludedWorkspaceIds : [])
      .map(workspaceId => normalizeWorkspaceId(workspaceId))
      .filter(Boolean)
  );

  const accountIds = candidateAccounts.map(account => account.id);
  const placeholders = accountIds.map(() => '?').join(',');
  const workspaceRows = db.prepare(`
    SELECT *
    FROM workspaces
    WHERE account_id IN (${placeholders})
      AND sync_status = 'success'
      AND COALESCE(workspace_id, '') != ''
      AND COALESCE(invite_locked, 0) = 0
      AND COALESCE(auto_invite_locked, 0) = 0
  `).all(...accountIds);

  const accountById = new Map(candidateAccounts.map(account => [account.id, account]));
  const candidates = workspaceRows
    .map(workspace => {
      const account = accountById.get(workspace.account_id);
      return buildWorkspaceCandidate(account, workspace, excludedWorkspaceIds);
    })
    .filter(Boolean)
    .sort(compareWorkspaceCandidatePriority);

  const dedupedByWorkspace = new Map();
  for (const candidate of candidates) {
    const existing = dedupedByWorkspace.get(candidate.workspaceId);
    if (!existing || compareWorkspaceCandidatePriority(candidate, existing) < 0) {
      dedupedByWorkspace.set(candidate.workspaceId, candidate);
    }
  }

  return [...dedupedByWorkspace.values()].sort(compareWorkspaceCandidatePriority);
}

function getAccountInviteWorkspaceCandidates(accountId, options = {}) {
  const normalizedAccountId = parseInt(accountId, 10);
  if (!Number.isInteger(normalizedAccountId) || normalizedAccountId <= 0) {
    return [];
  }

  const account = getAccountInviteDiagnostics(normalizedAccountId);
  if (!account || isInvitePaused(account) || isInviteDegraded(account)) {
    return [];
  }

  const excludedWorkspaceIds = new Set(
    normalizeWorkspaceIdList(options.excludedWorkspaceIds || [])
  );

  const workspaceRows = db.prepare(`
    SELECT *
    FROM workspaces
    WHERE account_id = ?
      AND sync_status = 'success'
      AND COALESCE(workspace_id, '') != ''
      AND COALESCE(invite_locked, 0) = 0
      AND COALESCE(auto_invite_locked, 0) = 0
    ORDER BY id ASC
  `).all(normalizedAccountId);

  return workspaceRows
    .map(workspace => buildWorkspaceCandidate(account, workspace, excludedWorkspaceIds))
    .filter(Boolean)
    .sort(compareWorkspaceCandidatePriority);
}

function getPreferredWorkspaceCandidate(preferredAccountId = 0, preferredWorkspaceId = '', options = {}) {
  const normalizedWorkspaceId = normalizeWorkspaceId(preferredWorkspaceId);
  if (!normalizedWorkspaceId) {
    return null;
  }

  const excludedAccountIds = new Set(normalizeIntegerIdList(options.excludedAccountIds || []));
  const excludedWorkspaceIds = new Set(normalizeWorkspaceIdList(options.excludedWorkspaceIds || []));
  if (excludedWorkspaceIds.has(normalizedWorkspaceId)) {
    return null;
  }

  const normalizedAccountId = parseInt(preferredAccountId, 10);
  const params = [normalizedWorkspaceId];
  let accountFilterSql = '';
  if (Number.isInteger(normalizedAccountId) && normalizedAccountId > 0) {
    accountFilterSql = ' AND accounts.id = ?';
    params.push(normalizedAccountId);
  }

  const row = db.prepare(`
    SELECT
      accounts.*,
      accounts.id AS account_id,
      accounts.email AS account_email,
      accounts.status AS account_status,
      COALESCE((
        SELECT COUNT(*)
        FROM invites
        WHERE invites.account_id = accounts.id
          AND (
            invites.failure_category = 'invite_not_materialized'
            OR (
              invites.failure_category = 'generic_error'
              AND LOWER(COALESCE(invites.message, '')) LIKE '%unable to invite user due to an error%'
            )
          )
          AND invites.updated_at >= datetime('now', '-${INVITE_FAILURE_WINDOW_HOURS} hours')
      ), 0) AS recent_materialize_failures,
      COALESCE((
        SELECT COUNT(*)
        FROM invites
        WHERE invites.account_id = accounts.id
          AND invites.failure_category IN ('revoke_failed', 'resend_failed')
          AND invites.updated_at >= datetime('now', '-${INVITE_FAILURE_WINDOW_HOURS} hours')
      ), 0) AS recent_retry_failures,
      COALESCE((
        SELECT COUNT(*)
        FROM invites
        WHERE invites.account_id = accounts.id
          AND invites.status = 'sent'
          AND invites.updated_at >= datetime('now', '-${INVITE_FAILURE_WINDOW_HOURS} hours')
      ), 0) AS recent_invite_successes,
      workspaces.*
    FROM workspaces
    JOIN accounts ON accounts.id = workspaces.account_id
    WHERE COALESCE(workspaces.workspace_id, '') = ?
      AND workspaces.sync_status = 'success'
      AND accounts.status = 'active'
      AND accounts.access_token IS NOT NULL
      AND accounts.access_token != ''
      ${accountFilterSql}
    ORDER BY CASE WHEN accounts.id = ? THEN 0 ELSE 1 END ASC, workspaces.id ASC
    LIMIT 1
  `).get(...params, Number.isInteger(normalizedAccountId) && normalizedAccountId > 0 ? normalizedAccountId : 0);

  if (!row) {
    return null;
  }

  if (excludedAccountIds.has(Number(row.account_id || 0))) {
    return null;
  }

  if (Number(row.invite_locked || 0) === 1 || Number(row.auto_invite_locked || 0) === 1) {
    return null;
  }

  const account = {
    ...row,
    id: Number(row.account_id || 0),
    email: String(row.account_email || row.email || '').trim(),
    status: String(row.account_status || row.status || '').trim(),
  };

  if (isInvitePaused(account) || isInviteDegraded(account)) {
    return null;
  }

  return buildWorkspaceCandidate(account, row, excludedWorkspaceIds);
}

function getAccountInviteDiagnostics(accountId) {
  return db.prepare(`
    SELECT ${ACCOUNT_INVITE_HEALTH_SELECT_SQL}
    FROM accounts AS accounts
    WHERE id = ?
      AND status = 'active'
      AND access_token IS NOT NULL
      AND access_token != ''
  `).get(accountId);
}

function isInviteDegraded(account) {
  if (!account) {
    return false;
  }

  const materializeFailures = Number(account.recent_materialize_failures || 0);
  const recentSuccesses = Number(account.recent_invite_successes || 0);

  return Number(account.invite_paused || 0) === 1
    || String(account.invite_health_status || '') === 'paused'
    || String(account.invite_health_status || '') === 'degraded'
    || (
      (materializeFailures >= INVITE_DEGRADED_THRESHOLD && recentSuccesses === 0)
      || materializeFailures >= INVITE_SEVERE_DEGRADED_THRESHOLD
    );
}

function isInvitePaused(account) {
  return Number(account?.invite_paused || 0) === 1
    || String(account?.invite_health_status || '') === 'paused';
}

function getInviteTotal(account) {
  return Math.max(0, parseInt(account?.invite_total, 10) || 0);
}

function getCapacitySnapshot(account, workspaceId = '') {
  if (!account) {
    return null;
  }

  const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
  const inviteTotal = getInviteTotal(account);

  if (normalizedWorkspaceId) {
    const workspace = db.prepare(`
      SELECT *
      FROM workspaces
      WHERE account_id = ?
        AND workspace_id = ?
      LIMIT 1
    `).get(account.id, normalizedWorkspaceId);

    if (workspace && String(workspace.sync_status || '') === 'success') {
      const total = Number(workspace.invite_total_hint || 0) > 0
        ? Number(workspace.invite_total_hint || 0)
        : inviteTotal;
      const memberSeats = Number(workspace.occupied_seats || 0);
      const memberTotal = Number(workspace.member_count || 0);
      const syncedPendingInvites = Number(workspace.pending_invites || 0);
      const localPendingInvites = getWorkspaceLocalPendingInviteCount(normalizedWorkspaceId);
      const transientReservations = getWorkspaceReservationCount(normalizedWorkspaceId);
      const pendingInvites = Math.max(syncedPendingInvites, localPendingInvites) + transientReservations;
      const reservedSeats = memberSeats + pendingInvites;
      const memberLimit = getWorkspaceMemberLimit();
      const projectedMemberTotal = memberTotal + pendingInvites;

      return {
        source: 'workspace',
        workspaceId: normalizedWorkspaceId,
        inviteTotal: total,
        memberSeats,
        memberTotal,
        memberLimit,
        pendingInvites,
        reservedSeats,
        remainingSeats: total - memberSeats,
        projectedRemainingSeats: total - reservedSeats,
        remainingMemberSlots: memberLimit - memberTotal,
        projectedRemainingMemberSlots: memberLimit - projectedMemberTotal,
        syncStatus: workspace.sync_status || '',
      };
    }

    const quotaWorkspaceId = normalizeWorkspaceId(account.quota_workspace_id);
    if (quotaWorkspaceId && quotaWorkspaceId !== normalizedWorkspaceId) {
      return null;
    }
  }

  const syncSuccess = String(account.quota_sync_status || '') === 'success';
  const memberSeats = syncSuccess
    ? Number(account.quota_member_seats || 0)
    : Number(account.invited_count || 0);
  const memberTotal = syncSuccess
    ? Number(account.quota_total_users || 0)
    : Number(account.workspace_member_count || account.quota_total_users || 0);
  const pendingInvites = syncSuccess
    ? Number(account.quota_pending_invites || 0)
    : 0;
  const reservedSeats = memberSeats + pendingInvites;
  const memberLimit = getWorkspaceMemberLimit();
  const projectedMemberTotal = memberTotal + pendingInvites;

  return {
    source: syncSuccess ? 'account_quota' : 'local',
    workspaceId: normalizeWorkspaceId(account.quota_workspace_id),
    inviteTotal,
    memberSeats,
    memberTotal,
    memberLimit,
    pendingInvites,
    reservedSeats,
    remainingSeats: inviteTotal - memberSeats,
    projectedRemainingSeats: inviteTotal - reservedSeats,
    remainingMemberSlots: memberLimit - memberTotal,
    projectedRemainingMemberSlots: memberLimit - projectedMemberTotal,
    syncStatus: account.quota_sync_status || '',
  };
}

function isCapacityAtLimit(capacity) {
  if (!capacity) {
    return false;
  }

  if (Number(capacity.inviteTotal || 0) <= 0) {
    return true;
  }

  return Number(capacity.reservedSeats || 0) >= Number(capacity.inviteTotal || 0)
    || Number(capacity.reservedSeats || 0) >= Number(capacity.memberLimit || getWorkspaceMemberLimit());
}

function buildCapacityFullResponse(account, capacity) {
  const memberSeats = Number(capacity?.memberSeats || 0);
  const memberTotal = Number(capacity?.memberTotal || 0);
  const memberLimit = Number(capacity?.memberLimit || getWorkspaceMemberLimit());
  const pendingInvites = Number(capacity?.pendingInvites || 0);
  const reservedSeats = Number(capacity?.reservedSeats || 0);
  const inviteTotal = Number(capacity?.inviteTotal || 0);
  const projectedMemberTotal = memberTotal + pendingInvites;

  return {
    error: `账号 ${account.email} 已达到邀请上限：当前成员总数 ${memberTotal}/${memberLimit}，待处理邀请 ${pendingInvites}，总预占 ${reservedSeats}/${inviteTotal}，已停止继续拉人`,
    failure_category: 'capacity_full',
    capacity: {
      member_seats: memberSeats,
      member_total: memberTotal,
      member_limit: memberLimit,
      projected_member_total: projectedMemberTotal,
      pending_invites: pendingInvites,
      reserved_seats: reservedSeats,
      invite_total: inviteTotal,
      projected_remaining_seats: Number(capacity?.projectedRemainingSeats || 0),
      projected_remaining_member_slots: Number(capacity?.projectedRemainingMemberSlots || 0),
      source: capacity?.source || '',
    },
  };
}

function isInviteRecordReusable(invite) {
  if (!invite) {
    return false;
  }

  const status = String(invite.status || '').toLowerCase();
  const remoteState = String(invite.remote_state || '').toLowerCase();
  const failureCategory = String(invite.failure_category || '').toLowerCase();

  if (failureCategory || ['error', 'failed', 'accepted'].includes(status)) {
    return false;
  }

  if (['missing', 'member', 'accepted'].includes(remoteState)) {
    return false;
  }

  return ['sent', 'pending'].includes(status) || (!status && Boolean(invite.remote_invite_id));
}

function clearInvitePauseState(accountId) {
  db.prepare(`
    UPDATE accounts
    SET invite_paused = 0,
        invite_pause_reason = '',
        invite_paused_at = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(accountId);
}

function restoreInviteHealthForAccount(accountId) {
  const restored = db.prepare(`
    UPDATE invites
    SET failure_category = CASE
      WHEN failure_category = 'invite_not_materialized' THEN 'invite_not_materialized_restored'
      WHEN failure_category = 'generic_error' THEN 'generic_error_restored'
      WHEN failure_category = 'revoke_failed' THEN 'revoke_failed_restored'
      WHEN failure_category = 'resend_failed' THEN 'resend_failed_restored'
      ELSE failure_category
    END
    WHERE account_id = ?
      AND failure_category IN ('invite_not_materialized', 'generic_error', 'revoke_failed', 'resend_failed')
      AND updated_at >= datetime('now', '-${INVITE_FAILURE_WINDOW_HOURS} hours')
  `).run(accountId);

  clearInvitePauseState(accountId);

  logInviteEvent(accountId, 'active', `[invite-health-restored] restored ${restored.changes} recent failure records`);

  return restored.changes;
}

function logInviteAttempts(context, targetEmail, attempts = []) {
  const seen = new Set();

  for (const attempt of attempts) {
    if (!attempt?.account?.id || !attempt?.result || attempt.result.success) {
      continue;
    }

    const message = String(attempt.result.message || '').trim();
    if (!message) {
      continue;
    }

    const key = `${attempt.account.id}:${message}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    logInviteEvent(attempt.account.id, 'error', `[${context}-attempt] ${targetEmail}: ${message}`);
  }
}

function buildInviteHealthDiagnosis(account) {
  const materializeFailures = Number(account.recent_materialize_failures || 0);
  const retryFailures = Number(account.recent_retry_failures || 0);
  const recentSuccesses = Number(account.recent_invite_successes || 0);
  const projectedRemaining = Number(account.projected_remaining || 0);
  const pauseReason = String(account.invite_pause_reason || '').trim();

  if (isInvitePaused(account)) {
    return pauseReason || '该账号已被系统暂停邀请，修复后可手动恢复';
  }

  if ((materializeFailures >= INVITE_DEGRADED_THRESHOLD && recentSuccesses === 0)
    || materializeFailures >= INVITE_SEVERE_DEGRADED_THRESHOLD) {
    return `近 ${INVITE_FAILURE_WINDOW_HOURS} 小时出现 ${materializeFailures} 次“假成功未落地”，建议暂停用于自动邀请`;
  }

  if (retryFailures > 0) {
    return `近 ${INVITE_FAILURE_WINDOW_HOURS} 小时出现 ${retryFailures} 次补发/撤销异常，建议观察`;
  }

  if (projectedRemaining <= 0) {
    return '当前没有可用邀请余量';
  }

  if (recentSuccesses > 0) {
    return `近 ${INVITE_FAILURE_WINDOW_HOURS} 小时成功邀请 ${recentSuccesses} 次`;
  }

  return '近期没有邀请异常';
}

function persistInviteSuccess(account, targetEmail, result) {
  const workspaceId = normalizeWorkspaceId(result.workspace_id || result.workspaceId || '');
  const workspaceName = normalizeWorkspaceName(result.workspace_name || result.workspaceName || '');
  const requestedAccountId = result.requested_account_id || account.id;
  const fallbackFromAccountId = result.fallback_from_account_id || null;
  const remoteInviteId = result.remote_invite_id || '';
  const deliveryType = result.delivery_type || (result.wasResend ? 'resend' : 'send');
  const failureCategory = result.failure_category || '';
  let cdkTaskId = String(result.cdk_task_id || result.cdkTaskId || '').trim();
  if (!cdkTaskId) {
    cdkTaskId = findCdkTeamTaskForInvite({
      ...result,
      target_email: targetEmail,
    });
    if (cdkTaskId) {
      result.cdk_task_id = cdkTaskId;
      result.cdkTaskId = cdkTaskId;
    }
  }
  const normalizedTargetEmail = normalizeEmail(targetEmail);
  const existingForTask = cdkTaskId
    ? db.prepare(`
      SELECT *
      FROM invites
      WHERE account_id = ?
        AND LOWER(target_email) = LOWER(?)
        AND COALESCE(workspace_id, '') = ?
        AND cdk_task_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(account.id, normalizedTargetEmail, workspaceId, cdkTaskId)
    : null;
  const latestExisting = findInviteRecord(account.id, normalizedTargetEmail, workspaceId);
  const existing = existingForTask || latestExisting;
  const existingTaskId = String(existing?.cdk_task_id || '').trim();
  const shouldInsertSeparateRecord = Boolean(existing && cdkTaskId && existingTaskId && existingTaskId !== cdkTaskId);

  if (!existing || shouldInsertSeparateRecord) {
    db.prepare(`UPDATE accounts SET updated_at = datetime('now') WHERE id = ?`).run(account.id);

    const insertInfo = db.prepare(`
      INSERT INTO invites (
        account_id,
        requested_account_id,
        fallback_from_account_id,
        target_email,
        status,
        message,
        remote_invite_id,
        delivery_type,
        workspace_id,
        workspace_name,
        failure_category,
        cdk_task_id
      ) VALUES (?, ?, ?, ?, 'sent', ?, ?, ?, ?, ?, ?, ?)
    `).run(account.id, requestedAccountId, fallbackFromAccountId, targetEmail, result.message, remoteInviteId, deliveryType, workspaceId, workspaceName, failureCategory, cdkTaskId);

    result.invite_id = Number(insertInfo.lastInsertRowid);
    result.inviteId = result.invite_id;
  } else {
    db.prepare(`
      UPDATE invites
      SET updated_at = datetime('now'),
          status = 'sent',
          message = ?,
          requested_account_id = ?,
          fallback_from_account_id = ?,
          remote_invite_id = ?,
          delivery_type = ?,
          workspace_id = ?,
          workspace_name = ?,
          failure_category = ?,
          cdk_task_id = CASE
            WHEN ? != '' AND COALESCE(cdk_task_id, '') = '' THEN ?
            ELSE cdk_task_id
          END
      WHERE id = ?
    `).run(result.message, requestedAccountId, fallbackFromAccountId, remoteInviteId, deliveryType, workspaceId, workspaceName, failureCategory, cdkTaskId, cdkTaskId, existing.id);
    db.prepare(`UPDATE accounts SET updated_at = datetime('now') WHERE id = ?`).run(account.id);

    result.invite_id = existing.id;
    result.inviteId = existing.id;
  }

  return shouldInsertSeparateRecord ? null : existing;
}

function normalizeCdkCode(value) {
  return String(value || '').trim().toUpperCase();
}

function findCdkTeamTaskForInvite(result = {}) {
  const explicitTaskId = String(result.cdk_task_id || result.cdkTaskId || '').trim();
  if (explicitTaskId) {
    return explicitTaskId;
  }

  const targetEmail = normalizeEmail(result.target_email || result.email || result.account_email).toLowerCase();
  const cdkCode = normalizeCdkCode(result.cdk_code || result.cdkCode);
  const cdkId = Number(result.cdk_id || result.cdkId || 0);

  if (!targetEmail || (!cdkCode && !cdkId)) {
    return '';
  }

  const params = {
    targetEmail,
    cdkCode,
    cdkId: cdkId > 0 ? cdkId : null,
  };
  const task = db.prepare(`
    SELECT id
    FROM cdk_tasks
    WHERE task_type = 'team_invite'
      AND LOWER(account_email) = LOWER(@targetEmail)
      AND UPPER(status) IN ('PENDING', 'PROCESSING', 'FAILED')
      AND (
        (@cdkId IS NOT NULL AND cdk_id = @cdkId)
        OR (@cdkCode != '' AND UPPER(TRIM(cdk_code)) = @cdkCode)
      )
    ORDER BY datetime(COALESCE(NULLIF(updated_at, ''), created_at)) DESC
    LIMIT 1
  `).get(params);

  return String(task?.id || '').trim();
}

function syncCdkTeamTaskAfterInvite(cdkTaskId, finalResult, source) {
  const normalizedTaskId = String(cdkTaskId || findCdkTeamTaskForInvite(finalResult) || '').trim();
  if (!normalizedTaskId) {
    return null;
  }

  finalResult.cdk_task_id = normalizedTaskId;
  finalResult.cdkTaskId = normalizedTaskId;

  try {
    const syncResult = completeCdkTeamTask(normalizedTaskId, finalResult, { source });
    if (!syncResult.completed && syncResult.reason !== 'cdk_already_completed') {
      const retry = scheduleCdkTeamTaskCompletionRetry(normalizedTaskId, finalResult, {
        source: `${source}_retry`,
      });
      console.error(
        `[CDK Team Sync] Task ${normalizedTaskId} not completed after invite success (${syncResult.reason || 'unknown'}); retry ${retry.scheduled ? 'scheduled' : retry.reason || 'skipped'}`
      );
    }
    return syncResult;
  } catch (syncErr) {
    const retry = scheduleCdkTeamTaskCompletionRetry(normalizedTaskId, finalResult, {
      source: `${source}_retry`,
    });
    console.error(
      `[CDK Team Sync] Failed to mark task ${normalizedTaskId} as success; retry ${retry.scheduled ? 'scheduled' : retry.reason || 'skipped'}:`,
      syncErr.message
    );
    return { completed: false, error: syncErr.message };
  }
}

function logInviteEvent(accountId, status, message) {
  db.prepare(`INSERT INTO check_logs (account_id, status, message) VALUES (?, ?, ?)`).run(accountId, status, message);
}

function persistInviteFailure(account, targetEmail, workspaceId, workspaceName, message) {
  const existing = findInviteRecord(account.id, targetEmail, workspaceId);
  const failureCategory = classifyFailure(message, 'error');

  if (!existing) {
    db.prepare(`
      INSERT INTO invites (
        account_id,
        requested_account_id,
        target_email,
        status,
        message,
        workspace_id,
        workspace_name,
        failure_category
      ) VALUES (?, ?, ?, 'error', ?, ?, ?, ?)
    `).run(account.id, account.id, targetEmail, message, workspaceId, workspaceName, failureCategory);
  } else {
    db.prepare(`
      UPDATE invites
      SET status = 'error',
          message = ?,
          workspace_id = ?,
          workspace_name = ?,
          failure_category = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(message, workspaceId, workspaceName, failureCategory, existing.id);
  }

  return failureCategory;
}

async function syncQuotaAfterInvite(account) {
  try {
    const quotaResult = await quotaSync.syncSingleAccountUsage(account);
    if (quotaResult.success || quotaResult.skipped) {
      return quotaResult;
    }

    logInviteEvent(account.id, 'error', `[quota-sync-after-invite] ${quotaResult.message}`);
    return null;
  } catch (err) {
    logInviteEvent(account.id, 'error', `[quota-sync-after-invite] ${err.message}`);
    return null;
  }
}

function formatInviteFailure(attempts) {
  return attempts.slice(0, 4).map(({ account, result }) => `${account.email}: ${result.message}`).join(' | ');
}

function shouldFallbackInviteResult(result) {
  const code = String(result?.code || '').trim().toLowerCase();
  const message = String(result?.message || '').trim().toLowerCase();

  if (
    result?.stopFallback
    || result?.stop_fallback
    || result?.invitationMayHaveBeenSent
    || result?.invitation_may_have_been_sent
  ) {
    return false;
  }

  return code === 'invite_not_materialized'
    || code === 'capacity_full'
    || code === 'workspace_lookup_failed'
    || code === 'invite_lookup_failed'
    || code === 'user_lookup_failed'
    || (code === 'create_failed' && (
      message.includes('deactivated_workspace')
      || message.includes('workspace not found')
      || message.includes('invalidated oauth token')
      || message.includes('http 401')
      || message.includes('http 402')
      || message.includes('http 403')
      || message.includes('http 404')
    ))
    || message.includes('deactivated_workspace')
    || message.includes('workspace not found')
    || message.includes('invalidated oauth token')
    || message.includes('encountered invalidated oauth token')
    || message.includes('http 401')
    || message.includes('http 402')
    || message.includes('http 403')
    || message.includes('http 404');
}

function shouldSyncQuotaAfterInvite(account, result, requestedWorkspaceId = '') {
  const finalWorkspaceId = normalizeWorkspaceId(result.workspace_id || result.workspaceId || requestedWorkspaceId);
  const quotaWorkspaceId = normalizeWorkspaceId(account.quota_workspace_id);

  if (!finalWorkspaceId || !quotaWorkspaceId) {
    return true;
  }

  return finalWorkspaceId === quotaWorkspaceId;
}

function getQuotaSyncSkippedReasonAfterInvite(account, result) {
  const finalWorkspaceId = normalizeWorkspaceId(result.workspace_id || result.workspaceId);
  const quotaWorkspaceId = normalizeWorkspaceId(account.quota_workspace_id);

  if (finalWorkspaceId && quotaWorkspaceId && finalWorkspaceId !== quotaWorkspaceId) {
    return '当前账号已绑定其他工作区的配额同步，本次指定工作区邀请后未自动刷新名额';
  }

  return null;
}

function enqueuePostInviteSync(account, shouldSyncQuota) {
  if (!account?.id) {
    return;
  }

  const existing = postInviteSyncByAccountId.get(account.id);
  if (existing) {
    existing.shouldSyncQuota = existing.shouldSyncQuota || shouldSyncQuota;
    return;
  }

  const item = { account, shouldSyncQuota };
  postInviteSyncByAccountId.set(account.id, item);
  postInviteSyncQueue.push(item);
  setImmediate(processPostInviteSyncQueue);
}

async function processPostInviteSyncQueue() {
  if (postInviteSyncRunning) {
    return;
  }

  postInviteSyncRunning = true;

  try {
    while (postInviteSyncQueue.length > 0) {
      const item = postInviteSyncQueue.shift();
      postInviteSyncByAccountId.delete(item.account.id);

      if (item.shouldSyncQuota) {
        await syncQuotaAfterInvite(item.account);
      }

      await workspaceSync.syncAccountWorkspaces(item.account).catch(err => {
        logInviteEvent(item.account.id, 'error', `[workspace-sync-after-invite] ${err.message}`);
      });
    }
  } finally {
    postInviteSyncRunning = false;
  }
}

function schedulePostInviteSync(account, result, requestedWorkspaceId = '') {
  const shouldSyncQuota = shouldSyncQuotaAfterInvite(account, result, requestedWorkspaceId);
  const quotaSyncSkippedReason = shouldSyncQuota ? null : getQuotaSyncSkippedReasonAfterInvite(account, result);

  enqueuePostInviteSync(account, shouldSyncQuota);

  return {
    quotaSyncScheduled: shouldSyncQuota,
    quotaSyncSkippedReason,
  };
}

async function sendInviteWithFallback(primaryAccount, targetEmail, options = {}) {
  const inviter = require('../services/inviter');
  const attempts = [];
  const requestedWorkspaceId = normalizeWorkspaceId(options.workspaceId);
  const requestedWorkspaceName = normalizeWorkspaceName(options.workspaceName);
  const primaryResult = await inviter.sendTeamInvite(primaryAccount, targetEmail, {
    forceResend: Boolean(options.forceResend),
    workspaceId: requestedWorkspaceId,
    workspaceName: requestedWorkspaceName,
    maxReservedSeats: getInviteTotal(primaryAccount),
  });

  attempts.push({ account: primaryAccount, result: primaryResult });

  if (
    primaryResult.success ||
    !options.allowFallback ||
    requestedWorkspaceId ||
    !shouldFallbackInviteResult(primaryResult)
  ) {
    return { account: primaryAccount, result: primaryResult, attempts };
  }

  const fallbackAccounts = getFallbackAccounts([primaryAccount.id]).slice(0, 6);

  for (const fallbackAccount of fallbackAccounts) {
    const fallbackResult = await inviter.sendTeamInvite(fallbackAccount, targetEmail, {
      forceResend: Boolean(options.forceResend),
      maxReservedSeats: getInviteTotal(fallbackAccount),
    });

    attempts.push({ account: fallbackAccount, result: fallbackResult });

    if (fallbackResult.success) {
      return { account: fallbackAccount, result: fallbackResult, attempts };
    }

    if (!shouldFallbackInviteResult(fallbackResult)) {
      return { account: fallbackAccount, result: fallbackResult, attempts };
    }
  }

  return {
    account: primaryAccount,
    result: {
      ...primaryResult,
      message: formatInviteFailure(attempts),
    },
    attempts,
  };
}

async function sendInviteWithWorkspaceCandidates(targetEmail, workspaceCandidates = [], options = {}) {
  const inviter = require('../services/inviter');
  const attempts = [];
  let lastFailure = null;

  for (const candidate of workspaceCandidates) {
    if (!candidate?.account || !candidate?.workspaceId) {
      continue;
    }

    if (isWorkspaceReservedForEmail(targetEmail, candidate.workspaceId)) {
      continue;
    }

    const reservation = reserveWorkspaceSlot(candidate.workspaceId, targetEmail);
    const result = await inviter.sendTeamInvite(candidate.account, targetEmail, {
      forceResend: Boolean(options.forceResend),
      workspaceId: candidate.workspaceId,
      workspaceName: candidate.workspaceName,
      maxReservedSeats: Number(candidate.inviteTotal || getInviteTotal(candidate.account)),
    });

    attempts.push({ account: candidate.account, result });

    if (result.success) {
      return {
        account: candidate.account,
        result,
        attempts,
        reservation,
        workspaceCandidate: candidate,
      };
    }

    releaseWorkspaceSlot(reservation);
    if (!shouldFallbackInviteResult(result)) {
      return {
        account: candidate.account,
        result,
        attempts,
        reservation: null,
        workspaceCandidate: candidate,
      };
    }

    lastFailure = {
      account: candidate.account,
      result,
      workspaceCandidate: candidate,
    };

  }

  if (lastFailure) {
    return {
      account: lastFailure.account,
      result: {
        ...lastFailure.result,
        message: formatInviteFailure(attempts) || lastFailure.result.message,
      },
      attempts,
      reservation: null,
      workspaceCandidate: lastFailure.workspaceCandidate,
    };
  }

  return {
    account: null,
    result: {
      success: false,
      code: 'no_workspace_candidate',
      message: 'No workspace candidate available',
    },
    attempts,
    reservation: null,
    workspaceCandidate: null,
  };
}

// GET /api/accounts — list all accounts with optional status filter
router.get('/', (req, res) => {
  const { status, search, page = 1, limit = 50 } = req.query;
  let query = `SELECT ${ACCOUNT_INVITE_HEALTH_SELECT_SQL} FROM accounts AS accounts`;
  let countQuery = 'SELECT COUNT(*) as count FROM accounts AS accounts';
  const conditions = [];
  const params = [];

  applyAccountsVisibilityFilter(conditions, { search });
  applyStatusFilter(conditions, params, status);
  if (search) {
    conditions.push('(email LIKE ? OR label LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  if (conditions.length > 0) {
    const whereClause = ' WHERE ' + conditions.join(' AND ');
    query += whereClause;
    countQuery += whereClause;
  }

  query += ' ORDER BY updated_at DESC';

  const offset = (parseInt(page) - 1) * parseInt(limit);
  const total = db.prepare(countQuery).get(...params).count;

  query += ` LIMIT ? OFFSET ?`;
  params.push(parseInt(limit), offset);

  const accounts = db.prepare(query).all(...params).map(account => ({
    ...account,
    ...getAccountWorkspaceInviteSummary(account.id),
  }));
  res.json({ accounts, total, page: parseInt(page), limit: parseInt(limit) });
});

router.get('/overflow-rebalance-records', (req, res) => {
  const requestedLimit = parseInt(req.query.limit, 10);
  const limit = Number.isInteger(requestedLimit)
    ? Math.max(1, Math.min(requestedLimit, 50))
    : 12;

  const rows = db.prepare(`
    SELECT
      check_logs.id,
      check_logs.account_id,
      check_logs.status,
      check_logs.message,
      check_logs.checked_at,
      accounts.email AS account_email
    FROM check_logs
    JOIN accounts ON accounts.id = check_logs.account_id
    WHERE check_logs.message LIKE '[overflow-rebalance]%'
      AND check_logs.message NOT LIKE '[overflow-rebalance] invite attempt %; trying next target workspace'
    ORDER BY datetime(check_logs.checked_at) DESC, check_logs.id DESC
    LIMIT ?
  `).all(limit);

  const records = rows.map(buildOverflowRebalanceRecord);
  res.json({ records, limit, total: records.length });
});

// GET /api/accounts/stats — overall statistics
router.get('/stats', (req, res) => {
  const activeQuotaCondition = `
    status = 'active'
    AND access_token IS NOT NULL
    AND access_token != ''
  `;

  const mainStats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN ${activeQuotaCondition} THEN 1 ELSE 0 END) AS currentTotal,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN status = 'banned' THEN 1 ELSE 0 END) AS banned,
      SUM(CASE WHEN status = 'invalid_credentials' THEN 1 ELSE 0 END) AS invalid,
      SUM(CASE WHEN status = 'no_password' THEN 1 ELSE 0 END) AS noPassword,
      SUM(CASE WHEN status IN ('unknown', 'error', 'rate_limited') THEN 1 ELSE 0 END) AS unknown,
      COALESCE(SUM(CASE WHEN ${activeQuotaCondition} THEN invited_count ELSE 0 END), 0) AS invitesUsed,
      COALESCE(SUM(CASE WHEN ${activeQuotaCondition} THEN invite_total ELSE 0 END), 0) AS invitesTotal,
      SUM(CASE WHEN ${activeQuotaCondition} THEN 1 ELSE 0 END) AS quotaSyncEligible,
      COALESCE(SUM(CASE WHEN ${activeQuotaCondition} AND quota_sync_status = 'success' THEN 1 ELSE 0 END), 0) AS quotaSynced,
      COALESCE(SUM(CASE WHEN ${activeQuotaCondition} AND quota_sync_status = 'error' THEN 1 ELSE 0 END), 0) AS quotaFailed,
      COALESCE(SUM(CASE WHEN ${activeQuotaCondition} AND quota_sync_status = 'skipped' THEN 1 ELSE 0 END), 0) AS quotaSkipped,
      COALESCE(SUM(CASE WHEN ${activeQuotaCondition} AND (quota_sync_status = 'never' OR quota_sync_status IS NULL OR TRIM(quota_sync_status) = '') THEN 1 ELSE 0 END), 0) AS quotaNever,
      COALESCE(SUM(CASE WHEN ${activeQuotaCondition} AND invited_count > invite_total THEN 1 ELSE 0 END), 0) AS overQuota,
      COALESCE(SUM(CASE WHEN ${activeQuotaCondition} AND invited_count >= invite_total THEN 1 ELSE 0 END), 0) AS fullQuota,
      MAX(CASE WHEN ${activeQuotaCondition} THEN quota_last_synced_at ELSE NULL END) AS quotaLastSyncedAt
    FROM accounts
  `).get();

  const inviteHealthStats = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN ${INVITE_HEALTH_STATUS_SQL} = 'paused' THEN 1 ELSE 0 END), 0) AS paused,
      COALESCE(SUM(CASE WHEN ${INVITE_HEALTH_STATUS_SQL} = 'degraded' THEN 1 ELSE 0 END), 0) AS degraded,
      COALESCE(SUM(CASE WHEN ${INVITE_HEALTH_STATUS_SQL} = 'warning' THEN 1 ELSE 0 END), 0) AS warning,
      COALESCE(SUM(CASE WHEN ${INVITE_HEALTH_STATUS_SQL} = 'healthy' THEN 1 ELSE 0 END), 0) AS healthy
    FROM accounts AS accounts
    WHERE status = 'active'
      AND access_token IS NOT NULL
      AND access_token != ''
  `).get();

  res.json({
    total: mainStats.total,
    currentTotal: mainStats.currentTotal,
    active: mainStats.active,
    banned: mainStats.banned,
    invalid: mainStats.invalid,
    noPassword: mainStats.noPassword,
    unknown: mainStats.unknown,
    badInviteAccounts: inviteHealthStats.degraded + inviteHealthStats.paused,
    pausedInviteAccounts: inviteHealthStats.paused,
    watchInviteAccounts: inviteHealthStats.warning,
    healthyInviteAccounts: inviteHealthStats.healthy,
    invitesUsed: mainStats.invitesUsed,
    invitesTotal: mainStats.invitesTotal,
    quotaSyncEligible: mainStats.quotaSyncEligible,
    quotaSyncSuccess: mainStats.quotaSynced,
    quotaSyncError: mainStats.quotaFailed,
    quotaSyncSkipped: mainStats.quotaSkipped,
    quotaSyncNever: mainStats.quotaNever,
    quotaLastSyncedAt: mainStats.quotaLastSyncedAt,
    overQuota: mainStats.overQuota,
    fullQuota: mainStats.fullQuota,
  });
});

// GET /api/accounts/invalid-credentials - hidden invalid token accounts for dashboard
router.get('/invalid-credentials', (req, res) => {
  const accounts = db.prepare(`
    SELECT
      accounts.id,
      accounts.email,
      accounts.label,
      accounts.status,
      accounts.last_checked,
      accounts.updated_at,
      COALESCE((
        SELECT message
        FROM check_logs
        WHERE check_logs.account_id = accounts.id
        ORDER BY datetime(check_logs.checked_at) DESC, check_logs.id DESC
        LIMIT 1
      ), '') AS last_message
    FROM accounts AS accounts
    WHERE accounts.status = 'invalid_credentials'
    ORDER BY COALESCE(accounts.last_checked, accounts.updated_at) DESC, accounts.id DESC
  `).all();

  res.json({
    total: accounts.length,
    accounts,
  });
});

router.get('/invite-health', (req, res) => {
  const { account_id: accountId, only_bad: onlyBad } = req.query;
  const conditions = [
    "status = 'active'",
    "access_token IS NOT NULL",
    "access_token != ''",
  ];
  const params = [];

  if (accountId) {
    conditions.push('accounts.id = ?');
    params.push(accountId);
  }

  if (String(onlyBad || '').toLowerCase() === 'true') {
    conditions.push(`${INVITE_HEALTH_STATUS_SQL} IN ('paused', 'degraded')`);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  const accounts = db.prepare(`
    SELECT ${ACCOUNT_INVITE_HEALTH_SELECT_SQL}
    FROM accounts AS accounts
    ${whereClause}
    ORDER BY
      CASE invite_health_status
        WHEN 'paused' THEN 0
        WHEN 'degraded' THEN 0
        WHEN 'warning' THEN 1
        ELSE 2
      END ASC,
      recent_materialize_failures DESC,
      recent_retry_failures DESC,
      projected_remaining DESC,
      updated_at DESC
  `).all(...params).map(account => ({
    ...account,
    diagnosis: buildInviteHealthDiagnosis(account),
  }));

  const summary = accounts.reduce((acc, account) => {
    acc.total += 1;
    if (account.invite_health_status === 'paused') acc.paused += 1;
    else if (account.invite_health_status === 'degraded') acc.degraded += 1;
    else if (account.invite_health_status === 'warning') acc.warning += 1;
    else acc.healthy += 1;

    if (Number(account.projected_remaining || 0) > 0) {
      acc.hasCapacity += 1;
    }

    return acc;
  }, {
    total: 0,
    paused: 0,
    degraded: 0,
    warning: 0,
    healthy: 0,
    hasCapacity: 0,
  });

  res.json({
    summary,
    accounts,
    window_hours: INVITE_FAILURE_WINDOW_HOURS,
    threshold: INVITE_DEGRADED_THRESHOLD,
  });
});

router.post('/restore-invite-health', (req, res) => {
  const accounts = db.prepare(`
    SELECT ${ACCOUNT_INVITE_HEALTH_SELECT_SQL}
    FROM accounts AS accounts
    WHERE status = 'active'
      AND access_token IS NOT NULL
      AND access_token != ''
      AND ${INVITE_HEALTH_STATUS_SQL} IN ('paused', 'degraded', 'warning')
  `).all();

  let restoredRecords = 0;
  for (const account of accounts) {
    restoredRecords += restoreInviteHealthForAccount(account.id);
  }

  return res.json({
    message: `已修复 ${accounts.length} 个邀请状态异常账号`,
    restoredAccounts: accounts.length,
    restoredRecords,
  });
});

router.post('/sync-quotas', async (req, res) => {
  try {
    const results = await quotaSync.syncAllAccountUsage();
    const summary = quotaSync.summarizeQuotaResults(results);
    const post_quota_maintenance = await runPostQuotaMaintenance(results);

    res.json({
      message: `Quota sync completed: ${summary.synced} synced, ${summary.failed} failed`,
      ...summary,
      post_quota_maintenance,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/accounts/:id/workspaces — list workspaces for an account
router.get('/:id(\\d+)/workspaces', async (req, res) => {
  const { id } = req.params;
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);

  if (!account) {
    return res.status(404).json({ error: 'Account not found' });
  }

  if (!account.access_token) {
    return res.status(400).json({ error: '账号尚未授权' });
  }

  try {
    const result = await listAccountWorkspaces(account);
    if (!result.success) {
      return res.status(500).json({ error: result.message });
    }

    const lockedWorkspaceIds = new Set(
      db.prepare(`
        SELECT workspace_id
        FROM workspaces
        WHERE account_id = ?
          AND (COALESCE(invite_locked, 0) = 1 OR COALESCE(auto_invite_locked, 0) = 1)
      `).all(id).map(row => normalizeWorkspaceId(row.workspace_id)).filter(Boolean)
    );

    const workspaces = (result.workspaces || []).filter(workspace =>
      !lockedWorkspaceIds.has(
        normalizeWorkspaceId(workspace?.id || workspace?.workspace_id || '')
      )
    );

    const defaultWorkspaceId = !lockedWorkspaceIds.has(normalizeWorkspaceId(result.default_workspace_id || ''))
      ? (result.default_workspace_id || '')
      : (workspaces[0]?.id || workspaces[0]?.workspace_id || '');
    const defaultWorkspace = workspaces.find(workspace =>
      normalizeWorkspaceId(workspace?.id || workspace?.workspace_id || '') === normalizeWorkspaceId(defaultWorkspaceId)
    );

    return res.json({
      workspaces,
      default_workspace_id: defaultWorkspaceId,
      default_workspace_name: defaultWorkspace?.name || defaultWorkspace?.workspace_name || result.default_workspace_name || '',
      default_plan_type: defaultWorkspace?.plan_type || result.default_plan_type || '',
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/', (req, res) => {
  const { email, password, label, invite_link, invite_total, invited_count } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const result = db.prepare(`
    INSERT INTO accounts (email, password, label, invite_link, invite_total, invited_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(email, password || '', label || '', invite_link || '', invite_total || 4, invited_count || 0);

  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(account);
});

// POST /api/accounts/batch — bulk import
router.post('/batch', (req, res) => {
  const { accounts } = req.body;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return res.status(400).json({ error: 'Accounts array is required' });
  }

  const insert = db.prepare(`
    INSERT INTO accounts (email, password, label, invite_link, invite_total, invited_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let imported = 0;
  let errors = [];

  const importBatch = db.transaction(() => {
    for (const acc of accounts) {
      try {
        if (!acc.email) {
          errors.push({ email: acc.email || 'unknown', error: 'Email is required' });
          continue;
        }
        insert.run(
          acc.email,
          acc.password || '',
          acc.label || '',
          acc.invite_link || '',
          acc.invite_total || 4,
          acc.invited_count || 0
        );
        imported++;
      } catch (err) {
        errors.push({ email: acc.email, error: err.message });
      }
    }
  });

  importBatch();
  res.status(201).json({ imported, errors, total: accounts.length });
});

// PUT /api/accounts/:id — update account
router.put('/:id', (req, res) => {
  const { id } = req.params;
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!account) {
    return res.status(404).json({ error: 'Account not found' });
  }

  const fields = ['email', 'password', 'label', 'invite_link', 'invite_total', 'invited_count', 'status'];
  const updates = [];
  const params = [];

  for (const field of fields) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = ?`);
      params.push(req.body[field]);
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  updates.push("updated_at = datetime('now')");
  params.push(id);

  db.prepare(`UPDATE accounts SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const updated = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  res.json(updated);
});

// DELETE /api/accounts/:id — delete account
router.delete('/:id', (req, res) => {
  const { id } = req.params;
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!account) {
    return res.status(404).json({ error: 'Account not found' });
  }

  db.prepare('DELETE FROM check_logs WHERE account_id = ?').run(id);
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  res.json({ message: 'Account deleted' });
});

// DELETE /api/accounts — delete multiple accounts
router.delete('/', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Account IDs array is required' });
  }

  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM check_logs WHERE account_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM accounts WHERE id IN (${placeholders})`).run(...ids);
  res.json({ deleted: ids.length });
});

// POST /api/accounts/:id/sync-quota — sync quota for a single account
router.post('/:id(\\d+)/sync-quota', async (req, res) => {
  const { id } = req.params;
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);

  if (!account) {
    return res.status(404).json({ error: 'Account not found' });
  }

  try {
    const result = await quotaSync.syncSingleAccountUsage(account);
    if (result.success || result.skipped) {
      const post_quota_maintenance = await runPostQuotaMaintenance(result);
      return res.json({
        ...result,
        post_quota_maintenance,
      });
    }

    return res.status(500).json({ error: result.message });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/:id(\\d+)/restore-invite-health', (req, res) => {
  const { id } = req.params;
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);

  if (!account) {
    return res.status(404).json({ error: 'Account not found' });
  }

  const restoredRecords = restoreInviteHealthForAccount(id);

  const diagnostics = getAccountInviteDiagnostics(id) || {
    id: account.id,
    email: account.email,
    invite_paused: 0,
    invite_pause_reason: '',
    recent_materialize_failures: 0,
    recent_retry_failures: 0,
    recent_invite_successes: 0,
    projected_remaining: Number(account.invite_total || 0) - Number(account.invited_count || 0),
    invite_health_status: 'healthy',
    invite_health_label: '正常',
  };

  return res.json({
    message: `已恢复 ${account.email} 的坏号状态`,
    restored: restoredRecords,
    account: {
      ...diagnostics,
      diagnosis: buildInviteHealthDiagnosis(diagnostics),
    },
  });
});

router.post('/:id(\\d+)/invite', async (req, res) => {
  let workspaceReservation = null;

  try {
    const { email, force_resend: forceResend, workspace_id: workspaceId, workspace_name: workspaceName } = req.body;
    if (!email) {
      return res.status(400).json({ error: '请提供目标邮箱地址' });
    }

    const { id } = req.params;
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    if (!account.access_token) {
      return res.status(400).json({ error: '该账号尚未进行 OAuth 授权，请先授权' });
    }
    const targetEmail = normalizeEmail(email);
    if (!isValidEmail(targetEmail)) {
      return res.status(400).json({ error: `Invalid email address: ${targetEmail}`, failure_category: 'invalid_email' });
    }
    const historicalMemberships = getHistoricalWorkspaceMemberships(targetEmail);
    const historicalWorkspaceIds = Array.from(new Set(
      [
        ...historicalMemberships.map(item => normalizeWorkspaceId(item.workspace_id)),
        ...getEmailReservedWorkspaceIds(targetEmail),
      ].filter(Boolean)
    ));
    const selectedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const selectedWorkspaceName = normalizeWorkspaceName(workspaceName);
    if (selectedWorkspaceId && historicalWorkspaceIds.includes(selectedWorkspaceId)) {
      return res.status(409).json({
        error: '该邮箱曾进入过这个空间，重新邀请时不能回到原空间',
        failure_category: 'historical_workspace_blocked',
      });
    }
    if (selectedWorkspaceId && isWorkspaceInviteLocked(selectedWorkspaceId, account.id)) {
      return res.status(409).json({
        error: '该工作区已锁定，不参与邀请分配',
        failure_category: 'workspace_locked',
      });
    }
    const accountDiagnostics = getAccountInviteDiagnostics(account.id) || account;

    if (isInvitePaused(accountDiagnostics)) {
      return res.status(409).json({
        error: accountDiagnostics.invite_pause_reason || '该账号已被系统暂停邀请，请修复后恢复',
        failure_category: 'invite_paused',
      });
    }

    const cooldownInvite = !forceResend
      ? findRecentInviteWithinCooldown(account.id, targetEmail, selectedWorkspaceId)
      : null;
    if (cooldownInvite) {
      return res.status(429).json({
        error: `Cooldown active for ${targetEmail} in the selected workspace`,
        failure_category: 'cooldown',
      });
    }

    const existingSelectedInvite = findInviteRecord(account.id, targetEmail, selectedWorkspaceId);
    const resendOnly = Boolean(forceResend && isInviteRecordReusable(existingSelectedInvite));
    const accountWorkspaceCandidates = !selectedWorkspaceId
      ? getAccountInviteWorkspaceCandidates(account.id, {
        excludedWorkspaceIds: historicalWorkspaceIds,
      })
      : [];
    const useAccountWorkspaceCandidates = !selectedWorkspaceId && accountWorkspaceCandidates.length > 0;
    const capacity = useAccountWorkspaceCandidates ? null : getCapacitySnapshot(accountDiagnostics, selectedWorkspaceId);
    if (!useAccountWorkspaceCandidates && !selectedWorkspaceId) {
      return res.status(409).json({
        error: historicalWorkspaceIds.length > 0
          ? `该邮箱 ${targetEmail} 已进入过当前账号现有可用空间，或当前账号没有可用空间`
          : '当前账号没有可用工作区，已锁定或已满员',
        failure_category: historicalWorkspaceIds.length > 0 ? 'historical_workspace_blocked' : 'workspace_locked',
      });
    }
    if (!useAccountWorkspaceCandidates && !resendOnly && isCapacityAtLimit(capacity)) {
      return res.status(409).json(buildCapacityFullResponse(account, capacity));
    }

    if (!selectedWorkspaceId) {
      const selectedAccountDiagnostics = getInviteCandidateAccounts([], { includeDegraded: true, includePaused: true })
        .find(item => item.id === account.id);
      const healthyFallbacks = getFallbackAccounts([account.id]);

      if (selectedAccountDiagnostics && isInvitePaused(selectedAccountDiagnostics)) {
        return res.status(409).json({
          error: selectedAccountDiagnostics.invite_pause_reason || '该账号已被系统暂停邀请，请修复后恢复',
          failure_category: 'invite_paused',
        });
      }

      if (
        selectedAccountDiagnostics &&
        isInviteDegraded(selectedAccountDiagnostics) &&
        healthyFallbacks.length === 0
      ) {
        return res.status(409).json({
          error: '当前选中的账号近期连续出现邀请假成功，且没有健康 fallback 账号可用，请先修复后再试',
          failure_category: 'invite_degraded',
        });
      }

      if (accountWorkspaceCandidates.length === 0) {
        return res.status(409).json({
          error: `该邮箱 ${targetEmail} 已进入过现有可用空间，当前没有新的空间可分配`,
          failure_category: 'historical_workspace_blocked',
        });
      }
    }

    const delivery = useAccountWorkspaceCandidates
      ? await sendInviteWithWorkspaceCandidates(targetEmail, accountWorkspaceCandidates, {
        forceResend: false,
      })
      : await sendInviteWithFallback(account, targetEmail, {
        forceResend: Boolean(forceResend),
        allowFallback: !selectedWorkspaceId,
        workspaceId: selectedWorkspaceId,
        workspaceName: selectedWorkspaceName,
      });
    workspaceReservation = delivery.reservation || null;
    const usedAccount = delivery.account;
    const result = delivery.result;

    if (result.success) {
      const fallbackUsed = usedAccount.id !== account.id;
      const cdkTaskId = String(req.body.cdk_task_id || req.body.cdkTaskId || '').trim();
      const requestCdkId = req.body.cdk_id || req.body.cdkId || '';
      const requestCdkCode = normalizeCdkCode(req.body.cdk_code || req.body.cdkCode || '');
      const finalResult = {
        ...result,
        target_email: targetEmail,
        cdk_task_id: cdkTaskId || result.cdk_task_id || result.cdkTaskId || '',
        cdk_id: requestCdkId || result.cdk_id || result.cdkId || '',
        cdk_code: requestCdkCode || result.cdk_code || result.cdkCode || '',
        requested_account_id: account.id,
        fallback_from_account_id: fallbackUsed ? account.id : null,
        remote_invite_id: result.remoteInviteId || result.remote_invite_id || '',
        delivery_type: result.wasResend ? 'resend' : 'send',
        workspace_id: result.workspaceId || result.workspace_id || selectedWorkspaceId || normalizeWorkspaceId(delivery.workspaceCandidate?.workspaceId),
        workspace_name: result.workspaceName || result.workspace_name || selectedWorkspaceName || normalizeWorkspaceName(delivery.workspaceCandidate?.workspaceName),
        plan_type: result.planType || result.plan_type || '',
        failure_category: '',
        message: fallbackUsed
          ? `${result.message}（备用账号：${usedAccount.email}）`
          : result.message,
      };
      const existing = persistInviteSuccess(usedAccount, targetEmail, finalResult);
      if (workspaceReservation) {
        releaseWorkspaceSlot(workspaceReservation);
        workspaceReservation = null;
      }
      syncCdkTeamTaskAfterInvite(cdkTaskId, finalResult, 'manual_invite_route_success');
      const postInviteSync = schedulePostInviteSync(usedAccount, finalResult, selectedWorkspaceId);

      logInviteAttempts(finalResult.wasResend ? 'manual-resend' : 'manual-invite', targetEmail, delivery.attempts);

      logInviteEvent(
        usedAccount.id,
        'active',
        `${existing || finalResult.wasResend ? '[resend] ' : '[invite] '}invite sent to ${targetEmail}${fallbackUsed ? ` via fallback from ${account.email}` : ''}`
      );
        
      res.json({
        ...finalResult,
        used_account: usedAccount.email,
        used_account_id: usedAccount.id,
        fallback_from_account: fallbackUsed ? account.email : null,
        workspace_id: finalResult.workspace_id,
        workspace_name: finalResult.workspace_name,
        plan_type: finalResult.plan_type,
        is_resend: !!existing || !!finalResult.wasResend || Boolean(forceResend) || fallbackUsed,
        quota_sync: null,
        quota_sync_pending: postInviteSync.quotaSyncScheduled,
        quota_sync_skipped_reason: postInviteSync.quotaSyncSkippedReason,
      });
    } else {
      logInviteAttempts(Boolean(forceResend) ? 'manual-resend' : 'manual-invite', targetEmail, delivery.attempts);
      if (workspaceReservation) {
        releaseWorkspaceSlot(workspaceReservation);
        workspaceReservation = null;
      }
      if (result.code === 'capacity_full') {
        const fullAccount = delivery.account || account;
        logInviteEvent(fullAccount.id, 'error', `[invite-blocked-capacity] ${targetEmail}: ${result.message}`);
        return res.status(409).json(buildCapacityFullResponse(fullAccount, result.capacity));
      }

      const failureWorkspaceId = normalizeWorkspaceId(result.workspaceId || result.workspace_id || selectedWorkspaceId || delivery.workspaceCandidate?.workspaceId);
      const failureWorkspaceName = normalizeWorkspaceName(result.workspaceName || result.workspace_name || selectedWorkspaceName || delivery.workspaceCandidate?.workspaceName);
      const failureCategory = persistInviteFailure(account, targetEmail, failureWorkspaceId, failureWorkspaceName, result.message);
      logInviteEvent(account.id, 'error', `[invite-failed] ${targetEmail}: ${result.message}`);
      res.status(500).json({ error: result.message, failure_category: failureCategory });
    }
  } catch (err) {
    if (workspaceReservation) {
      releaseWorkspaceSlot(workspaceReservation);
      workspaceReservation = null;
    }
    res.status(500).json({ error: err.message });
  }
});

// POST /api/accounts/auto-invite - send team invitation automatically using an available account
router.post('/auto-invite', async (req, res) => {
  let workspaceReservation = null;

  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: '请提供目标邮箱地址' });
    }

    // First check if this email was already invited
    let account = null;
    let workspaceCandidates = [];
    const targetEmail = normalizeEmail(email);
    const preferFreshWorkspace = Boolean(
      req.body.prefer_fresh_workspace
      || req.body.preferFreshWorkspace
      || req.body.cdk_task_id
      || req.body.cdkTaskId
      || req.body.cdk_code
      || req.body.cdkCode
    );
    const externalExcludedAccountIds = normalizeIntegerIdList(
      req.body.exclude_account_ids || req.body.excludeAccountIds || []
    );
    const externalExcludedWorkspaceIds = normalizeWorkspaceIdList(
      req.body.exclude_workspace_ids || req.body.excludeWorkspaceIds || []
    );
    const preferredWorkspaceId = normalizeWorkspaceId(
      req.body.preferred_workspace_id || req.body.preferredWorkspaceId || ''
    );
    const preferredWorkspaceName = normalizeWorkspaceName(
      req.body.preferred_workspace_name || req.body.preferredWorkspaceName || ''
    );
    const preferredAccountId = normalizeIntegerIdList(
      req.body.preferred_account_id || req.body.preferredAccountId || []
    )[0] || 0;
    const allowPreferredWorkspaceFallback = Boolean(
      req.body.allow_preferred_workspace_fallback || req.body.allowPreferredWorkspaceFallback
    );
    const preferredWorkspaceLocked = preferredWorkspaceId
      ? isWorkspaceInviteLocked(preferredWorkspaceId, preferredAccountId)
      : false;
    if (preferredWorkspaceLocked && !allowPreferredWorkspaceFallback) {
      return res.status(409).json({
        error: `指定目标空间已锁定：${preferredWorkspaceName || preferredWorkspaceId}`,
        failure_category: 'workspace_locked',
      });
    }
    if (!isValidEmail(targetEmail)) {
      return res.status(400).json({ error: `Invalid email address: ${targetEmail}`, failure_category: 'invalid_email' });
    }
    const historicalMemberships = getHistoricalWorkspaceMemberships(targetEmail);
    const historicalWorkspaceIds = Array.from(new Set(
      [
        ...historicalMemberships.map(item => normalizeWorkspaceId(item.workspace_id)),
        ...getEmailReservedWorkspaceIds(targetEmail),
      ].filter(Boolean)
    ));
    const preferredWorkspaceBlockedByHistory = preferredWorkspaceId
      ? historicalWorkspaceIds.includes(preferredWorkspaceId)
      : false;
    if (preferredWorkspaceBlockedByHistory && !allowPreferredWorkspaceFallback) {
      return res.status(409).json({
        error: `该邮箱曾进入过目标空间：${preferredWorkspaceName || preferredWorkspaceId}，重新邀请时不能回到原空间`,
        failure_category: 'historical_workspace_blocked',
      });
    }
    const inviteHistory = preferFreshWorkspace ? getInviteHistoryByEmail(targetEmail) : [];
    const usedWorkspaceIds = Array.from(new Set(
      [
        ...inviteHistory.map(item => normalizeWorkspaceId(item.workspace_id)),
        ...historicalWorkspaceIds,
      ]
        .filter(Boolean)
    ));
    const usedAccountIds = Array.from(new Set(
      inviteHistory
        .flatMap(item => [Number(item.account_id || 0), Number(item.requested_account_id || 0)])
        .filter(id => Number.isInteger(id) && id > 0)
    ));
    const existingInvite = db.prepare(`
      SELECT *
      FROM invites
      WHERE LOWER(target_email) = LOWER(?)
      ORDER BY created_at DESC
      LIMIT 1
    `).get(targetEmail);
    const existingInviteWorkspaceId = normalizeWorkspaceId(existingInvite?.workspace_id);
    const existingInviteWorkspaceLocked = existingInviteWorkspaceId
      ? isWorkspaceInviteLocked(existingInviteWorkspaceId, Number(existingInvite?.account_id || 0))
      : false;
    
    if (
      !preferFreshWorkspace
      && existingInvite
      && isInviteRecordReusable(existingInvite)
      && !existingInviteWorkspaceLocked
      && !externalExcludedAccountIds.includes(Number(existingInvite.account_id || 0))
      && !externalExcludedWorkspaceIds.includes(normalizeWorkspaceId(existingInvite.workspace_id))
    ) {
      const existingInviteAccount = getAccountInviteDiagnostics(existingInvite.account_id);
      if (existingInviteAccount && !isInviteDegraded(existingInviteAccount) && !isInvitePaused(existingInviteAccount)) {
        account = existingInviteAccount;
      }
    }
    
    if (!account) {
      const excludedIds = Array.from(new Set([
        ...(existingInvite?.account_id ? [existingInvite.account_id] : []),
        ...externalExcludedAccountIds,
      ]));
      const strictExcludedIds = preferFreshWorkspace
        ? Array.from(new Set([...excludedIds, ...usedAccountIds]))
        : excludedIds;
      const effectiveExcludedWorkspaceIds = Array.from(new Set([
        ...usedWorkspaceIds,
        ...externalExcludedWorkspaceIds,
      ]));
      const preferredWorkspaceCandidate = (!preferredWorkspaceLocked && !preferredWorkspaceBlockedByHistory)
        ? getPreferredWorkspaceCandidate(preferredAccountId, preferredWorkspaceId, {
          excludedAccountIds: strictExcludedIds,
          excludedWorkspaceIds: effectiveExcludedWorkspaceIds,
        })
        : null;
      const getNonPausedDegradedWorkspaceCandidates = excludedAccountIds =>
        getInviteWorkspaceCandidates(excludedAccountIds, {
          excludedWorkspaceIds: effectiveExcludedWorkspaceIds,
          includeDegraded: true,
        }).filter(candidate => !isInvitePaused(candidate?.account));
      workspaceCandidates = getInviteWorkspaceCandidates(strictExcludedIds, {
        excludedWorkspaceIds: effectiveExcludedWorkspaceIds,
      });

      if (workspaceCandidates.length === 0) {
        workspaceCandidates = getNonPausedDegradedWorkspaceCandidates(strictExcludedIds);
      }

      if (preferFreshWorkspace && workspaceCandidates.length === 0 && usedWorkspaceIds.length > 0) {
        workspaceCandidates = getInviteWorkspaceCandidates(excludedIds, {
          excludedWorkspaceIds: effectiveExcludedWorkspaceIds,
        });

        if (workspaceCandidates.length === 0) {
          workspaceCandidates = getNonPausedDegradedWorkspaceCandidates(excludedIds);
        }
      }

      if (preferredWorkspaceCandidate) {
        if (preferredWorkspaceId && !allowPreferredWorkspaceFallback) {
          workspaceCandidates = [preferredWorkspaceCandidate];
        } else {
          workspaceCandidates = [
            preferredWorkspaceCandidate,
            ...workspaceCandidates.filter(candidate =>
              normalizeWorkspaceId(candidate?.workspaceId) !== normalizeWorkspaceId(preferredWorkspaceCandidate.workspaceId)
            ),
          ];
        }
      } else {
        workspaceCandidates = prioritizeWorkspaceCandidates(
          workspaceCandidates,
          preferredWorkspaceId,
          preferredAccountId
        );
      }

      if (
        preferredWorkspaceId
        && !preferredWorkspaceCandidate
        && !allowPreferredWorkspaceFallback
      ) {
        return res.status(409).json({
          error: `指定目标空间当前不可用：${preferredWorkspaceName || preferredWorkspaceId}`,
          failure_category: 'preferred_workspace_unavailable',
        });
      }

      if (workspaceCandidates.length > 0) {
        account = workspaceCandidates[0].account;
      }
    }

    if (!account) {
      if (historicalWorkspaceIds.length > 0) {
        return res.status(409).json({
          error: `该邮箱 ${targetEmail} 曾进入过现有可用空间，当前没有新的空间可分配`,
          failure_category: 'historical_workspace_blocked',
        });
      }
      if (preferFreshWorkspace) {
        return res.status(409).json({
          error: usedWorkspaceIds.length > 0
            ? `该邮箱 ${targetEmail} 已在现有可用空间里有邀请记录，当前没有新的空间可分配`
            : '当前没有可用于新 CDK 激活的空间，请稍后再试',
          failure_category: 'no_fresh_workspace',
        });
      }

      const degradedCandidates = getInviteWorkspaceCandidates([], { includeDegraded: true, includePaused: true })
        .map(item => item.account);
      if (degradedCandidates.length > 0) {
        const pausedCandidates = degradedCandidates.filter(item => isInvitePaused(item));
        return res.status(409).json({
          error: pausedCandidates.length > 0
            ? '当前有可用余量账号，但它们已被系统暂停邀请，请先修复后恢复'
            : '当前有可用余量账号，但近期连续出现邀请异常，已自动跳过',
          failure_category: pausedCandidates.length > 0 ? 'invite_paused' : 'invite_degraded',
        });
      }
    }

    if (!account) {
      return res.status(404).json({ error: '没有可用的账号（均已满员或未授权/被封禁）' });
    }

    const reusableInvite = !preferFreshWorkspace && existingInvite && isInviteRecordReusable(existingInvite) && !existingInviteWorkspaceLocked && account && account.id === existingInvite.account_id
      ? existingInvite
      : null;
    const existingWorkspaceId = normalizeWorkspaceId(reusableInvite?.workspace_id);
    const existingWorkspaceName = normalizeWorkspaceName(reusableInvite?.workspace_name);
    const useWorkspaceCandidates = !reusableInvite && workspaceCandidates.length > 0;
    const capacity = useWorkspaceCandidates ? null : getCapacitySnapshot(account, existingWorkspaceId);
    if (!useWorkspaceCandidates && !reusableInvite && isCapacityAtLimit(capacity)) {
      return res.status(409).json(buildCapacityFullResponse(account, capacity));
    }

    const cooldownWorkspaceId = reusableInvite
      ? existingWorkspaceId
      : normalizeWorkspaceId(workspaceCandidates[0]?.workspaceId);
    const cooldownInvite = !reusableInvite
      ? findRecentInviteWithinCooldown(account.id, targetEmail, cooldownWorkspaceId)
      : null;
    if (cooldownInvite) {
      return res.status(429).json({
        error: `Cooldown active for ${targetEmail}`,
        failure_category: 'cooldown',
      });
    }

    const delivery = useWorkspaceCandidates
      ? await sendInviteWithWorkspaceCandidates(targetEmail, workspaceCandidates, {
        forceResend: false,
      })
      : await sendInviteWithFallback(account, targetEmail, {
        forceResend: Boolean(reusableInvite),
        allowFallback: !existingWorkspaceId,
        workspaceId: existingWorkspaceId,
        workspaceName: existingWorkspaceName,
      });
    workspaceReservation = delivery.reservation || null;
    const usedAccount = delivery.account;
    const result = delivery.result;

    if (result.success) {
      const fallbackUsed = usedAccount.id !== account.id;
      const cdkTaskId = String(req.body.cdk_task_id || req.body.cdkTaskId || '').trim();
      const requestCdkId = req.body.cdk_id || req.body.cdkId || '';
      const requestCdkCode = normalizeCdkCode(req.body.cdk_code || req.body.cdkCode || '');
      const finalResult = {
        ...result,
        target_email: targetEmail,
        cdk_task_id: cdkTaskId || result.cdk_task_id || result.cdkTaskId || '',
        cdk_id: requestCdkId || result.cdk_id || result.cdkId || '',
        cdk_code: requestCdkCode || result.cdk_code || result.cdkCode || '',
        requested_account_id: account.id,
        fallback_from_account_id: fallbackUsed ? account.id : null,
        remote_invite_id: result.remoteInviteId || result.remote_invite_id || '',
        delivery_type: result.wasResend ? 'resend' : 'send',
        workspace_id: result.workspaceId || result.workspace_id || existingWorkspaceId || normalizeWorkspaceId(delivery.workspaceCandidate?.workspaceId),
        workspace_name: result.workspaceName || result.workspace_name || existingWorkspaceName || normalizeWorkspaceName(delivery.workspaceCandidate?.workspaceName),
        plan_type: result.planType || result.plan_type || '',
        failure_category: '',
        message: fallbackUsed
          ? `${result.message}（备用账号：${usedAccount.email}）`
          : result.message,
      };
      const existing = persistInviteSuccess(usedAccount, targetEmail, finalResult);
      if (workspaceReservation) {
        releaseWorkspaceSlot(workspaceReservation);
        workspaceReservation = null;
      }
      syncCdkTeamTaskAfterInvite(cdkTaskId, finalResult, 'auto_invite_route_success');
      const postInviteSync = schedulePostInviteSync(usedAccount, finalResult, reusableInvite?.workspace_id);

      logInviteAttempts(reusableInvite ? 'auto-resend' : 'auto-invite', targetEmail, delivery.attempts);

      logInviteEvent(
        usedAccount.id,
        'active',
        `${existing || finalResult.wasResend || reusableInvite ? '[auto-resend] ' : '[auto-invite] '}invite sent to ${targetEmail}${fallbackUsed ? ` via fallback from ${account.email}` : ''}`
      );
        
      res.json({
        ...finalResult,
        used_account: usedAccount.email,
        used_account_id: usedAccount.id,
        fallback_from_account: fallbackUsed ? account.email : null,
        workspace_id: finalResult.workspace_id,
        workspace_name: finalResult.workspace_name,
        plan_type: finalResult.plan_type,
        is_resend: !!existing || !!finalResult.wasResend || !!reusableInvite || fallbackUsed,
        quota_sync: null,
        quota_sync_pending: postInviteSync.quotaSyncScheduled,
        quota_sync_skipped_reason: postInviteSync.quotaSyncSkippedReason,
      });
    } else {
      logInviteAttempts(reusableInvite ? 'auto-resend' : 'auto-invite', targetEmail, delivery.attempts);
      if (workspaceReservation) {
        releaseWorkspaceSlot(workspaceReservation);
        workspaceReservation = null;
      }
      if (result.code === 'capacity_full') {
        const fullAccount = delivery.account || account;
        logInviteEvent(fullAccount.id, 'error', `[auto-invite-blocked-capacity] ${targetEmail}: ${result.message}`);
        return res.status(409).json({
          ...buildCapacityFullResponse(fullAccount, result.capacity),
          used_account: fullAccount.email,
        });
      }

      const failureWorkspaceId = normalizeWorkspaceId(
        result.workspaceId
        || result.workspace_id
        || existingWorkspaceId
        || delivery.workspaceCandidate?.workspaceId
        || cooldownWorkspaceId
      );
      const failureWorkspaceName = normalizeWorkspaceName(
        result.workspaceName
        || result.workspace_name
        || existingWorkspaceName
        || delivery.workspaceCandidate?.workspaceName
      );
      const failureCategory = persistInviteFailure(account, targetEmail, failureWorkspaceId, failureWorkspaceName, result.message);
      logInviteEvent(account.id, 'error', `[auto-invite-failed] ${targetEmail}: ${result.message}`);
      res.status(500).json({ error: result.message, used_account: account.email, failure_category: failureCategory });
    }
  } catch (err) {
    if (workspaceReservation) {
      releaseWorkspaceSlot(workspaceReservation);
      workspaceReservation = null;
    }
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
