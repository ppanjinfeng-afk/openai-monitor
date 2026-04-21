const express = require('express');
const db = require('../db');
const router = express.Router();

// GET /api/invites — list all invites
router.get('/', (req, res) => {
  const { search, page = 1, limit = 50 } = req.query;
  let query = `
    SELECT
      i.*,
      a.email as account_email,
      a.label as account_label,
      req.email as requested_account_email,
      req.label as requested_account_label,
      fb.email as fallback_from_account_email,
      fb.label as fallback_from_account_label
    FROM invites i
    JOIN accounts a ON i.account_id = a.id
    LEFT JOIN accounts req ON i.requested_account_id = req.id
    LEFT JOIN accounts fb ON i.fallback_from_account_id = fb.id
  `;
  const conditions = [];
  const params = [];

  if (search) {
    conditions.push(`
      (
        i.target_email LIKE ?
        OR a.email LIKE ?
        OR COALESCE(req.email, '') LIKE ?
        OR COALESCE(fb.email, '') LIKE ?
        OR COALESCE(i.workspace_name, '') LIKE ?
        OR COALESCE(i.workspace_id, '') LIKE ?
        OR COALESCE(i.remote_invite_id, '') LIKE ?
      )
    `);
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY i.created_at DESC, i.id DESC';

  const offset = (parseInt(page) - 1) * parseInt(limit);
  
  // Count total matching rows
  let countQuery = `
    SELECT COUNT(*) as count 
    FROM invites i
    JOIN accounts a ON i.account_id = a.id
    LEFT JOIN accounts req ON i.requested_account_id = req.id
    LEFT JOIN accounts fb ON i.fallback_from_account_id = fb.id
  `;
  if (conditions.length > 0) {
    countQuery += ' WHERE ' + conditions.join(' AND ');
  }
  const total = db.prepare(countQuery).get(...params).count;

  query += ` LIMIT ? OFFSET ?`;
  params.push(parseInt(limit), offset);
  
  const invites = db.prepare(query).all(...params);

  res.json({ invites, total, page: parseInt(page), limit: parseInt(limit) });
});

// DELETE /api/invites/:id — delete invite record
router.delete('/:id', (req, res) => {
  const { id } = req.params;
  db.prepare('DELETE FROM invites WHERE id = ?').run(id);
  res.json({ message: 'Invite record deleted' });
});

module.exports = router;
