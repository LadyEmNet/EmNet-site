const RAW_APP_ID = process.env.ALGOLAND_APP_ID || '3215540125';
const PARSED_APP_ID = Number.parseInt(RAW_APP_ID, 10);
export const APP_ID = Number.isFinite(PARSED_APP_ID) ? PARSED_APP_ID : 3215540125;

export const WEEK_CONFIG = [
  { week: 1, assetId: 3215542832 },
  { week: 2, assetId: 3215542840 },
  { week: 3, assetId: null },
  { week: 4, assetId: null },
  { week: 5, assetId: null },
  { week: 6, assetId: null },
  { week: 7, assetId: null },
  { week: 8, assetId: null },
  { week: 9, assetId: null },
  { week: 10, assetId: null },
  { week: 11, assetId: null },
  { week: 12, assetId: null },
  { week: 13, assetId: null },
];

const DEFAULT_DISTRIBUTOR = 'HHADCZKQV24QDCBER5GTOH7BOLF4ZQ6WICNHAA3GZUECIMJXIIMYBIWEZM';

export const DISTRIBUTOR_ALLOWLIST = {
  default: [DEFAULT_DISTRIBUTOR],
  byAsset: {
    3215542832: [DEFAULT_DISTRIBUTOR],
    3215542840: [DEFAULT_DISTRIBUTOR],
  },
};

export function getAllowlistForAsset(assetId) {
  if (!assetId) {
    return DISTRIBUTOR_ALLOWLIST.default;
  }
  const key = String(assetId);
  const list = DISTRIBUTOR_ALLOWLIST.byAsset[key];
  if (Array.isArray(list) && list.length > 0) {
    return list;
  }
  return DISTRIBUTOR_ALLOWLIST.default;
}
