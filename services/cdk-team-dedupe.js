const db = require('../db');

const DUPLICATE_FAILURE_CATEGORY = 'duplicate_cdk_untracked';

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function parseJsonSafely(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

function getTaskWorkspace(task) {
  const result = parseJsonSafely(task?.invite_result_json);
  return {
    inviteId: Number(result.invite_id || result.inviteId || 0) || 0,
    remoteInviteId: normalizeText(result.remote_invite_id || result.remoteInviteId),
    workspaceId: normalizeText(result.workspace_id || result.workspaceId),
    workspaceName: normalizeText(result.workspace_name || result.workspaceName),
  };
}

function buildDuplicateResult(task, canonicalTask, options = {}) {
  return {
    ...parseJsonSafely(task.invite_result_json),
    ...(options.inviteResult || {}),
    duplicate_cdk_untracked: true,
    duplicate_of_task_id: canonicalTask.id,
    duplicate_repaired_at: new Date().toISOString(),
    duplicate_repair_source: options.source || 'duplicate_cdk_repair',
  };
}

function markRelatedInvitesAsDuplicate(task, canonicalTask) {
  const taskEmail = normalizeEmail(task.account_email);
  if (!taskEmail) {
    return 0;
  }

  const taskWorkspace = getTaskWorkspace(task);
  const canonicalWorkspace = getTaskWorkspace(canonicalTask);
  const message = `Duplicate CDK source removed; first valid task is ${canonicalTask.id}`;
  let changed = 0;

  changed += db.prepare(`
    UPDATE invites
    SET failure_category = ?,
        message = ?,
        updated_at = datetime('now')
    WHERE cdk_task_id = ?
      AND LOWER(target_email) = LOWER(?)
  `).run(DUPLICATE_FAILURE_CATEGORY, message, task.id, taskEmail).changes;

  if (taskWorkspace.inviteId > 0) {
    changed += db.prepare(`
      UPDATE invites
      SET failure_category = ?,
          message = ?,
          updated_at = datetime('now')
      WHERE id = ?
        AND LOWER(target_email) = LOWER(?)
    `).run(DUPLICATE_FAILURE_CATEGORY, message, taskWorkspace.inviteId, taskEmail).changes;
  }

  if (taskWorkspace.remoteInviteId) {
    changed += db.prepare(`
      UPDATE invites
      SET failure_category = ?,
          message = ?,
          updated_at = datetime('now')
      WHERE remote_invite_id = ?
        AND LOWER(target_email) = LOWER(?)
    `).run(DUPLICATE_FAILURE_CATEGORY, message, taskWorkspace.remoteInviteId, taskEmail).changes;
  }

  const duplicateWorkspace = taskWorkspace.workspaceId;
  const canonicalWorkspaceId = canonicalWorkspace.workspaceId;
  if (duplicateWorkspace && duplicateWorkspace !== canonicalWorkspaceId) {
    changed += db.prepare(`
      UPDATE invites
      SET failure_category = ?,
          message = ?,
          updated_at = datetime('now')
      WHERE workspace_id = ?
        AND LOWER(target_email) = LOWER(?)
        AND (COALESCE(cdk_task_id, '') = '' OR cdk_task_id = ?)
    `).run(DUPLICATE_FAILURE_CATEGORY, message, duplicateWorkspace, taskEmail, task.id).changes;
  }

  return changed;
}

function markDuplicateTeamCdkTaskUntracked(task, canonicalTask, options = {}) {
  if (!task?.id || !canonicalTask?.id || task.id === canonicalTask.id) {
    return { changed: false, inviteRowsMarked: 0 };
  }

  const resultJson = JSON.stringify(buildDuplicateResult(task, canonicalTask, options));
  const message = `Duplicate CDK task is not recognized; first valid task is ${canonicalTask.id}`;

  const run = db.transaction(() => {
    const taskChanges = db.prepare(`
      UPDATE cdk_tasks
      SET status = 'FAILED',
          status_message = 'Duplicate CDK source removed',
          error_message = ?,
          invite_result_json = ?,
          completed_at = COALESCE(completed_at, datetime('now')),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(message, resultJson, task.id).changes;

    const inviteRowsMarked = markRelatedInvitesAsDuplicate(task, canonicalTask);

    if (canonicalTask.cdk_id) {
      db.prepare(`
        UPDATE cdk_cards
        SET status = 'used',
            assigned_email = COALESCE(NULLIF(?, ''), assigned_email),
            used_at = COALESCE(used_at, ?),
            updated_at = datetime('now')
        WHERE id = ?
      `).run(
        normalizeText(canonicalTask.account_email),
        normalizeText(canonicalTask.completed_at || canonicalTask.updated_at || canonicalTask.created_at),
        canonicalTask.cdk_id
      );
    }

    return { taskChanges, inviteRowsMarked };
  });

  const result = run();
  return {
    changed: result.taskChanges > 0 || result.inviteRowsMarked > 0,
    inviteRowsMarked: result.inviteRowsMarked,
  };
}

function loadDuplicateSuccessGroups() {
  return db.prepare(`
    WITH task_sources AS (
      SELECT
        t.*,
        COALESCE(NULLIF(TRIM(t.cdk_code), ''), c.code, '') AS normalized_cdk_code
      FROM cdk_tasks t
      LEFT JOIN cdk_cards c ON c.id = t.cdk_id
      WHERE t.task_type = 'team_invite'
        AND t.status = 'SUCCESS'
        AND (t.cdk_id IS NOT NULL OR COALESCE(TRIM(t.cdk_code), '') != '' OR COALESCE(c.code, '') != '')
    )
    SELECT group_key, COUNT(*) AS success_count
    FROM (
      SELECT
        'id:' || cdk_id AS group_key
      FROM task_sources
      WHERE cdk_id IS NOT NULL
      UNION ALL
      SELECT 'code:' || LOWER(TRIM(normalized_cdk_code)) AS group_key
      FROM task_sources
      WHERE COALESCE(TRIM(normalized_cdk_code), '') != ''
    )
    GROUP BY group_key
    HAVING COUNT(*) > 1
    ORDER BY success_count DESC, group_key ASC
  `).all();
}

function loadSuccessTasksForGroup(groupKey) {
  const key = normalizeText(groupKey);
  if (key.startsWith('id:')) {
    const cdkId = Number(key.slice(3));
    return db.prepare(`
      SELECT *
      FROM cdk_tasks
      WHERE task_type = 'team_invite'
        AND status = 'SUCCESS'
        AND cdk_id = ?
      ORDER BY datetime(COALESCE(NULLIF(completed_at, ''), updated_at, created_at)) ASC,
               datetime(created_at) ASC,
               id ASC
    `).all(cdkId);
  }

  const code = key.startsWith('code:') ? key.slice(5) : key;
  return db.prepare(`
    SELECT t.*
    FROM cdk_tasks t
    LEFT JOIN cdk_cards c ON c.id = t.cdk_id
    WHERE t.task_type = 'team_invite'
      AND t.status = 'SUCCESS'
      AND LOWER(TRIM(COALESCE(NULLIF(TRIM(t.cdk_code), ''), c.code, ''))) = ?
    ORDER BY datetime(COALESCE(NULLIF(t.completed_at, ''), t.updated_at, t.created_at)) ASC,
             datetime(t.created_at) ASC,
             t.id ASC
  `).all(code);
}

function repairDuplicateTeamCdkTasks(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const groups = loadDuplicateSuccessGroups();
  const details = [];
  let duplicateTasksMarked = 0;
  let inviteRowsMarked = 0;

  const run = db.transaction(() => {
    for (const group of groups) {
      const tasks = loadSuccessTasksForGroup(group.group_key);
      if (tasks.length <= 1) {
        continue;
      }

      const canonicalTask = tasks[0];
      const duplicates = tasks.slice(1);
      details.push({
        group_key: group.group_key,
        canonical_task_id: canonicalTask.id,
        canonical_email: canonicalTask.account_email,
        duplicate_task_ids: duplicates.map(task => task.id),
      });

      if (dryRun) {
        continue;
      }

      for (const task of duplicates) {
        const result = markDuplicateTeamCdkTaskUntracked(task, canonicalTask, {
          source: 'repair_duplicate_team_cdk_tasks',
        });
        if (result.changed) {
          duplicateTasksMarked += 1;
          inviteRowsMarked += result.inviteRowsMarked || 0;
        }
      }
    }
  });

  run();

  return {
    dryRun,
    groupsScanned: groups.length,
    groupsChanged: details.length,
    duplicateTasksMarked,
    inviteRowsMarked,
    details,
  };
}

module.exports = {
  DUPLICATE_FAILURE_CATEGORY,
  markDuplicateTeamCdkTaskUntracked,
  repairDuplicateTeamCdkTasks,
};
