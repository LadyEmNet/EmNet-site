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
  const asaLabel = normaliseString(asaRaw);
  if (asaLabel) {
    entry.asa = asaLabel;
    if (/^\d+$/.test(asaLabel)) {
      const parsedAssetId = Number.parseInt(asaLabel, 10);
      if (Number.isFinite(parsedAssetId) && parsedAssetId > 0) {
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

  if (entry.assetId && entry.image) {
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
