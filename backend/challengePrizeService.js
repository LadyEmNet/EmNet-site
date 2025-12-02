import NodeCache from 'node-cache';

import { WEEK_CONFIG } from './config.js';
import { getAllPrizes, getTotalWeeks } from './prizeStore.js';
import { mergePrizeMetadata } from './prizeMetadata.js';

const TOTAL_WEEKS = getTotalWeeks();
const DEFAULT_REFRESH_SECONDS = Number.parseInt(process.env.CHALLENGE_REFRESH_SECONDS || '', 10) || 600;

function toNumericId(value) {
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const truncated = Math.trunc(value);
    return truncated > 0 ? truncated : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function toStringId(value) {
  const numeric = toNumericId(value);
  return numeric ? String(numeric) : null;
}

function toSafeTimestamp(value) {
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function normaliseChallenge(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const week = Number.parseInt(raw.id ?? raw.challengeId, 10);
  if (!Number.isFinite(week) || week < 1) {
    return null;
  }
  const badgeAsa = toStringId(
    raw.completionPrizeAssetId ?? raw.completionBadgeAssetId ?? raw.badgeAssetId,
  );
  const prizeAsa = toStringId(
    raw.drawPrizeAssetId
      ?? (Array.isArray(raw.drawPrizeAssetIds) ? raw.drawPrizeAssetIds[0] : undefined)
      ?? raw.prizeAssetId,
  );

  const weekEntry = {
    week,
    badgeAsa,
    prizeAsa,
  };

  const timeStart = toSafeTimestamp(raw.timeStart ?? raw.startTime);
  if (timeStart !== undefined) {
    weekEntry.timeStart = timeStart;
  }
  const timeEnd = toSafeTimestamp(raw.timeEnd ?? raw.endTime);
  if (timeEnd !== undefined) {
    weekEntry.timeEnd = timeEnd;
  }

  if (badgeAsa || prizeAsa) {
    weekEntry.status = 'configured';
  } else {
    weekEntry.status = 'pending';
  }

  return mergePrizeMetadata(weekEntry);
}

async function buildFallbackWeeks() {
  const legacyPrizes = await getAllPrizes();
  const weeks = [];
  for (let week = 1; week <= TOTAL_WEEKS; week += 1) {
    const badgeAsa = toStringId(WEEK_CONFIG.find((item) => item.week === week)?.assetId);
    const legacyEntry = legacyPrizes.find((item) => item.week === week) || {};
    const prizeAsa = toStringId(legacyEntry.assetId ?? legacyEntry.asa);
    const entry = mergePrizeMetadata({
      week,
      badgeAsa,
      prizeAsa,
      status: prizeAsa || badgeAsa ? 'legacy' : 'pending',
    });
    weeks.push(entry);
  }
  return weeks;
}

function fillMissingWeeks(weeks) {
  const byWeek = new Map(weeks.map((week) => [week.week, week]));
  const mergedWeeks = [];
  for (let week = 1; week <= TOTAL_WEEKS; week += 1) {
    const entry = byWeek.get(week);
    if (entry) {
      mergedWeeks.push(entry);
      continue;
    }
    const badgeAsa = toStringId(WEEK_CONFIG.find((item) => item.week === week)?.assetId);
    mergedWeeks.push(mergePrizeMetadata({ week, badgeAsa, prizeAsa: null, status: 'pending' }));
  }
  return mergedWeeks;
}

export function createChallengePrizeService({ sdk, refreshIntervalSeconds = DEFAULT_REFRESH_SECONDS }) {
  const cache = new NodeCache({
    stdTTL: refreshIntervalSeconds,
    checkperiod: Math.max(Math.floor(refreshIntervalSeconds / 2), 30),
    useClones: false,
  });

  let refreshTimer = null;
  let lastGoodSnapshot = null;

  async function fetchFromChain() {
    const challenges = await sdk.getChallenges();
    const mapped = Array.from(challenges.values())
      .map((challenge) => normaliseChallenge(challenge))
      .filter(Boolean)
      .sort((a, b) => a.week - b.week);
    const weeks = fillMissingWeeks(mapped);
    const snapshot = {
      weeks,
      fetchedAt: new Date().toISOString(),
      source: 'algoland-sdk',
    };
    lastGoodSnapshot = snapshot;
    cache.set('snapshot', snapshot);
    return snapshot;
  }

  async function buildFallbackSnapshot(error) {
    const weeks = await buildFallbackWeeks();
    const snapshot = {
      weeks,
      fetchedAt: new Date().toISOString(),
      source: 'legacy-prizes',
      stale: true,
    };
    if (error) {
      snapshot.error = error.message || String(error);
    }
    lastGoodSnapshot = snapshot;
    cache.set('snapshot', snapshot, refreshIntervalSeconds * 2);
    return snapshot;
  }

  async function getSnapshot() {
    const cached = cache.get('snapshot');
    if (cached) {
      return cached;
    }

    try {
      return await fetchFromChain();
    } catch (error) {
      if (lastGoodSnapshot) {
        return { ...lastGoodSnapshot, stale: true, error: error?.message || 'Unable to refresh challenges' };
      }
      return buildFallbackSnapshot(error);
    }
  }

  async function refreshInBackground() {
    try {
      await fetchFromChain();
    } catch (error) {
      console.warn('[Algoland API] Failed to refresh challenge prizes', { message: error?.message });
    }
  }

  function start() {
    refreshInBackground();
    refreshTimer = setInterval(refreshInBackground, refreshIntervalSeconds * 1000);
    if (typeof refreshTimer.unref === 'function') {
      refreshTimer.unref();
    }
  }

  function stop() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
    }
  }

  return {
    getSnapshot,
    start,
    stop,
  };
}
