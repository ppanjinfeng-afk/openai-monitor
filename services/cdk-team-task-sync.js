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

  return null;
}

function findFirstSuccessfulTaskForSameCdk(task) {
  let cdkCode = normalizeText(task.cdk_code);
  if (!cdkCode && task.cdk_id) {
    const card = db.prepare('SELECT code FROM cdk_cards WHERE id = ?').get(task.cdk_id);
    cdkCode = normalizeText(card?.code);
  }

  if (!task.cdk_id && !cdkCode) {
    return null;
  }

  return db.prepare(`
    SELECT existing.*
    FROM cdk_tasks existing
    LEFT JOIN cdk_cards existing_card ON existing_card.id = existing.cdk_id
    WHERE existing.task_type = 'team_invite'
      AND existing.status = 'SUCCESS'
      AND existing.id != @taskId
      AND (
        (@cdkId IS NOT NULL AND existing.cdk_id = @cdkId)
        OR (
          @cdkCode != ''
          AND LOWER(TRIM(COALESCE(NULLIF(TRIM(existing.cdk_code), ''), existing_card.code, ''))) = LOWER(TRIM(@cdkCode))
        )
      )
    ORDER BY datetime(COALESCE(NULLIF(completed_at, ''), updated_at, created_at)) ASC,
             datetime(created_at) ASC,
             id ASC
    LIMIT 1
  `).get({
    taskId: task.id,
    cdkId: task.cdk_id ?? null,
    cdkCode,
  });
}

function getTaskCdkCode(task = {}) {
  let cdkCode = normalizeText(task.cdk_code);
  if (!cdkCode && task.cdk_id) {
    const card = db.prepare('SELECT code FROM cdk_cards WHERE id = ?').get(task.cdk_id);
    cdkCode = normalizeText(card?.code);
  }
  return cdkCode;
}

function buildTaskSourceIdentity(task = {}) {
  const taskId = normalizeText(task.id);
  const cdkCode = getTaskCdkCode(task);
  const cdkId = task.cdk_id == null ? null : Number(task.cdk_id);

  if (!taskId || (!cdkId && !cdkCode)) {
    return null;
  }

  return {
    source_cdk_task_id: taskId,
    source_cdk_id: cdkId || null,
    source_cdk_code: cdkCode,
  };
}

function bindTaskSourceToWorkspaceRows(task = {}, inviteResult = {}) {
  const source = buildTaskSourceIdentity(task);
  if (!source) {
    return { pendingUpdated: 0, membersUpdated: 0 };
  }

  const workspaceId = normalizeText(inviteResult.workspace_id || inviteResult.workspaceId);
  const targetEmail = normalizeEmail(task.account_email || inviteResult.email || inviteResult.target_email);
  const remoteInviteId = normalizeText(inviteResult.remote_invite_id || inviteResult.remoteInviteId);

  if (!workspaceId || !targetEmail) {
    return { pendingUpdated: 0, membersUpdated: 0 };
  }

  let pendingUpdated = 0;
  if (remoteInviteId) {
    pendingUpdated = db.prepare(`
      UPDATE workspace_pending_invites
      SET source_cdk_task_id = ?,
          source_cdk_id = ?,
          source_cdk_code = ?,
          last_synced_at = COALESCE(last_synced_at, datetime('now'))
      WHERE workspace_id = ?
        AND LOWER(email) = LOWER(?)
        AND COALESCE(remote_invite_id, '') = ?
    `).run(
      source.source_cdk_task_id,
      source.source_cdk_id,
      source.source_cdk_code,
      workspaceId,
      targetEmail,
      remoteInviteId
    ).changes;
  } else {
    pendingUpdated = db.prepare(`
      UPDATE workspace_pending_invites
      SET source_cdk_task_id = ?,
          source_cdk_id = ?,
          source_cdk_code = ?,
          last_synced_at = COALESCE(last_synced_at, datetime('now'))
      WHERE workspace_id = ?
        AND LOWER(email) = LOWER(?)
        AND (COALESCE(source_cdk_task_id, '') = '' OR source_cdk_task_id = ?)
    `).run(
      source.source_cdk_task_id,
      source.source_cdk_id,
      source.source_cdk_code,
      workspaceId,
      targetEmail,
      source.source_cdk_task_id
    ).changes;
  }

  const membersUpdated = db.prepare(`
    UPDATE workspace_members
    SET source_cdk_task_id = ?,
        source_cdk_id = ?,
        source_cdk_code = ?,
        last_synced_at = COALESCE(last_synced_at, datetime('now'))
    WHERE workspace_id = ?
      AND LOWER(email) = LOWER(?)
      AND COALESCE(deactivated_time, '') = ''
      AND (COALESCE(source_cdk_task_id, '') = '' OR source_cdk_task_id = ?)
  `).run(
    source.source_cdk_task_id,
    source.source_cdk_id,
    source.source_cdk_code,
    workspaceId,
    targetEmail,
    source.source_cdk_task_id
  ).changes;

  return { pendingUpdated, membersUpdated };
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
    ...buildTaskSourceIdentity(task),
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
          AND LOWER(target_email) = LOWER(?)
          AND (COALESCE(cdk_task_id, '') = '' OR cdk_task_id = ?)
      `).run(normalizedTaskId, inviteId, targetEmail, normalizedTaskId);
    } else if (remoteInviteId) {
      const matches = db.prepare(`
        SELECT id
        FROM invites
        WHERE remote_invite_id = ?
          AND LOWER(target_email) = LOWER(?)
          AND COALESCE(status, '') IN ('sent', 'accepted')
          AND (COALESCE(cdk_task_id, '') = '' OR cdk_task_id = ?)
        ORDER BY datetime(COALESCE(NULLIF(updated_at, ''), created_at)) DESC
        LIMIT 2
      `).all(remoteInviteId, targetEmail, normalizedTaskId);

      if (matches.length === 1) {
        db.prepare(`
          UPDATE invites
          SET cdk_task_id = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(normalizedTaskId, matches[0].id);
      }
    } else if (workspaceId && targetEmail) {
      const matches = db.prepare(`
        SELECT id
        FROM invites
        WHERE workspace_id = ?
          AND LOWER(target_email) = LOWER(?)
          AND COALESCE(status, '') IN ('sent', 'accepted')
          AND COALESCE(cdk_task_id, '') = ''
        ORDER BY datetime(COALESCE(NULLIF(updated_at, ''), created_at)) DESC
        LIMIT 2
      `).all(workspaceId, targetEmail);

      if (matches.length === 1) {
        db.prepare(`
          UPDATE invites
          SET cdk_task_id = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(normalizedTaskId, matches[0].id);
      }
    }

    bindTaskSourceToWorkspaceRows(task, result);
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
