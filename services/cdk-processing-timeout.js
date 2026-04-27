const db = require('../db');

const PROCESSING_TIMEOUT_MINUTES = Math.max(
  1,
  Number(process.env.CDK_PROCESSING_TIMEOUT_MINUTES || 10)
);

function releaseStaleProcessingCdks(options = {}) {
  const log = Boolean(options.log);
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
    `).run(timeoutMessage, cutoffModifier);

    const cardResult = db.prepare(`
      UPDATE cdk_cards
      SET status = 'unused',
          assigned_email = '',
          updated_at = datetime('now')
      WHERE status = 'processing'
        AND updated_at < datetime('now', ?)
    `).run(cutoffModifier);

    return {
      timedOutTasks: taskResult.changes,
      releasedCards: cardResult.changes,
      timeoutMinutes: PROCESSING_TIMEOUT_MINUTES,
    };
  });

  const result = release();
  if (log && (result.timedOutTasks || result.releasedCards)) {
    console.log(
      `[CDK Timeout] Released ${result.releasedCards} stale processing CDK(s), marked ${result.timedOutTasks} task(s) as failed`
    );
  }

  return result;
}

module.exports = {
  PROCESSING_TIMEOUT_MINUTES,
  releaseStaleProcessingCdks,
};
