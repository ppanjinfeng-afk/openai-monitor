const db = require('../db');

const DEFAULT_EXPIRE_AFTER_DAYS = Math.max(
  0.01,
  Number(process.env.CDK_EXPIRE_AFTER_DAYS || 1) || 1
);
const DEFAULT_SAMPLE_LIMIT = 20;

function normalizeExpireAfterDays(value, fallback = DEFAULT_EXPIRE_AFTER_DAYS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function normalizeSampleLimit(value, fallback = DEFAULT_SAMPLE_LIMIT) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.max(1, Math.min(parsed, 200));
}

function secondsSinceSql(alias, preferredColumn = 'created_at') {
  const prefix = alias ? `${alias}.` : '';
  const timestampSql = `COALESCE(
        NULLIF(${prefix}${preferredColumn}, ''),
        NULLIF(${prefix}created_at, ''),
        '1970-01-01 00:00:00'
      )`;

  return `
    CASE
      WHEN ${timestampSql} > datetime('now', '+1 hour')
        THEN (strftime('%s', 'now', 'localtime') - strftime('%s', ${timestampSql}))
      ELSE (strftime('%s', 'now') - strftime('%s', ${timestampSql}))
    END
  `;
}

function buildExpireWhere(options = {}) {
  const clauses = [
    "LOWER(COALESCE(cdk_cards.status, '')) = 'unused'",
    `${secondsSinceSql('cdk_cards', 'created_at')} >= @expireAfterSeconds`,
    `NOT EXISTS (
      SELECT 1
      FROM cdk_tasks active_task
      WHERE active_task.cdk_id = cdk_cards.id
        AND UPPER(COALESCE(active_task.status, '')) IN ('PENDING', 'PROCESSING')
    )`,
  ];

  if (options.onlyDelivered) {
    clauses.push("COALESCE(cdk_cards.source_order_no, '') != ''");
  }

  if (options.planType) {
    clauses.push('cdk_cards.plan_type = @planType');
  }

  return clauses.join('\n    AND ');
}

function expireOldCdks(options = {}) {
  const expireAfterDays = normalizeExpireAfterDays(options.expireAfterDays ?? options.days);
  const expireAfterSeconds = Math.round(expireAfterDays * 24 * 60 * 60);
  const sampleLimit = normalizeSampleLimit(options.sampleLimit);
  const onlyDelivered = Boolean(options.onlyDelivered);
  const dryRun = Boolean(options.dryRun);
  const planType = options.planType ? String(options.planType).trim() : '';
  const params = {
    expireAfterSeconds,
    sampleLimit,
    planType,
  };
  const whereSql = buildExpireWhere({ onlyDelivered, planType });

  const summary = db.prepare(`
    SELECT
      COUNT(*) AS matched,
      MIN(created_at) AS oldestCreatedAt,
      MAX(created_at) AS newestCreatedAt
    FROM cdk_cards
    WHERE ${whereSql}
  `).get(params);

  const sample = db.prepare(`
    SELECT
      id,
      code,
      plan_type AS planType,
      buyer_email AS buyerEmail,
      assigned_email AS assignedEmail,
      source_order_no AS sourceOrderNo,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM cdk_cards
    WHERE ${whereSql}
    ORDER BY datetime(COALESCE(NULLIF(created_at, ''), updated_at)) ASC, id ASC
    LIMIT @sampleLimit
  `).all(params);

  if (dryRun) {
    return {
      dryRun: true,
      expireAfterDays,
      expireAfterSeconds,
      onlyDelivered,
      planType,
      matchedCount: Number(summary?.matched || 0),
      expiredCount: 0,
      oldestCreatedAt: summary?.oldestCreatedAt || '',
      newestCreatedAt: summary?.newestCreatedAt || '',
      sample,
    };
  }

  const expire = db.transaction(() => {
    const result = db.prepare(`
      UPDATE cdk_cards
      SET status = 'expired',
          updated_at = datetime('now')
      WHERE ${whereSql}
    `).run(params);

    return result.changes;
  });

  const expiredCount = expire();

  return {
    dryRun: false,
    expireAfterDays,
    expireAfterSeconds,
    onlyDelivered,
    planType,
    matchedCount: Number(summary?.matched || 0),
    expiredCount,
    oldestCreatedAt: summary?.oldestCreatedAt || '',
    newestCreatedAt: summary?.newestCreatedAt || '',
    sample,
  };
}

module.exports = {
  DEFAULT_EXPIRE_AFTER_DAYS,
  expireOldCdks,
};
