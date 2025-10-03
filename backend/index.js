import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import NodeCache from 'node-cache';
import { performance } from 'node:perf_hooks';

import { APP_ID, DISTRIBUTOR_ALLOWLIST, WEEK_CONFIG, getAllowlistForAsset } from './config.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const RAW_ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'https://emnetcm.com,https://www.emnetcm.com';
const INDEXER_BASE = (process.env.INDEXER_BASE || 'https://mainnet-idx.algonode.cloud').replace(/\/+$/, '');
const CACHE_TTL_SECONDS = Number.parseInt(process.env.CACHE_TTL_SECONDS || '', 10) || 300;
const MAX_RETRIES = Number.parseInt(process.env.INDEXER_MAX_RETRIES || '', 10) || 5;
const RETRY_BASE_DELAY_MS = Number.parseInt(process.env.INDEXER_RETRY_BASE_MS || '', 10) || 500;

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

const assetMetadataCache = new NodeCache({
  stdTTL: 6 * 60 * 60,
  checkperiod: 60 * 60,
  useClones: false,
});

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
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') {
      return;
    }
    url.searchParams.set(key, value);
  });

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

async function getCompletionsForAsset(assetId) {
  const cacheKey = `completions:${assetId}`;
  const cached = responseCache.get(cacheKey);
  try {
    const start = performance.now();
    const holders = new Set();
    const {
      adminAddresses,
    } = await getAssetMetadata(assetId);

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
    const payload = {
      assetId: Number.parseInt(assetId, 10),
      completions: holders.size,
      updatedAt: new Date().toISOString(),
      source: INDEXER_BASE,
      meta: {
        durationMs,
        pageCount,
        scannedBalances: accountCount,
        uniqueHolders: holders.size,
      },
    };
    responseCache.set(cacheKey, payload);
    console.info('[Algoland API] Completions computed', {
      assetId,
      completions: holders.size,
      pageCount,
      scannedBalances: accountCount,
      durationMs,
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
