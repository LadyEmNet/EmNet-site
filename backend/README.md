# Algoland backend API

This directory contains a small Express service that proxies Algorand Indexer queries on behalf of the public Algoland dashboard. It exposes cached endpoints that the static site can call without shipping any credentials or provider URLs to browsers.

## Endpoints

- `GET /api/ping` — health check that reports configuration basics.
- `GET /api/entrants` — total entrant wallets with local state for application `3215540125`.
- `GET /api/algoland/prizes` — weekly badge + draw prize ASA IDs pulled from the Algoland registry contract via the official SDK.
- `GET /api/completions?asset=<assetId>` — unique receivers of positive badge transfers for a given ASA.
- `GET /api/algoland-stats?address=<address>` — fetches decoded campaign progress for a wallet via the Algoland registry contract.

All responses are cached in-memory for five minutes by default. When the upstream Indexer is unavailable the service falls back to the last cached payload and marks it as `stale: true`.

## Verifying weekly draw winners

Use `tools/fetch-weekly-winners.js` to read the Algoland weekly draw contract directly from chain. The helper pulls the draw app id from the registry, decodes each requested `weeklyDrawState` box, and prints the VRF-selected relative ids alongside the associated wallet profiles.

```bash
node tools/fetch-weekly-winners.js --week 1-3
```

The command above reproduces the on-chain week 1–3 winners, including their relative ids, wallet addresses, points, referrals, quest/challenge completions, and prize claim history. Pass multiple `--week` values (repeat the flag, supply a comma list, or use a range) to inspect several draws at once. The script also enumerates the on-chain holders of each prize ASA so you can compare VRF winners with wallets that have already claimed their NFTs.

Add `--json` to emit the same payload as machine-readable JSON (including `prizeAssets` metadata and holder balances), or `--draw`/`--registry` if you need to inspect a different deployment of the contracts.

## Local development

```bash
cd backend
npm install
npm run dev
```

The service listens on `http://localhost:3000` by default. Configure the following environment variables as needed:

- `ALLOWED_ORIGINS` — comma-separated list of origins permitted to access the API. Example: `https://emnetcm.com,https://www.emnetcm.com`.
- `INDEXER_BASE` — Algorand Indexer base URL. Defaults to `https://mainnet-idx.algonode.cloud`.
- `CACHE_TTL_SECONDS` — overrides the default 300 second cache TTL.
- `CHALLENGE_REFRESH_SECONDS` — refresh interval for on-chain challenge prize snapshots (default: 600 seconds).
- `INDEXER_MAX_RETRIES` and `INDEXER_RETRY_BASE_MS` — adjust retry behaviour when the Indexer returns 429 or 5xx responses.

## Deployment on Render

1. Create a new Web Service from this directory.
2. Set the build command to `npm install` and the start command to `npm start`.
3. Configure the environment variables listed above.
4. After deployment succeeds, verify:
   - `/api/ping` responds with service metadata.
   - `/api/entrants` returns the entrants count and timestamp.
  - `/api/completions?asset=3215542831` returns the completions count for week 1.

Remember to update the static site configuration so `/algoland` fetches data from the deployed Render URL.
