const db = require('../db');

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeWorkspaceId(workspaceId) {
  return String(workspaceId || '').trim();
}

function normalizeCdkCode(code) {
  return String(code || '').trim();
}

const canonicalCdkTasksCte = `
  cdk_task_sources AS (
    SELECT
      t.*,
      COALESCE(NULLIF(TRIM(t.cdk_code), ''), c.code, '') AS normalized_cdk_code
    FROM cdk_tasks t
    LEFT JOIN cdk_cards c ON c.id = t.cdk_id
  ),
  canonical_cdk_tasks AS (
    SELECT *
    FROM cdk_task_sources t
    WHERE t.task_type = 'team_invite'
      AND t.status = 'SUCCESS'
      AND (
        t.cdk_id IS NOT NULL
        OR COALESCE(TRIM(t.normalized_cdk_code), '') != ''
      )
      AND NOT EXISTS (
        SELECT 1
        FROM cdk_task_sources earlier
        WHERE earlier.task_type = 'team_invite'
          AND earlier.status = 'SUCCESS'
          AND (
            (t.cdk_id IS NOT NULL AND earlier.cdk_id = t.cdk_id)
            OR (
              COALESCE(TRIM(t.normalized_cdk_code), '') != ''
              AND LOWER(TRIM(earlier.normalized_cdk_code)) = LOWER(TRIM(t.normalized_cdk_code))
            )
          )
          AND (
            datetime(COALESCE(NULLIF(earlier.completed_at, ''), earlier.updated_at, earlier.created_at))
              < datetime(COALESCE(NULLIF(t.completed_at, ''), t.updated_at, t.created_at))
            OR (
              datetime(COALESCE(NULLIF(earlier.completed_at, ''), earlier.updated_at, earlier.created_at))
                = datetime(COALESCE(NULLIF(t.completed_at, ''), t.updated_at, t.created_at))
              AND datetime(earlier.created_at) < datetime(t.created_at)
            )
            OR (
              datetime(COALESCE(NULLIF(earlier.completed_at, ''), earlier.updated_at, earlier.created_at))
                = datetime(COALESCE(NULLIF(t.completed_at, ''), t.updated_at, t.created_at))
              AND datetime(earlier.created_at) = datetime(t.created_at)
              AND earlier.id < t.id
            )
          )
      )
  )
`;

const findStrictCdkSourceStmt = db.prepare(`
  WITH ${canonicalCdkTasksCte},
  candidate_sources AS (
    SELECT
      t.id AS source_cdk_task_id,
      t.cdk_id AS source_cdk_id,
      t.normalized_cdk_code AS source_cdk_code,
      1 AS source_priority,
      datetime(COALESCE(NULLIF(t.completed_at, ''), t.updated_at, t.created_at)) AS source_at
    FROM invites i
    JOIN canonical_cdk_tasks t ON t.id = i.cdk_task_id
    WHERE COALESCE(i.workspace_id, '') = @workspaceId
      AND LOWER(TRIM(i.target_email)) = @email
      AND COALESCE(t.account_email, '') != ''
      AND LOWER(TRIM(t.account_email)) = @email
      AND COALESCE(i.status, '') IN ('sent', 'accepted')
      AND COALESCE(i.failure_category, '') = ''
      AND (
        @remoteInviteId = ''
        OR COALESCE(i.remote_invite_id, '') = ''
        OR COALESCE(i.remote_invite_id, '') = @remoteInviteId
      )

    UNION ALL

    SELECT
      t.id AS source_cdk_task_id,
      t.cdk_id AS source_cdk_id,
      t.normalized_cdk_code AS source_cdk_code,
      2 AS source_priority,
      datetime(COALESCE(NULLIF(t.completed_at, ''), t.updated_at, t.created_at)) AS source_at
    FROM canonical_cdk_tasks t
    WHERE LOWER(TRIM(t.account_email)) = @email
      AND COALESCE(t.invite_result_json, '') != ''
      AND json_valid(t.invite_result_json)
      AND COALESCE(json_extract(t.invite_result_json, '$.failure_category'), '') = ''
      AND COALESCE(
        NULLIF(json_extract(t.invite_result_json, '$.workspace_id'), ''),
        NULLIF(json_extract(t.invite_result_json, '$.workspaceId'), '')
      ) = @workspaceId
  )
  SELECT *
  FROM candidate_sources
  ORDER BY source_priority ASC, datetime(source_at) ASC, source_cdk_task_id ASC
  LIMIT 1
`);

function findStrictCdkSourceForWorkspaceEmail({ workspaceId, email, remoteInviteId = '' } = {}) {
  const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedWorkspaceId || !normalizedEmail) {
    return null;
  }

  const row = findStrictCdkSourceStmt.get({
    workspaceId: normalizedWorkspaceId,
    email: normalizedEmail,
    remoteInviteId: String(remoteInviteId || '').trim(),
  });

  if (!row?.source_cdk_task_id) {
    return null;
  }

  return {
    source_cdk_task_id: String(row.source_cdk_task_id || ''),
    source_cdk_id: row.source_cdk_id == null ? null : Number(row.source_cdk_id),
    source_cdk_code: normalizeCdkCode(row.source_cdk_code),
  };
}

module.exports = {
  canonicalCdkTasksCte,
  findStrictCdkSourceForWorkspaceEmail,
  normalizeCdkCode,
  normalizeEmail,
  normalizeWorkspaceId,
};
