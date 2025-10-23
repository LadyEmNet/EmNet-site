#!/usr/bin/env node
import { setDefaultResultOrder } from 'node:dns';
import { Agent, setGlobalDispatcher } from 'undici';

import { APP_ID as DEFAULT_REGISTRY_APP_ID } from '../config.js';
import {
  fetchWeeklyDrawData,
  resolveDrawAppId,
  normaliseError,
} from '../drawService.js';

if (typeof setDefaultResultOrder === 'function') {
  try {
    setDefaultResultOrder('ipv4first');
  } catch {}
}

try {
  setGlobalDispatcher(new Agent({ connect: { family: 4, ipv6Only: false } }));
} catch {}

function jsonReplacer(_key, value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('base64');
  }
  return value;
}

function usage(message) {
  if (message) {
    console.error(`Error: ${message}`);
  }
  console.error('Usage: node backend/tools/fetch-weekly-winners.js --week <number>');
  console.error('Options:');
  console.error('  --week, -w <value>      Week number to inspect (repeat, comma list, or range like 1-3)');
  console.error('  --registry <id>         Override registry app id (default from config.js)');
  console.error('  --draw <id>             Override draw app id (normally read from registry)');
  console.error('  --json                  Output machine-readable JSON');
  process.exit(message ? 1 : 0);
}

function addWeekToken(target, token) {
  if (token === undefined || token === null) {
    throw new Error('Missing week value');
  }
  if (Array.isArray(token)) {
    token.forEach((value) => addWeekToken(target, value));
    return;
  }
  const raw = String(token).trim();
  if (!raw) {
    throw new Error('Missing week value');
  }
  if (raw.includes(',')) {
    raw.split(',').forEach((part) => addWeekToken(target, part));
    return;
  }
  const rangeMatch = raw.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const start = Number.parseInt(rangeMatch[1], 10);
    const end = Number.parseInt(rangeMatch[2], 10);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < 1) {
      throw new Error(`Invalid week range: ${raw}`);
    }
    if (end < start) {
      throw new Error(`Week range must increase from start to end: ${raw}`);
    }
    for (let value = start; value <= end; value += 1) {
      target.add(value);
    }
    return;
  }
  if (/^\d+$/.test(raw)) {
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value) || value < 1) {
      throw new Error(`Week values must be positive integers: ${raw}`);
    }
    target.add(value);
    return;
  }
  throw new Error(`Invalid week value: ${raw}`);
}

function parseArgs(argv) {
  const options = {
    registryAppId: DEFAULT_REGISTRY_APP_ID,
    drawAppId: null,
    weeks: [],
    json: false,
  };
  const weekCollector = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      usage();
    } else if (arg === '--week' || arg === '-w') {
      const value = argv[index + 1];
      if (!value) {
        usage('Missing value for --week');
      }
      try {
        addWeekToken(weekCollector, value);
      } catch (error) {
        usage(error.message);
      }
      index += 1;
    } else if (arg === '--registry') {
      const value = argv[index + 1];
      if (!value) {
        usage('Missing value for --registry');
      }
      options.registryAppId = Number.parseInt(value, 10);
      index += 1;
    } else if (arg === '--draw') {
      const value = argv[index + 1];
      if (!value) {
        usage('Missing value for --draw');
      }
      options.drawAppId = Number.parseInt(value, 10);
      index += 1;
    } else if (arg === '--json') {
      options.json = true;
    } else if (/^[\d,-]+$/.test(arg)) {
      try {
        addWeekToken(weekCollector, arg);
      } catch (error) {
        usage(error.message);
      }
    } else {
      usage(`Unknown argument: ${arg}`);
    }
  }

  if (weekCollector.size === 0) {
    usage('At least one --week value is required');
  }
  if (!Number.isInteger(options.registryAppId) || options.registryAppId <= 0) {
    usage('A valid --registry app id is required');
  }

  options.weeks = Array.from(weekCollector).sort((a, b) => a - b);

  return options;
}

function withPlural(count, noun) {
  const safe = Number.isFinite(count) ? count : 0;
  const suffix = safe === 1 ? '' : 's';
  return `${safe} ${noun}${suffix}`;
}

function formatList(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    return `${label}: none`;
  }
  return `${label}: ${values.join(', ')}`;
}

function formatIdList(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return 'none';
  }
  return values.join(', ');
}

function printWinner(winner, index) {
  console.log(`Winner ${index + 1}: Relative ID ${winner.relativeId}`);
  console.log(`  Address: ${winner.address}`);
  console.log(`  Referrer ID: ${winner.referrerId ?? '—'}`);
  console.log(`  Points: ${winner.points ?? 0}`);
  console.log(`  Redeemed points: ${winner.redeemedPoints ?? 0}`);
  console.log(`  Weekly draw entries: ${winner.weeklyDrawEntries}`);
  console.log(`  ${withPlural(winner.numReferrals, 'referral')} (${winner.referralIds.join(', ') || 'none'})`);
  console.log(`  ${formatList(winner.completedQuests, 'Completed quests')}`);
  console.log(`  ${formatList(winner.completedChallenges, 'Completed challenges')}`);
  console.log(`  Available prize asset IDs: ${winner.availablePrizeAssetIds.join(', ') || 'none'}`);
  console.log(`  Claimed prize asset IDs: ${winner.claimedPrizeAssetIds.join(', ') || 'none'}`);
  console.log('');
}

function printPrizeAsset(asset) {
  if (asset.error) {
    console.log(`  ASA ${asset.assetId}: ${asset.error}`);
    return;
  }
  const uniqueCount = asset.meta?.uniqueHolders ?? asset.holders?.length ?? 0;
  console.log(`  ASA ${asset.assetId}: ${uniqueCount} holder(s)`);
  if (Array.isArray(asset.balances) && asset.balances.length > 0) {
    asset.balances.forEach((record) => {
      console.log(`    - ${record.address} (${record.amount})`);
    });
  } else {
    console.log('    (no holders)');
  }
}

function printWeekSummary(weekData) {
  console.log(`Week ${weekData.week} weekly draw summary`);
  console.log('='.repeat(40));
  const weeklyState = weekData.weeklyState || {};
  const challenge = weekData.challenge || {};
  console.log(`Status: ${weeklyState.status ?? 'unknown'}`);
  console.log(`Eligible accounts ingested: ${weeklyState.accountsIngested ?? '0'}`);
  console.log(`Last relative id scanned: ${weeklyState.lastRelativeId ?? '0'}`);
  console.log(`Draw winners (relative ids): ${formatIdList(weeklyState.winners)}`);
  console.log('');
  console.log('Challenge configuration');
  console.log(`  Quest IDs: ${formatIdList(challenge.questIds)}`);
  console.log(`  Draw prize asset IDs: ${formatIdList(challenge.drawPrizeAssetIds)}`);
  console.log(`  Eligible accounts reported: ${challenge.numDrawEligibleAccounts ?? '0'}`);
  console.log(`  Winners expected: ${challenge.numDrawWinners ?? '0'}`);
  console.log('');
  console.log('Winner details');
  weekData.winners.forEach((winner, index) => {
    printWinner(winner, index);
  });
  console.log('Prize asset holders');
  if (Array.isArray(weekData.prizeAssets) && weekData.prizeAssets.length > 0) {
    weekData.prizeAssets.forEach((asset) => {
      printPrizeAsset(asset);
    });
  } else {
    console.log('  No prize asset data available.');
  }
}

function printErrorSummary({ week, error }) {
  console.log(`Week ${week} weekly draw summary`);
  console.log('='.repeat(40));
  console.log(`Error: ${error}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let drawAppId = options.drawAppId;
  if (!drawAppId) {
    drawAppId = await resolveDrawAppId({ registryAppId: options.registryAppId });
  }

  const results = [];
  for (const week of options.weeks) {
    try {
      const weekData = await fetchWeeklyDrawData(week, {
        registryAppId: options.registryAppId,
        drawAppId,
      });
      results.push(weekData);
    } catch (error) {
      results.push({ week, error: normaliseError(error) });
    }
  }

  if (options.json) {
    const payload = {
      registryAppId: options.registryAppId,
      drawAppId,
      weeks: results,
    };
    console.log(JSON.stringify(payload, jsonReplacer, 2));
    return;
  }

  results.forEach((result) => {
    if (result.error) {
      printErrorSummary(result);
    } else {
      printWeekSummary(result);
    }
    console.log('');
  });
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
