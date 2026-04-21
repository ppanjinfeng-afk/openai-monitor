const crypto = require('crypto');
const db = require('../db');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCdkCode(prefix = 'TEAM') {
  const bytes = crypto.randomBytes(16);
  let body = '';

  for (let i = 0; i < 16; i++) {
    body += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }

  return `${prefix}-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}`;
}

function createCdkCard(options = {}) {
  const planType = options.planType || 'team_invite';
  const buyerEmail = options.buyerEmail || '';
  const assignedEmail = options.assignedEmail || '';
  const sourceOrderNo = options.sourceOrderNo || '';
  const prefix = options.prefix || 'TEAM';

  let code = '';
  for (let attempt = 0; attempt < 20; attempt++) {
    code = generateCdkCode(prefix);
    const existing = db.prepare('SELECT 1 FROM cdk_cards WHERE code = ?').get(code);
    if (!existing) {
      const result = db.prepare(`
        INSERT INTO cdk_cards (
          code,
          status,
          plan_type,
          assigned_email,
          buyer_email,
          source_order_no
        ) VALUES (?, 'unused', ?, ?, ?, ?)
      `).run(code, planType, assignedEmail, buyerEmail, sourceOrderNo);

      return {
        id: result.lastInsertRowid,
        code,
        planType,
      };
    }
  }

  throw new Error('Failed to generate a unique CDK code');
}

function maskCdkCode(code) {
  const value = String(code || '');
  if (value.length <= 8) {
    return value;
  }

  return `${value.slice(0, 8)}****${value.slice(-4)}`;
}

module.exports = {
  createCdkCard,
  generateCdkCode,
  maskCdkCode,
};
