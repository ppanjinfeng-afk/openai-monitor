#!/usr/bin/env node

const { expireOldCdks } = require('../services/cdk-expiration');

function getArgValue(name, fallback = '') {
  const prefix = `--${name}=`;
  const inline = process.argv.find(arg => arg.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }

  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }

  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function printHelp() {
  console.log(`
Usage:
  node scripts/expire-old-cdks.js [options]

Options:
  --days <number>          Expire unused CDKs older than this many days. Default: 1
  --dry-run                Show what would expire without changing the database.
  --only-delivered         Only expire CDKs generated from paid/delivered orders.
  --plan-type <type>       Only expire one plan type, for example team_invite.
  --sample-limit <number>  Number of matching rows to show in the sample. Default: 20
  --help                   Show this help text.

Examples:
  node scripts/expire-old-cdks.js --dry-run
  node scripts/expire-old-cdks.js --days=1
  node scripts/expire-old-cdks.js --days=1 --only-delivered
`.trim());
}

if (hasFlag('help') || hasFlag('h')) {
  printHelp();
  process.exit(0);
}

try {
  const result = expireOldCdks({
    expireAfterDays: getArgValue('days', process.env.CDK_EXPIRE_AFTER_DAYS || '1'),
    dryRun: hasFlag('dry-run'),
    onlyDelivered: hasFlag('only-delivered'),
    planType: getArgValue('plan-type', ''),
    sampleLimit: getArgValue('sample-limit', '20'),
  });

  console.log(JSON.stringify(result, null, 2));

  if (result.dryRun) {
    console.log('\nDry run only. Run without --dry-run to expire these CDKs.');
  } else {
    console.log(`\nExpired ${result.expiredCount} CDK(s).`);
  }
} catch (err) {
  console.error(`Failed to expire old CDKs: ${err.stack || err.message}`);
  process.exit(1);
}
