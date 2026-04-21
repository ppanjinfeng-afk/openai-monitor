const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, 'data', 'monitor.db'));
const rows = db.prepare("SELECT id, autosub_status, autosub_error, card_last4 FROM checkout_tools_history ORDER BY id DESC LIMIT 5").all();
console.log(JSON.stringify(rows, null, 2));
db.close();
