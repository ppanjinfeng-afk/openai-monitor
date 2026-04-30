const db = require('../db');
const { reconcileCdkTeamTaskSuccess } = require('./cdk-team-task-sync');

const PROCESSING_TIMEOUT_MINUTES = Math.max(
  1,
  Number(process.env.CDK_PROCESSING_TIMEOUT_MINUTES || 10)
);

function releaseStaleProcessingCdks(options = {}) {
  const log = Boolean(options.log);
  const reconciledTasks = reconcileSuccessfulTeamInvites();
  const cutoffModifier = `-${PROCESSING_TIMEOUT_MINUTES} minutes`;
  const timeoutMessage = `处理超过 ${PROCESSING_TIMEOUT_MINUTES} 分钟未完成，已释放 CDK，可重新提交激活`;

  const release = db.transaction(() => {
    const taskResult = db.prepare(`
      UPDATE cdk_tasks
      SET status = 'FAILED',
          status_message = '处理超时',
          error_message = ?,
          completed_at = datetime('now'),
          updated_at = datetime('now')
      WHERE status IN ('pending', 'PROCESSING', 'processing')
        AND updated_at < datetime('now', ?)
        AND NOT EXISTS (
          SELECT 1
          FROM cdk_tasks success_task
          WHERE success_task.cdk_id = cdk_tasks.cdk_id
            AND success_task.task_type = 'team_invite'
            AND success_task.status = 'SUCCESS'
        )
    `).run(timeoutMessage, cutoffModifier);

    const cardResult = db.prepare(`
      UPDATE cdk_cards
      SET status = 'unused',
          assigned_email = '',
          updated_at = datetime('now')
      WHERE status = 'processing'
        AND updated_at < datetime('now', ?)
        AND NOT EXISTS (
          SELECT 1
          FROM cdk_tasks success_task
          WHERE success_task.cdk_id = cdk_cards.id
            AND success_task.task_type = 'team_invite'
            AND success_task.status = 'SUCCESS'
        )
    `).run(cutoffModifier);

    return {
      timedOutTasks: taskResult.changes,
      releasedCards: cardResult.changes,
      reconciledTasks,
      timeoutMinutes: PROCESSING_TIMEOUT_MINUTES,
    };
  });

  const result = release();
  if (log && (result.timedOutTasks || result.releasedCards || result.reconciledTasks)) {
    console.log(
      `[CDK Timeout] Reconciled ${result.reconciledTasks} successful invite task(s), released ${result.releasedCards} stale processing CDK(s), marked ${result.timedOutTasks} task(s) as failed`
    );
  }

  return result;
}

function reconcileSuccessfulTeamInvites() {
  const tasks = db.prepare(`
    SELECT t.*
    FROM cdk_tasks t
    LEFT JOIN cdk_cards c ON c.id = t.cdk_id
    WHERE t.task_type = 'team_invite'
      AND t.status IN ('FAILED', 'pending', 'PROCESSING', 'processing')
      AND COALESCE(c.status, '') IN ('unused', 'processing', '')
      AND datetime(COALESCE(NULLIF(t.updated_at, ''), t.created_at))
          >= datetime('now', '-2 days')
    ORDER BY datetime(COALESCE(NULLIF(t.updated_at, ''), t.created_at)) DESC
    LIMIT 200
  `).all();

  let reconciled = 0;
  const reconciledCardIds = new Set();
  for (const task of tasks) {
    if (task.cdk_id && reconciledCardIds.has(task.cdk_id)) {
      continue;
    }

    const result = reconcileCdkTeamTaskSuccess(task.id, {
      source: 'processing_timeout_reconcile',
    });
    if (result.reconciled) {
      reconciled += 1;
      if (task.cdk_id) {
        reconciledCardIds.add(task.cdk_id);
      }
    }
  }

  return reconciled;
}

module.exports = {
  PROCESSING_TIMEOUT_MINUTES,
  releaseStaleProcessingCdks,
  reconcileSuccessfulTeamInvites,
};
