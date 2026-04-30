const db = require('../db');

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeText(value) {
  return String(value || '').trim();
}

function parseJsonSafely(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

function buildInviteResultFromInvite(invite = {}) {
  const accountEmail = normalizeText(invite.account_email);
  const workspaceName = normalizeText(invite.workspace_name);
  const workspaceId = normalizeText(invite.workspace_id);
  const message = normalizeText(invite.message)
    || `Team invite sent${accountEmail ? ` by ${accountEmail}` : ''}`;

  return {
    success: true,
    reconciled_from_invite: true,
    message,
    used_account: accountEmail,
    used_account_id: invite.account_id || null,
    requested_account_id: invite.requested_account_id || invite.account_id || null,
    fallback_from_account_id: invite.fallback_from_account_id || null,
    remote_invite_id: normalizeText(invite.remote_invite_id),
    delivery_type: normalizeText(invite.delivery_type) || 'send',
    workspace_id: workspaceId,
    workspace_name: workspaceName,
    plan_type: normalizeText(invite.plan_type),
    status: normalizeText(invite.status),
  };
}

function findSuccessfulInviteForTask(taskOrId) {
  const task = typeof taskOrId === 'object' && taskOrId
    ? taskOrId
    : db.prepare('SELECT * FROM cdk_tasks WHERE id = ?').get(taskOrId);

  if (!task) {
    return null;
  }

  const targetEmail = normalizeEmail(task.account_email);
  if (!targetEmail) {
    return null;
  }

  return db.prepare(`
    SELECT
      i.*,
      a.email AS account_email,
      a.label AS account_label
    FROM invites i
    LEFT JOIN accounts a ON a.id = i.account_id
    WHERE LOWER(i.target_email) = LOWER(?)
      AND COALESCE(i.status, '') IN ('sent', 'accepted')
      AND COALESCE(i.failure_category, '') = ''
      AND datetime(COALESCE(NULLIF(i.updated_at, ''), i.created_at))
          >= datetime(COALESCE(NULLIF(?, ''), 'now'), '-15 minutes')
    ORDER BY datetime(COALESCE(NULLIF(i.updated_at, ''), i.created_at)) DESC
    LIMIT 1
  `).get(targetEmail, task.created_at || task.updated_at || '');
}

function completeCdkTeamTask(taskId, inviteResult = {}, options = {}) {
  const normalizedTaskId = normalizeText(taskId);
  if (!normalizedTaskId) {
    return { completed: false, reason: 'missing_task_id' };
  }

  const task = db.prepare('SELECT * FROM cdk_tasks WHERE id = ?').get(normalizedTaskId);
  if (!task) {
    return { completed: false, reason: 'task_not_found' };
  }

  if (normalizeText(task.task_type) && normalizeText(task.task_type) !== 'team_invite') {
    return { completed: false, reason: 'not_team_invite_task' };
  }

  const result = {
    ...parseJsonSafely(task.invite_result_json),
    ...inviteResult,
    success: true,
    cdk_task_sync_source: options.source || 'unknown',
    cdk_task_synced_at: new Date().toISOString(),
  };
  const workspaceName = normalizeText(result.workspace_name || result.workspaceName || result.workspace_id || result.workspaceId);
  const message = normalizeText(result.message)
    || (workspaceName
      ? `Team invite sent, please check email and accept invite (${workspaceName})`
      : 'Team invite sent, please check email and accept invite');
  const resultJson = JSON.stringify(result);

  const complete = db.transaction(() => {
    db.prepare(`
      UPDATE cdk_tasks
      SET status = 'SUCCESS',
          status_message = ?,
          error_message = '',
          invite_result_json = ?,
          completed_at = COALESCE(completed_at, datetime('now')),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(message, resultJson, normalizedTaskId);

    if (task.cdk_id) {
      db.prepare(`
        UPDATE cdk_cards
        SET status = 'used',
            assigned_email = ?,
            used_at = COALESCE(used_at, datetime('now')),
            updated_at = datetime('now')
        WHERE id = ?
      `).run(task.account_email || '', task.cdk_id);
    }
  });

  complete();

  return {
    completed: true,
    task,
    inviteResult: result,
  };
}

function reconcileCdkTeamTaskSuccess(taskId, options = {}) {
  const invite = findSuccessfulInviteForTask(taskId);
  if (!invite) {
    return { reconciled: false, reason: 'success_invite_not_found' };
  }

  const result = completeCdkTeamTask(
    taskId,
    buildInviteResultFromInvite(invite),
    { source: options.source || 'invite_record_reconcile' }
  );

  return {
    reconciled: Boolean(result.completed),
    invite,
    ...result,
  };
}

module.exports = {
  completeCdkTeamTask,
  reconcileCdkTeamTaskSuccess,
  findSuccessfulInviteForTask,
  buildInviteResultFromInvite,
};
