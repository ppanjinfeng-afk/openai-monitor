const db = require('../db');
const fetch = require('node-fetch');
const telegram = require('./telegram');

const OFFSET_KEY = 'telegram_control_offset';
const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';

let baseUrl = DEFAULT_BASE_URL;
let pollTimer = null;
let polling = false;
let stopRequested = false;

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeCommand(input) {
  return String(input || '').trim().toLowerCase().replace(/@.+$/, '');
}

function normalizePlainTextCommand(input) {
  const text = String(input || '').trim();
  if (!text) {
    return '';
  }

  if (text.startsWith('/')) {
    return normalizeCommand(text.split(/\s+/)[0]);
  }

  if (text.includes('坏号')) return '/bad';
  if (text.includes('可用账号') || text.includes('账号列表')) return '/accounts';
  if (text.includes('统计') || text.includes('多少个账号') || (text.includes('账号') && text.includes('多少'))) return '/stats';
  if (text === '开始' || text === '菜单' || text === '帮助') return '/help';
  return '';
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function getControlConfig() {
  const config = telegram.getConfig();
  return {
    token: String(config.token || '').trim(),
    chatId: String(config.chatId || '').trim(),
  };
}

function getOffset() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(OFFSET_KEY);
  return Math.max(0, parseInt(row?.value || '0', 10) || 0);
}

function setOffset(offset) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(OFFSET_KEY, String(offset));
}

function buildReplyKeyboard() {
  return {
    keyboard: [
      [{ text: '/stats' }, { text: '/accounts' }],
      [{ text: '/bad' }, { text: '/help' }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function buildHelpText() {
  return [
    '<b>TG 远程控制已连接</b>',
    '',
    '可用命令：',
    '/stats 查看统计',
    '/accounts 查看可用账号',
    '/bad 查看坏号',
    '/invite 邮箱 自动邀请',
    '/invite 账号ID 邮箱 指定账号邀请',
    '/resend 账号ID 邮箱 指定账号补发',
    '/recover 账号ID 恢复坏号',
    '/check 账号ID 立即检查账号',
    '/syncquota 账号ID 同步单号名额',
    '/help 查看帮助',
    '',
    '示例：',
    '<code>/invite test@example.com</code>',
    '<code>/invite 12 test@example.com</code>',
    '<code>/resend 12 test@example.com</code>',
    '<code>/recover 12</code>',
  ].join('\n');
}

async function telegramApi(method, payload = {}) {
  const config = getControlConfig();
  if (!config.token) {
    throw new Error('Telegram bot token 未配置');
  }

  const url = `https://api.telegram.org/bot${config.token}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));

  if (!data.ok) {
    throw new Error(data.description || `HTTP ${res.status}`);
  }

  return data.result;
}

async function localApi(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-openai-monitor-internal': '1',
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  return {
    ok: res.ok,
    status: res.status,
    data,
  };
}

async function sendReply(chatId, text, replyMarkup = null) {
  return telegram.sendMessage(text, 'HTML', {
    force: true,
    chatId,
    replyMarkup,
  });
}

async function syncCommandMenu() {
  await telegramApi('setMyCommands', {
    commands: [
      { command: 'start', description: '打开远程控制帮助' },
      { command: 'stats', description: '查看当前统计' },
      { command: 'accounts', description: '查看可用账号' },
      { command: 'bad', description: '查看坏号' },
      { command: 'invite', description: '发送邀请' },
      { command: 'resend', description: '补发邀请' },
      { command: 'recover', description: '恢复坏号' },
      { command: 'check', description: '立即检查账号' },
      { command: 'syncquota', description: '同步单号名额' },
      { command: 'help', description: '查看帮助' },
    ],
  });
}

async function initializeOffset() {
  const currentOffset = getOffset();
  if (currentOffset > 0) {
    return;
  }

  const updates = await telegramApi('getUpdates', {
    timeout: 0,
    allowed_updates: ['message'],
  });

  if (Array.isArray(updates) && updates.length > 0) {
    const nextOffset = updates[updates.length - 1].update_id + 1;
    setOffset(nextOffset);
    console.log(`[TelegramControl] Initialized offset at ${nextOffset}`);
  }
}

function formatInviteResult(title, targetEmail, data) {
  const lines = [
    `<b>${title}</b>`,
    '',
    `邮箱: <code>${escapeHtml(targetEmail)}</code>`,
  ];

  if (data.used_account) {
    lines.push(`实际账号: <code>${escapeHtml(data.used_account)}</code>`);
  }
  if (data.fallback_from_account) {
    lines.push(`回退自: <code>${escapeHtml(data.fallback_from_account)}</code>`);
  }
  if (data.workspace_name || data.workspace_id) {
    lines.push(`工作区: <code>${escapeHtml(data.workspace_name || data.workspace_id)}</code>`);
  }
  if (data.remote_invite_id) {
    lines.push(`远端ID: <code>${escapeHtml(data.remote_invite_id)}</code>`);
  }
  if (data.message) {
    lines.push(`结果: ${escapeHtml(data.message)}`);
  }

  if (data.quota_sync) {
    lines.push(
      `名额: 成员 ${Number(data.quota_sync.member_seats || 0)} / 待处理 ${Number(data.quota_sync.pending_invites || 0)} / 剩余 ${Number(data.quota_sync.remaining_seats || 0)}`
    );
  } else if (data.quota_sync_skipped_reason) {
    lines.push(`名额刷新: ${escapeHtml(data.quota_sync_skipped_reason)}`);
  }

  return lines.join('\n');
}

async function handleStats(chatId) {
  const result = await localApi('/api/accounts/stats');
  if (!result.ok) {
    await sendReply(chatId, `<b>查询统计失败</b>\n\n${escapeHtml(result.data.error || `HTTP ${result.status}`)}`);
    return;
  }

  const stats = result.data;
  const text = [
    '<b>当前统计</b>',
    '',
    `总账号: ${stats.total || 0}`,
    `活跃: ${stats.active || 0}`,
    `封号类: ${stats.banned || 0}`,
    `无密码: ${stats.noPassword || 0}`,
    `邀请名额: ${stats.invitesUsed || 0}/${stats.invitesTotal || 0}`,
    `配额同步: ${stats.quotaSyncSuccess || 0}/${stats.quotaSyncEligible || 0}`,
    `超额预警: ${stats.overQuota || 0}`,
    `坏号: ${stats.badInviteAccounts || 0}`,
    `待观察: ${stats.watchInviteAccounts || 0}`,
  ].join('\n');

  await sendReply(chatId, text);
}

async function handleAccounts(chatId) {
  const result = await localApi('/api/accounts?status=active&limit=100');
  if (!result.ok) {
    await sendReply(chatId, `<b>查询账号失败</b>\n\n${escapeHtml(result.data.error || `HTTP ${result.status}`)}`);
    return;
  }

  const rows = (result.data.accounts || [])
    .filter(account => account.access_token)
    .sort((a, b) => Number(b.projected_remaining || 0) - Number(a.projected_remaining || 0))
    .slice(0, 12);

  if (rows.length === 0) {
    await sendReply(chatId, '<b>当前没有可用账号</b>');
    return;
  }

  const text = [
    '<b>可用账号</b>',
    '',
    ...rows.map(account => {
      const remaining = Number(account.projected_remaining || 0);
      const health = escapeHtml(account.invite_health_label || '正常');
      return `#${account.id} <code>${escapeHtml(account.email)}</code>\n剩余 ${remaining} · ${health}`;
    }),
  ].join('\n');

  await sendReply(chatId, text);
}

async function handleBad(chatId) {
  const result = await localApi('/api/accounts/invite-health?only_bad=true');
  if (!result.ok) {
    await sendReply(chatId, `<b>坏号检测失败</b>\n\n${escapeHtml(result.data.error || `HTTP ${result.status}`)}`);
    return;
  }

  const rows = result.data.accounts || [];
  if (rows.length === 0) {
    await sendReply(chatId, '<b>当前没有检测到坏号</b>');
    return;
  }

  const text = [
    `<b>坏号列表</b>`,
    '',
    ...rows.slice(0, 10).map(account => {
      return [
        `#${account.id} <code>${escapeHtml(account.email)}</code>`,
        `假成功 ${Number(account.recent_materialize_failures || 0)} · 补发异常 ${Number(account.recent_retry_failures || 0)} · 剩余 ${Number(account.projected_remaining || 0)}`,
        `${escapeHtml(account.diagnosis || '')}`,
      ].join('\n');
    }),
  ].join('\n\n');

  await sendReply(chatId, text);
}

async function handleInvite(chatId, args, forceResend = false) {
  let path = '/api/accounts/auto-invite';
  let body = null;
  let targetEmail = '';

  if (args.length === 1 && isEmail(args[0])) {
    targetEmail = String(args[0]).trim();
    body = { email: targetEmail };
  } else if (args.length >= 2 && /^\d+$/.test(args[0]) && isEmail(args[1])) {
    const accountId = parseInt(args[0], 10);
    targetEmail = String(args[1]).trim();
    path = `/api/accounts/${accountId}/invite`;
    body = {
      email: targetEmail,
      ...(forceResend ? { force_resend: true } : {}),
    };
  } else {
    await sendReply(
      chatId,
      forceResend
        ? '<b>补发命令格式</b>\n\n<code>/resend 账号ID 邮箱</code>'
        : '<b>邀请命令格式</b>\n\n自动邀请：<code>/invite 邮箱</code>\n指定账号：<code>/invite 账号ID 邮箱</code>'
    );
    return;
  }

  const result = await localApi(path, {
    method: 'POST',
    body,
  });

  if (!result.ok) {
    await sendReply(
      chatId,
      `<b>${forceResend ? '补发失败' : '邀请失败'}</b>\n\n${escapeHtml(result.data.error || `HTTP ${result.status}`)}`
    );
    return;
  }

  await sendReply(
    chatId,
    formatInviteResult(forceResend ? '补发成功' : '邀请成功', targetEmail, result.data)
  );
}

async function handleCheck(chatId, args) {
  const accountId = parseInt(args[0], 10);
  if (!accountId) {
    await sendReply(chatId, '<b>检查命令格式</b>\n\n<code>/check 账号ID</code>');
    return;
  }

  const result = await localApi(`/api/checks/${accountId}`, { method: 'POST' });
  if (!result.ok) {
    await sendReply(chatId, `<b>检查失败</b>\n\n${escapeHtml(result.data.error || `HTTP ${result.status}`)}`);
    return;
  }

  await sendReply(
    chatId,
    `<b>检查完成</b>\n\n账号ID: <code>${accountId}</code>\n状态: ${escapeHtml(result.data.status || 'unknown')}\n结果: ${escapeHtml(result.data.message || '')}`
  );
}

async function handleSyncQuota(chatId, args) {
  const accountId = parseInt(args[0], 10);
  if (!accountId) {
    await sendReply(chatId, '<b>同步命令格式</b>\n\n<code>/syncquota 账号ID</code>');
    return;
  }

  const result = await localApi(`/api/accounts/${accountId}/sync-quota`, { method: 'POST' });
  if (!result.ok) {
    await sendReply(chatId, `<b>同步失败</b>\n\n${escapeHtml(result.data.error || `HTTP ${result.status}`)}`);
    return;
  }

  const data = result.data;
  await sendReply(
    chatId,
    [
      '<b>名额同步完成</b>',
      '',
      `账号: <code>${escapeHtml(data.email || String(accountId))}</code>`,
      `成员总数: ${Number(data.totalUsers || 0)}`,
      `占位成员: ${Number(data.memberSeats || 0)}`,
      `待处理邀请: ${Number(data.pendingInvites || 0)}`,
      `剩余: ${Number(data.remainingSeats || 0)}`,
    ].join('\n')
  );
}

async function handleRecover(chatId, args) {
  const accountId = parseInt(args[0], 10);
  if (!accountId) {
    await sendReply(chatId, '<b>恢复命令格式</b>\n\n<code>/recover 账号ID</code>');
    return;
  }

  const result = await localApi(`/api/accounts/${accountId}/restore-invite-health`, { method: 'POST' });
  if (!result.ok) {
    await sendReply(chatId, `<b>恢复坏号失败</b>\n\n${escapeHtml(result.data.error || `HTTP ${result.status}`)}`);
    return;
  }

  const account = result.data.account || {};
  await sendReply(
    chatId,
    [
      '<b>坏号已恢复</b>',
      '',
      `账号: <code>${escapeHtml(account.email || String(accountId))}</code>`,
      `恢复记录: ${Number(result.data.restored || 0)}`,
      `当前状态: ${escapeHtml(account.invite_health_label || '正常')}`,
      `${escapeHtml(account.diagnosis || result.data.message || '')}`,
    ].join('\n')
  );
}

async function handleMessage(message) {
  const config = getControlConfig();
  const chatId = String(message?.chat?.id || '');
  if (!config.chatId || chatId !== config.chatId) {
    return;
  }

  const text = String(message.text || '').trim();
  if (!text) {
    return;
  }

  const parts = text.split(/\s+/);
  let command = normalizeCommand(parts.shift());
  if (!command) {
    command = normalizePlainTextCommand(text);
  }
  const args = parts;

  console.log(`[TelegramControl] ${chatId} => ${text}`);

  switch (command) {
    case '/start':
    case '/help':
      await sendReply(chatId, buildHelpText(), buildReplyKeyboard());
      break;
    case '/stats':
      await handleStats(chatId);
      break;
    case '/accounts':
      await handleAccounts(chatId);
      break;
    case '/bad':
      await handleBad(chatId);
      break;
    case '/invite':
      await handleInvite(chatId, args, false);
      break;
    case '/resend':
      await handleInvite(chatId, args, true);
      break;
    case '/recover':
      await handleRecover(chatId, args);
      break;
    case '/check':
      await handleCheck(chatId, args);
      break;
    case '/syncquota':
      await handleSyncQuota(chatId, args);
      break;
    default:
      await sendReply(
        chatId,
        '<b>未识别命令</b>\n\n发送 <code>/help</code> 查看可用命令。',
        buildReplyKeyboard()
      );
      break;
  }
}

function scheduleNextPoll(delay = 1000) {
  if (stopRequested) {
    return;
  }

  clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    pollUpdates().catch(err => {
      console.error('[TelegramControl] Poll loop failed:', err.message);
      scheduleNextPoll(3000);
    });
  }, delay);
}

async function pollUpdates() {
  if (polling || stopRequested) {
    return;
  }

  const config = getControlConfig();
  if (!config.token || !config.chatId) {
    return;
  }

  polling = true;
  try {
    const updates = await telegramApi('getUpdates', {
      offset: getOffset() || undefined,
      timeout: 15,
      allowed_updates: ['message'],
    });

    for (const update of updates) {
      const nextOffset = update.update_id + 1;
      setOffset(nextOffset);
      try {
        await handleMessage(update.message);
      } catch (err) {
        console.error('[TelegramControl] Handle message failed:', err.message);
        const fallbackChatId = String(update?.message?.chat?.id || '');
        if (fallbackChatId) {
          await sendReply(
            fallbackChatId,
            `<b>命令执行失败</b>\n\n${escapeHtml(err.message || '未知错误')}`
          ).catch(innerErr => {
            console.error('[TelegramControl] Failed to send error reply:', innerErr.message);
          });
        }
      }
    }
  } catch (err) {
    console.error('[TelegramControl] Poll failed:', err.message);
  } finally {
    polling = false;
    scheduleNextPoll(1200);
  }
}

async function startTelegramControl(options = {}) {
  if (options.baseUrl) {
    baseUrl = options.baseUrl;
  }

  stopTelegramControl();
  stopRequested = false;

  const config = getControlConfig();
  if (!config.token || !config.chatId) {
    console.log('[TelegramControl] Missing token or chat_id, skipping');
    return;
  }

  try {
    await telegramApi('deleteWebhook', { drop_pending_updates: false });
  } catch (err) {
    console.error('[TelegramControl] deleteWebhook failed:', err.message);
  }

  try {
    await syncCommandMenu();
  } catch (err) {
    console.error('[TelegramControl] setMyCommands failed:', err.message);
  }

  try {
    await initializeOffset();
  } catch (err) {
    console.error('[TelegramControl] initialize offset failed:', err.message);
  }

  console.log(`[TelegramControl] Listening on chat ${config.chatId}`);
  scheduleNextPoll(800);
}

function stopTelegramControl() {
  stopRequested = true;
  clearTimeout(pollTimer);
  pollTimer = null;
}

function restartTelegramControl(options = {}) {
  stopTelegramControl();
  startTelegramControl(options).catch(err => {
    console.error('[TelegramControl] restart failed:', err.message);
  });
}

module.exports = {
  startTelegramControl,
  stopTelegramControl,
  restartTelegramControl,
};
