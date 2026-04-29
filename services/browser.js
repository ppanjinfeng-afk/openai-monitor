const { getPuppeteer } = require('./inviter');
const { withBrowserTask } = require('./browser-task-queue');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-blink-features=AutomationControlled',
  '--window-size=1280,800',
];
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function withBrowserPage(work, options = {}) {
  return withBrowserTask(async () => {
    const pptr = await getPuppeteer();
    const browser = await pptr.launch({
      headless: 'new',
      args: BROWSER_ARGS,
      defaultViewport: DEFAULT_VIEWPORT,
    });

    try {
      const page = await browser.newPage();
      await page.setUserAgent(USER_AGENT);
      await page.goto('https://chatgpt.com/', {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });
      await sleep(1500);
      return await work(page);
    } finally {
      await browser.close().catch(() => {});
    }
  }, {
    label: options.label || 'browser-page',
    priority: options.priority || 0,
  });
}

module.exports = {
  withBrowserPage,
};
