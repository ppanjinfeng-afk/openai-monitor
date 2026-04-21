const db = require('../db');
const accountAuth = require('./account-auth');
const { classifyFailure, categoryLabel } = require('./failure-utils');

const INVITE_LOOKBACK_HOURS = 24;
const INVITE_FAILURE_THRESHOLD = 3;
const INVITE_SEVERE_FAILURE_THRESHOLD = 5;
const INVITE_HISTORY_LIMIT = 12;

const BAD_INVITE_FAILURE_CATEGORIES = new Set([
  'generic_error',
  'invite_not_materialized',
  'workspace_lookup_failed',
  'revoke_failed',
  'resend_failed',
  'token_invalid',
  'oauth_missing',
]);

function normalizeText(value) {
  return String(value || '').trim();
}

function isInviteDisabled(account) {
  return Number(account?.invite_disabled || 0) === 1;
}

function getProjectedUsedSeats(account) {
  if (account?.quota_sync_status === 'success') {
    return Number(account?.quota_member_seats || 0) + Number(account?.quota_pending_invites || 0);
  }

  return Number(account?.invited_count || 0);
}

function hasInviteHeadroom(account) {
  return getProjectedUsedSeats(account) < Number(account?.invite_total || 0);
}

function getRecentInviteRows(accountId) {
  return db.prepare(`
    SELECT
      status,
      failure_category,
      message,
      workspace_id,
      workspace_name,
      updated_at,
      created_at
    FROM invites
    WHERE account_id = ?
      AND updated_at >= datetime('now', ?)
    ORDER BY updated_at DESC, id DESC
    LIMIT ?
  `).all(accountId, `-${INVITE_LOOKBACK_HOURS} hours`, INVITE_HISTORY_LIMIT);
}

function summarizeWorkspaces(rows) {
  const labels = [];

  for (const row of rows) {
    const label = normalizeText(row.workspace_name || row.workspace_id || '');
    if (!label || labels.includes(label)) {
      continue;
    }
    labels.push(label);
    if (labels.length >= 2) {
      break;
    }
  }

  return labels;
}

function summarizeCategories(rows) {
  const counters = new Map();

  for (const row of rows) {
    const category = BAD_INVITE_FAILURE_CATEGORIES.has(normalizeText(row.failure_category).toLowerCase())
      ? normalizeText(row.failure_category).toLowerCase()
      : classifyFailure(row.message, row.status);
    if (!category) {
      continue;
    }

    counters.set(category, (counters.get(category) || 0) + 1);
  }

  return [...counters.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 2)
    .map(([category, count]) => `${categoryLabel(category)} ${count}`);
}

function analyzeInviteHealth(account) {
  if (!hasInviteHeadroom(account)) {
    return {
      shouldDisable: false,
      reason: '',
      recentFailures: 0,
      recentSuccesses: 0,
    };
  }

  const recentRows = getRecentInviteRows(account.id);
  if (recentRows.length === 0) {
    return {
      shouldDisable: false,
      reason: '',
      recentFailures: 0,
      recentSuccesses: 0,
    };
  }

  const successRows = recentRows.filter(row => row.status === 'sent' || row.status === 'accepted');
  const failureRows = recentRows.filter(row => {
    if (row.status !== 'error') {
      return false;
    }

    const category = normalizeText(row.failure_category).toLowerCase() || classifyFailure(row.message, row.status);
    return BAD_INVITE_FAILURE_CATEGORIES.has(category);
  });

  const failureCount = failureRows.length;
  const successCount = successRows.length;
  const shouldDisable =
    (failureCount >= INVITE_FAILURE_THRESHOLD && successCount === 0) ||
    failureCount >= INVITE_SEVERE_FAILURE_THRESHOLD;

  if (!shouldDisable) {
    return {
      shouldDisable: false,
      reason: '',
      recentFailures: failureCount,
      recentSuccesses: successCount,
    };
  }

  const workspaceBits = summarizeWorkspaces(failureRows);
  const categoryBits = summarizeCategories(failureRows);
  const reasonParts = [
    `${INVITE_LOOKBACK_HOURS}h 内邀请失败 ${failureCount} 次`,
    successCount > 0 ? `成功 ${successCount} 次` : '没有成功邀请',
  ];

  if (workspaceBits.length > 0) {
    reasonParts.push(`工作区 ${workspaceBits.join(', ')}`);
  }

  if (categoryBits.length > 0) {
    reasonParts.push(categoryBits.join(' / '));
  }

  return {
    shouldDisable: true,
    reason: reasonParts.join(' | '),
    recentFailures: failureCount,
    recentSuccesses: successCount,
  };
}

function setInviteDisabled(account, reason, source = 'bad-account-detect') {
  const normalizedReason = normalizeText(reason) || '账号已被移出邀请池';
  const alreadyDisabled = isInviteDisabled(account);
  const reasonChanged = normalizeText(account.invite_disabled_reason) !== normalizedReason;

  db.prepare(`
    UPDATE accounts
    SET invite_disabled = 1,
        invite_disabled_reason = ?,
        invite_disabled_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(normalizedReason, account.id);

  if (!alreadyDisabled || reasonChanged) {
    db.prepare(`INSERT INTO check_logs (account_id, status, message) VALUES (?, 'error', ?)`)
      .run(account.id, `[${source}] ${normalizedReason}`);
  }
}

function clearInviteDisabled(account, source = 'bad-account-detect') {
  if (!isInviteDisabled(account) && !normalizeText(account.invite_disabled_reason)) {
    return false;
  }

  db.prepare(`
    UPDATE accounts
    SET invite_disabled = 0,
        invite_disabled_reason = '',
        invite_disabled_at = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(account.id);

  db.prepare(`INSERT INTO check_logs (account_id, status, message) VALUES (?, 'active', ?)`)
    .run(account.id, `[${source}] 账号已恢复到邀请池`);

  return true;
}

async function detectSingleAccount(account) {
  const currentAccount = db.prepare('SELECT * FROM accounts WHERE id = ?').get(account.id);
  if (!currentAccount) {
    return null;
  }

  const result = {
    account_id: currentAccount.id,
    email: currentAccount.email,
    disabled: false,
    cleared: false,
    skipped: false,
    reason: '',
    auth_code: '',
  };

  if (!normalizeText(currentAccount.access_token) && !normalizeText(currentAccount.refresh_token)) {
    const reason = '账号未授权，已从邀请池移除';
    setInviteDisabled(currentAccount, reason);
    return {
      ...result,
      disabled: true,
      reason,
      auth_code: 'oauth_missing',
    };
  }

  const authResult = await accountAuth.ensureUsableAccessToken(currentAccount);
  if (!authResult.success) {
    const reason = normalizeText(authResult.message) || '账号鉴权失败，已从邀请池移除';
    setInviteDisabled(currentAccount, reason);
    return {
      ...result,
      disabled: true,
      reason,
      auth_code: normalizeText(authResult.code),
    };
  }

  const refreshedAccount = db.prepare('SELECT * FROM accounts WHERE id = ?').get(currentAccount.id) || currentAccount;
  const inviteHealth = analyzeInviteHealth(refreshedAccount);

  if (inviteHealth.shouldDisable) {
    setInviteDisabled(refreshedAccount, inviteHealth.reason);
    return {
      ...result,
      disabled: true,
      reason: inviteHealth.reason,
      recent_failures: inviteHealth.recentFailures,
      recent_successes: inviteHealth.recentSuccesses,
    };
  }

  if (clearInviteDisabled(refreshedAccount)) {
    return {
      ...result,
      cleared: true,
      reason: '账号检测正常，已恢复邀请',
      recent_failures: inviteHealth.recentFailures,
      recent_successes: inviteHealth.recentSuccesses,
    };
  }

  return {
    ...result,
    skipped: true,
    reason: '账号检测正常',
    recent_failures: inviteHealth.recentFailures,
    recent_successes: inviteHealth.recentSuccesses,
  };
}

async function detectBadAccounts(options = {}) {
  const ids = Array.isArray(options.ids)
    ? [...new Set(options.ids.map(id => parseInt(id, 10)).filter(id => Number.isInteger(id) && id > 0))]
    : [];

  const accounts = ids.length > 0
    ? db.prepare(`SELECT * FROM accounts WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY updated_at DESC, id DESC`).all(...ids)
    : db.prepare('SELECT * FROM accounts ORDER BY updated_at DESC, id DESC').all();

  const details = [];
  for (const account of accounts) {
    const detail = await detectSingleAccount(account);
    if (detail) {
      details.push(detail);
    }
  }

  return {
    checked: details.length,
    disabled: details.filter(item => item.disabled).length,
    cleared: details.filter(item => item.cleared).length,
    skipped: details.filter(item => item.skipped).length,
    details,
  };
}

module.exports = {
  detectBadAccounts,
  detectSingleAccount,
};
