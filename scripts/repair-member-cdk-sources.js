#!/usr/bin/env node

const db = require('../db');
const {
  buildStrictCdkSourceAssignments,
  makeAssignmentKey,
} = require('../services/cdk-source');

const dryRun = process.argv.includes('--dry-run');

const updateMemberSource = db.prepare(`
  UPDATE workspace_members
  SET source_cdk_task_id = ?,
      source_cdk_id = ?,
      source_cdk_code = ?,
      last_synced_at = datetime('now')
  WHERE id = ?
`);

const updatePendingSource = db.prepare(`
  UPDATE workspace_pending_invites
  SET source_cdk_task_id = ?,
      source_cdk_id = ?,
      source_cdk_code = ?,
      last_synced_at = datetime('now')
  WHERE id = ?
`);

function sourceValues(source) {
  return [
    source?.source_cdk_task_id || '',
    source?.source_cdk_id ?? null,
    source?.source_cdk_code || '',
  ];
}

function repairMembers(assignments) {
  const rows = db.prepare(`
    SELECT
      'member' AS item_type,
      id,
      workspace_id,
      email,
      '' AS remote_invite_id,
      joined_at,
      '' AS invited_at,
      last_synced_at
    FROM workspace_members
    WHERE COALESCE(email, '') != ''
      AND COALESCE(deactivated_time, '') = ''
  `).all();

  let linked = 0;
  let cleared = 0;

  const transaction = db.transaction(() => {
    for (const row of rows) {
      const source = assignments.get(makeAssignmentKey(row));

      if (source) {
        linked += 1;
      } else {
        cleared += 1;
      }

      updateMemberSource.run(...sourceValues(source), row.id);
    }
  });

  if (!dryRun) {
    transaction();
  } else {
    for (const row of rows) {
      const source = assignments.get(makeAssignmentKey(row));
      if (source) linked += 1;
      else cleared += 1;
    }
  }

  return { scanned: rows.length, linked, cleared };
}

function repairPendingInvites(assignments) {
  const rows = db.prepare(`
    SELECT
      'pending' AS item_type,
      id,
      workspace_id,
      remote_invite_id,
      email,
      '' AS joined_at,
      invited_at,
      last_synced_at
    FROM workspace_pending_invites
    WHERE COALESCE(email, '') != ''
  `).all();

  let linked = 0;
  let cleared = 0;

  const transaction = db.transaction(() => {
    for (const row of rows) {
      const source = assignments.get(makeAssignmentKey(row));

      if (source) {
        linked += 1;
      } else {
        cleared += 1;
      }

      updatePendingSource.run(...sourceValues(source), row.id);
    }
  });

  if (!dryRun) {
    transaction();
  } else {
    for (const row of rows) {
      const source = assignments.get(makeAssignmentKey(row));
      if (source) linked += 1;
      else cleared += 1;
    }
  }

  return { scanned: rows.length, linked, cleared };
}

const memberRows = db.prepare(`
  SELECT
    'member' AS item_type,
    id,
    workspace_id,
    email,
    '' AS remote_invite_id,
    joined_at,
    '' AS invited_at,
    last_synced_at
  FROM workspace_members
  WHERE COALESCE(email, '') != ''
    AND COALESCE(deactivated_time, '') = ''
`).all();

const pendingRows = db.prepare(`
  SELECT
    'pending' AS item_type,
    id,
    workspace_id,
    remote_invite_id,
    email,
    '' AS joined_at,
    invited_at,
    last_synced_at
  FROM workspace_pending_invites
  WHERE COALESCE(email, '') != ''
`).all();

const assignments = buildStrictCdkSourceAssignments([...memberRows, ...pendingRows]);

const result = {
  dryRun,
  members: repairMembers(assignments),
  pending_invites: repairPendingInvites(assignments),
};

console.log(JSON.stringify(result, null, 2));
if (dryRun) {
  console.log('\nDry run only. Run without --dry-run to apply the repair.');
}
