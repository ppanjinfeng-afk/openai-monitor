const express = require('express');
const db = require('../db');
const telegram = require('../services/telegram');
const telegramControl = require('../services/telegram-control');
const scheduler = require('../services/scheduler');

const router = express.Router();

// GET /api/settings — get all settings
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM settings').all();
  const settings = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  res.json(settings);
});

// PUT /api/settings — update settings
router.put('/', (req, res) => {
  const update = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

  const allowedKeys = [
    'telegram_bot_token',
    'telegram_chat_id',
    'check_interval_minutes',
    'member_cleanup_interval_minutes',
    'alerts_enabled',
    'daily_summary_enabled',
    'daily_summary_hour',
    'invite_cooldown_minutes',
    'public_tunnel_enabled',
    'cdk_team_price_cents',
    'untracked_members_auto_kick_enabled',
    'stale_members_auto_kick_enabled',
    'stale_members_auto_kick_hours',
  ];

  const updateAll = db.transaction(() => {
    for (const [key, value] of Object.entries(req.body)) {
      if (allowedKeys.includes(key)) {
        if (key === 'cdk_team_price_cents') {
          const cents = Number.parseInt(value, 10);
          if (!Number.isFinite(cents) || cents < 1 || cents > 999999) {
            const err = new Error('CDK 单价必须在 0.01 到 9999.99 元之间');
            err.statusCode = 400;
            throw err;
          }
          update.run(key, String(cents));
          continue;
        }

        if (key === 'stale_members_auto_kick_hours') {
          const hours = Number.parseFloat(value);
          if (!Number.isFinite(hours) || hours < 1 || hours > 720) {
            const err = new Error('Auto kick hours must be between 1 and 720');
            err.statusCode = 400;
            throw err;
          }
          update.run(key, String(hours));
          continue;
        }

        if (key === 'member_cleanup_interval_minutes') {
          const minutes = Number.parseInt(value, 10);
          if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60) {
            const err = new Error('Member cleanup interval must be between 1 and 60 minutes');
            err.statusCode = 400;
            throw err;
          }
          update.run(key, String(minutes));
          continue;
        }

        update.run(key, String(value));
      }
    }
  });

  try {
    updateAll();
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }

  // Restart scheduler if interval changed
  if (
    req.body.check_interval_minutes ||
    req.body.member_cleanup_interval_minutes ||
    req.body.daily_summary_enabled ||
    req.body.daily_summary_hour
  ) {
    scheduler.restartScheduler();
  }

  if (
    req.body.telegram_bot_token !== undefined ||
    req.body.telegram_chat_id !== undefined ||
    req.body.alerts_enabled !== undefined
  ) {
    telegramControl.restartTelegramControl();
  }

  const rows = db.prepare('SELECT * FROM settings').all();
  const settings = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  res.json(settings);
});

// POST /api/settings/test-telegram — send a test message
router.post('/test-telegram', async (req, res) => {
  try {
    const success = await telegram.sendTestMessage();
    if (success) {
      res.json({ message: 'Test message sent successfully' });
    } else {
      res.status(400).json({ error: 'Failed to send test message. Check your Telegram configuration.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
