const puppeteer = require('puppeteer-core');
const http = require('http');

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
    console.log('🔄 正在尝试连接您的本地浏览器...');
    const browserWSEndpoint = await getWSEndpoint();
    
    const browser = await puppeteer.connect({ browserWSEndpoint });
    const pages = await browser.pages();
    
    console.log(`✅ 成功接管！当前您的浏览器中打开了 ${pages.length} 个标签页:`);
    for (let i = 0; i < pages.length; i++) {
        const title = await pages[i].title() || '无标题页';
        const url = pages[i].url();
        console.log(`[标签 ${i + 1}] ${title}\n          URL: ${url}`);
    }
    
    await browser.disconnect();
  } catch(e) {
    console.error('❌ 连接失败，请确保您刚才的命令执行成功并且浏览器并未被关闭。详细错误:', e.message);
  }
})();
