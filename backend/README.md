# Algoland backend API

This directory contains a small Express service that proxies Algorand Indexer queries and the Lands Inspector API on behalf of the public Algoland dashboard. It exposes cached endpoints that the static site can call without shipping any credentials or provider URLs to browsers.

## Endpoints

- `GET /api/ping` — health check that reports configuration basics.
- `GET /api/entrants` — total entrant wallets with local state for application `3215540125`.
- `GET /api/completions?asset=<assetId>` — unique receivers of positive badge transfers for a given ASA.
- `GET /api/algoland-stats?address=<address>` — fetches decoded campaign progress for a wallet by forwarding the request to the Lands Inspector API.

All responses are cached in-memory for five minutes by default. When the upstream Indexer is unavailable the service falls back to the last cached payload and marks it as `stale: true`.

## Local development

```bash
cd backend
npm install
npm run dev
```

The service listens on `http://localhost:3000` by default. Configure the following environment variables as needed:

- `ALLOWED_ORIGINS` — comma-separated list of origins permitted to access the API. Example: `https://emnetcm.com,https://www.emnetcm.com`.
- `INDEXER_BASE` — Algorand Indexer base URL. Defaults to `https://mainnet-idx.algonode.cloud`.
- `LANDS_INSPECTOR_BASE` — Lands Inspector base URL. Defaults to `https://landsinspector.pages.dev`.
- `CACHE_TTL_SECONDS` — overrides the default 300 second cache TTL.
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
