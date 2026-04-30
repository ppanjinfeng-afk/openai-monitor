#!/usr/bin/env node

const { repairDuplicateTeamCdkTasks } = require('../services/cdk-team-dedupe');

const dryRun = process.argv.includes('--dry-run');
const result = repairDuplicateTeamCdkTasks({ dryRun });

console.log(JSON.stringify(result, null, 2));

if (dryRun) {
  console.log('\nDry run only. Run without --dry-run to apply the repair.');
}
