const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'monitor.db'));

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    password TEXT DEFAULT '',
    access_token TEXT DEFAULT '',
    refresh_token TEXT DEFAULT '',
    label TEXT DEFAULT '',
    status TEXT DEFAULT 'unknown',
    invited_count INTEGER DEFAULT 0,
    invite_total INTEGER DEFAULT 4,
    invite_link TEXT DEFAULT '',
    last_checked TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS check_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    message TEXT DEFAULT '',
    checked_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    target_email TEXT NOT NULL,
    status TEXT DEFAULT 'sent',
    message TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workspaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    workspace_id TEXT NOT NULL,
    workspace_name TEXT DEFAULT '',
    plan_type TEXT DEFAULT '',
    member_count INTEGER DEFAULT 0,
    occupied_seats INTEGER DEFAULT 0,
    pending_invites INTEGER DEFAULT 0,
    invite_total_hint INTEGER DEFAULT 0,
    remaining_seats INTEGER DEFAULT 0,
    projected_remaining_seats INTEGER DEFAULT 0,
    sync_status TEXT DEFAULT 'never',
    sync_message TEXT DEFAULT '',
    last_synced_at TEXT,
    health_score INTEGER DEFAULT 0,
    health_label TEXT DEFAULT '',
    recent_error_count INTEGER DEFAULT 0,
    invite_locked INTEGER DEFAULT 0,
    auto_invite_locked INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(account_id, workspace_id),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS workspace_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    account_user_id TEXT DEFAULT '',
    email TEXT DEFAULT '',
    name TEXT DEFAULT '',
    role TEXT DEFAULT '',
    seat_type TEXT DEFAULT '',
    is_owner INTEGER DEFAULT 0,
    deactivated_time TEXT DEFAULT '',
    joined_at TEXT DEFAULT '',
    last_synced_at TEXT,
    UNIQUE(workspace_id, user_id),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS workspace_pending_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    workspace_id TEXT NOT NULL,
    remote_invite_id TEXT DEFAULT '',
    email TEXT DEFAULT '',
    invited_at TEXT DEFAULT '',
    last_synced_at TEXT,
    UNIQUE(workspace_id, email),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS cdk_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    status TEXT DEFAULT 'unused',
    plan_type TEXT DEFAULT 'plus_monthly',
    assigned_email TEXT DEFAULT '',
    buyer_email TEXT DEFAULT '',
    source_order_no TEXT DEFAULT '',
    used_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cdk_tasks (
    id TEXT PRIMARY KEY,
    cdk_id INTEGER,
    cdk_code TEXT NOT NULL,
    task_type TEXT DEFAULT 'plus_checkout',
    account_email TEXT DEFAULT '',
    access_token TEXT DEFAULT '',
    session_json TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    status_message TEXT DEFAULT '',
    error_message TEXT DEFAULT '',
    checkout_session_id TEXT DEFAULT '',
    card_last4 TEXT DEFAULT '',
    invite_result_json TEXT DEFAULT '',
    task_token TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    FOREIGN KEY (cdk_id) REFERENCES cdk_cards(id)
  );

  CREATE TABLE IF NOT EXISTS cdk_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no TEXT NOT NULL UNIQUE,
    buyer_email TEXT NOT NULL,
    product_type TEXT DEFAULT 'team_invite',
    payment_method TEXT DEFAULT 'mock',
    amount_cents INTEGER NOT NULL,
    currency TEXT DEFAULT 'CNY',
    status TEXT DEFAULT 'pending',
    provider_order_id TEXT DEFAULT '',
    provider_trade_no TEXT DEFAULT '',
    pay_url TEXT DEFAULT '',
    public_token TEXT DEFAULT '',
    paid_amount_cents INTEGER DEFAULT 0,
    payer_name TEXT DEFAULT '',
    listener_event_id INTEGER,
    match_status TEXT DEFAULT '',
    receipt_raw TEXT DEFAULT '',
    cdk_id INTEGER,
    cdk_code TEXT DEFAULT '',
    paid_at TEXT,
    delivered_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (cdk_id) REFERENCES cdk_cards(id)
  );

  CREATE TABLE IF NOT EXISTS cdk_order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no TEXT NOT NULL,
    item_index INTEGER NOT NULL,
    target_email TEXT DEFAULT '',
    cdk_id INTEGER,
    cdk_code TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(order_no, item_index),
    FOREIGN KEY (order_no) REFERENCES cdk_orders(order_no) ON DELETE CASCADE,
    FOREIGN KEY (cdk_id) REFERENCES cdk_cards(id)
  );

  CREATE TABLE IF NOT EXISTS checkout_tools_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_type TEXT DEFAULT '',
    raw_input TEXT DEFAULT '',
    normalized_link TEXT DEFAULT '',
    session_id TEXT DEFAULT '',
    redeem_code_masked TEXT DEFAULT '',
    source_domain TEXT DEFAULT '',
    status TEXT DEFAULT 'parsed',
    note TEXT DEFAULT '',
    last_action TEXT DEFAULT '',
    last_used_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

function ensureColumn(tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some(column => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
  }
}

ensureColumn('invites', 'requested_account_id', 'requested_account_id INTEGER');
ensureColumn('invites', 'fallback_from_account_id', 'fallback_from_account_id INTEGER');
ensureColumn('invites', 'remote_invite_id', "remote_invite_id TEXT DEFAULT ''");
ensureColumn('invites', 'delivery_type', "delivery_type TEXT DEFAULT 'send'");
ensureColumn('invites', 'workspace_id', "workspace_id TEXT DEFAULT ''");
ensureColumn('invites', 'workspace_name', "workspace_name TEXT DEFAULT ''");
ensureColumn('invites', 'remote_state', "remote_state TEXT DEFAULT ''");
ensureColumn('invites', 'remote_last_seen_at', 'remote_last_seen_at TEXT');
ensureColumn('invites', 'failure_category', "failure_category TEXT DEFAULT ''");
ensureColumn('invites', 'cdk_task_id', "cdk_task_id TEXT DEFAULT ''");
ensureColumn('accounts', 'quota_sync_status', "quota_sync_status TEXT DEFAULT 'never'");
ensureColumn('accounts', 'quota_sync_message', "quota_sync_message TEXT DEFAULT ''");
ensureColumn('accounts', 'quota_last_synced_at', 'quota_last_synced_at TEXT');
ensureColumn('accounts', 'quota_member_seats', 'quota_member_seats INTEGER DEFAULT 0');
ensureColumn('accounts', 'quota_pending_invites', 'quota_pending_invites INTEGER DEFAULT 0');
ensureColumn('accounts', 'quota_total_users', 'quota_total_users INTEGER DEFAULT 0');
ensureColumn('accounts', 'quota_workspace_id', "quota_workspace_id TEXT DEFAULT ''");
ensureColumn('accounts', 'quota_workspace_name', "quota_workspace_name TEXT DEFAULT ''");
ensureColumn('accounts', 'quota_plan_type', "quota_plan_type TEXT DEFAULT ''");
ensureColumn('accounts', 'invite_paused', 'invite_paused INTEGER DEFAULT 0');
ensureColumn('accounts', 'invite_pause_reason', "invite_pause_reason TEXT DEFAULT ''");
ensureColumn('accounts', 'invite_paused_at', 'invite_paused_at TEXT');
ensureColumn('workspaces', 'invite_locked', 'invite_locked INTEGER DEFAULT 0');
ensureColumn('workspaces', 'auto_invite_locked', 'auto_invite_locked INTEGER DEFAULT 0');
ensureColumn('workspace_members', 'source_cdk_task_id', "source_cdk_task_id TEXT DEFAULT ''");
ensureColumn('workspace_members', 'source_cdk_id', 'source_cdk_id INTEGER');
ensureColumn('workspace_members', 'source_cdk_code', "source_cdk_code TEXT DEFAULT ''");
ensureColumn('workspace_pending_invites', 'source_cdk_task_id', "source_cdk_task_id TEXT DEFAULT ''");
ensureColumn('workspace_pending_invites', 'source_cdk_id', 'source_cdk_id INTEGER');
ensureColumn('workspace_pending_invites', 'source_cdk_code', "source_cdk_code TEXT DEFAULT ''");
ensureColumn('cdk_cards', 'buyer_email', "buyer_email TEXT DEFAULT ''");
ensureColumn('cdk_cards', 'source_order_no', "source_order_no TEXT DEFAULT ''");
ensureColumn('cdk_tasks', 'task_type', "task_type TEXT DEFAULT 'plus_checkout'");
ensureColumn('cdk_tasks', 'invite_result_json', "invite_result_json TEXT DEFAULT ''");
ensureColumn('cdk_tasks', 'task_token', "task_token TEXT DEFAULT ''");
ensureColumn('cdk_orders', 'public_token', "public_token TEXT DEFAULT ''");
ensureColumn('cdk_orders', 'paid_amount_cents', "paid_amount_cents INTEGER DEFAULT 0");
ensureColumn('cdk_orders', 'payer_name', "payer_name TEXT DEFAULT ''");
ensureColumn('cdk_orders', 'listener_event_id', 'listener_event_id INTEGER');
ensureColumn('cdk_orders', 'match_status', "match_status TEXT DEFAULT ''");
ensureColumn('cdk_orders', 'receipt_raw', "receipt_raw TEXT DEFAULT ''");
ensureColumn('cdk_orders', 'item_count', 'item_count INTEGER DEFAULT 1');
ensureColumn('cdk_orders', 'delivered_count', 'delivered_count INTEGER DEFAULT 0');
ensureColumn('checkout_tools_history', 'autosub_status', "autosub_status TEXT DEFAULT 'pending'");
ensureColumn('checkout_tools_history', 'autosub_error', "autosub_error TEXT DEFAULT ''");
ensureColumn('checkout_tools_history', 'card_last4', "card_last4 TEXT DEFAULT ''");
ensureColumn('checkout_tools_history', 'redeem_code_raw', "redeem_code_raw TEXT DEFAULT ''");
ensureColumn('checkout_tools_history', 'checkout_mode', "checkout_mode TEXT DEFAULT 'api'");
ensureColumn('checkout_tools_history', 'card_number_raw', "card_number_raw TEXT DEFAULT ''");
ensureColumn('checkout_tools_history', 'card_exp_raw', "card_exp_raw TEXT DEFAULT ''");
ensureColumn('checkout_tools_history', 'card_cvv_raw', "card_cvv_raw TEXT DEFAULT ''");
ensureColumn('checkout_tools_history', 'autosub_order_id', "autosub_order_id TEXT DEFAULT ''");
ensureColumn('checkout_tools_history', 'card_needs_3ds', "card_needs_3ds INTEGER DEFAULT 0");
ensureColumn('checkout_tools_history', 'autosub_log', "autosub_log TEXT DEFAULT ''");


db.prepare(`
  UPDATE invites
  SET requested_account_id = COALESCE(requested_account_id, account_id),
      delivery_type = CASE
        WHEN delivery_type IS NULL OR TRIM(delivery_type) = '' THEN
          CASE WHEN LOWER(COALESCE(message, '')) LIKE '%resent%' THEN 'resend' ELSE 'send' END
        ELSE delivery_type
      END,
      workspace_id = COALESCE(workspace_id, ''),
      workspace_name = COALESCE(workspace_name, ''),
      remote_state = COALESCE(remote_state, ''),
      failure_category = COALESCE(failure_category, '')
  WHERE requested_account_id IS NULL
     OR delivery_type IS NULL
     OR TRIM(delivery_type) = ''
`).run();

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_invites_target_email ON invites(target_email);
  CREATE INDEX IF NOT EXISTS idx_invites_workspace_email ON invites(workspace_id, target_email);
  CREATE INDEX IF NOT EXISTS idx_invites_cdk_task_id ON invites(cdk_task_id);
  CREATE INDEX IF NOT EXISTS idx_workspaces_account ON workspaces(account_id);
  CREATE INDEX IF NOT EXISTS idx_workspaces_workspace_id ON workspaces(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_workspace_members_email ON workspace_members(email);
  CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace ON workspace_members(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_workspace_members_source_task ON workspace_members(source_cdk_task_id);
  CREATE INDEX IF NOT EXISTS idx_workspace_pending_email ON workspace_pending_invites(email);
  CREATE INDEX IF NOT EXISTS idx_workspace_pending_workspace ON workspace_pending_invites(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_workspace_pending_source_task ON workspace_pending_invites(source_cdk_task_id);
  CREATE INDEX IF NOT EXISTS idx_checkout_tools_session_id ON checkout_tools_history(session_id);
  CREATE INDEX IF NOT EXISTS idx_checkout_tools_created_at ON checkout_tools_history(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_cdk_cards_code ON cdk_cards(code);
  CREATE INDEX IF NOT EXISTS idx_cdk_cards_status ON cdk_cards(status);
  CREATE INDEX IF NOT EXISTS idx_cdk_cards_source_order ON cdk_cards(source_order_no);
  CREATE INDEX IF NOT EXISTS idx_cdk_tasks_status ON cdk_tasks(status);
  CREATE INDEX IF NOT EXISTS idx_cdk_tasks_cdk_code ON cdk_tasks(cdk_code);
  CREATE INDEX IF NOT EXISTS idx_cdk_tasks_task_token ON cdk_tasks(task_token);
  CREATE INDEX IF NOT EXISTS idx_cdk_orders_order_no ON cdk_orders(order_no);
  CREATE INDEX IF NOT EXISTS idx_cdk_orders_public_token ON cdk_orders(public_token);
  CREATE INDEX IF NOT EXISTS idx_cdk_orders_status ON cdk_orders(status);
  CREATE INDEX IF NOT EXISTS idx_cdk_orders_buyer_email ON cdk_orders(buyer_email);
  CREATE INDEX IF NOT EXISTS idx_cdk_orders_amount_status ON cdk_orders(amount_cents, status, created_at);
`);

db.prepare(`
  UPDATE accounts
  SET quota_sync_status = COALESCE(NULLIF(TRIM(quota_sync_status), ''), 'never'),
      quota_sync_message = COALESCE(quota_sync_message, ''),
      quota_member_seats = COALESCE(quota_member_seats, 0),
      quota_pending_invites = COALESCE(quota_pending_invites, 0),
      quota_total_users = COALESCE(quota_total_users, 0),
      quota_workspace_id = COALESCE(quota_workspace_id, ''),
      quota_workspace_name = COALESCE(quota_workspace_name, ''),
      quota_plan_type = COALESCE(quota_plan_type, ''),
      invite_paused = COALESCE(invite_paused, 0),
      invite_pause_reason = COALESCE(invite_pause_reason, '')
  WHERE quota_sync_status IS NULL
     OR TRIM(quota_sync_status) = ''
     OR quota_sync_message IS NULL
`).run();

db.prepare(`
  UPDATE accounts
  SET invited_count = COALESCE(quota_member_seats, 0)
  WHERE quota_sync_status = 'success'
`).run();

// Insert default settings if not exist
const insertSetting = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
const defaultSettings = [
  ['telegram_bot_token', ''],
  ['telegram_chat_id', ''],
  ['check_interval_minutes', '5'],
  ['alerts_enabled', 'true'],
  ['daily_summary_enabled', 'true'],
  ['daily_summary_hour', '9'],
  ['invite_cooldown_minutes', '5'],
  ['public_tunnel_enabled', 'true'],
  ['cdk_team_price_cents', String(Number.parseInt(process.env.CDK_TEAM_PRICE_CENTS || '200', 10) || 200)],
  ['untracked_members_auto_kick_enabled', 'false'],
  ['stale_members_auto_kick_enabled', 'false'],
  ['stale_members_auto_kick_hours', '26'],
];
const insertDefaults = db.transaction(() => {
  for (const [key, value] of defaultSettings) {
    insertSetting.run(key, value);
  }
});
insertDefaults();

module.exports = db;
