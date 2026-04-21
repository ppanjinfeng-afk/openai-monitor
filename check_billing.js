/**
 * 检查测试账号的订阅和账单状态
 * 用法: node check_billing.js <accessToken>
 * 
 * 如果不传 token，会提示你去 https://chatgpt.com/api/auth/session 获取
 */

const fetch = require('node-fetch');

const TOKEN = process.argv[2] || '';

if (!TOKEN) {
  console.log('用法: node check_billing.js <你的accessToken>');
  console.log('');
  console.log('获取方法:');
  console.log('1. 在浏览器登录 ChatGPT');
  console.log('2. 访问 https://chatgpt.com/api/auth/session');
  console.log('3. 复制 JSON 中 "accessToken" 的值');
  process.exit(1);
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const headers = {
  'Authorization': `Bearer ${TOKEN}`,
  'User-Agent': UA,
  'Content-Type': 'application/json',
  'Origin': 'https://chatgpt.com',
  'Referer': 'https://chatgpt.com/',
};

async function checkEndpoint(name, url, method = 'GET') {
  try {
    const res = await fetch(url, { method, headers });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📋 ${name}`);
    console.log(`   URL: ${url}`);
    console.log(`   Status: ${res.status}`);
    console.log(`${'='.repeat(60)}`);
    console.log(JSON.stringify(data, null, 2));
    return data;
  } catch (err) {
    console.log(`\n❌ ${name}: ${err.message}`);
    return null;
  }
}

async function main() {
  console.log('🔍 开始检查账号订阅和账单状态...\n');

  // 1. 检查当前用户信息
  await checkEndpoint(
    '用户信息 (me)',
    'https://chatgpt.com/backend-api/me'
  );

  // 2. 检查订阅状态 —— 这是最关键的
  const sub = await checkEndpoint(
    '订阅状态 (subscription)',
    'https://chatgpt.com/backend-api/subscription'
  );

  // 3. 检查账单信息
  await checkEndpoint(
    '账单信息 (billing)',
    'https://chatgpt.com/backend-api/accounts/billing'
  );

  // 4. 检查支付方式
  await checkEndpoint(
    '支付方式 (payment methods)',
    'https://chatgpt.com/backend-api/payments/payment_methods'
  );

  // 5. 检查订阅详情
  await checkEndpoint(
    '订阅计划 (plan)',
    'https://chatgpt.com/backend-api/payments/subscription'
  );

  // 6. 检查发票/收据
  await checkEndpoint(
    '发票记录 (invoices)',
    'https://chatgpt.com/backend-api/payments/invoices'
  );

  // 7. 检查是否在某个workspace/team里
  await checkEndpoint(
    '组织/团队 (accounts)',
    'https://chatgpt.com/backend-api/accounts'
  );

  // 8. 额外检查 - 直接查 Stripe customer
  await checkEndpoint(
    '结账会话 (checkout sessions)',
    'https://chatgpt.com/backend-api/payments/checkout_sessions'
  );

  console.log('\n\n' + '='.repeat(60));
  console.log('📊 分析总结');
  console.log('='.repeat(60));
  
  if (sub) {
    console.log(`\n订阅类型: ${sub.plan?.id || sub.plan_type || sub.subscription_plan || '未知'}`);
    console.log(`账号类型: ${sub.account_plan_type || sub.plan?.title || '未知'}`);
    console.log(`是否Plus: ${sub.is_chatgpt_plus ? '✅ 是' : '❌ 否'}`);
    console.log(`是否Team: ${sub.is_chatgpt_team ? '✅ 是' : '❌ 否'}`);
    
    if (sub.has_payment_method !== undefined) {
      console.log(`绑定支付方式: ${sub.has_payment_method ? '✅ 有' : '❌ 无'}`);
    }
    if (sub.customer_id) {
      console.log(`Stripe Customer ID: ${sub.customer_id}`);
    }
    if (sub.subscription_id) {
      console.log(`Stripe Subscription ID: ${sub.subscription_id}`);
    }
    if (sub.billing_address) {
      console.log(`账单地址: ${JSON.stringify(sub.billing_address)}`);
    }
  }
}

main().catch(console.error);
