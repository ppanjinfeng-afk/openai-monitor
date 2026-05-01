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

function makeAssignmentKey(row = {}) {
  return `${row.item_type || 'member'}:${String(row.id ?? '')}`;
}

function toSourceObject(source) {
  if (!source?.source_cdk_task_id) {
    return null;
  }

  return {
    source_cdk_task_id: String(source.source_cdk_task_id || ''),
    source_cdk_id: source.source_cdk_id == null ? null : Number(source.source_cdk_id),
    source_cdk_code: normalizeCdkCode(source.source_cdk_code),
  };
}

function parseTime(value) {
  const text = String(value || '').trim();
  if (!text) {
    return 0;
  }

  const parsed = Date.parse(text.includes('T') ? text : text.replace(' ', 'T'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function itemTime(row = {}) {
  return parseTime(row.joined_at || row.invited_at || row.last_synced_at);
}

function sourceTaskId(source = {}) {
  return String(source.source_cdk_task_id || '').trim();
}

function getSourceRemoteInviteId(source = {}) {
  return String(source.remote_invite_id || '').trim();
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

function loadStrictCdkSourcesForEmails(emails = []) {
  const normalizedEmails = Array.from(new Set(
    emails.map(normalizeEmail).filter(Boolean)
  ));

  if (normalizedEmails.length === 0) {
    return [];
  }

  const placeholders = normalizedEmails.map(() => '?').join(',');

  return db.prepare(`
    WITH ${canonicalCdkTasksCte},
    candidate_sources AS (
      SELECT
        t.id AS source_cdk_task_id,
        t.cdk_id AS source_cdk_id,
        t.normalized_cdk_code AS source_cdk_code,
        LOWER(TRIM(t.account_email)) AS email_key,
        COALESCE(i.workspace_id, '') AS workspace_key,
        COALESCE(i.remote_invite_id, '') AS remote_invite_id,
        1 AS source_priority,
        datetime(COALESCE(NULLIF(t.completed_at, ''), t.updated_at, t.created_at)) AS source_at
      FROM invites i
      JOIN canonical_cdk_tasks t ON t.id = i.cdk_task_id
      WHERE COALESCE(i.target_email, '') != ''
        AND COALESCE(t.account_email, '') != ''
        AND LOWER(TRIM(i.target_email)) = LOWER(TRIM(t.account_email))
        AND COALESCE(i.workspace_id, '') != ''
        AND COALESCE(i.status, '') IN ('sent', 'accepted')
        AND COALESCE(i.failure_category, '') = ''

      UNION ALL

      SELECT
        t.id AS source_cdk_task_id,
        t.cdk_id AS source_cdk_id,
        t.normalized_cdk_code AS source_cdk_code,
        LOWER(TRIM(t.account_email)) AS email_key,
        COALESCE(
          NULLIF(json_extract(t.invite_result_json, '$.workspace_id'), ''),
          NULLIF(json_extract(t.invite_result_json, '$.workspaceId'), '')
        ) AS workspace_key,
        '' AS remote_invite_id,
        2 AS source_priority,
        datetime(COALESCE(NULLIF(t.completed_at, ''), t.updated_at, t.created_at)) AS source_at
      FROM canonical_cdk_tasks t
      WHERE COALESCE(t.account_email, '') != ''
        AND COALESCE(t.invite_result_json, '') != ''
        AND json_valid(t.invite_result_json)
        AND COALESCE(json_extract(t.invite_result_json, '$.failure_category'), '') = ''
        AND COALESCE(
          NULLIF(json_extract(t.invite_result_json, '$.workspace_id'), ''),
          NULLIF(json_extract(t.invite_result_json, '$.workspaceId'), '')
        ) != ''

    )
    SELECT *
    FROM candidate_sources
    WHERE email_key IN (${placeholders})
    ORDER BY source_priority ASC, datetime(source_at) ASC, source_cdk_task_id ASC
  `).all(...normalizedEmails);
}

function normalizeAssignmentItem(row = {}, index = 0) {
  return {
    ...row,
    id: String(row.id ?? `row-${index}`),
    item_type: row.item_type || 'member',
    email_key: normalizeEmail(row.email),
    workspace_key: normalizeWorkspaceId(row.workspace_id),
    remote_invite_id: String(row.remote_invite_id || '').trim(),
  };
}

function sourceCanBindItem(source = {}, item = {}, requireWorkspace = false) {
  if (!source?.source_cdk_task_id || !item?.email_key) {
    return false;
  }

  if (normalizeEmail(source.email_key) !== item.email_key) {
    return false;
  }

  const sourceWorkspace = normalizeWorkspaceId(source.workspace_key);
  if (requireWorkspace && sourceWorkspace !== item.workspace_key) {
    return false;
  }

  if (sourceWorkspace && sourceWorkspace !== item.workspace_key) {
    return false;
  }

  const sourceRemoteInviteId = getSourceRemoteInviteId(source);
  if (sourceRemoteInviteId && item.remote_invite_id && sourceRemoteInviteId !== item.remote_invite_id) {
    return false;
  }

  return true;
}

function assignmentScore(source = {}, item = {}, requireWorkspace = false) {
  if (!sourceCanBindItem(source, item, requireWorkspace)) {
    return null;
  }

  const sourceRemoteInviteId = getSourceRemoteInviteId(source);
  const itemRemoteInviteId = String(item.remote_invite_id || '').trim();
  const sourceAt = parseTime(source.source_at);
  const rowAt = itemTime(item);
  const timeDistance = sourceAt && rowAt
    ? Math.abs(sourceAt - rowAt)
    : Number.MAX_SAFE_INTEGER;

  let score = Number(source.source_priority || 99) * 1000000000;

  if (sourceRemoteInviteId && itemRemoteInviteId && sourceRemoteInviteId === itemRemoteInviteId) {
    score += 0;
  } else if (sourceRemoteInviteId && item.item_type === 'member') {
    score += 100000;
  } else if (sourceRemoteInviteId) {
    score += 200000;
  } else if (itemRemoteInviteId) {
    score += 300000;
  } else {
    score += 400000;
  }

  score += item.item_type === 'pending' && sourceRemoteInviteId && itemRemoteInviteId ? 0 : item.item_type === 'member' ? 1000 : 2000;
  score += Math.min(timeDistance, 30 * 24 * 60 * 60 * 1000) / 1000;
  return score;
}

function buildStrictCdkSourceAssignments(rows = []) {
  const items = rows
    .map(normalizeAssignmentItem)
    .filter(item => item.email_key);
  const assignments = new Map();

  if (items.length === 0) {
    return assignments;
  }

  const sources = loadStrictCdkSourcesForEmails(items.map(item => item.email_key));
  const usedTasks = new Set();
  const usedItems = new Set();
  const sortedItems = items
    .slice()
    .sort((left, right) => {
      const timeDiff = itemTime(left) - itemTime(right);
      if (timeDiff !== 0) {
        return timeDiff;
      }
      return makeAssignmentKey(left).localeCompare(makeAssignmentKey(right));
    });

  const sortedSources = sources
    .slice()
    .sort((left, right) => {
      const priorityDiff = Number(left.source_priority || 99) - Number(right.source_priority || 99);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      const timeDiff = parseTime(left.source_at) - parseTime(right.source_at);
      if (timeDiff !== 0) {
        return timeDiff;
      }
      return String(left.source_cdk_task_id || '').localeCompare(String(right.source_cdk_task_id || ''));
    });

  function assign(source, item) {
    const itemKey = makeAssignmentKey(item);
    assignments.set(itemKey, toSourceObject(source));
    usedTasks.add(sourceTaskId(source));
    usedItems.add(itemKey);
  }

  function assignPass(candidateSources, requireWorkspace) {
    for (const source of candidateSources) {
      const taskId = sourceTaskId(source);
      if (!taskId || usedTasks.has(taskId)) {
        continue;
      }

      let item = null;
      let itemKey = '';
      let bestScore = Infinity;

      for (const row of sortedItems) {
        const candidateKey = makeAssignmentKey(row);
        if (usedItems.has(candidateKey)) {
          continue;
        }

        const score = assignmentScore(source, row, requireWorkspace);
        if (score === null) {
          continue;
        }

        if (score < bestScore || (score === bestScore && (!itemKey || candidateKey.localeCompare(itemKey) < 0))) {
          item = row;
          itemKey = candidateKey;
          bestScore = score;
        }
      }

      if (item) {
        assign(source, item);
      }
    }
  }

  // A CDK source is only valid for the workspace it actually invited into.
  // Do not fall back by email globally, otherwise old CDK records can be bound to
  // a later invite in another workspace.
  assignPass(sortedSources.filter(source => normalizeWorkspaceId(source.workspace_key)), true);

  return assignments;
}

module.exports = {
  buildStrictCdkSourceAssignments,
  canonicalCdkTasksCte,
  findStrictCdkSourceForWorkspaceEmail,
  loadStrictCdkSourcesForEmails,
  makeAssignmentKey,
  normalizeCdkCode,
  normalizeEmail,
  normalizeWorkspaceId,
  toSourceObject,
};
