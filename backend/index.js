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

async function getEntrantsCount() {
  const cacheKey = 'entrants';
  const cached = responseCache.get(cacheKey);
  try {
    const start = performance.now();
    let nextToken;
    let pageCount = 0;
    let totalAccounts = 0;
    do {
      const params = {
        'application-id': APP_ID,
        limit: 1000,
      };
      if (nextToken) {
        params.next = nextToken;
      }
      const page = await indexerRequest('/v2/accounts', params);
      pageCount += 1;
      const accounts = Array.isArray(page.accounts) ? page.accounts : [];
      totalAccounts += accounts.length;
      nextToken = page['next-token'] || null;
    } while (nextToken);
    const durationMs = performance.now() - start;
    const payload = {
      entrants: totalAccounts,
      updatedAt: new Date().toISOString(),
      source: INDEXER_BASE,
      meta: { pageCount, durationMs },
    };
    responseCache.set(cacheKey, payload);
    console.info('[Algoland API] Entrants computed', {
      entrants: totalAccounts,
      pageCount,
      durationMs,
    });
    return payload;
  } catch (error) {
    if (cached) {
      console.warn('[Algoland API] Entrants falling back to cache', {
        message: error.message,
      });
      return { ...cached, stale: true };
    }
    throw error;
  }
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
  ].filter(Boolean));
  const metadata = {
    decimals: Number.parseInt(params.decimals, 10) || 0,
    adminAddresses,
  };
  assetMetadataCache.set(cacheKey, metadata, 24 * 60 * 60);
  return metadata;
}

function normaliseAmount(amount, decimals) {
  if (!Number.isFinite(amount)) {
    return 0;
  }
  if (!Number.isFinite(decimals) || decimals <= 0) {
    return amount;
  }
  const divisor = 10 ** decimals;
  return amount / divisor;
}

async function getCompletionsForAsset(assetId) {
  const cacheKey = `completions:${assetId}`;
  const cached = responseCache.get(cacheKey);
  try {
    const allowlist = new Set(getAllowlistForAsset(assetId));
    const { decimals, adminAddresses } = await getAssetMetadata(assetId);
    const receivers = new Set();
    let nextToken;
    let pageCount = 0;
    const start = performance.now();
    do {
      const params = {
        limit: 1000,
        'tx-type': 'axfer',
      };
      if (nextToken) {
        params.next = nextToken;
      }
      const data = await indexerRequest(`/v2/assets/${assetId}/transactions`, params);
      pageCount += 1;
      const transactions = Array.isArray(data.transactions) ? data.transactions : [];
      transactions.forEach((txn) => {
        const transfer = txn['asset-transfer-transaction'];
        if (!transfer) {
          return;
        }
        const rawAmount = Number(transfer.amount) || 0;
        const amount = normaliseAmount(rawAmount, decimals);
        if (amount <= 0) {
          return;
        }
        const txnSender = txn.sender;
        const assetSender = transfer.sender || txnSender;
        if (!allowlist.has(txnSender) && !allowlist.has(assetSender)) {
          return;
        }
        const receiver = transfer.receiver;
        if (!receiver || adminAddresses.has(receiver)) {
          return;
        }
        receivers.add(receiver);
      });
      nextToken = data['next-token'] || null;
    } while (nextToken);
    const durationMs = performance.now() - start;
    const payload = {
      assetId: Number.parseInt(assetId, 10),
      completions: receivers.size,
      updatedAt: new Date().toISOString(),
      source: INDEXER_BASE,
      meta: { pageCount, durationMs },
    };
    responseCache.set(cacheKey, payload);
    console.info('[Algoland API] Completions computed', {
      assetId,
      completions: receivers.size,
      pageCount,
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
