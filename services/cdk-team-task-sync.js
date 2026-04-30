const db = require('../db');
const { markDuplicateTeamCdkTaskUntracked } = require('./cdk-team-dedupe');

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
    cdk_task_id: normalizeText(invite.cdk_task_id),
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

  const linkedInvite = db.prepare(`
    SELECT
      i.*,
      a.email AS account_email,
      a.label AS account_label
    FROM invites i
    LEFT JOIN accounts a ON a.id = i.account_id
    WHERE i.cdk_task_id = ?
      AND COALESCE(i.status, '') IN ('sent', 'accepted')
      AND COALESCE(i.failure_category, '') = ''
    ORDER BY datetime(COALESCE(NULLIF(i.updated_at, ''), i.created_at)) DESC
    LIMIT 1
  `).get(task.id);

  if (linkedInvite) {
    return linkedInvite;
  }

  return db.prepare(`
    SELECT
      i.*,
      a.email AS account_email,
      a.label AS account_label
    FROM invites i
    LEFT JOIN accounts a ON a.id = i.account_id
    WHERE LOWER(i.target_email) = LOWER(?)
      AND (COALESCE(i.cdk_task_id, '') = '' OR i.cdk_task_id = ?)
      AND COALESCE(i.status, '') IN ('sent', 'accepted')
      AND COALESCE(i.failure_category, '') = ''
      AND datetime(COALESCE(NULLIF(i.updated_at, ''), i.created_at))
          >= datetime(COALESCE(NULLIF(?, ''), 'now'), '-15 minutes')
    ORDER BY datetime(COALESCE(NULLIF(i.updated_at, ''), i.created_at)) DESC
    LIMIT 1
  `).get(targetEmail, task.id, task.created_at || task.updated_at || '');
}

function findFirstSuccessfulTaskForSameCdk(task) {
  if (task.cdk_id) {
    return db.prepare(`
      SELECT *
      FROM cdk_tasks
      WHERE cdk_id = ?
        AND task_type = 'team_invite'
        AND status = 'SUCCESS'
        AND id != ?
      ORDER BY datetime(COALESCE(NULLIF(completed_at, ''), updated_at, created_at)) ASC,
               datetime(created_at) ASC,
               id ASC
      LIMIT 1
    `).get(task.cdk_id, task.id);
  }

  const cdkCode = normalizeText(task.cdk_code);
  if (!cdkCode) {
    return null;
  }

  return db.prepare(`
    SELECT *
    FROM cdk_tasks
    WHERE cdk_id IS NULL
      AND TRIM(cdk_code) = ?
      AND task_type = 'team_invite'
      AND status = 'SUCCESS'
      AND id != ?
    ORDER BY datetime(COALESCE(NULLIF(completed_at, ''), updated_at, created_at)) ASC,
             datetime(created_at) ASC,
             id ASC
    LIMIT 1
  `).get(cdkCode, task.id);
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

  if (normalizeText(task.status).toUpperCase() === 'SUCCESS') {
    return {
      completed: true,
      alreadyCompleted: true,
      task,
      inviteResult: parseJsonSafely(task.invite_result_json),
    };
  }

  const existingSuccess = findFirstSuccessfulTaskForSameCdk(task);
  if (existingSuccess) {
    markDuplicateTeamCdkTaskUntracked(task, existingSuccess, {
      source: options.source || 'cdk_task_sync_duplicate',
      inviteResult,
    });

    return {
      completed: false,
      reason: 'cdk_already_completed',
      task,
      existingTask: existingSuccess,
    };
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

    const inviteId = Number(result.invite_id || result.inviteId || 0);
    const remoteInviteId = normalizeText(result.remote_invite_id || result.remoteInviteId);
    const workspaceId = normalizeText(result.workspace_id || result.workspaceId);
    const targetEmail = normalizeEmail(task.account_email);

    if (inviteId > 0) {
      db.prepare(`
        UPDATE invites
        SET cdk_task_id = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(normalizedTaskId, inviteId);
    } else if (remoteInviteId) {
      db.prepare(`
        UPDATE invites
        SET cdk_task_id = ?,
            updated_at = datetime('now')
        WHERE remote_invite_id = ?
          AND COALESCE(cdk_task_id, '') = ''
      `).run(normalizedTaskId, remoteInviteId);
    } else if (workspaceId && targetEmail) {
      db.prepare(`
        UPDATE invites
        SET cdk_task_id = ?,
            updated_at = datetime('now')
        WHERE workspace_id = ?
          AND LOWER(target_email) = LOWER(?)
          AND COALESCE(status, '') IN ('sent', 'accepted')
          AND COALESCE(cdk_task_id, '') = ''
      `).run(normalizedTaskId, workspaceId, targetEmail);
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
