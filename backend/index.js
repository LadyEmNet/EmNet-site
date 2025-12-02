import algosdk from 'algosdk';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import NodeCache from 'node-cache';
import path from 'node:path';
import { setDefaultResultOrder } from 'node:dns';
import { createRequire } from 'node:module';
import { STATUS_CODES } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Agent, setGlobalDispatcher } from 'undici';

import { APP_ID, DISTRIBUTOR_ALLOWLIST, WEEK_CONFIG, getAllowlistForAsset } from './config.js';
import { createChallengePrizeService } from './challengePrizeService.js';
import { fetchWeeklyDrawData, resolveDrawAppId, normaliseError as normaliseDrawError } from './drawService.js';
import { getAllPrizes, getPrizeForWeek } from './prizeStore.js';

const require = createRequire(import.meta.url);
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const { AlgolandSDK } = require(path.join(
  currentDir,
  'node_modules',
  '@algorandfoundation',
  'algoland-sdk',
  'dist',
  'cjs',
  'index.js',
));
const { AlgorandClient } = require(path.join(
  currentDir,
  'node_modules',
  '@algorandfoundation',
  'algokit-utils',
  'types',
  'algorand-client.js',
));

const execFileAsync = promisify(execFile);

async function createCurlFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input?.url ?? input?.href;
  if (!url) {
    throw new TypeError('A valid URL is required for fetch');
  }

  const method = typeof init.method === 'string' && init.method.length
    ? init.method.toUpperCase()
    : 'GET';

  const headers = new Headers(init.headers || {});
  if (!headers.has('accept')) {
    headers.set('accept', 'application/json');
  }
  const headerArgs = [];
  headers.forEach((value, key) => {
    headerArgs.push('-H', `${key}: ${value}`);
  });

  const args = [
    '--silent',
    '--show-error',
    '--compressed',
    '--location',
    '--http1.1',
    '--connect-timeout',
    String(DEFAULT_CURL_CONNECT_TIMEOUT_SECONDS),
    '--max-time',
    String(DEFAULT_CURL_TIMEOUT_SECONDS),
    '--write-out',
    '%{http_code}',
  ];

  if (method && method !== 'GET') {
    args.push('-X', method);
  }

  if (init.body !== undefined && init.body !== null) {
    let serialisedBody = init.body;
    if (typeof serialisedBody === 'object' && !(serialisedBody instanceof Uint8Array)) {
      if (typeof serialisedBody.toString === 'function' && serialisedBody.toString !== Object.prototype.toString) {
        serialisedBody = serialisedBody.toString();
      } else {
        serialisedBody = JSON.stringify(serialisedBody);
        if (!headers.has('content-type')) {
          headers.set('content-type', 'application/json');
          headerArgs.push('-H', 'content-type: application/json');
        }
      }
    }
    if (serialisedBody instanceof ArrayBuffer) {
      serialisedBody = Buffer.from(serialisedBody).toString('utf8');
    }
    if (ArrayBuffer.isView(serialisedBody)) {
      serialisedBody = Buffer.from(serialisedBody).toString('utf8');
    }
    args.push('--data-binary', typeof serialisedBody === 'string' ? serialisedBody : String(serialisedBody));
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), 'algoland-fetch-'));
  const bodyPath = path.join(tempDir, 'body');
  const headerPath = path.join(tempDir, 'headers');

  args.push(...headerArgs);
  args.push('--output', bodyPath);
  args.push('--dump-header', headerPath);
  args.push(url);

  let stdout;
  try {
    ({ stdout } = await execFileAsync('curl', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 }));
  } catch (error) {
    const stderr = error?.stderr ? error.stderr.toString() : '';
    const message = stderr || error?.message || 'curl request failed';
    const errorWithCause = new Error(message);
    errorWithCause.cause = error;
    throw errorWithCause;
  }

  const statusLine = stdout.trim();
  const status = Number.parseInt(statusLine, 10);
  if (!Number.isFinite(status)) {
    throw new Error(`Invalid status code from curl response: ${statusLine}`);
  }

  const bodyBuffer = await readFile(bodyPath);
  const bodyText = bodyBuffer.toString('utf8');
  let headerText = '';
  try {
    headerText = await readFile(headerPath, 'utf8');
  } catch {}

  try {
    await rm(tempDir, { recursive: true, force: true });
  } catch {}

  const responseHeaders = new Headers();
  const headerBlocks = headerText.split(/\r?\n\r?\n/).filter(Boolean);
  const relevantHeaders = headerBlocks.length > 0 ? headerBlocks.at(-1) : '';
  for (const line of relevantHeaders.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^HTTP\//i.test(trimmed)) {
      continue;
    }
    const separatorIndex = trimmed.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (key) {
      responseHeaders.append(key, value);
    }
  }
  headers.forEach((value, key) => {
    if (!responseHeaders.has(key)) {
      responseHeaders.set(key, value);
    }
  });

  if (process.env.DEBUG_CURL_FETCH === '1') {
    console.debug('[Algoland API] curl fetch response', {
      url,
      status,
      bodyPreview: bodyText.slice(0, 200),
    });
  }

  return buildCurlResponse({ status, bodyText, bodyBuffer, headers: responseHeaders, url });
}

function buildCurlResponse({ status, bodyText, bodyBuffer, headers, url }) {
  const response = {
    status,
    statusText: STATUS_CODES[status] ?? '',
    ok: status >= 200 && status < 300,
    headers,
    url,
    redirected: false,
    type: 'basic',
    async text() {
      return bodyText;
    },
    async json() {
      if (!bodyText) {
        return null;
      }
      try {
        return JSON.parse(bodyText);
      } catch (error) {
        console.warn('[Algoland API] Failed to parse JSON response', {
          url,
          status,
          bodyPreview: bodyText.slice(0, 200),
        });
        throw error;
      }
    },
    async arrayBuffer() {
      const view = bodyBuffer instanceof Uint8Array ? bodyBuffer : Buffer.from(bodyText, 'utf8');
      return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
    },
    async blob() {
      const view = bodyBuffer instanceof Uint8Array ? bodyBuffer : Buffer.from(bodyText, 'utf8');
      return new Blob([view]);
    },
    clone() {
      const clonedBuffer = bodyBuffer instanceof Uint8Array ? Buffer.from(bodyBuffer) : Buffer.from(bodyText, 'utf8');
      return buildCurlResponse({ status, bodyText, bodyBuffer: clonedBuffer, headers: new Headers(headers), url });
    },
  };

  return response;
}

if (typeof setDefaultResultOrder === 'function') {
  try {
    setDefaultResultOrder('ipv4first');
  } catch (error) {
    console.warn('[Algoland API] Failed to set DNS result order', { message: error?.message });
  }
}

try {
  setGlobalDispatcher(new Agent({ connect: { family: 4, ipv6Only: false } }));
} catch (error) {
  console.warn('[Algoland API] Failed to set global HTTP agent', { message: error?.message });
}

const DEFAULT_CURL_TIMEOUT_SECONDS = Number.parseInt(process.env.CURL_TIMEOUT_SECONDS || '', 10) || 30;
const DEFAULT_CURL_CONNECT_TIMEOUT_SECONDS = Number.parseInt(
  process.env.CURL_CONNECT_TIMEOUT_SECONDS || '',
  10,
) || 10;

globalThis.fetch = createCurlFetch;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const RAW_ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'https://emnetcm.com,https://www.emnetcm.com';
const INDEXER_BASE = (process.env.INDEXER_BASE || 'https://mainnet-idx.algonode.cloud').replace(/\/+$/, '');
const ALGOD_BASE = (process.env.ALGOD_BASE || 'https://mainnet-api.algonode.cloud').replace(/\/+$/, '');
const CACHE_TTL_SECONDS = Number.parseInt(process.env.CACHE_TTL_SECONDS || '', 10) || 300;
const MAX_RETRIES = Number.parseInt(process.env.INDEXER_MAX_RETRIES || '', 10) || 5;
const RETRY_BASE_DELAY_MS = Number.parseInt(process.env.INDEXER_RETRY_BASE_MS || '', 10) || 500;

const algorandClient = AlgorandClient.mainNet();
const algolandSdk = new AlgolandSDK({ appId: BigInt(APP_ID), algorand: algorandClient });
const challengePrizeService = createChallengePrizeService({ sdk: algolandSdk });

const RELATIVE_ID_KEYS = [
  'relativeid',
  'relative_id',
  'relative',
  'relid',
  'userindex',
  'user_id',
  'userid',
];
const REFERRER_ID_KEYS = [
  'referrerid',
  'referrer_id',
  'referrer',
  'parentid',
  'parent_id',
];
const POINT_KEYS = [
  'points',
  'totalpoints',
  'points_total',
  'pointsbalance',
  'pointbalance',
  'currentpoints',
  'availablepoints',
  'balance',
];
const REDEEMED_POINT_KEYS = [
  'redeemedpoints',
  'pointsredeemed',
  'redeemed',
  'redeemed_points',
  'pointsclaimed',
  'claimedpoints',
];
const QUEST_LIST_KEYS = [
  'completedquests',
  'questscompleted',
  'quests_complete',
  'quests',
  'questhistory',
  'quest_history',
  'questscompletedlist',
  'quest_completed',
  'questcomplete',
];
const CHALLENGE_LIST_KEYS = [
  'completedchallenges',
  'challengescompleted',
  'challenges',
  'challengehistory',
  'challenge_history',
  'challenges_complete',
];
const REFERRAL_LIST_KEYS = [
  'referrals',
  'referrallist',
  'referralslist',
  'referralhistory',
  'refs',
];
const REFERRAL_COUNT_KEYS = [
  'referralcount',
  'referralscount',
  'referrals_total',
  'referralsnumber',
  'refcount',
];
const WEEKLY_DRAW_KEYS = [
  'weeklydraws',
  'weekly_draws',
  'weeklydraweligibility',
  'weekly_draw_eligibility',
  'weeklyentries',
  'drawentries',
  'weeklydrawentries',
  'draws',
  'weekly',
  'draw_history',
];

const AVAILABLE_DRAW_PRIZE_KEYS = [
  'availabledrawprizeassetids',
  'availableprizes',
  'availabledrawprizes',
  'availableprizeassetids',
  'availableprizeids',
  'availableassets',
  'available',
];

const CLAIMED_DRAW_PRIZE_KEYS = [
  'claimeddrawprizeassetids',
  'claimedprizes',
  'claimeddrawprizes',
  'claimedprizeassetids',
  'claimedprizeids',
  'claimedassets',
  'claimed',
];

const COMPLETABLE_CHALLENGE_KEYS = [
  'completablechallenges',
  'availablechallenges',
  'challengeoptions',
  'challenge_pool',
  'eligiblechallenges',
];

const WEEKLY_DRAW_ENTRY_KEYS = [
  'weeklydrawentries',
  'weeklyentries',
  'entriescount',
  'entrycount',
  'totalentries',
  'drawentries',
  'entrytotal',
];

const CHALLENGES_PER_WEEK = 3;
const TOTAL_WEEKS = 13;
const TOTAL_CHALLENGES = CHALLENGES_PER_WEEK * TOTAL_WEEKS;
const CHALLENGE_BOX_PREFIX = 'addr:';

const allowedOrigins = RAW_ALLOWED_ORIGINS.split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) {
      callback(null, true);
      return;
    }
    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Not allowed by CORS'), false);
  },
  methods: ['GET', 'OPTIONS'],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

const responseCache = new NodeCache({
  stdTTL: CACHE_TTL_SECONDS,
  checkperiod: Math.max(Math.floor(CACHE_TTL_SECONDS / 2), 30),
  useClones: false,
});

const profileCache = new NodeCache({
  stdTTL: CACHE_TTL_SECONDS,
  checkperiod: Math.max(Math.floor(CACHE_TTL_SECONDS / 2), 30),
  useClones: false,
});

const idLookupCache = new NodeCache({
  stdTTL: 12 * 60 * 60,
  checkperiod: 60 * 60,
  useClones: false,
});

const assetMetadataCache = new NodeCache({
  stdTTL: 6 * 60 * 60,
  checkperiod: 60 * 60,
  useClones: false,
});

const assetHoldersCache = new NodeCache({
  stdTTL: 0,
  checkperiod: 0,
  useClones: false,
});

const weeklyDrawCache = new NodeCache({
  stdTTL: 0,
  checkperiod: 0,
  useClones: false,
});

const MAX_HOLDER_CACHE_AGE_MS = Math.max(CACHE_TTL_SECONDS * 1000, 60 * 1000);
const MAX_DRAW_CACHE_AGE_MS = Math.max(CACHE_TTL_SECONDS * 1000, 60 * 1000);

challengePrizeService.start();

let cachedDrawAppId = null;
let drawAppIdPromise = null;

function normalisePath(path) {
  if (!path.startsWith('/')) {
    return `/${path}`;
  }
  return path;
}

async function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function indexerRequest(path, params = {}) {
  const url = new URL(normalisePath(path), `${INDEXER_BASE}`);
  const queryParts = [];
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') {
      return;
    }
    const encodedKey = encodeURIComponent(key);
    const stringValue = Array.isArray(value) ? value.join(',') : `${value}`;
    let encodedValue = encodeURIComponent(stringValue);
    if (key === 'name' && stringValue.startsWith('base64:')) {
      encodedValue = encodedValue.replace(/^base64%3A/, 'base64:');
    }
    queryParts.push(`${encodedKey}=${encodedValue}`);
  });
  if (queryParts.length > 0) {
    url.search = `?${queryParts.join('&')}`;
  }

  let attempt = 0;
  let delayMs = RETRY_BASE_DELAY_MS;
  let lastError;
  while (attempt < MAX_RETRIES) {
    try {
      const start = performance.now();
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
        },
      });
      const durationMs = performance.now() - start;
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`Indexer responded with status ${response.status}`);
        console.warn('[Algoland API] Indexer busy', {
          url: url.toString(),
          status: response.status,
          attempt: attempt + 1,
          durationMs,
        });
      } else if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Indexer request failed (${response.status}): ${errorText}`);
      } else {
        console.info('[Algoland API] Indexer request complete', {
          url: url.toString(),
          status: response.status,
          durationMs,
          attempt: attempt + 1,
        });
        return response.json();
      }
    } catch (error) {
      lastError = error;
      console.warn('[Algoland API] Indexer request error', {
        url: url.toString(),
        attempt: attempt + 1,
        message: error.message,
      });
    }
    attempt += 1;
    if (attempt < MAX_RETRIES) {
      await delay(delayMs);
      delayMs *= 2;
    }
  }
  throw lastError || new Error('Indexer request failed');
}

function decodeStateKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    return undefined;
  }
  try {
    return Buffer.from(key, 'base64').toString('utf8');
  } catch (error) {
    console.warn('[Algoland API] Failed to decode state key', {
      message: error.message,
    });
    return undefined;
  }
}

function toSafeInteger(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return undefined;
    }
    return Math.trunc(value);
  }
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      return undefined;
    }
    return Number(value);
  }
  if (typeof value === 'string') {
    if (value.trim().length === 0) {
      return undefined;
    }
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function extractUintValue(stateValue) {
  if (!stateValue || typeof stateValue !== 'object') {
    return undefined;
  }
  const directUint = toSafeInteger(stateValue.uint);
  if (directUint !== undefined && directUint >= 0) {
    return directUint;
  }
  if (typeof stateValue.bytes === 'string' && stateValue.bytes.length > 0) {
    try {
      const buffer = Buffer.from(stateValue.bytes, 'base64');
      if (buffer.length === 0) {
        return 0;
      }
      const hex = buffer.toString('hex');
      if (hex.length === 0) {
        return 0;
      }
      const bigintValue = BigInt(`0x${hex}`);
      return toSafeInteger(bigintValue);
    } catch (error) {
      console.warn('[Algoland API] Failed to decode uint from bytes', {
        message: error.message,
      });
    }
  }
  return undefined;
}

function createProfileError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function parseProfileIdentifier(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw createProfileError('missing_identifier', 'address query parameter is required.', 400);
  }
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(numeric) || numeric < 0) {
      throw createProfileError('invalid_identifier', 'Algoland ID must be a positive integer.', 400);
    }
    return { type: 'id', value: numeric, raw: trimmed };
  }
  const upper = trimmed.toUpperCase();
  if (isAlgorandAddress(upper)) {
    return { type: 'address', value: upper, raw: upper };
  }
  throw createProfileError(
    'invalid_identifier',
    'address must be a numeric ID or 58-character Algorand address.',
    400,
  );
}

function isAlgorandAddress(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed.length !== 58) {
    return false;
  }
  try {
    return algosdk.isValidAddress(trimmed);
  } catch (error) {
    console.warn('[Algoland API] Address validation failed', {
      message: error.message,
    });
    return false;
  }
}

function parseStateValue(stateValue) {
  const numeric = extractUintValue(stateValue);
  if (numeric !== undefined) {
    return numeric;
  }
  if (!stateValue || typeof stateValue !== 'object') {
    return null;
  }
  const { bytes } = stateValue;
  if (typeof bytes !== 'string') {
    return null;
  }
  if (bytes.length === 0) {
    return '';
  }
  try {
    const buffer = Buffer.from(bytes, 'base64');
    if (buffer.length === 0) {
      return '';
    }
    const utf8 = buffer.toString('utf8');
    const cleaned = utf8.replace(/\u0000+$/g, '');
    const trimmed = cleaned.trim();
    if (!trimmed) {
      return '';
    }
    const jsonValue = tryParseJson(trimmed);
    if (jsonValue !== undefined) {
      return jsonValue;
    }
    if (/[\n,|]/.test(trimmed)) {
      const parts = trimmed
        .split(/[\n,|]+/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      if (parts.length > 1) {
        return parts;
      }
    }
    return trimmed;
  } catch (error) {
    console.warn('[Algoland API] Failed to decode local state bytes', {
      message: error.message,
    });
    return null;
  }
}

function buildChallengeBoxName(address) {
  if (!address || typeof address !== 'string') {
    return undefined;
  }
  try {
    return Buffer.from(`${CHALLENGE_BOX_PREFIX}${address}`, 'utf8').toString('base64');
  } catch (error) {
    console.warn('[Algoland API] Failed to encode challenge box name', {
      message: error.message,
    });
    return undefined;
  }
}

function decodeChallengeBoxValue(boxValue) {
  const empty = {
    buffer: Buffer.alloc(0),
    values: Array.from({ length: TOTAL_CHALLENGES }, () => 0),
  };
  if (!boxValue || typeof boxValue !== 'object') {
    return empty;
  }
  const { bytes } = boxValue;
  if (typeof bytes !== 'string' || bytes.length === 0) {
    return empty;
  }
  try {
    const buffer = Buffer.from(bytes, 'base64');
    return {
      buffer,
      values: decodeChallengeBuffer(buffer),
    };
  } catch (error) {
    console.warn('[Algoland API] Failed to decode challenge box payload', {
      message: error.message,
    });
    return empty;
  }
}

function decodeChallengeBuffer(buffer) {
  const values = Array.from({ length: TOTAL_CHALLENGES }, () => 0);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return values;
  }
  for (let index = 0; index < TOTAL_CHALLENGES; index += 1) {
    const offset = index * 2;
    if (offset + 2 <= buffer.length) {
      values[index] = buffer.readUInt16LE(offset);
    } else if (offset < buffer.length) {
      values[index] = buffer.readUInt8(offset);
    }
  }
  return values;
}

function summariseChallengeProgress(values) {
  const completedChallenges = [];
  const completedQuests = [];
  const weeklyDraws = [];
  const weeklyPoints = [];
  let totalPointsRaw = 0;

  for (let weekIndex = 0; weekIndex < TOTAL_WEEKS; weekIndex += 1) {
    const weekLabel = `Week ${weekIndex + 1}`;
    const challengePoints = [];
    let allCompleted = true;

    for (let challengeIndex = 0; challengeIndex < CHALLENGES_PER_WEEK; challengeIndex += 1) {
      const valueIndex = weekIndex * CHALLENGES_PER_WEEK + challengeIndex;
      const rawValue = Number(values?.[valueIndex] ?? 0);
      const safeValue = Number.isFinite(rawValue) && rawValue > 0 ? Math.trunc(rawValue) : 0;
      totalPointsRaw += safeValue;
      challengePoints.push(safeValue);

      if (safeValue > 0) {
        const formattedPoints = (safeValue / 100).toLocaleString('en-GB', {
          minimumFractionDigits: 0,
          maximumFractionDigits: 2,
        });
        completedChallenges.push(
          `${weekLabel} – Challenge ${challengeIndex + 1} (${formattedPoints} pts)`,
        );
      } else {
        allCompleted = false;
      }
    }

    weeklyPoints.push({
      week: weekIndex + 1,
      challenges: challengePoints,
    });

    if (allCompleted) {
      completedQuests.push(weekLabel);
      weeklyDraws.push({ week: weekIndex + 1, eligible: true });
    }
  }

  return {
    rawValues: Array.isArray(values) ? values.slice(0, TOTAL_CHALLENGES) : [],
    totalPointsRaw,
    totalPoints: totalPointsRaw / 100,
    completedChallenges,
    completedQuests,
    weeklyDraws,
    weeklyPoints,
  };
}

function tryParseJson(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return undefined;
  }
  const firstChar = text.charAt(0);
  if (firstChar !== '{' && firstChar !== '[') {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    return undefined;
  }
}

function decodeLocalStateEntries(keyValues) {
  if (!Array.isArray(keyValues)) {
    return [];
  }
  const entries = [];
  keyValues.forEach((entry) => {
    const keyName = decodeStateKey(entry?.key);
    if (!keyName) {
      return;
    }
    const value = parseStateValue(entry?.value);
    entries.push({
      key: keyName,
      lowerKey: keyName.toLowerCase(),
      value,
    });
  });
  return entries;
}

function normaliseKeyName(key) {
  if (typeof key === 'string') {
    return key.toLowerCase();
  }
  return String(key || '').toLowerCase();
}

function extractFirstValue(entries, keys) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return undefined;
  }
  const searchKeys = Array.isArray(keys) ? keys : [keys];
  const lowerKeys = new Set(searchKeys.map((key) => normaliseKeyName(key)));
  for (const entry of entries) {
    if (lowerKeys.has(entry.lowerKey)) {
      return entry.value;
    }
  }
  return undefined;
}

function extractNestedValue(value, keys, depth = 0) {
  if (value === null || value === undefined || depth > 6) {
    return undefined;
  }
  const searchKeys = Array.isArray(keys) ? keys : [keys];
  const lowerKeys = new Set(searchKeys.map((key) => normaliseKeyName(key)));

  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = extractNestedValue(item, searchKeys, depth + 1);
        if (nested !== undefined) {
          return nested;
        }
      }
      return undefined;
    }

    for (const [key, candidate] of Object.entries(value)) {
      const lowerKey = normaliseKeyName(key);
      if (lowerKeys.has(lowerKey)) {
        return candidate;
      }
    }

    for (const candidate of Object.values(value)) {
      const nested = extractNestedValue(candidate, searchKeys, depth + 1);
      if (nested !== undefined) {
        return nested;
      }
    }
    return undefined;
  }

  if (typeof value === 'string') {
    const parsed = tryParseJson(value.trim());
    if (parsed !== undefined) {
      return extractNestedValue(parsed, searchKeys, depth + 1);
    }
  }

  return undefined;
}

function extractProfileValue(entries, keys) {
  const direct = extractFirstValue(entries, keys);
  if (direct !== undefined) {
    return direct;
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    return undefined;
  }
  for (const entry of entries) {
    const nested = extractNestedValue(entry.value, keys);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

function coerceNumericValue(candidate, depth = 0) {
  if (candidate === null || candidate === undefined) {
    return undefined;
  }
  const direct = toSafeInteger(candidate);
  if (direct !== undefined) {
    return direct;
  }
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      const parsed = Number.parseInt(trimmed, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  if (typeof candidate === 'object' && depth < 3) {
    const keysToCheck = [
      'value',
      'count',
      'total',
      'balance',
      'current',
      'available',
      'entries',
      'amount',
      'totalPoints',
      'points',
    ];
    for (const key of keysToCheck) {
      if (key in candidate) {
        const nested = coerceNumericValue(candidate[key], depth + 1);
        if (nested !== undefined) {
          return nested;
        }
      }
    }
    const seenKeys = new Set(keysToCheck);
    for (const [key, value] of Object.entries(candidate)) {
      if (seenKeys.has(key) || isInspectorScalingKey(key)) {
        continue;
      }
      const nested = coerceNumericValue(value, depth + 1);
      if (nested !== undefined) {
        return nested;
      }
    }
  }
  return undefined;
}

function coerceListValue(candidate, depth = 0) {
  if (candidate === null || candidate === undefined) {
    return [];
  }
  if (Array.isArray(candidate)) {
    return candidate.slice();
  }
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    if (!trimmed) {
      return [];
    }
    if (/[\n,|]/.test(trimmed)) {
      return trimmed
        .split(/[\n,|]+/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    }
    return [trimmed];
  }
  if (typeof candidate === 'number' && Number.isFinite(candidate)) {
    return candidate === 0 ? [] : [candidate];
  }
  if (typeof candidate === 'object' && depth < 3) {
    const arrayLikeKeys = ['list', 'items', 'entries', 'weeks', 'values', 'ids', 'history'];
    for (const key of arrayLikeKeys) {
      if (Array.isArray(candidate[key])) {
        return candidate[key].slice();
      }
    }
    if (typeof candidate.text === 'string' && candidate.text.trim()) {
      return [candidate.text.trim()];
    }
    const flatEntries = Object.entries(candidate).filter(([, value]) =>
      value !== null && value !== undefined && typeof value !== 'object',
    );
    if (flatEntries.length > 0) {
      return flatEntries.map(([key, value]) => `${key}: ${value}`);
    }
  }
  return [];
}

function normaliseWeeklyDrawState(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.slice();
  }
  if (typeof value === 'object') {
    const result = {};
    const eligible =
      typeof value.eligible === 'boolean'
        ? value.eligible
        : typeof value.isEligible === 'boolean'
          ? value.isEligible
          : undefined;
    if (eligible !== undefined) {
      result.eligible = eligible;
    }
    const entriesCount = coerceNumericValue(
      value.entries ?? value.count ?? value.totalEntries ?? value.total,
    );
    if (entriesCount !== undefined) {
      result.entries = entriesCount;
    }
    const weeksList = coerceListValue(
      value.weeks ?? value.list ?? value.entries ?? value.weekNumbers ?? value.values ?? value.history,
    );
    if (weeksList.length > 0) {
      result.weeks = weeksList;
    }
    if (typeof value.summary === 'string' && value.summary.trim()) {
      result.summary = value.summary.trim();
    }
    if (typeof value.status === 'string' && value.status.trim()) {
      result.status = value.status.trim();
    }
    if (Object.keys(result).length === 0) {
      const derived = coerceListValue(value);
      if (derived.length > 0) {
        return derived;
      }
    }
    return Object.keys(result).length > 0 ? result : null;
  }
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function buildProfileFromEntries(entries, context = {}) {
  const address = context.address ? normaliseAddress(context.address) : undefined;
  const rawState = {};
  entries.forEach((entry) => {
    rawState[entry.key] = entry.value;
  });

  const relativeId = coerceNumericValue(extractProfileValue(entries, RELATIVE_ID_KEYS));
  const referrerId = coerceNumericValue(extractProfileValue(entries, REFERRER_ID_KEYS));
  const pointsValue = extractProfileValue(entries, POINT_KEYS);
  const redeemedValue = extractProfileValue(entries, REDEEMED_POINT_KEYS);
  const referralsValue = extractProfileValue(entries, REFERRAL_LIST_KEYS);
  const profile = {
    resolvedAddress: address || null,
    relativeId: relativeId ?? null,
    referrerId: referrerId ?? null,
    points: coerceNumericValue(pointsValue) ?? null,
    redeemedPoints: coerceNumericValue(redeemedValue) ?? null,
    completedQuests: coerceListValue(extractProfileValue(entries, QUEST_LIST_KEYS)),
    completedChallenges: coerceListValue(extractProfileValue(entries, CHALLENGE_LIST_KEYS)),
    referrals: coerceListValue(referralsValue),
    weeklyDraws: normaliseWeeklyDrawState(extractProfileValue(entries, WEEKLY_DRAW_KEYS)),
    rawState,
    source: INDEXER_BASE,
  };

  const referralsCountValue = extractProfileValue(entries, REFERRAL_COUNT_KEYS);
  const referralsCount = coerceNumericValue(referralsCountValue);
  if (referralsCount !== undefined) {
    profile.referralsCount = referralsCount;
  } else if (profile.referrals.length > 0) {
    profile.referralsCount = profile.referrals.length;
  }

  return profile;
}

async function getUserCounterFromApplication() {
  const application = await indexerRequest(`/v2/applications/${APP_ID}`);
  const globalState = application?.application?.params?.['global-state'];
  if (!Array.isArray(globalState)) {
    throw new Error('Application global state unavailable');
  }
  for (const entry of globalState) {
    const keyName = decodeStateKey(entry?.key);
    if (keyName !== 'userCounter') {
      continue;
    }
    const counter = extractUintValue(entry?.value);
    if (counter === undefined) {
      throw new Error('userCounter value invalid');
    }
    return counter;
  }
  throw new Error('userCounter not found in global state');
}

async function getChallengeProgressForAddress(address) {
  const normalised = normaliseAddress(address);
  if (!normalised) {
    return null;
  }
  const encodedName = buildChallengeBoxName(normalised);
  if (!encodedName) {
    return null;
  }

  try {
    const box = await indexerRequest(`/v2/applications/${APP_ID}/box`, {
      name: `base64:${encodedName}`,
    });
    const decoded = decodeChallengeBoxValue(box?.value);
    return {
      ...decoded,
      encodedName,
      box,
    };
  } catch (error) {
    if (isIndexerNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

async function tryGetEntrantsFromGlobalCounter(cacheKey, cached) {
  const start = performance.now();
  try {
    const counter = await getUserCounterFromApplication();
    if (!Number.isFinite(counter) || counter < 0) {
      console.warn('[Algoland API] Invalid global counter value', {
        counter,
      });
      return null;
    }
    if (cached && Number.isFinite(cached.entrants) && counter < cached.entrants) {
      console.warn('[Algoland API] Global counter lower than cached entrants, triggering enumeration fallback', {
        counter,
        cachedEntrants: cached.entrants,
      });
      return null;
    }
    const durationMs = performance.now() - start;
    const payload = {
      entrants: counter,
      updatedAt: new Date().toISOString(),
      source: INDEXER_BASE,
      meta: {
        method: 'global-state',
        durationMs,
        appId: APP_ID,
      },
    };
    responseCache.set(cacheKey, payload);
    console.info('[Algoland API] Entrants counter fetched from global state', {
      entrants: counter,
      durationMs,
    });
    return payload;
  } catch (error) {
    console.warn('[Algoland API] Failed to read global entrants counter', {
      message: error.message,
    });
    return null;
  }
}

async function enumerateEntrants(cacheKey, cached) {
  try {
    const start = performance.now();
    const accounts = new Set();
    let nextToken;
    let pageCount = 0;

    const baseParams = {
      limit: 1000,
      'include-all': false,
    };

    do {
      const params = { ...baseParams };
      if (nextToken) {
        params.next = nextToken;
      }
      const page = await indexerRequest(`/v2/applications/${APP_ID}/accounts`, params);
      pageCount += 1;
      const pageAccounts = Array.isArray(page.accounts) ? page.accounts : [];
      pageAccounts.forEach((account) => {
        const address = normaliseAddress(account.address);
        if (!address) {
          return;
        }
        accounts.add(address);
      });
      nextToken = page['next-token'] || null;
    } while (nextToken);

    const durationMs = performance.now() - start;
    const entrantCount = accounts.size;
    const payload = {
      entrants: entrantCount,
      updatedAt: new Date().toISOString(),
      source: INDEXER_BASE,
      meta: {
        method: 'enumeration',
        pageCount,
        uniqueAccounts: entrantCount,
        durationMs,
      },
    };
    responseCache.set(cacheKey, payload);
    console.info('[Algoland API] Entrants computed via enumeration', {
      entrants: entrantCount,
      pageCount,
      durationMs,
    });
    return payload;
  } catch (error) {
    if (cached) {
      console.warn('[Algoland API] Entrants enumeration falling back to cache', {
        message: error.message,
      });
      return { ...cached, stale: true };
    }
    throw error;
  }
}

async function getEntrantsCount() {
  const cacheKey = 'entrants';
  const cached = responseCache.get(cacheKey);
  const counterPayload = await tryGetEntrantsFromGlobalCounter(cacheKey, cached);
  if (counterPayload) {
    return counterPayload;
  }
  return enumerateEntrants(cacheKey, cached);
}

async function getAssetMetadata(assetId) {
  const cacheKey = `asset:${assetId}`;
  const cached = assetMetadataCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const asset = await indexerRequest(`/v2/assets/${assetId}`);
  const params = asset?.asset?.params || {};
  const adminAddresses = new Set([
    params.creator,
    params.manager,
    params.reserve,
    params.freeze,
    params.clawback,
  ].map(normaliseAddress).filter(Boolean));
  const creationRoundRaw = asset?.asset?.['created-at-round'];
  const creationRound = Number.parseInt(creationRoundRaw, 10);
  const metadata = {
    decimals: Number.parseInt(params.decimals, 10) || 0,
    adminAddresses,
    creationRound: Number.isFinite(creationRound) ? creationRound : undefined,
  };
  assetMetadataCache.set(cacheKey, metadata, 24 * 60 * 60);
  return metadata;
}

function normaliseAddress(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed.toUpperCase() : undefined;
  }
  if (!value) {
    return undefined;
  }
  if (typeof value.toString === 'function') {
    const stringValue = value.toString();
    if (typeof stringValue === 'string') {
      const trimmed = stringValue.trim();
      return trimmed ? trimmed.toUpperCase() : undefined;
    }
  }
  return undefined;
}

function isIndexerNotFoundError(error) {
  if (!error || typeof error.message !== 'string') {
    return false;
  }
  return error.message.includes('(404)');
}

async function resolveRelativeId(relativeId) {
  const safeRelativeId = toSafeInteger(relativeId);
  if (typeof safeRelativeId !== 'number' || safeRelativeId < 0) {
    return undefined;
  }
  const cacheKey = `relative:${safeRelativeId}`;
  const cached = idLookupCache.get(cacheKey);
  if (typeof cached === 'string' && cached) {
    return cached;
  }
  if (cached === null) {
    return undefined;
  }

  try {
    const user = await algolandSdk.getUser({ userId: BigInt(safeRelativeId) });
    if (!user || !user.address) {
      idLookupCache.set(cacheKey, null, 60);
      return undefined;
    }
    const address = normaliseAddress(user.address);
    if (!address) {
      idLookupCache.set(cacheKey, null, 60);
      return undefined;
    }
    idLookupCache.set(cacheKey, address);
    return address;
  } catch (error) {
    console.warn('[Algoland API] Failed to resolve relative ID', {
      relativeId: safeRelativeId,
      message: error.message,
    });
    throw error;
  }
}

function createEmptyProfile(address) {
  const now = new Date().toISOString();
  return {
    resolvedAddress: address,
    relativeId: null,
    referrerId: null,
    points: 0,
    pointsRaw: 0,
    redeemedPoints: 0,
    completedQuests: [],
    completedChallenges: [],
    completableChallenges: [],
    weeklyDrawEligibility: [],
    weeklyDraws: {
      eligible: false,
      entries: 0,
      weeks: [],
      availablePrizeAssetIds: [],
      claimedPrizeAssetIds: [],
    },
    availableDrawPrizeAssetIds: [],
    claimedDrawPrizeAssetIds: [],
    referrals: [],
    referralsCount: 0,
    hasParticipation: false,
    status: 'no_data',
    statusMessage: 'We couldn\'t find any Algoland activity for that wallet yet.',
    source: '@algorandfoundation/algoland-sdk',
    updatedAt: now,
    fetchedAt: now,
    raw: null,
  };
}

async function fetchAlgolandProfile(address) {
  try {
    const user = await algolandSdk.getUser({ userAddress: address });
    if (!user) {
      return null;
    }
    let referralAddresses = [];
    try {
      referralAddresses = await algolandSdk.getUserReferrals({ userAddress: address });
    } catch (error) {
      console.warn('[Algoland API] Failed to resolve referral addresses', {
        address,
        message: error.message,
      });
      referralAddresses = [];
    }
    return { user, referrals: referralAddresses };
  } catch (error) {
    const logError = error && typeof error === 'object'
      ? { message: error.message, stack: error.stack, cause: error.cause }
      : { message: String(error) };
    console.error('[Algoland API] Failed to fetch Algoland profile', {
      address,
      error: logError,
    });
    throw error;
  }
}

function buildSdkProfile(address, algolandUser, referralAddresses) {
  const now = new Date().toISOString();
  const completedQuests = formatQuestList(algolandUser?.completedQuests);
  const completedChallenges = formatChallengeList(algolandUser?.completedChallenges);
  const completableChallenges = formatChallengeList(algolandUser?.completableChallenges);
  const weeklyEligibilityRaw = normaliseNumericList(algolandUser?.weeklyDrawEligibility);
  const weeklyEligibility = formatWeeklyList(weeklyEligibilityRaw);
  const availablePrizes = formatAssetIdList(algolandUser?.availableDrawPrizeAssetIds);
  const claimedPrizes = formatAssetIdList(algolandUser?.claimedDrawPrizeAssetIds);
  const referralAddressesList = Array.isArray(referralAddresses)
    ? referralAddresses.filter(isAlgorandAddress)
    : [];
  const referralIds = normaliseNumericList(algolandUser?.referrals);
  const referrals = referralAddressesList.length > 0
    ? referralAddressesList
    : formatRelativeIdList(referralIds);
  const referralsCount = referralAddressesList.length > 0
    ? referralAddressesList.length
    : toSafeInteger(algolandUser?.numReferrals) ?? referralIds.length;

  const pointsRaw = toSafeNumber(algolandUser?.points);
  const pointsDisplay = toSafeNumber(algolandUser?.displayPoints)
    ?? (typeof pointsRaw === 'number' ? pointsRaw * 100 : null);
  const redeemedPointsRaw = toSafeNumber(algolandUser?.redeemedPoints);
  const redeemedPointsDisplay = toSafeNumber(algolandUser?.displayRedeemedPoints)
    ?? (typeof redeemedPointsRaw === 'number' ? redeemedPointsRaw * 100 : null);
  const referralPointsRaw = toSafeNumber(algolandUser?.referralPoints);
  const referralPointsDisplay = toSafeNumber(algolandUser?.displayReferralPoints)
    ?? (typeof referralPointsRaw === 'number' ? referralPointsRaw * 100 : null);

  const hasParticipation = Boolean(
    (pointsRaw ?? 0) > 0
      || (redeemedPointsRaw ?? 0) > 0
      || completedQuests.length > 0
      || completedChallenges.length > 0
      || referrals.length > 0
      || weeklyEligibility.length > 0
      || availablePrizes.length > 0
      || claimedPrizes.length > 0,
  );

  const profile = {
    resolvedAddress: address,
    address,
    relativeId: toSafeInteger(algolandUser?.relativeId) ?? null,
    referrerId: toSafeInteger(algolandUser?.referrerId) ?? null,
    points: pointsDisplay,
    pointsRaw,
    redeemedPoints: redeemedPointsDisplay,
    redeemedPointsRaw,
    referralPoints: referralPointsDisplay,
    referralPointsRaw,
    completedQuests,
    completedChallenges,
    completableChallenges,
    weeklyDrawEligibility: weeklyEligibility,
    weeklyDraws: {
      eligible: weeklyEligibility.length > 0,
      entries: weeklyEligibility.length,
      weeks: weeklyEligibility,
      availablePrizeAssetIds: availablePrizes,
      claimedPrizeAssetIds: claimedPrizes,
    },
    availableDrawPrizeAssetIds: availablePrizes,
    claimedDrawPrizeAssetIds: claimedPrizes,
    referrals,
    referralsCount,
    referralsRelativeIds: referralIds,
    hasParticipation,
    status: hasParticipation ? 'ok' : 'no_data',
    statusMessage: hasParticipation
      ? null
      : 'We couldn\'t find any Algoland activity for that wallet yet.',
    source: '@algorandfoundation/algoland-sdk',
    updatedAt: now,
    fetchedAt: now,
    raw: serialiseAlgolandUser(algolandUser, referralAddressesList),
  };

  return profile;
}

function formatQuestList(values) {
  return normaliseNumericList(values).map((questId) => `Quest ${questId}`);
}

function formatChallengeList(values) {
  return normaliseNumericList(values).map((challengeId) => `Challenge ${challengeId}`);
}

function formatWeeklyList(values) {
  return normaliseNumericList(values).map((challengeId) => `Challenge ${challengeId}`);
}

function formatRelativeIdList(values) {
  return normaliseNumericList(values).map((id) => `Relative ID ${id}`);
}

function formatAssetIdList(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .map((value) => {
      if (typeof value === 'bigint') {
        return `Asset ${value.toString()}`;
      }
      if (typeof value === 'number') {
        return Number.isFinite(value) ? `Asset ${Math.trunc(value)}` : null;
      }
      if (typeof value === 'string' && value.trim().length > 0) {
        return `Asset ${value.trim()}`;
      }
      return null;
    })
    .filter((item) => typeof item === 'string');
}

function convertBigIntList(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .map((value) => {
      if (typeof value === 'bigint') {
        return value.toString();
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        return String(Math.trunc(value));
      }
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
      return null;
    })
    .filter((item) => typeof item === 'string');
}

function serialiseAlgolandUser(algolandUser, referralAddresses) {
  if (!algolandUser) {
    return null;
  }
  return {
    address: normaliseAddress(algolandUser.address) || null,
    relativeId: toSafeInteger(algolandUser.relativeId) ?? null,
    referrerId: toSafeInteger(algolandUser.referrerId) ?? null,
    numReferrals: toSafeInteger(algolandUser.numReferrals) ?? null,
    referrals: normaliseNumericList(algolandUser.referrals),
    referralAddresses: Array.isArray(referralAddresses)
      ? referralAddresses.filter(isAlgorandAddress)
      : [],
    points: toSafeNumber(algolandUser.points),
    displayPoints: toSafeNumber(algolandUser.displayPoints),
    redeemedPoints: toSafeNumber(algolandUser.redeemedPoints),
    displayRedeemedPoints: toSafeNumber(algolandUser.displayRedeemedPoints),
    referralPoints: toSafeNumber(algolandUser.referralPoints),
    displayReferralPoints: toSafeNumber(algolandUser.displayReferralPoints),
    completedQuests: normaliseNumericList(algolandUser.completedQuests),
    completedChallenges: normaliseNumericList(algolandUser.completedChallenges),
    completableChallenges: normaliseNumericList(algolandUser.completableChallenges),
    weeklyDrawEligibility: normaliseNumericList(algolandUser.weeklyDrawEligibility),
    availableDrawPrizeAssetIds: convertBigIntList(algolandUser.availableDrawPrizeAssetIds),
    claimedDrawPrizeAssetIds: convertBigIntList(algolandUser.claimedDrawPrizeAssetIds),
  };
}

function normaliseNumericList(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .map((value) => toSafeInteger(value))
    .filter((value) => typeof value === 'number');
}

function toSafeNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'bigint') {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : null;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

async function getProfileForAddress(address) {
  const normalised = normaliseAddress(address);
  if (!normalised || !isAlgorandAddress(normalised)) {
    throw createProfileError('invalid_address', 'Algorand address is invalid.', 400);
  }
  const cacheKey = `profile:${normalised}`;
  const cached = profileCache.get(cacheKey);
  if (cached) {
    return { ...cached };
  }

  let sdkPayload;
  try {
    sdkPayload = await fetchAlgolandProfile(normalised);
  } catch (error) {
    console.error('[Algoland API] Algoland SDK lookup failed', {
      address: normalised,
      message: error.message,
    });
    throw createProfileError('profile_unavailable', 'Unable to load Algoland profile at this time.', 502);
  }

  const profile = sdkPayload
    ? buildSdkProfile(normalised, sdkPayload.user, sdkPayload.referrals)
    : createEmptyProfile(normalised);

  profileCache.set(cacheKey, profile);
  if (typeof profile.relativeId === 'number' && Number.isFinite(profile.relativeId)) {
    idLookupCache.set(`relative:${profile.relativeId}`, normalised);
  }

  return { ...profile };
}

async function getProfileForIdentifier(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') {
    throw createProfileError('invalid_identifier', 'address query parameter is required.', 400);
  }
  if (descriptor.type === 'address') {
    return getProfileForAddress(descriptor.value);
  }
  if (descriptor.type === 'id') {
    const address = await resolveRelativeId(descriptor.value);
    if (!address) {
      throw createProfileError(
        'profile_not_found',
        'No Algoland profile was found for that ID.',
        404,
      );
    }
    return getProfileForAddress(address);
  }
  throw createProfileError('invalid_identifier', 'Unsupported identifier type.', 400);
}

async function getCompletionsForAsset(assetId) {
  const cacheKey = `completions:${assetId}`;
  const cached = responseCache.get(cacheKey);
  try {
    const holdersPayload = await getAssetHolders(assetId);
    const payload = {
      assetId: holdersPayload.assetId,
      completions: Array.isArray(holdersPayload.holders) ? holdersPayload.holders.length : 0,
      updatedAt: holdersPayload.updatedAt,
      source: holdersPayload.source,
      meta: holdersPayload.meta,
    };
    if (holdersPayload.stale) {
      payload.stale = true;
    }
    responseCache.set(cacheKey, payload);
    console.info('[Algoland API] Completions computed', {
      assetId,
      completions: payload.completions,
      stale: Boolean(payload.stale),
      scannedBalances: payload.meta?.scannedBalances,
      durationMs: payload.meta?.durationMs,
    });
    return payload;
  } catch (error) {
    if (cached) {
      console.warn('[Algoland API] Completions falling back to cache', {
        assetId,
        message: error.message,
      });
      return { ...cached, stale: true };
    }
    throw error;
  }
}

async function getAssetHolders(assetId) {
  const cacheKey = `holders:${assetId}`;
  const cachedWrapper = assetHoldersCache.get(cacheKey);
  const now = Date.now();
  if (cachedWrapper && cachedWrapper.payload && typeof cachedWrapper.cachedAt === 'number') {
    const age = now - cachedWrapper.cachedAt;
    if (age <= MAX_HOLDER_CACHE_AGE_MS) {
      return { ...cachedWrapper.payload };
    }
  }

  try {
    const start = performance.now();
    const holders = new Set();
    const { adminAddresses } = await getAssetMetadata(assetId);

    const excludedAddresses = new Set(
      getAllowlistForAsset(assetId)
        .map(normaliseAddress)
        .filter(Boolean),
    );
    adminAddresses.forEach((address) => excludedAddresses.add(address));

    let pageCount = 0;
    let accountCount = 0;
    let nextToken;

    const baseParams = {
      limit: 1000,
      'include-all': false,
      'currency-greater-than': 0,
    };

    do {
      const params = { ...baseParams };
      if (nextToken) {
        params.next = nextToken;
      }
      const page = await indexerRequest(`/v2/assets/${assetId}/balances`, params);
      pageCount += 1;
      const balances = Array.isArray(page.balances) ? page.balances : [];
      accountCount += balances.length;
      balances.forEach((balance) => {
        const address = normaliseAddress(balance.address);
        if (!address || excludedAddresses.has(address) || adminAddresses.has(address)) {
          return;
        }
        const amount = Number(balance.amount) || 0;
        if (amount <= 0) {
          return;
        }
        holders.add(address);
      });
      nextToken = page['next-token'] || null;
    } while (nextToken);

    const durationMs = performance.now() - start;
    const sortedHolders = Array.from(holders).sort();
    const payload = {
      assetId: Number.parseInt(assetId, 10),
      holders: sortedHolders,
      updatedAt: new Date().toISOString(),
      source: INDEXER_BASE,
      meta: {
        durationMs,
        pageCount,
        scannedBalances: accountCount,
        uniqueHolders: sortedHolders.length,
      },
      stale: false,
    };
    assetHoldersCache.set(cacheKey, { payload, cachedAt: now });
    console.info('[Algoland API] Asset holders enumerated', {
      assetId,
      holders: sortedHolders.length,
      pageCount,
      scannedBalances: accountCount,
      durationMs,
    });
    return payload;
  } catch (error) {
    if (cachedWrapper && cachedWrapper.payload) {
      console.warn('[Algoland API] Holder enumeration falling back to cache', {
        assetId,
        message: error.message,
      });
      return { ...cachedWrapper.payload, stale: true };
    }
    throw error;
  }
}

async function getDrawAppIdCached() {
  if (Number.isFinite(cachedDrawAppId) && cachedDrawAppId > 0) {
    return cachedDrawAppId;
  }
  if (!drawAppIdPromise) {
    drawAppIdPromise = resolveDrawAppId({
      registryAppId: APP_ID,
      indexerBase: INDEXER_BASE,
      algodBase: ALGOD_BASE,
    })
      .then((value) => {
        cachedDrawAppId = value;
        drawAppIdPromise = null;
        return value;
      })
      .catch((error) => {
        drawAppIdPromise = null;
        throw error;
      });
  }
  return drawAppIdPromise;
}

async function getWeeklyDrawData(week) {
  const cacheKey = `weekly-draw:${week}`;
  const cachedWrapper = weeklyDrawCache.get(cacheKey);
  const now = Date.now();
  if (cachedWrapper && cachedWrapper.payload && typeof cachedWrapper.cachedAt === 'number') {
    const age = now - cachedWrapper.cachedAt;
    if (age <= MAX_DRAW_CACHE_AGE_MS) {
      return { ...cachedWrapper.payload };
    }
  }

  try {
    const drawAppId = await getDrawAppIdCached();
    const payload = await fetchWeeklyDrawData(week, {
      registryAppId: APP_ID,
      drawAppId,
      indexerBase: INDEXER_BASE,
      algodBase: ALGOD_BASE,
    });
    const enriched = { ...payload, fetchedAt: new Date().toISOString(), stale: false };
    weeklyDrawCache.set(cacheKey, { payload: enriched, cachedAt: now });
    return enriched;
  } catch (error) {
    if (cachedWrapper && cachedWrapper.payload) {
      console.warn('[Algoland API] Weekly draw fetch falling back to cache', {
        week,
        message: error.message,
      });
      return { ...cachedWrapper.payload, stale: true };
    }
    throw error;
  }
}

function sanitiseNumberLike(value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }
  return null;
}

function sanitiseNumberArray(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return [];
  }
  return values
    .map((value) => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === 'string' && /^\d+$/.test(value)) {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : null;
      }
      if (typeof value === 'bigint') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
      }
      return null;
    })
    .filter((value) => value !== null);
}

function sanitiseStringArray(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return [];
  }
  return values
    .map((value) => {
      if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length ? trimmed : null;
      }
      if (value && typeof value.toString === 'function') {
        const stringValue = value.toString();
        return typeof stringValue === 'string' && stringValue.length ? stringValue : null;
      }
      return null;
    })
    .filter((value) => value !== null);
}

function sanitiseChallenge(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const challenge = {
    questIds: sanitiseNumberArray(raw.questIds),
    drawPrizeAssetIds: sanitiseNumberArray(raw.drawPrizeAssetIds),
    numDrawEligibleAccounts: sanitiseNumberLike(raw.numDrawEligibleAccounts),
    numDrawWinners: sanitiseNumberLike(raw.numDrawWinners),
  };
  if (raw.completionBadgeAssetId) {
    challenge.completionBadgeAssetId = String(raw.completionBadgeAssetId);
  }
  if (raw.timeStart !== undefined) {
    challenge.timeStart = sanitiseNumberLike(raw.timeStart);
  }
  if (raw.timeEnd !== undefined) {
    challenge.timeEnd = sanitiseNumberLike(raw.timeEnd);
  }
  return challenge;
}

function sanitiseWeeklyState(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  return {
    status: raw.status || null,
    accountsIngested: sanitiseNumberLike(raw.accountsIngested),
    lastRelativeId: sanitiseNumberLike(raw.lastRelativeId),
    commitBlocks: sanitiseNumberArray(raw.commitBlocks),
    winners: sanitiseNumberArray(raw.winners),
    txIds: sanitiseStringArray(raw.txIds),
  };
}

function sanitiseWinnerRecord(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  return {
    relativeId: Number.isFinite(raw.relativeId) ? raw.relativeId : null,
    address: typeof raw.address === 'string' ? raw.address : null,
    referrerId: Number.isFinite(raw.referrerId) ? raw.referrerId : raw.referrerId ?? null,
    points: typeof raw.points === 'number' ? raw.points : null,
    redeemedPoints: typeof raw.redeemedPoints === 'number' ? raw.redeemedPoints : null,
    weeklyDrawEntries: Number.isFinite(raw.weeklyDrawEntries) ? raw.weeklyDrawEntries : 0,
    completedQuests: Array.isArray(raw.completedQuests) ? [...raw.completedQuests] : [],
    completedChallenges: Array.isArray(raw.completedChallenges) ? [...raw.completedChallenges] : [],
    numReferrals: Number.isFinite(raw.numReferrals) ? raw.numReferrals : 0,
    referralIds: Array.isArray(raw.referralIds) ? [...raw.referralIds] : [],
    availablePrizeAssetIds: Array.isArray(raw.availablePrizeAssetIds) ? [...raw.availablePrizeAssetIds] : [],
    claimedPrizeAssetIds: Array.isArray(raw.claimedPrizeAssetIds) ? [...raw.claimedPrizeAssetIds] : [],
  };
}

function sanitisePrizeAsset(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const descriptor = {
    assetId: Number.isFinite(raw.assetId) ? raw.assetId : Number.parseInt(raw.assetId, 10) || null,
    holders: Array.isArray(raw.holders) ? [...raw.holders] : [],
    balances: Array.isArray(raw.balances) ? raw.balances.map((balance) => ({
      address: typeof balance.address === 'string' ? balance.address : null,
      amount: typeof balance.amount === 'string' ? balance.amount : String(balance.amount ?? ''),
    })) : [],
    updatedAt: raw.updatedAt || null,
    source: raw.source || null,
    meta: raw.meta && typeof raw.meta === 'object' ? { ...raw.meta } : null,
  };
  if (raw.error) {
    descriptor.error = raw.error;
  }
  if (raw.stale) {
    descriptor.stale = true;
  }
  return descriptor;
}

function buildDrawPayload(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const winners = Array.isArray(raw.winners)
    ? raw.winners.map(sanitiseWinnerRecord).filter(Boolean)
    : [];
  const prizeAssets = Array.isArray(raw.prizeAssets)
    ? raw.prizeAssets.map(sanitisePrizeAsset).filter(Boolean)
    : [];
  return {
    week: Number.isFinite(raw.week) ? raw.week : Number.parseInt(raw.week, 10) || null,
    fetchedAt: raw.fetchedAt || null,
    stale: Boolean(raw.stale),
    challenge: sanitiseChallenge(raw.challenge),
    weeklyState: sanitiseWeeklyState(raw.weeklyState),
    winners,
    prizeAssets,
  };
}

function formatChallengeWeek(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const week = Number.parseInt(raw.week, 10);
  if (!Number.isFinite(week)) {
    return null;
  }
  const response = {
    week,
    badgeAsa: raw.badgeAsa ?? null,
    prizeAsa: raw.prizeAsa ?? null,
    status: raw.status || null,
  };
  const timeStart = Number.parseInt(raw.timeStart, 10);
  if (Number.isFinite(timeStart)) {
    response.timeStart = timeStart;
  }
  const timeEnd = Number.parseInt(raw.timeEnd, 10);
  if (Number.isFinite(timeEnd)) {
    response.timeEnd = timeEnd;
  }
  if (raw.badgeMetadata) {
    response.badgeMetadata = raw.badgeMetadata;
  }
  if (raw.prizeMetadata) {
    response.prizeMetadata = raw.prizeMetadata;
  }
  return response;
}

function sendCachedOrError(res, error) {
  console.error('[Algoland API] Request failed', { message: error.message });
  res.status(502).json({
    error: 'upstream_unavailable',
    message: 'Indexer is temporarily unavailable. Please retry shortly.',
  });
}

app.get('/api/ping', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    service: 'algoland-backend',
    provider: INDEXER_BASE,
    cacheTtlSeconds: CACHE_TTL_SECONDS,
    now: new Date().toISOString(),
    configuredOrigins: allowedOrigins,
    weeks: WEEK_CONFIG,
    allowlist: DISTRIBUTOR_ALLOWLIST,
  });
});

app.get('/api/entrants', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const payload = await getEntrantsCount();
    const responseBody = {
      entrants: payload.entrants,
      updatedAt: payload.updatedAt,
      source: payload.source,
    };
    if (payload.stale) {
      responseBody.stale = true;
    }
    res.json(responseBody);
  } catch (error) {
    sendCachedOrError(res, error);
  }
});

app.get('/api/algoland/prizes', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const snapshot = await challengePrizeService.getSnapshot();
    const weeks = Array.isArray(snapshot.weeks)
      ? snapshot.weeks.map((week) => formatChallengeWeek(week)).filter(Boolean)
      : [];

    const responseBody = {
      fetchedAt: snapshot.fetchedAt ?? null,
      source: snapshot.source ?? 'algoland-sdk',
      stale: Boolean(snapshot.stale),
      weeks,
    };
    if (snapshot.error) {
      responseBody.error = snapshot.error;
    }

    res.json(responseBody);
  } catch (error) {
    console.error('[Algoland API] Failed to load Algoland challenge prizes', { message: error.message });
    res.status(502).json({
      error: 'prize_config_unavailable',
      message: 'Unable to load Algoland challenge configuration right now. Please try again shortly.',
    });
  }
});

app.get('/api/algoland-stats', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  let descriptor;
  try {
    descriptor = parseProfileIdentifier(req.query.address);
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 400;
    res.status(status).json({ error: error?.code || 'invalid_identifier', message: error?.message || 'address query parameter is required.' });
    return;
  }

  try {
    const profile = await getProfileForIdentifier(descriptor);
    const responseBody = { ...profile };
    responseBody.lookupType = descriptor.type;
    responseBody.lookupValue = descriptor.raw ?? descriptor.value;
    res.json(responseBody);
  } catch (error) {
    if (error && error.code) {
      const status = Number.isInteger(error.status)
        ? error.status
        : error.code === 'profile_unavailable'
          ? 502
          : error.code === 'profile_not_found'
            ? 404
            : 400;
      res.status(status).json({ error: error.code, message: error.message });
      return;
    }
    console.error('[Algoland API] Profile lookup failed', { message: error?.message });
    res.status(500).json({
      error: 'profile_error',
      message: 'Unable to fetch Algoland profile at this time. Please try again shortly.',
    });
  }
});

app.get('/api/prizes', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const prizes = await getAllPrizes();
    res.json({
      weeks: prizes.map((prize) => ({
        week: prize.week,
        status: prize.status,
        asa: prize.asa,
        assetId: prize.assetId ?? null,
        image: prize.image ?? null,
        mainAssetIds: Array.isArray(prize.mainAssetIds) ? [...prize.mainAssetIds] : [],
        mainPrizes: Array.isArray(prize.mainPrizes) ? [...prize.mainPrizes] : [],
        specialPrizes: Array.isArray(prize.specialPrizes) ? [...prize.specialPrizes] : [],
      })),
    });
  } catch (error) {
    console.error('[Algoland API] Failed to load prize configuration', { message: error.message });
    res.status(500).json({
      error: 'prize_config_unavailable',
      message: 'Prize configuration is currently unavailable. Please retry shortly.',
    });
  }
});

app.get('/api/prizes/:week', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const weekParam = req.params.week;
  let prize;
  try {
    prize = await getPrizeForWeek(weekParam);
  } catch (error) {
    console.error('[Algoland API] Failed to read prize configuration', { message: error.message });
    res.status(500).json({
      error: 'prize_config_unavailable',
      message: 'Prize configuration is currently unavailable. Please retry shortly.',
    });
    return;
  }

  if (!prize) {
    res.status(400).json({ error: 'invalid_week', message: 'Week must be between 1 and 13.' });
    return;
  }

  const responseBody = {
    week: prize.week,
    status:
      prize.assetId && (prize.image || (Array.isArray(prize.mainPrizes) && prize.mainPrizes.length > 0))
        ? 'available'
        : 'coming-soon',
    asa: prize.asa,
    assetId: prize.assetId ?? null,
    image: prize.image ?? null,
    mainAssetIds: Array.isArray(prize.mainAssetIds) ? [...prize.mainAssetIds] : [],
    mainPrizes: Array.isArray(prize.mainPrizes) ? [...prize.mainPrizes] : [],
    specialPrizes: Array.isArray(prize.specialPrizes) ? [...prize.specialPrizes] : [],
    winners: [],
    winnersCount: 0,
    prizeAssets: [],
    selectedWinners: [],
  };

  if (responseBody.status === 'coming-soon') {
    responseBody.message = 'Prize details coming soon. Check back soon.';
  }

  let drawData = null;
  let drawError = null;
  try {
    drawData = await getWeeklyDrawData(prize.week);
  } catch (error) {
    drawError = error;
  }

  if (drawData) {
    const drawPayload = buildDrawPayload(drawData);
    if (drawPayload) {
      responseBody.draw = drawPayload;
      responseBody.prizeAssets = Array.isArray(drawPayload.prizeAssets) ? drawPayload.prizeAssets : [];
      responseBody.selectedWinners = Array.isArray(drawPayload.winners) ? drawPayload.winners : [];
      if (drawPayload.stale) {
        responseBody.stale = true;
        if (responseBody.status === 'available') {
          responseBody.status = 'stale';
        }
      }
      if (prize.assetId) {
        const mainAsset = responseBody.prizeAssets.find((asset) => asset.assetId === prize.assetId);
        if (mainAsset) {
          responseBody.winners = Array.isArray(mainAsset.holders) ? [...mainAsset.holders] : [];
          responseBody.winnersCount = responseBody.winners.length;
          if (mainAsset.updatedAt) {
            responseBody.updatedAt = mainAsset.updatedAt;
          } else if (drawPayload.fetchedAt) {
            responseBody.updatedAt = drawPayload.fetchedAt;
          }
          if (mainAsset.source) {
            responseBody.source = mainAsset.source;
          }
          if (mainAsset.meta) {
            responseBody.meta = mainAsset.meta;
          }
          if (mainAsset.error) {
            responseBody.winnerError = mainAsset.error;
          }
          if (mainAsset.stale) {
            responseBody.stale = true;
            responseBody.status = 'stale';
          }
        }
      }
    }
  } else if (drawError) {
    responseBody.draw = { error: normaliseDrawError(drawError) };
  }

  if (!Array.isArray(responseBody.winners)) {
    responseBody.winners = [];
  }
  if (typeof responseBody.winnersCount !== 'number') {
    responseBody.winnersCount = responseBody.winners.length;
  }
  if (!Array.isArray(responseBody.prizeAssets)) {
    responseBody.prizeAssets = [];
  }
  if (!Array.isArray(responseBody.selectedWinners)) {
    responseBody.selectedWinners = [];
  }

  res.json(responseBody);
});

app.get('/api/completions', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const assetId = req.query.asset;
  if (!assetId) {
    res.status(400).json({ error: 'missing_asset', message: 'asset query parameter is required' });
    return;
  }
  if (!/^\d+$/.test(String(assetId))) {
    res.status(400).json({ error: 'invalid_asset', message: 'asset must be a numeric ID' });
    return;
  }
  try {
    const payload = await getCompletionsForAsset(Number(assetId));
    const responseBody = {
      assetId: payload.assetId,
      completions: payload.completions,
      updatedAt: payload.updatedAt,
      source: payload.source,
    };
    if (payload.stale) {
      responseBody.stale = true;
    }
    res.json(responseBody);
  } catch (error) {
    sendCachedOrError(res, error);
  }
});

app.get('/api/completions/bulk', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const assetsParam = req.query.assets;
  if (!assetsParam) {
    res.status(400).json({ error: 'missing_assets', message: 'assets query parameter is required' });
    return;
  }

  const assetIds = String(assetsParam)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index);

  if (assetIds.length === 0) {
    res.status(400).json({ error: 'invalid_assets', message: 'assets query parameter must contain numeric IDs' });
    return;
  }

  const validAssetIds = [];
  const rejectedAssets = [];
  assetIds.forEach((value) => {
    if (/^\d+$/.test(String(value))) {
      validAssetIds.push(Number(value));
    } else {
      rejectedAssets.push(value);
    }
  });

  const completionPayloads = await Promise.all(validAssetIds.map(async (assetId) => {
    try {
      const payload = await getCompletionsForAsset(assetId);
      return {
        assetId: payload.assetId,
        completions: payload.completions,
        updatedAt: payload.updatedAt,
        source: payload.source,
        stale: Boolean(payload.stale),
      };
    } catch (error) {
      return {
        assetId,
        error: 'unavailable',
        message: error?.message || 'Unable to fetch completions for that asset.',
      };
    }
  }));

  const responseBody = { results: completionPayloads };
  if (rejectedAssets.length > 0) {
    responseBody.invalidAssets = rejectedAssets;
  }

  res.json(responseBody);
});

app.use((req, res) => {
  res.status(404).json({ error: 'not_found' });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.info(`[Algoland API] Service listening on port ${PORT}`, {
      indexerBase: INDEXER_BASE,
      cacheTtlSeconds: CACHE_TTL_SECONDS,
    });
  });
}

export default app;
export {
  buildSdkProfile,
  createEmptyProfile,
};
