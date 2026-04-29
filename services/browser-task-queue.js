function normalizeConcurrency(value, fallback = 2, max = 6) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.max(1, Math.min(Math.floor(parsed), max));
}

function getBrowserTaskConcurrency() {
  return normalizeConcurrency(
    process.env.BROWSER_TASK_CONCURRENCY || process.env.BROWSER_CONCURRENCY,
    2,
    6
  );
}

function getMaintenanceConcurrency() {
  const total = getBrowserTaskConcurrency();
  return normalizeConcurrency(
    process.env.BROWSER_MAINTENANCE_CONCURRENCY,
    Math.max(1, total - 1),
    total
  );
}

let activeCount = 0;
let activeMaintenanceCount = 0;
let sequence = 0;
const queue = [];

function sortQueue() {
  queue.sort((a, b) => {
    if (b.priority !== a.priority) {
      return b.priority - a.priority;
    }
    return a.id - b.id;
  });
}

function maybeLogQueueState(event, item) {
  if (process.env.BROWSER_TASK_QUEUE_DEBUG !== 'true') {
    return;
  }

  console.log(
    `[BrowserTaskQueue] ${event}: ${item?.label || '-'} lane=${item?.lane || '-'} active=${activeCount} maintenance=${activeMaintenanceCount} queued=${queue.length} limit=${getBrowserTaskConcurrency()} maintenanceLimit=${getMaintenanceConcurrency()}`
  );
}

function runItem(item) {
  activeCount += 1;
  if (item.lane === 'maintenance') {
    activeMaintenanceCount += 1;
  }
  maybeLogQueueState('start', item);

  Promise.resolve()
    .then(item.work)
    .then(item.resolve, item.reject)
    .finally(() => {
      activeCount = Math.max(0, activeCount - 1);
      if (item.lane === 'maintenance') {
        activeMaintenanceCount = Math.max(0, activeMaintenanceCount - 1);
      }
      maybeLogQueueState('finish', item);
      drainQueue();
    });
}

function canRunItem(item, limit, maintenanceLimit) {
  if (activeCount >= limit) {
    return false;
  }

  if (item.lane !== 'maintenance') {
    return true;
  }

  return activeMaintenanceCount < maintenanceLimit;
}

function drainQueue() {
  const limit = getBrowserTaskConcurrency();
  const maintenanceLimit = getMaintenanceConcurrency();

  while (activeCount < limit && queue.length > 0) {
    sortQueue();
    const itemIndex = queue.findIndex(candidate => canRunItem(candidate, limit, maintenanceLimit));
    if (itemIndex === -1) {
      return;
    }
    const [item] = queue.splice(itemIndex, 1);
    runItem(item);
  }
}

function withBrowserTask(work, options = {}) {
  if (typeof work !== 'function') {
    return Promise.reject(new Error('Browser task must be a function'));
  }

  const priority = Number(options.priority || 0);
  const item = {
    id: ++sequence,
    label: String(options.label || 'browser-task'),
    lane: options.lane === 'invite' ? 'invite' : 'maintenance',
    priority: Number.isFinite(priority) ? priority : 0,
    work,
    resolve: null,
    reject: null,
  };

  return new Promise((resolve, reject) => {
    item.resolve = resolve;
    item.reject = reject;
    queue.push(item);
    maybeLogQueueState('queue', item);
    drainQueue();
  });
}

function getBrowserTaskStats() {
  return {
    active: activeCount,
    activeMaintenance: activeMaintenanceCount,
    queued: queue.length,
    limit: getBrowserTaskConcurrency(),
    maintenanceLimit: getMaintenanceConcurrency(),
  };
}

module.exports = {
  withBrowserTask,
  getBrowserTaskStats,
  getBrowserTaskConcurrency,
  getMaintenanceConcurrency,
};
