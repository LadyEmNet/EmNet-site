const PRIZE_METADATA = new Map([
  ['3215542832', { image: 'Prize1.png' }],
  ['3215542841', { image: 'Prize2.png' }],
  ['3215542837', { image: 'Prize3.png' }],
  ['3257999518', { image: 'Prize4.png' }],
  ['3257999523', { image: 'Prize5.png' }],
  ['3257999514', { image: 'Prize6.png', title: 'MS Pacman Game' }],
  ['3257999513', { image: 'Prize7.png', title: 'Creality 3D Printer' }],
  ['3257999515', { image: 'secretprize.png', title: 'Secret prize' }],
  ['3300006144', { image: 'Prize8.png' }],
  ['3311114042', { image: 'Prize9.PNG' }],
  ['3323502873', {
    image: 'week9.png',
    title:
      'Week 9 Algoland VRF prize minted by HHADCZKQV24QDCBER5GTOH7BOLF4ZQ6WICNHAA3GZUECIMJXIIMYBIWEZM',
  }],
  ['3311114119', { image: 'Prize10.png' }],
  ['3341903705', { image: 'Prize11.png' }],
]);

function normaliseAssetId(value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const truncated = Math.trunc(value);
    return truncated > 0 ? String(truncated) : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

export function getPrizeMetadata(assetId) {
  const normalised = normaliseAssetId(assetId);
  if (!normalised) {
    return null;
  }
  const entry = PRIZE_METADATA.get(normalised);
  if (!entry) {
    return null;
  }
  return {
    assetId: normalised,
    title: entry.title || null,
    image: entry.image || null,
  };
}

export function mergePrizeMetadata(weekEntry) {
  const entry = { ...weekEntry };
  if (entry.badgeAsa) {
    const badgeMetadata = getPrizeMetadata(entry.badgeAsa);
    if (badgeMetadata) {
      entry.badgeMetadata = badgeMetadata;
    }
  }
  if (entry.prizeAsa) {
    const prizeMetadata = getPrizeMetadata(entry.prizeAsa);
    if (prizeMetadata) {
      entry.prizeMetadata = prizeMetadata;
    }
  }
  return entry;
}
