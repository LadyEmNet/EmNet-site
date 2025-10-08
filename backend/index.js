import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import NodeCache from 'node-cache';
import { performance } from 'node:perf_hooks';

import { APP_ID, DISTRIBUTOR_ALLOWLIST, WEEK_CONFIG, getAllowlistForAsset } from './config.js';
import { getAllPrizes, getPrizeForWeek } from './prizeStore.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const RAW_ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'https://emnetcm.com,https://www.emnetcm.com';
const INDEXER_BASE = (process.env.INDEXER_BASE || 'https://mainnet-idx.algonode.cloud').replace(/\/+$/, '');
const LANDS_INSPECTOR_BASE = (process.env.LANDS_INSPECTOR_BASE || 'https://landsinspector.pages.dev').replace(/\/+$/, '');
const CACHE_TTL_SECONDS = Number.parseInt(process.env.CACHE_TTL_SECONDS || '', 10) || 300;
const MAX_RETRIES = Number.parseInt(process.env.INDEXER_MAX_RETRIES || '', 10) || 5;
const RETRY_BASE_DELAY_MS = Number.parseInt(process.env.INDEXER_RETRY_BASE_MS || '', 10) || 500;

const ALGOLAND_ADDRESS_PATTERN = /^[A-Z2-7]{58}$/;

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
  'weeklyentries',
  'drawentries',
  'weeklydrawentries',
  'draws',
  'weekly',
  'draw_history',
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

const MAX_HOLDER_CACHE_AGE_MS = Math.max(CACHE_TTL_SECONDS * 1000, 60 * 1000);

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
  const trimmed = value.trim().toUpperCase();
  if (trimmed.length !== 58) {
    return false;
  }
  return ALGOLAND_ADDRESS_PATTERN.test(trimmed);
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
  if (!Number.isFinite(relativeId) || relativeId < 0) {
    return undefined;
  }
  const cacheKey = `relative:${relativeId}`;
  const cached = idLookupCache.get(cacheKey);
  if (typeof cached === 'string' && cached) {
    return cached;
  }
  if (cached === null) {
    return undefined;
  }

  let nextToken;
  const baseParams = {
    limit: 100,
    'include-all': false,
  };

  try {
    do {
      const params = { ...baseParams };
      if (nextToken) {
        params.next = nextToken;
      }
      const page = await indexerRequest(`/v2/applications/${APP_ID}/accounts`, params);
      const accounts = Array.isArray(page.accounts) ? page.accounts : [];
      for (const account of accounts) {
        const address = normaliseAddress(account.address);
        if (!address) {
          continue;
        }
        const localStates = Array.isArray(account['apps-local-state'])
          ? account['apps-local-state']
          : [];
        const appState = localStates.find((state) => Number(state.id) === Number(APP_ID));
        if (!appState || !Array.isArray(appState['key-value'])) {
          continue;
        }
        const entries = decodeLocalStateEntries(appState['key-value']);
        if (entries.length === 0) {
          continue;
        }
        const value = coerceNumericValue(extractFirstValue(entries, RELATIVE_ID_KEYS));
        if (value !== undefined) {
          idLookupCache.set(`relative:${value}`, address);
          if (value === relativeId) {
            return address;
          }
        }
      }
      nextToken = page['next-token'] || null;
    } while (nextToken);
  } catch (error) {
    console.warn('[Algoland API] Failed to resolve relative ID', {
      relativeId,
      message: error.message,
    });
    throw error;
  }

  idLookupCache.set(cacheKey, null, 60);
  return undefined;
}

async function fetchLandsInspectorProfile(address) {
  const url = new URL('/api/user', `${LANDS_INSPECTOR_BASE}/`);
  url.searchParams.set('user', address);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
    },
  });

  if (response.status === 404 || response.status === 204) {
    return null;
  }

  if (!response.ok) {
    const message = `Lands Inspector responded with status ${response.status}`;
    throw new Error(message);
  }

  try {
    const payload = await response.json();
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    return payload;
  } catch (error) {
    console.warn('[Algoland API] Failed to parse Lands Inspector payload', {
      message: error.message,
    });
    return null;
  }
}

function normaliseInspectorNumber(value) {
  const numeric = coerceNumericValue(value);
  if (typeof numeric === 'number' && Number.isFinite(numeric)) {
    return numeric;
  }
  return null;
}

function normaliseInspectorList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (item === null || item === undefined) {
        return null;
      }
      if (typeof item === 'string') {
        const trimmed = item.trim();
        return trimmed.length > 0 ? trimmed : null;
      }
      if (typeof item === 'number' && Number.isFinite(item)) {
        return item;
      }
      return null;
    })
    .filter((item) => item !== null);
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
    source: LANDS_INSPECTOR_BASE,
    updatedAt: now,
    fetchedAt: now,
    raw: null,
  };
}

function buildInspectorProfile(address, payload) {
  const now = new Date().toISOString();
  const relativeId = toSafeInteger(payload?.relativeId);
  const referrerId = toSafeInteger(payload?.referrerId);
  const points = normaliseInspectorNumber(payload?.points) ?? 0;
  const redeemedPoints = normaliseInspectorNumber(payload?.redeemedPoints) ?? 0;
  const completedQuests = normaliseInspectorList(payload?.completedQuests);
  const completedChallenges = normaliseInspectorList(payload?.completedChallenges);
  const completableChallenges = normaliseInspectorList(payload?.completableChallenges);
  const weeklyDrawEligibility = normaliseInspectorList(payload?.weeklyDrawEligibility);
  const availablePrizes = normaliseInspectorList(payload?.availableDrawPrizeAssetIds);
  const claimedPrizes = normaliseInspectorList(payload?.claimedDrawPrizeAssetIds);
  const referrals = normaliseInspectorList(payload?.referrals);
  const referralsCountCandidate = normaliseInspectorNumber(
    payload?.referralsCount ?? payload?.referralCount,
  );

  const hasParticipation = Boolean(
    (points ?? 0) > 0
      || redeemedPoints > 0
      || completedQuests.length > 0
      || completedChallenges.length > 0
      || referrals.length > 0
      || weeklyDrawEligibility.length > 0
      || availablePrizes.length > 0
      || claimedPrizes.length > 0,
  );

  let statusMessage = null;
  if (typeof payload?.statusMessage === 'string' && payload.statusMessage.trim().length > 0) {
    statusMessage = payload.statusMessage.trim();
  } else if (typeof payload?.message === 'string' && payload.message.trim().length > 0) {
    statusMessage = payload.message.trim();
  } else if (typeof payload?.note === 'string' && payload.note.trim().length > 0) {
    statusMessage = payload.note.trim();
  }

  if (!hasParticipation && !statusMessage) {
    statusMessage = 'We couldn\'t find any Algoland activity for that wallet yet.';
  }

  const weeklyDraws = {
    eligible: weeklyDrawEligibility.length > 0,
    entries: weeklyDrawEligibility.length,
    weeks: weeklyDrawEligibility,
    availablePrizeAssetIds: availablePrizes,
    claimedPrizeAssetIds: claimedPrizes,
  };

  const profile = {
    resolvedAddress: address,
    relativeId: Number.isFinite(relativeId) ? relativeId : null,
    referrerId: Number.isFinite(referrerId) ? referrerId : null,
    points,
    pointsRaw: points,
    redeemedPoints,
    completedQuests,
    completedChallenges,
    completableChallenges,
    weeklyDrawEligibility,
    weeklyDraws,
    availableDrawPrizeAssetIds: availablePrizes,
    claimedDrawPrizeAssetIds: claimedPrizes,
    referrals,
    referralsCount: Number.isFinite(referralsCountCandidate)
      ? referralsCountCandidate
      : referrals.length,
    hasParticipation,
    status: hasParticipation ? 'ok' : 'no_data',
    statusMessage,
    source: LANDS_INSPECTOR_BASE,
    updatedAt:
      typeof payload?.updatedAt === 'string' && payload.updatedAt.trim().length > 0
        ? payload.updatedAt
        : now,
    fetchedAt: now,
    raw: payload,
  };

  return profile;
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

  let inspectorPayload;
  try {
    inspectorPayload = await fetchLandsInspectorProfile(normalised);
  } catch (error) {
    console.error('[Algoland API] Lands Inspector lookup failed', {
      address: normalised,
      message: error.message,
    });
    throw createProfileError('profile_unavailable', 'Unable to load Algoland profile at this time.', 502);
  }

  const profile = inspectorPayload
    ? buildInspectorProfile(normalised, inspectorPayload)
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

  if (!prize.assetId || !prize.image) {
    res.json({
      week: prize.week,
      status: 'coming-soon',
      asa: prize.asa,
      assetId: prize.assetId ?? null,
      image: prize.image ?? null,
      message: 'Prize details coming soon. Check back soon.',
    });
    return;
  }

  try {
    const holdersPayload = await getAssetHolders(prize.assetId);
    const winners = Array.isArray(holdersPayload.holders) ? holdersPayload.holders : [];
    const responseBody = {
      week: prize.week,
      status: 'available',
      asa: prize.asa,
      assetId: prize.assetId,
      image: prize.image,
      winners,
      winnersCount: winners.length,
      updatedAt: holdersPayload.updatedAt,
      source: holdersPayload.source,
    };
    if (holdersPayload.meta) {
      responseBody.meta = holdersPayload.meta;
    }
    if (holdersPayload.stale) {
      responseBody.stale = true;
      responseBody.status = 'stale';
    }
    res.json(responseBody);
  } catch (error) {
    sendCachedOrError(res, error);
  }
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

app.use((req, res) => {
  res.status(404).json({ error: 'not_found' });
});

app.listen(PORT, () => {
  console.info(`[Algoland API] Service listening on port ${PORT}`, {
    indexerBase: INDEXER_BASE,
    cacheTtlSeconds: CACHE_TTL_SECONDS,
  });
});
