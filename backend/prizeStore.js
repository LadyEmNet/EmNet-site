import { readFile, stat } from 'node:fs/promises';

const PRIZES_FILE = new URL('./prizes', import.meta.url);
const TOTAL_WEEKS = 13;

let cachedPrizes = null;
let cachedMtime = 0;

function createDefaultPrize(week) {
  return {
    week,
    asa: 'Coming soon',
    assetId: null,
    image: null,
    status: 'coming-soon',
    mainPrizes: [],
    specialPrizes: [],
    mainAssetIds: [],
  };
}

function normaliseString(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : '';
  }
  return '';
}

function normaliseAssetId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const truncated = Math.trunc(value);
    return truncated > 0 ? truncated : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return null;
}

function normalisePrizeVisualItem(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const assetId = normaliseAssetId(raw.assetId ?? raw.asa ?? raw.id ?? raw.asset);
  const asaLabelSource = raw.asa ?? raw.ASA ?? raw.assetId ?? raw.id ?? raw.asset;
  const asaLabel = normaliseString(asaLabelSource);
  const image = normaliseString(raw.image ?? raw.imageName ?? raw.icon ?? raw.filename);
  const title = normaliseString(raw.title ?? raw.name ?? raw.label ?? raw.description);
  const descriptor = {
    assetId,
    asa: asaLabel || (assetId ? String(assetId) : null),
    image: image || null,
    title: title || null,
  };
  return descriptor;
}

function normalisePrizeVisualArray(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item) => {
      if (typeof item === 'string' || typeof item === 'number') {
        return normalisePrizeVisualItem({ assetId: item });
      }
      return normalisePrizeVisualItem(item);
    })
    .filter((item) => item && (item.assetId !== null || item.image || item.title));
}

function normalisePrizeEntry(rawEntry) {
  if (!rawEntry || typeof rawEntry !== 'object') {
    return null;
  }
  const weekNumber = Number.parseInt(rawEntry.week, 10);
  if (!Number.isFinite(weekNumber) || weekNumber < 1) {
    return null;
  }
  const entry = createDefaultPrize(weekNumber);

  const asaRaw = rawEntry.asa ?? rawEntry.ASA ?? rawEntry.assetId ?? rawEntry.asset ?? rawEntry.id;
  if (Array.isArray(asaRaw)) {
    const asaLabels = asaRaw.map(normaliseString).filter(Boolean);
    if (asaLabels.length > 0) {
      entry.asa = asaLabels.join(' · ');
    }
    const firstAssetId = asaRaw
      .map((value) => normaliseAssetId(value))
      .find((value) => value !== null);
    if (firstAssetId !== null) {
      entry.assetId = firstAssetId;
    }
  } else {
    const asaLabel = normaliseString(asaRaw);
    if (asaLabel) {
      entry.asa = asaLabel;
      const parsedAssetId = normaliseAssetId(asaLabel);
      if (parsedAssetId !== null) {
        entry.assetId = parsedAssetId;
        entry.asa = String(parsedAssetId);
      }
    }
  }

  const imageRaw = rawEntry.image ?? rawEntry.imageName ?? rawEntry.assetImage ?? rawEntry.filename;
  const imageName = normaliseString(imageRaw);
  if (imageName) {
    entry.image = imageName;
  }

  const mainPrizes = normalisePrizeVisualArray(rawEntry.mainPrizes ?? rawEntry.gallery ?? rawEntry.mainPrizeImages);
  if (mainPrizes.length > 0) {
    entry.mainPrizes = mainPrizes;
    entry.mainAssetIds = mainPrizes
      .map((item) => item.assetId)
      .filter((value) => Number.isInteger(value));
    if (!entry.image) {
      const firstImage = mainPrizes.find((item) => item.image);
      if (firstImage) {
        entry.image = firstImage.image;
      }
    }
    if (entry.asa === 'Coming soon') {
      const asaLabels = mainPrizes
        .map((item) => item.asa || (item.assetId ? String(item.assetId) : ''))
        .filter(Boolean);
      if (asaLabels.length > 0) {
        entry.asa = asaLabels.join(' · ');
      }
    }
    if (entry.assetId === null) {
      const firstAssetId = entry.mainAssetIds.find((value) => value !== null);
      if (typeof firstAssetId === 'number') {
        entry.assetId = firstAssetId;
      }
    }
  }

  const specialPrizes = normalisePrizeVisualArray(rawEntry.specialPrizes);
  if (specialPrizes.length > 0) {
    entry.specialPrizes = specialPrizes;
  }

  if (entry.assetId && (entry.image || entry.mainPrizes.length > 0)) {
    entry.status = 'available';
  }

  return entry;
}

async function loadPrizesInternal() {
  let fileStat;
  try {
    fileStat = await stat(PRIZES_FILE);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      const fallback = Array.from({ length: TOTAL_WEEKS }, (_, index) => createDefaultPrize(index + 1));
      cachedPrizes = {
        weeks: fallback,
        byWeek: new Map(fallback.map((item) => [item.week, item])),
      };
      cachedMtime = 0;
      return cachedPrizes;
    }
    throw error;
  }

  if (cachedPrizes && cachedMtime === fileStat.mtimeMs) {
    return cachedPrizes;
  }

  const raw = await readFile(PRIZES_FILE, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('Prize configuration file is not valid JSON.');
  }

  const byWeek = new Map();
  if (Array.isArray(parsed)) {
    parsed.forEach((item) => {
      const entry = normalisePrizeEntry(item);
      if (!entry) {
        return;
      }
      byWeek.set(entry.week, entry);
    });
  }

  const weeks = [];
  for (let week = 1; week <= TOTAL_WEEKS; week += 1) {
    const entry = byWeek.get(week) || createDefaultPrize(week);
    if (!byWeek.has(week)) {
      byWeek.set(week, entry);
    }
    weeks.push(entry);
  }

  cachedPrizes = { weeks, byWeek };
  cachedMtime = fileStat.mtimeMs;
  return cachedPrizes;
}

export async function getAllPrizes() {
  const data = await loadPrizesInternal();
  return data.weeks.map((item) => ({ ...item }));
}

export async function getPrizeForWeek(week) {
  const targetWeek = Number.parseInt(week, 10);
  if (!Number.isFinite(targetWeek) || targetWeek < 1 || targetWeek > TOTAL_WEEKS) {
    return null;
  }
  const data = await loadPrizesInternal();
  const entry = data.byWeek.get(targetWeek);
  if (!entry) {
    return createDefaultPrize(targetWeek);
  }
  return { ...entry };
}

export function getTotalWeeks() {
  return TOTAL_WEEKS;
}
