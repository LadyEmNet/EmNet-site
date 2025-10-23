import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { APP_ID as REGISTRY_APP_ID, getAllowlistForAsset } from './config.js';

const require = createRequire(import.meta.url);
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

const algosdk = require(path.join(currentDir, 'node_modules', 'algosdk'));
const {
  getABIDecodedValue,
  getABIEncodedValue,
} = require(path.join(
  currentDir,
  'node_modules',
  '@algorandfoundation',
  'algokit-utils',
  'types',
  'app-arc56.js',
));
const drawGenerated = require(path.join(
  currentDir,
  'node_modules',
  '@algorandfoundation',
  'algoland-sdk',
  'dist',
  'cjs',
  'generated',
  'DrawGenerated.js',
));
const registryGenerated = require(path.join(
  currentDir,
  'node_modules',
  '@algorandfoundation',
  'algoland-sdk',
  'dist',
  'cjs',
  'generated',
  'AlgolandGenerated.js',
));

const DRAW_STRUCTS = drawGenerated.APP_SPEC.structs;
const REGISTRY_STRUCTS = registryGenerated.APP_SPEC.structs;

const DEFAULT_INDEXER_BASE = normaliseBase(
  process.env.INDEXER_BASE || 'https://mainnet-idx.algonode.cloud',
);
const DEFAULT_ALGOD_BASE = normaliseBase(
  process.env.ALGOD_BASE || 'https://mainnet-api.algonode.cloud',
);

function normaliseBase(base, fallback) {
  if (typeof base !== 'string' || base.trim().length === 0) {
    return fallback;
  }
  return base.replace(/\/+$/, '');
}

function normaliseAddress(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed.toUpperCase();
    }
    return undefined;
  }
  if (value && typeof value.toString === 'function') {
    const stringValue = value.toString();
    if (typeof stringValue === 'string') {
      const trimmed = stringValue.trim();
      if (trimmed) {
        return trimmed.toUpperCase();
      }
    }
  }
  return undefined;
}

function toBigInt(value) {
  try {
    if (typeof value === 'bigint') {
      return value;
    }
    if (typeof value === 'number') {
      return BigInt(value);
    }
    if (typeof value === 'string') {
      if (value.trim() === '') {
        return null;
      }
      return BigInt(value);
    }
    if (value && typeof value.toString === 'function') {
      const stringValue = value.toString();
      if (stringValue && typeof stringValue === 'string') {
        return BigInt(stringValue);
      }
    }
  } catch {
    return null;
  }
  return null;
}

function encodeMapKey(prefixChar, type, value, structs) {
  const prefix = Buffer.from(prefixChar, 'utf8');
  const encodedValue = Buffer.from(getABIEncodedValue(value, type, structs));
  return Buffer.concat([prefix, encodedValue]).toString('base64');
}

function buildBoxUrl(baseUrl, appId, base64Name) {
  const encodedName = encodeURIComponent(base64Name);
  return `${baseUrl}/v2/applications/${appId}/box?name=base64:${encodedName}`;
}

async function fetchJson(url, label) {
  const args = [
    '--silent',
    '--show-error',
    '--compressed',
    '--location',
    '--fail',
    '--header',
    'accept: application/json',
    url,
  ];
  try {
    const { stdout } = await execFileAsync('curl', args);
    return JSON.parse(stdout);
  } catch (error) {
    const message = error && error.message ? error.message : 'request failed';
    throw new Error(`${label} request failed: ${message}`);
  }
}

function decodeArcValue(base64Value, type, structs) {
  if (!base64Value || typeof base64Value !== 'string') {
    return null;
  }
  const buffer = Buffer.from(base64Value, 'base64');
  const view = new Uint8Array(buffer);
  return getABIDecodedValue(view, type, structs);
}

function formatPoints(raw) {
  if (typeof raw !== 'number' || Number.isNaN(raw)) {
    return null;
  }
  return raw * 100;
}

function formatAssets(values) {
  return Array.isArray(values)
    ? values
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0)
    : [];
}

function normaliseQuestList(list) {
  return Array.isArray(list) ? list.map((value) => `Quest ${value}`) : [];
}

function normaliseChallengeList(list) {
  return Array.isArray(list) ? list.map((value) => `Challenge ${value}`) : [];
}

function getUniquePrizeAssetIds(challenge) {
  const rawList = Array.isArray(challenge?.drawPrizeAssetIds) ? challenge.drawPrizeAssetIds : [];
  const unique = new Set();
  const ordered = [];
  rawList.forEach((raw) => {
    const value = Number.parseInt(raw, 10);
    if (Number.isFinite(value) && value > 0 && !unique.has(value)) {
      unique.add(value);
      ordered.push(value);
    }
  });
  return ordered;
}

async function getAssetAdminAddresses(assetId, context) {
  const url = `${context.indexerBase}/v2/assets/${assetId}`;
  const payload = await fetchJson(url, `asset ${assetId}`);
  const params = payload?.asset?.params || {};
  const adminAddresses = new Set();
  ['creator', 'manager', 'reserve', 'freeze', 'clawback'].forEach((key) => {
    const normalised = normaliseAddress(params[key]);
    if (normalised) {
      adminAddresses.add(normalised);
    }
  });
  return adminAddresses;
}

async function getAssetHoldersWithMetadata(assetId, context) {
  const allowlisted = new Set(
    getAllowlistForAsset(assetId)
      .map(normaliseAddress)
      .filter((address) => Boolean(address)),
  );
  const adminAddresses = await getAssetAdminAddresses(assetId, context);
  const excluded = new Set([...allowlisted, ...adminAddresses]);

  const holderMap = new Map();
  let nextToken;
  let pageCount = 0;
  let scannedBalances = 0;

  do {
    const params = new URLSearchParams({
      limit: '1000',
      'include-all': 'false',
      'currency-greater-than': '0',
    });
    if (nextToken) {
      params.set('next', nextToken);
    }
    const url = `${context.indexerBase}/v2/assets/${assetId}/balances?${params.toString()}`;
    const payload = await fetchJson(url, `asset ${assetId} balances`);
    pageCount += 1;
    const balances = Array.isArray(payload?.balances) ? payload.balances : [];
    scannedBalances += balances.length;
    balances.forEach((balance) => {
      const address = normaliseAddress(balance?.address);
      if (!address || excluded.has(address)) {
        return;
      }
      const amountBigInt = toBigInt(balance?.amount);
      if (amountBigInt === null || amountBigInt <= 0n) {
        return;
      }
      holderMap.set(address, amountBigInt.toString());
    });
    nextToken = payload?.['next-token'] || null;
  } while (nextToken);

  const balances = Array.from(holderMap.entries())
    .map(([address, amount]) => ({ address, amount }))
    .sort((a, b) => a.address.localeCompare(b.address));

  return {
    assetId: Number.parseInt(assetId, 10),
    holders: balances.map((entry) => entry.address),
    balances,
    updatedAt: new Date().toISOString(),
    source: context.indexerBase,
    meta: {
      pageCount,
      scannedBalances,
      uniqueHolders: balances.length,
    },
  };
}

async function getDrawAppId(context) {
  const url = `${context.indexerBase}/v2/applications/${context.registryAppId}`;
  const payload = await fetchJson(url, 'registry application');
  const globalState = payload?.application?.params?.['global-state'];
  if (!Array.isArray(globalState)) {
    throw new Error('Registry global state unavailable');
  }
  for (const entry of globalState) {
    if (entry?.key === 'ZHJhd0FwcElk') {
      const drawId = Number(entry?.value?.uint);
      if (Number.isFinite(drawId) && drawId > 0) {
        return drawId;
      }
    }
  }
  throw new Error('drawAppId not present in registry global state');
}

async function getChallenge(context, challengeId) {
  const boxName = encodeMapKey('c', 'uint8', challengeId, DRAW_STRUCTS);
  const url = buildBoxUrl(context.indexerBase, context.drawAppId, boxName);
  const payload = await fetchJson(url, `challenge ${challengeId} box`);
  const decoded = decodeArcValue(payload?.value, 'Challenge', DRAW_STRUCTS);
  if (!decoded) {
    throw new Error(`Challenge state for id ${challengeId} unavailable`);
  }
  return decoded;
}

async function getWeeklyDrawState(context, challengeId) {
  const boxName = encodeMapKey('w', 'uint8', challengeId, DRAW_STRUCTS);
  const url = buildBoxUrl(context.indexerBase, context.drawAppId, boxName);
  const payload = await fetchJson(url, `weekly draw state ${challengeId}`);
  const decoded = decodeArcValue(payload?.value, 'WeeklyDrawState', DRAW_STRUCTS);
  if (!decoded) {
    throw new Error(`Weekly draw state for id ${challengeId} unavailable`);
  }
  return decoded;
}

async function getRelativeAddress(context, relativeId) {
  const boxName = encodeMapKey('r', 'uint32', relativeId, REGISTRY_STRUCTS);
  const url = buildBoxUrl(context.indexerBase, context.registryAppId, boxName);
  const payload = await fetchJson(url, `relative id ${relativeId}`);
  const base64Value = payload?.value;
  if (typeof base64Value !== 'string' || base64Value.length === 0) {
    throw new Error(`Relative mapping ${relativeId} missing`);
  }
  const bytes = Buffer.from(base64Value, 'base64');
  return algosdk.encodeAddress(bytes);
}

async function getUserRecord(context, address) {
  const decoded = algosdk.decodeAddress(address);
  const base64Name = Buffer.from(decoded.publicKey).toString('base64');
  const url = buildBoxUrl(context.algodBase, context.registryAppId, base64Name);
  const payload = await fetchJson(url, `user box ${address}`);
  const decodedUser = decodeArcValue(payload?.value, 'User', REGISTRY_STRUCTS);
  if (!decodedUser) {
    throw new Error(`User record for ${address} unavailable`);
  }
  return decodedUser;
}

async function buildWinnerRecord(context, relativeId) {
  const address = await getRelativeAddress(context, relativeId);
  const user = await getUserRecord(context, address);
  const availablePrizes = formatAssets(user.availableDrawPrizeAssetIds);
  const claimedPrizes = formatAssets(user.claimedDrawPrizeAssetIds);
  const referrals = Array.isArray(user.referrals) ? user.referrals : [];
  return {
    relativeId,
    address,
    referrerId: user.referrerId || null,
    points: formatPoints(user.points),
    redeemedPoints: formatPoints(user.redeemedPoints),
    weeklyDrawEntries: Array.isArray(user.weeklyDrawEligibility)
      ? user.weeklyDrawEligibility.length
      : 0,
    completedQuests: normaliseQuestList(user.completedQuests),
    completedChallenges: normaliseChallengeList(user.completedChallenges),
    numReferrals: typeof user.numReferrals === 'number' ? user.numReferrals : referrals.length,
    referralIds: referrals,
    availablePrizeAssetIds: availablePrizes,
    claimedPrizeAssetIds: claimedPrizes,
  };
}

function buildContext(options = {}) {
  const context = {
    indexerBase: normaliseBase(options.indexerBase, DEFAULT_INDEXER_BASE),
    algodBase: normaliseBase(options.algodBase, DEFAULT_ALGOD_BASE),
    registryAppId: Number.isFinite(options.registryAppId) && options.registryAppId > 0
      ? Number(options.registryAppId)
      : REGISTRY_APP_ID,
  };
  if (options.drawAppId && Number.isFinite(options.drawAppId)) {
    context.drawAppId = Number(options.drawAppId);
  }
  return context;
}

export async function resolveDrawAppId(options = {}) {
  const context = buildContext(options);
  const drawAppId = await getDrawAppId(context);
  return drawAppId;
}

export async function fetchWeeklyDrawData(week, options = {}) {
  if (!Number.isFinite(Number(week)) || Number(week) < 1) {
    throw new Error('Week must be a positive integer');
  }
  const context = buildContext(options);
  if (!context.drawAppId) {
    context.drawAppId = await getDrawAppId(context);
  }
  const challenge = await getChallenge(context, Number(week));
  const weeklyState = await getWeeklyDrawState(context, Number(week));
  const winners = [];
  for (const relativeId of weeklyState.winners) {
    const winnerRecord = await buildWinnerRecord(context, relativeId);
    winners.push(winnerRecord);
  }
  const prizeAssets = [];
  const prizeAssetIds = options.includePrizeAssets === false
    ? []
    : getUniquePrizeAssetIds(challenge);
  for (const assetId of prizeAssetIds) {
    try {
      const holderInfo = await getAssetHoldersWithMetadata(assetId, context);
      prizeAssets.push(holderInfo);
    } catch (error) {
      prizeAssets.push({ assetId, error: normaliseError(error) });
    }
  }
  return {
    week: Number(week),
    challenge,
    weeklyState,
    winners,
    prizeAssets,
  };
}

export async function fetchMultipleWeeks(weeks, options = {}) {
  if (!Array.isArray(weeks) || weeks.length === 0) {
    throw new Error('At least one week is required');
  }
  const context = buildContext(options);
  if (!context.drawAppId) {
    context.drawAppId = await getDrawAppId(context);
  }
  const results = [];
  for (const week of weeks) {
    try {
      const weekData = await fetchWeeklyDrawData(week, { ...context });
      results.push(weekData);
    } catch (error) {
      results.push({ week: Number(week), error: normaliseError(error) });
    }
  }
  return {
    registryAppId: context.registryAppId,
    drawAppId: context.drawAppId,
    weeks: results,
  };
}

function normaliseError(error) {
  if (!error) {
    return 'Unknown error';
  }
  if (typeof error === 'string') {
    return error;
  }
  const message = error.message || String(error);
  if (message && message.includes('404')) {
    return 'Indexer returned 404 (state not found or not yet published)';
  }
  return message || 'Unknown error';
}

export { normaliseError };
