/**
 * Test script to run the auto-checkout flow and debug 3DS issues.
 * Usage: node test_checkout.js
 */
const db = require('./db');
const autoCheckout = require('./services/auto-checkout');

const CHECKOUT_URL = 'https://chatgpt.com/checkout/openai_llc/cs_live_a14Hfsj2dgowwoCivW4JZ4ExGAWzQ6Jf16UMoDzoWhWEQFQpKnNLUSKRlF';
const REDEEM_CODE = 'd73be332-56b7-4045-8670-f5fe5c703af7';
const SESSION_ID = 'cs_live_a14Hfsj2dgowwoCivW4JZ4ExGAWzQ6Jf16UMoDzoWhWEQFQpKnNLUSKRlF';

async function main() {
  console.log('=== Auto-Checkout Test ===');
  console.log(`Session: ${SESSION_ID}`);
  console.log(`Redeem Code: ${REDEEM_CODE}`);
  console.log('');
  
  // Create a test history record
  const insert = db.prepare(`
    INSERT INTO checkout_tools_history (
      tool_type, raw_input, normalized_link, session_id, 
      redeem_code_masked, redeem_code_raw, source_domain, 
      status, note, checkout_mode, 
      card_number_raw, card_exp_raw, card_cvv_raw, card_needs_3ds,
      last_action, last_used_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', NULL, datetime('now'))
  `);

  const result = insert.run(
    'checkout_and_code',
    CHECKOUT_URL,
    CHECKOUT_URL,
    SESSION_ID,
    REDEEM_CODE.slice(0, 8) + '...',
    REDEEM_CODE,
    'chatgpt.com',
    'parsed',
    'Test checkout',
    'api',    // mode = api (use redeem code from card vendor)
    '',       // no manual card number
    '',       // no manual exp
    '',       // no manual cvv
    0         // no manual 3ds flag
  );

  const historyId = result.lastInsertRowid;
  console.log(`Created test record: id=${historyId}`);
  console.log('');

  try {
    await autoCheckout.runAutoSub(historyId);
    console.log('');
    console.log('=== ✅ SUCCESS ===');
    const final = db.prepare('SELECT autosub_status, card_last4 FROM checkout_tools_history WHERE id = ?').get(historyId);
    console.log('Final status:', final);
  } catch (err) {
    console.error('');
    console.error('=== ❌ FAILED ===');
    console.error('Error:', err.message);
    const final = db.prepare('SELECT autosub_status, autosub_error FROM checkout_tools_history WHERE id = ?').get(historyId);
    console.log('Final DB record:', final);
  }
  
  process.exit(0);
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
