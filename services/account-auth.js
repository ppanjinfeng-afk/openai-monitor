const db = require('../db');
const checker = require('./checker');

function isTokenInvalidatedMessage(message = '') {
  const text = String(message || '').toLowerCase();
  return (
    text.includes('authentication token has been invalidated') ||
    text.includes('token has been invalidated') ||
    text.includes('token_expired') ||
    text.includes('signing in again') ||
    text.includes('sign in again') ||
    text.includes('login again')
  );
}

function stringifyAuthError(error, fallback = 'unknown_error') {
  if (typeof error === 'string') {
    const trimmed = error.trim();
    return trimmed || fallback;
  }

  if (error == null) {
    return fallback;
  }

  try {
    const json = JSON.stringify(error);
    return json && json !== 'null' ? json : fallback;
  } catch {
    return String(error);
  }
}

function persistAuthFailure(accountId, message) {
  if (!accountId) {
    return;
  }

  const normalizedMessage = stringifyAuthError(message, 'Authentication refresh failed');
  db.prepare(`
    UPDATE accounts
    SET status = 'error',
        last_checked = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(accountId);
  db.prepare(`INSERT INTO check_logs (account_id, status, message) VALUES (?, ?, ?)`)
    .run(accountId, 'error', normalizedMessage);
}

function persistTokenStatus(accountId, status, message, transient = false) {
  if (!accountId) {
    return;
  }

  const normalizedStatus = String(status || 'error');
  const normalizedMessage = stringifyAuthError(message, 'Token check failed');
  const nextStatus = transient ? null : normalizedStatus;

  if (nextStatus) {
    db.prepare(`
      UPDATE accounts
      SET status = ?,
          last_checked = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(nextStatus, accountId);
  } else {
    db.prepare(`
      UPDATE accounts
      SET last_checked = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(accountId);
  }

  db.prepare(`INSERT INTO check_logs (account_id, status, message) VALUES (?, ?, ?)`)
    .run(accountId, normalizedStatus, normalizedMessage);
}

function persistRefreshedTokens(accountId, accessToken, refreshToken) {
  db.prepare(`
    UPDATE accounts
    SET access_token = ?,
        refresh_token = ?,
        status = 'active',
        last_checked = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(accessToken, refreshToken, accountId);
}

async function refreshStoredAccountTokens(account) {
  if (!account?.refresh_token) {
    persistAuthFailure(account?.id, 'Your authentication token has been invalidated. Please try signing in again.');
    return {
      success: false,
      code: 'reauth_required',
      message: 'Your authentication token has been invalidated. Please try signing in again.',
    };
  }

  const refreshed = await checker.refreshAccessToken(account.refresh_token);
  if (refreshed.error) {
    const errorMessage = stringifyAuthError(refreshed.error, 'Authentication refresh failed');
    persistAuthFailure(account.id, `Failed to refresh account token: ${errorMessage}`);
    return {
      success: false,
      code: 'reauth_required',
      message: `Failed to refresh account token: ${errorMessage}`,
    };
  }

  persistRefreshedTokens(account.id, refreshed.access_token, refreshed.refresh_token);

  return {
    success: true,
    refreshed: true,
    account: {
      ...account,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
    },
  };
}

async function ensureUsableAccessToken(account) {
  if (!account?.access_token) {
    if (account?.refresh_token) {
      return refreshStoredAccountTokens(account);
    }

    return {
      success: false,
      code: 'oauth_missing',
      message: 'Account is not authorized yet',
    };
  }

  const tokenResult = await checker.checkWithToken(account.access_token);
  if (tokenResult.status === checker.STATUS.ACTIVE) {
    return {
      success: true,
      refreshed: false,
      account,
      tokenResult,
    };
  }

  if (tokenResult.status !== null) {
    persistTokenStatus(account.id, tokenResult.status, tokenResult.message, Boolean(tokenResult.transient));

    const code =
      tokenResult.status === checker.STATUS.BANNED
        ? 'banned'
        : tokenResult.status === checker.STATUS.RATE_LIMITED
          ? 'rate_limited'
          : 'token_check_failed';
    return {
      success: false,
      code,
      message: tokenResult.message || 'Account token is not usable right now',
    };
  }

  return refreshStoredAccountTokens(account);
}

module.exports = {
  ensureUsableAccessToken,
  refreshStoredAccountTokens,
  isTokenInvalidatedMessage,
};
