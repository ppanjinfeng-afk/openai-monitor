const puppeteer = require('puppeteer-core');
const http = require('http');

const data = {
    cvc: "379",
    expiry: "0432"
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

const delay = ms => new Promise(res => setTimeout(res, ms));

(async () => {
    try {
        const ws = await getWSEndpoint();
        const browser = await puppeteer.connect({ browserWSEndpoint: ws });
        const pages = await browser.pages();
        const page = pages.find(p => p.url().includes('pay.openai.com') || p.url().includes('stripe.com')) || pages[0];

        console.log('🔄 开始执行智能防风控重试策略 (最高尝试 3 次)...');

        async function typeInput(selector, text) {
            try {
                const el = await page.$(selector);
                if (el) {
                    // 人类手速纠错：全选删除，然后再带有随机延迟地敲入字符
                    await page.click(selector, {clickCount: 3});
                    await page.keyboard.press('Backspace');
                    await page.type(selector, text, {delay: Math.floor(Math.random() * 50) + 60});
                    return true;
                }
            } catch (e) {}
            return false;
        }

        const maxAttempts = 3;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            console.log(`\n▶️ [第 ${attempt} 次重试开始]`);

            // 1. 数据采集阶段扰动：随机滑条与虚拟鼠标轨迹
            console.log('   🖱️ 正在注入虚假的人类交互动作 (随机滚轮、鼠标移动以污染 Stripe 的行为收集特征)...');
            await page.mouse.move(200 + Math.random() * 300, 300 + Math.random() * 200, {steps: 12});
            await page.evaluate(() => window.scrollBy(0, 150));
            await delay(600 + Math.random() * 800);
            await page.evaluate(() => window.scrollBy(0, -100));
            await page.mouse.move(500 + Math.random() * 200, 400 + Math.random() * 100, {steps: 8});

            // 2. 软拒绝后的典型补救动作：手动修改一下输入
            // (通常 Stripe 拒卡后会强制清空 CVV，我们重新输入一遍)
            console.log('   ✍️ 模拟人工纠错并重新填卡...');
            await typeInput('#cardExpiry', data.expiry);
            await typeInput('#cardCvc', data.cvc);
            await delay(400);

            // 3. 开始执行高危操作：点击动作
            const btn = await page.$('button.SubmitButton');
            if (btn) {
                console.log('   👆 已按下结算按钮，等待风控模型判定...');
                // 模拟正常人点击的延迟
                await page.mouse.move(100, 100); 
                await btn.click();
            } else {
                console.log('   ⚠️ 未找到底部的提交按钮，可能是您目前不在正确表单位置。');
            }

            // 4. 等待判定结果返回
            console.log('   ⏳ 等待大概 7 秒让数据包飘一会...');
            await delay(7000);

            // 检测DOM中是否有红色的报错文本
            const errorText = await page.evaluate(() => {
                const els = document.querySelectorAll('[role="alert"], .FieldError, .PaymentError, .Text-color--red, .Notice--error, [class*="error"], [id*="error"]');
                for (let el of els) {
                    const txt = (el.textContent || el.innerText).trim();
                    // 这里捕捉 decline 以及其它常见错误
                    if (txt.length > 0 && (txt.toLowerCase().includes('declined') || txt.toLowerCase().includes('error'))) {
                        return txt;
                    }
                }
                return null;
            });

            if (errorText) {
                console.log(`   🔴 此番操作仍然被拦截！抓到了报错: "${errorText}"`);
                if (attempt < maxAttempts) {
                    // Exponential Backoff 退避算法，让 Stripe 认为不是爬虫在DDoS
                    const waitTime = attempt * 6000 + Math.random() * 2000;
                    console.log(`   💤 触发风控频率保护机制，当前休眠退避约 ${Math.floor(waitTime/1000)} 秒后再发动下一次模拟...`);
                    await delay(waitTime);
                } else {
                    console.log('   ❌ 三次精心编排的交互均遭遇滑铁卢。该卡或IP已经被该节点的底层信誉库彻底锁死。');
                }
            } else {
                console.log('   🎉 页面未出现任何常规报错！很可能通过了二次校验并正在加载跳转。测试终止。');
                break;
            }
        }

        await browser.disconnect();
    } catch(e) {
        console.error('❌ 脚本执行遇到严重异常:', e);
    }
})();
