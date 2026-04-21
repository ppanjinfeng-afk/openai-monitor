const puppeteer = require('puppeteer-core');
const http = require('http');

const data = {
    cardNumber: "5349336302332306",
    expiry: "0432",
    cvc: "379",
    name: "Destiny Flores",
    address: "2921 N Prince St, Apt d",
    city: "Clovis",
    state: "NM",
    zip: "88101"
};

function getWSEndpoint() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json/version', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data).webSocketDebuggerUrl));
    }).on('error', reject);
  });
}

(async () => {
  try {
    const browserWSEndpoint = await getWSEndpoint();
    const browser = await puppeteer.connect({ browserWSEndpoint });
    const pages = await browser.pages();
    // 尽量定位到 pay.openai 或者结账页
    const chatPage = pages.find(p => p.url().includes('pay.openai.com') || p.url().includes('stripe.com')) || pages[0];
    
    console.log('🔄 开始尝试自动填写卡信息...');

    // 辅助函数：在主页面节点尝试填入
    async function typeInput(selector, text) {
        try {
            const el = await chatPage.$(selector);
            if (el) {
                await chatPage.click(selector, {clickCount: 3});
                await chatPage.keyboard.press('Backspace');
                await chatPage.type(selector, text, {delay: 30});
                console.log('✅ 已填写: ' + selector);
            }
        } catch (e) {}
    }

    // 1. 尝试主页面的 Hosted 模式选择器
    await typeInput('#email', 'destiny@test.com'); // 有时会要求邮件
    await typeInput('#cardNumber', data.cardNumber);
    await typeInput('#cardExpiry', data.expiry);
    await typeInput('#cardCvc', data.cvc);
    await typeInput('#billingName', data.name);
    await typeInput('#billingAddressLine1', data.address);
    await typeInput('#billingLocality', data.city);
    await typeInput('#billingPostalCode', data.zip);
    
    // 或者基于 name 属性的变体
    await typeInput('input[name="cardNumber"]', data.cardNumber);
    await typeInput('input[name="cardExpiry"]', data.expiry);
    await typeInput('input[name="cardCvc"]', data.cvc);

    // 2. 如果存在 Stripe 安全内嵌 Iframe（有些时候虽然页面是 openai 但卡表单在内部嵌套了 js.stripe.com）
    let frameWithCard = null;
    for (let f of chatPage.frames()) {
        if (f.url().includes('stripe.com')) {
            try {
                if (await f.$('input[name="cardnumber"]')) {
                    frameWithCard = f;
                    break;
                }
            } catch(e){}
        }
    }

    if (frameWithCard) {
        console.log('🔍 检测到独立 Stripe Iframe！自动将输入焦点切换并注入数据...');
        try {
            await frameWithCard.focus('input[name="cardnumber"]');
            // Stripe 表单中焦点会自动从卡号跳转到日期、CVC和邮编，因此我们可以利用键盘连续打字来完成
            await chatPage.keyboard.type(data.cardNumber, {delay: 30});
            await new Promise(r => setTimeout(r, 200));
            await chatPage.keyboard.type(data.expiry, {delay: 30});
            await new Promise(r => setTimeout(r, 200));
            await chatPage.keyboard.type(data.cvc, {delay: 30});
            await new Promise(r => setTimeout(r, 200));
            await chatPage.keyboard.type(data.zip, {delay: 30}); 
            console.log('✅ [安全框连敲] 模拟物理按键填入卡号等完毕！');
        } catch(e) {
            console.log('⚠️ Iframe填入异常:', e.message);
        }
    }

    console.log('🎉 注入脚本执行结束！部分下拉选项（如国家州份）如果未能选中，麻烦您目测补齐一下。');
    await browser.disconnect();
  } catch(e) {
    console.error('❌ 执行失败:', e);
  }
})();
