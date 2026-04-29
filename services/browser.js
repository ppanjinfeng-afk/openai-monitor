const { getPuppeteer } = require('./inviter');
const { withBrowserTask } = require('./browser-task-queue');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-extensions',
  '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints',
  '--mute-audio',
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1280,800',
];
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAINTENANCE_BROWSER_REUSE_ENABLED = process.env.MAINTENANCE_REUSE_BROWSER !== 'false';
const MAINTENANCE_BROWSER_IDLE_TTL_MS = Math.max(
  30000,
  Number(process.env.MAINTENANCE_BROWSER_IDLE_TTL_MS || 10 * 60 * 1000)
);
const MAINTENANCE_BROWSER_MAX_AGE_MS = Math.max(
  MAINTENANCE_BROWSER_IDLE_TTL_MS,
  Number(process.env.MAINTENANCE_BROWSER_MAX_AGE_MS || 30 * 60 * 1000)
);
const MAINTENANCE_PAGE_BOOT_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.MAINTENANCE_PAGE_BOOT_TIMEOUT_MS || 20000)
);
const MAINTENANCE_PAGE_READY_DELAY_MS = Math.max(
  0,
  Number(process.env.MAINTENANCE_PAGE_READY_DELAY_MS || 500)
);

let sharedMaintenanceBrowser = null;
let sharedMaintenanceBrowserStartedAt = 0;
let sharedMaintenanceBrowserLaunchPromise = null;
let sharedMaintenanceBrowserIdleTimer = null;
let sharedMaintenanceBrowserUseCount = 0;

function isBrowserConnected(browser) {
  return Boolean(browser && (typeof browser.isConnected !== 'function' || browser.isConnected()));
}

function scheduleSharedMaintenanceBrowserClose() {
  if (!MAINTENANCE_BROWSER_REUSE_ENABLED || !sharedMaintenanceBrowser || sharedMaintenanceBrowserUseCount > 0) {
    return;
  }

  clearTimeout(sharedMaintenanceBrowserIdleTimer);
  sharedMaintenanceBrowserIdleTimer = setTimeout(async () => {
    const browser = sharedMaintenanceBrowser;
    sharedMaintenanceBrowser = null;
    sharedMaintenanceBrowserStartedAt = 0;
    await browser?.close?.().catch(() => {});
    console.log('[Browser] Closed idle shared maintenance browser');
  }, MAINTENANCE_BROWSER_IDLE_TTL_MS);

  if (typeof sharedMaintenanceBrowserIdleTimer.unref === 'function') {
    sharedMaintenanceBrowserIdleTimer.unref();
  }
}

function acquireSharedMaintenanceBrowser() {
  sharedMaintenanceBrowserUseCount += 1;
  clearTimeout(sharedMaintenanceBrowserIdleTimer);
}

async function releaseSharedMaintenanceBrowser() {
  sharedMaintenanceBrowserUseCount = Math.max(0, sharedMaintenanceBrowserUseCount - 1);
  if (sharedMaintenanceBrowserUseCount > 0) {
    return;
  }

  const browserAge = sharedMaintenanceBrowserStartedAt ? Date.now() - sharedMaintenanceBrowserStartedAt : 0;
  if (browserAge > MAINTENANCE_BROWSER_MAX_AGE_MS) {
    await closeStaleSharedMaintenanceBrowser();
    return;
  }

  scheduleSharedMaintenanceBrowserClose();
}

async function closeStaleSharedMaintenanceBrowser() {
  clearTimeout(sharedMaintenanceBrowserIdleTimer);
  const browser = sharedMaintenanceBrowser;
  sharedMaintenanceBrowser = null;
  sharedMaintenanceBrowserStartedAt = 0;
  sharedMaintenanceBrowserUseCount = 0;
  await browser?.close?.().catch(() => {});
}

async function launchMaintenanceBrowser(pptr) {
  const browser = await pptr.launch({
    headless: 'new',
    args: BROWSER_ARGS,
    defaultViewport: DEFAULT_VIEWPORT,
  });

  browser.on?.('disconnected', () => {
    if (sharedMaintenanceBrowser === browser) {
      sharedMaintenanceBrowser = null;
      sharedMaintenanceBrowserStartedAt = 0;
      clearTimeout(sharedMaintenanceBrowserIdleTimer);
    }
  });

  return browser;
}

async function getMaintenanceBrowser(pptr) {
  if (!MAINTENANCE_BROWSER_REUSE_ENABLED) {
    return { browser: await launchMaintenanceBrowser(pptr), shared: false };
  }

  const now = Date.now();
  const browserTooOld = sharedMaintenanceBrowserStartedAt
    && now - sharedMaintenanceBrowserStartedAt > MAINTENANCE_BROWSER_MAX_AGE_MS;

  if (isBrowserConnected(sharedMaintenanceBrowser) && (!browserTooOld || sharedMaintenanceBrowserUseCount > 0)) {
    clearTimeout(sharedMaintenanceBrowserIdleTimer);
    return { browser: sharedMaintenanceBrowser, shared: true };
  }

  if (sharedMaintenanceBrowserLaunchPromise) {
    const browser = await sharedMaintenanceBrowserLaunchPromise;
    return { browser, shared: true };
  }

  sharedMaintenanceBrowserLaunchPromise = (async () => {
    await closeStaleSharedMaintenanceBrowser();
    const browser = await launchMaintenanceBrowser(pptr);
    sharedMaintenanceBrowser = browser;
    sharedMaintenanceBrowserStartedAt = Date.now();
    console.log('[Browser] Launched shared maintenance browser');
    return browser;
  })();

  try {
    const browser = await sharedMaintenanceBrowserLaunchPromise;
    return { browser, shared: true };
  } finally {
    sharedMaintenanceBrowserLaunchPromise = null;
  }
}

async function createIsolatedPage(browser) {
  let context = null;
  let page = null;

  try {
    if (typeof browser.createBrowserContext === 'function') {
      context = await browser.createBrowserContext();
    } else if (typeof browser.createIncognitoBrowserContext === 'function') {
      context = await browser.createIncognitoBrowserContext();
    }

    page = context ? await context.newPage() : await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setDefaultNavigationTimeout(MAINTENANCE_PAGE_BOOT_TIMEOUT_MS);
    await page.setDefaultTimeout(MAINTENANCE_PAGE_BOOT_TIMEOUT_MS);
    await page.setCacheEnabled(true).catch(() => {});
    await page.setRequestInterception(true);
    page.on('request', request => {
      const resourceType = request.resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(resourceType)) {
        request.abort().catch(() => {});
        return;
      }
      request.continue().catch(() => {});
    });

    return { context, page };
  } catch (err) {
    if (context) {
      await context.close().catch(() => {});
    } else if (page) {
      await page.close().catch(() => {});
    }
    throw err;
  }
}

async function withBrowserPage(work, options = {}) {
  return withBrowserTask(async () => {
    let browser = null;
    let browserIsShared = false;
    let context = null;
    let page = null;

    try {
      const pptr = await getPuppeteer();
      const browserHandle = await getMaintenanceBrowser(pptr);
      browser = browserHandle.browser;
      browserIsShared = browserHandle.shared;
      if (browserIsShared) {
        acquireSharedMaintenanceBrowser();
      }
      const pageHandle = await createIsolatedPage(browser);
      context = pageHandle.context;
      page = pageHandle.page;

      await page.goto('https://chatgpt.com/', {
        waitUntil: 'domcontentloaded',
        timeout: MAINTENANCE_PAGE_BOOT_TIMEOUT_MS,
      });
      await sleep(MAINTENANCE_PAGE_READY_DELAY_MS);
      return await work(page);
    } finally {
      if (context) {
        await context.close().catch(() => {});
      } else if (page) {
        await page.close().catch(() => {});
      }

      if (browser && browserIsShared) {
        await releaseSharedMaintenanceBrowser();
      } else if (browser) {
        await browser.close().catch(() => {});
      }
    }
  }, {
    label: options.label || 'browser-page',
    priority: options.priority || 0,
  });
}

module.exports = {
  withBrowserPage,
};
