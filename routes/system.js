const express = require('express');
const os = require('os');

const router = express.Router();

function getCpuSnapshot() {
  return os.cpus().reduce(
    (total, cpu) => {
      const times = cpu.times || {};
      const idle = times.idle || 0;
      const used = (times.user || 0) + (times.nice || 0) + (times.sys || 0) + (times.irq || 0);
      total.idle += idle;
      total.total += idle + used;
      return total;
    },
    { idle: 0, total: 0 }
  );
}

let lastCpuSnapshot = getCpuSnapshot();

function getCpuUsagePercent() {
  const current = getCpuSnapshot();
  const idleDelta = current.idle - lastCpuSnapshot.idle;
  const totalDelta = current.total - lastCpuSnapshot.total;
  lastCpuSnapshot = current;

  if (totalDelta <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

router.get('/metrics', (req, res) => {
  const cpus = os.cpus();
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = Math.max(0, totalMemory - freeMemory);
  const processMemory = process.memoryUsage();

  res.json({
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(os.uptime()),
    loadavg: os.loadavg().map(value => round(value)),
    cpu: {
      cores: cpus.length,
      model: cpus[0]?.model || 'Unknown CPU',
      usage_percent: round(getCpuUsagePercent(), 1),
    },
    memory: {
      total: totalMemory,
      free: freeMemory,
      used: usedMemory,
      usage_percent: totalMemory > 0 ? round((usedMemory / totalMemory) * 100, 1) : 0,
    },
    process: {
      pid: process.pid,
      uptime_seconds: Math.floor(process.uptime()),
      memory_rss: processMemory.rss,
      memory_heap_used: processMemory.heapUsed,
      memory_heap_total: processMemory.heapTotal,
    },
  });
});

module.exports = router;
