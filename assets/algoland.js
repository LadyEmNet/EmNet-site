(function () {
  const root = document.querySelector('[data-algoland-root]');
  if (!root || typeof window.fetch !== 'function') {
    return;
  }

  const APP_ID = 3215540125;
  const CAMPAIGN_NAME = 'Algoland retail campaign';
  const KNOWN_ORGANISER_PREFIX = 'LANDBACKOF354GJUI4HMC6G2G3EGHEXDUZ4YEDDTJSSTIAZ3X4M5TLX3BI';
  const DEFAULT_DISTRIBUTOR = 'HHADCZKQV24QDCBER5GTOH7BOLF4ZQ6WICNHAA3GZUECIMJXIIMYBIWEZM';
  const SNAPSHOT_KEY = 'emnet.algoland.snapshot.v1';
  const CACHE_MS = 10 * 60 * 1000;
  const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
  const MAX_RETRIES = 4;
  const RETRY_BASE_DELAY_MS = 600;
  const providerBase = root.dataset.indexerProvider || window.EMNET_INDEXER_PROVIDER || 'https://mainnet-idx.algonode.cloud';
  const numberFormatter = new Intl.NumberFormat('en-GB');
  const percentFormatter = new Intl.NumberFormat('en-GB', {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const weeksConfig = [
    { week: 1, assetId: '3215542831', distributors: [DEFAULT_DISTRIBUTOR] },
    { week: 2, assetId: '3215542840', distributors: [DEFAULT_DISTRIBUTOR] },
    { week: 3, assetId: '', distributors: [DEFAULT_DISTRIBUTOR] },
    { week: 4, assetId: '', distributors: [DEFAULT_DISTRIBUTOR] },
    { week: 5, assetId: '', distributors: [DEFAULT_DISTRIBUTOR] },
    { week: 6, assetId: '', distributors: [DEFAULT_DISTRIBUTOR] },
    { week: 7, assetId: '', distributors: [DEFAULT_DISTRIBUTOR] },
    { week: 8, assetId: '', distributors: [DEFAULT_DISTRIBUTOR] },
    { week: 9, assetId: '', distributors: [DEFAULT_DISTRIBUTOR] },
    { week: 10, assetId: '', distributors: [DEFAULT_DISTRIBUTOR] },
    { week: 11, assetId: '', distributors: [DEFAULT_DISTRIBUTOR] },
    { week: 12, assetId: '', distributors: [DEFAULT_DISTRIBUTOR] },
    { week: 13, assetId: '', distributors: [DEFAULT_DISTRIBUTOR] },
  ];

  const summaryElements = {
    entrants: root.querySelector('[data-summary="entrants"]'),
    week1: root.querySelector('[data-summary="week-1"]'),
    week2: root.querySelector('[data-summary="week-2"]'),
    overall: root.querySelector('[data-summary="overall"]'),
  };
  const alertsContainer = root.querySelector('[data-algoland-alerts]');
  const table = root.querySelector('[data-algoland-table]');
  const updatedElement = root.querySelector('[data-algoland-updated]');
  const appExplorerUrl = `https://allo.info/application/${APP_ID}`;

  let lastSnapshot = loadSnapshot();
  let isRefreshing = false;

  console.info('[Algoland] Initialised Algoland dashboard', { provider: providerBase });

  initialiseStaticTable();

  if (lastSnapshot) {
    renderSnapshot(lastSnapshot, { fromCache: true, warnings: [] });
  }

  refreshData({ reason: 'initial load' });
  window.setInterval(() => {
    refreshData({ reason: 'scheduled interval' });
  }, REFRESH_INTERVAL_MS);

  function initialiseStaticTable() {
    if (!table) {
      return;
    }

    weeksConfig.forEach((config) => {
      const row = table.querySelector(`tr[data-week="${config.week}"]`);
      if (!row) {
        return;
      }

      const badgeCell = row.querySelector('[data-col="badge"]');
      if (badgeCell) {
        if (config.assetId) {
          badgeCell.textContent = config.assetId;
          badgeCell.classList.remove('na-value');
        } else {
          badgeCell.textContent = 'Coming soon';
          badgeCell.classList.add('na-value');
        }
      }

      const distributorCell = row.querySelector('[data-col="distributor"]');
      if (distributorCell) {
        distributorCell.textContent = '';
        config.distributors.forEach((address) => {
          const pill = document.createElement('span');
          pill.className = 'address-pill';
          pill.textContent = shortenAddress(address);
          pill.title = address;
          distributorCell.appendChild(pill);
        });
      }

      const linksCell = row.querySelector('[data-col="links"]');
      if (linksCell) {
        linksCell.textContent = '';
        linksCell.appendChild(createExplorerLink(appExplorerUrl, 'App'));
        if (config.assetId) {
          linksCell.appendChild(createExplorerLink(`https://allo.info/asset/${config.assetId}`, 'Badge'));
        }
        config.distributors.forEach((address, index) => {
          const label = config.distributors.length > 1 ? `Distributor ${index + 1}` : 'Distributor';
          linksCell.appendChild(createExplorerLink(`https://allo.info/address/${address}`, label));
        });
      }

      const completedCell = row.querySelector('[data-col="completed"]');
      const conversionCell = row.querySelector('[data-col="conversion"]');
      if (!config.assetId) {
        if (completedCell) {
          completedCell.textContent = 'N/A';
          completedCell.classList.add('na-value');
        }
        if (conversionCell) {
          conversionCell.textContent = 'N/A';
          conversionCell.classList.add('na-value');
        }
      }
    });
  }

  function shortenAddress(address) {
    if (!address || typeof address !== 'string') {
      return '';
    }
    if (address.length <= 12) {
      return address;
    }
    return `${address.slice(0, 6)}…${address.slice(-6)}`;
  }

  function createExplorerLink(href, label) {
    const link = document.createElement('a');
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = label;
    return link;
  }

  async function refreshData({ reason } = {}) {
    if (isRefreshing) {
      return;
    }

    isRefreshing = true;
    if (updatedElement) {
      updatedElement.textContent = 'Refreshing data…';
    }

    const fetchStart = performance.now();
    const warnings = [];
    let allowlistLog = Array.isArray(lastSnapshot && lastSnapshot.allowlistLog) ? [...lastSnapshot.allowlistLog] : [];

    try {
      const entrantsResult = await fetchEntrants();
      const weekResults = [];

      for (const config of weeksConfig) {
        const weekStart = performance.now();
        const result = await fetchWeekResult(config, entrantsResult, allowlistLog);
        result.durationMs = performance.now() - weekStart;
        console.info('[Algoland] Week fetch complete', {
          week: config.week,
          durationMs: result.durationMs,
          completed: result.completedCount,
        });
        weekResults.push(result);
        if (Array.isArray(result.noticeMessages)) {
          result.noticeMessages.forEach((message) => {
            warnings.push({ type: message.type || 'warning', text: `Week ${config.week}: ${message.text}` });
          });
        }
      }

      const entrantsCount = entrantsResult.addresses.size;
      const previousEntrants = lastSnapshot && typeof lastSnapshot.entrants?.count === 'number' ? lastSnapshot.entrants.count : null;
      if (previousEntrants && entrantsCount < previousEntrants * 0.9) {
        warnings.push({
          type: 'warning',
          text: `Entrants count dropped from ${numberFormatter.format(previousEntrants)} to ${numberFormatter.format(entrantsCount)}. This may indicate indexer lag.`,
        });
      }

      const snapshot = {
        timestamp: new Date().toISOString(),
        provider: providerBase,
        campaign: CAMPAIGN_NAME,
        entrants: {
          count: entrantsCount,
          addresses: Array.from(entrantsResult.addresses),
        },
        weeks: weekResults.map((week) => ({
          week: week.week,
          assetId: week.assetId,
          distributors: week.distributors,
          completedCount: week.completedCount,
          completedAddresses: Array.from(week.completedAddresses),
          conversion: week.conversion,
          decimals: week.decimals,
          warnings: week.warnings,
          syncing: week.syncing,
          verificationSample: week.verificationSample,
          allowlistEmpty: week.allowlistEmpty,
          adminAddresses: Array.from(week.adminAddresses),
          durationMs: week.durationMs,
          allowlistSuggestions: week.allowlistSuggestions,
          comingSoon: week.comingSoon,
        })),
        durations: {
          entrantsMs: entrantsResult.durationMs,
          totalMs: performance.now() - fetchStart,
        },
        providerUsed: providerBase,
        cacheExpiresAt: Date.now() + CACHE_MS,
        allowlistLog: trimAllowlistLog(allowlistLog),
      };

      persistSnapshot(snapshot);
      lastSnapshot = snapshot;
      renderSnapshot(snapshot, { fromCache: false, warnings });
      console.info('[Algoland] Refresh complete', {
        entrants: entrantsCount,
        totalDurationMs: snapshot.durations.totalMs,
        reason,
      });
    } catch (error) {
      console.error('[Algoland] Refresh failed', error);
      const cacheSnapshot = lastSnapshot || loadSnapshot();
      const cacheWarnings = [{
        type: 'warning',
        text: `Live refresh failed: ${error.message}. Displaying cached results where available.`,
      }];
      if (cacheSnapshot) {
        renderSnapshot(cacheSnapshot, { fromCache: true, warnings: cacheWarnings, cacheNotice: true });
      } else {
        renderAlerts(cacheWarnings);
      }
    } finally {
      isRefreshing = false;
    }
  }

  async function fetchEntrants() {
    const entrants = new Set();
    let nextToken = null;
    const start = performance.now();

    while (true) {
      const query = new URL(`/v2/applications/${APP_ID}/accounts`, providerBase);
      query.searchParams.set('limit', '1000');
      if (nextToken) {
        query.searchParams.set('next', nextToken);
      }
      const response = await fetchWithRetry(query);
      const accounts = Array.isArray(response.accounts) ? response.accounts : [];
      accounts.forEach((account) => {
        if (account && account.address) {
          entrants.add(account.address);
        }
      });
      nextToken = response['next-token'];
      if (!nextToken) {
        break;
      }
    }

    const durationMs = performance.now() - start;
    console.info(`[Algoland] Entrants fetched: ${entrants.size} wallets in ${durationMs.toFixed(0)}ms`);
    return { addresses: entrants, durationMs };
  }

  async function fetchWeekResult(config, entrantsResult, allowlistLog) {
    const result = {
      week: config.week,
      assetId: config.assetId,
      distributors: [...config.distributors],
      completedAddresses: new Set(),
      completedCount: 0,
      conversion: null,
      decimals: 0,
      warnings: [],
      noticeMessages: [],
      syncing: false,
      allowlistEmpty: config.distributors.length === 0,
      adminAddresses: new Set(),
      allowlistSuggestions: [],
      verificationSample: { checked: [], mismatches: [] },
    };

    result.comingSoon = !config.assetId;

    if (!config.assetId) {
      result.conversion = null;
      return result;
    }

    if (result.allowlistEmpty) {
      result.warnings.push('Distributor allowlist is empty. Completed counts disabled.');
      return result;
    }

    const assetDetails = await fetchAssetDetails(config.assetId);
    result.decimals = assetDetails.decimals;
    result.adminAddresses = assetDetails.adminAddresses;

    if (assetDetails.decimals !== 0) {
      result.warnings.push(`Asset decimals is ${assetDetails.decimals}. Amounts will be normalised.`);
    }

    const allowlist = new Set(config.distributors);
    const adminSet = assetDetails.adminAddresses;
    let nextToken = null;

    while (true) {
      const query = new URL(`/v2/assets/${config.assetId}/transactions`, providerBase);
      query.searchParams.set('tx-type', 'axfer');
      query.searchParams.set('limit', '1000');
      if (nextToken) {
        query.searchParams.set('next', nextToken);
      }

      const response = await fetchWithRetry(query);
      const transactions = Array.isArray(response.transactions) ? response.transactions : [];

      transactions.forEach((transaction) => {
        const transfer = transaction && transaction['asset-transfer-transaction'];
        if (!transfer || typeof transfer.amount !== 'number') {
          return;
        }

        const amount = transfer.amount;
        if (amount <= 0) {
          return;
        }

        const senderAddress = transfer.sender || transaction.sender;
        const feePayer = transaction.sender;
        const isDistributor = allowlist.has(senderAddress) || allowlist.has(feePayer);

        if (!isDistributor) {
          if (senderAddress && senderAddress.startsWith(KNOWN_ORGANISER_PREFIX)) {
            if (!allowlistLog.some((entry) => entry.week === config.week && entry.address === senderAddress)) {
              const logEntry = { week: config.week, address: senderAddress, notedAt: new Date().toISOString() };
              allowlistLog.push(logEntry);
              result.allowlistSuggestions.push(logEntry);
              console.info('[Algoland] Observed organiser-prefixed sender outside allowlist', {
                week: config.week,
                sender: senderAddress,
              });
              result.noticeMessages.push({
                type: 'info',
                text: `Observed organiser-prefixed sender ${shortenAddress(senderAddress)} not on allowlist. Review required before inclusion.`,
              });
            }
          }
          return;
        }

        const receiver = transfer.receiver;
        if (!receiver || adminSet.has(receiver)) {
          return;
        }

        result.completedAddresses.add(receiver);
      });

      nextToken = response['next-token'];
      if (!nextToken) {
        break;
      }
    }

    result.completedCount = result.completedAddresses.size;
    if (entrantsResult.addresses.size > 0) {
      result.conversion = result.completedCount / entrantsResult.addresses.size;
    }

    if (result.completedCount > 0) {
      const verification = await verifyBalances(config.assetId, result.decimals, Array.from(result.completedAddresses));
      result.verificationSample = verification;
      if (verification.mismatches.length > 0) {
        result.syncing = true;
        result.warnings.push(`Indexer still syncing balances for ${verification.mismatches.length} sampled wallet(s).`);
      }
    }

    console.info('[Algoland] Week summary', {
      week: config.week,
      assetId: config.assetId || null,
      completed: result.completedCount,
      conversion: result.conversion,
    });

    return result;
  }

  async function fetchAssetDetails(assetId) {
    const response = await fetchWithRetry(new URL(`/v2/assets/${assetId}`, providerBase));
    const asset = response.asset || {};
    const params = asset.params || {};
    const decimals = typeof params.decimals === 'number' ? params.decimals : 0;
    const adminAddresses = new Set();
    ['creator', 'manager', 'reserve', 'clawback'].forEach((key) => {
      if (asset[key]) {
        adminAddresses.add(asset[key]);
      }
      if (params[key]) {
        adminAddresses.add(params[key]);
      }
    });
    return { decimals, adminAddresses };
  }

  async function verifyBalances(assetId, decimals, addresses) {
    const pool = [...addresses];
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = pool[i];
      pool[i] = pool[j];
      pool[j] = temp;
    }
    const sample = pool.slice(0, Math.min(3, pool.length));
    const mismatches = [];
    const threshold = decimals > 0 ? Math.pow(10, decimals) : 1;

    for (const address of sample) {
      try {
        const response = await fetchWithRetry(new URL(`/v2/accounts/${address}`, providerBase));
        const account = response.account || {};
        const assets = Array.isArray(account.assets) ? account.assets : [];
        const holding = assets.find((entry) => String(entry['asset-id']) === String(assetId));
        const amount = holding ? Number(holding.amount) : 0;
        if (!holding || Number.isNaN(amount) || amount < threshold) {
          mismatches.push(address);
        }
      } catch (error) {
        mismatches.push(address);
      }
    }

    return { checked: sample, mismatches };
  }

  async function fetchWithRetry(url, attempt = 0) {
    const requestUrl = typeof url === 'string' ? url : url.toString();
    const started = performance.now();

    try {
      const response = await fetch(requestUrl, {
        headers: { Accept: 'application/json' },
        mode: 'cors',
      });

      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt + 1 < MAX_RETRIES) {
          const delayMs = Math.pow(2, attempt) * RETRY_BASE_DELAY_MS;
          await delay(delayMs);
          return fetchWithRetry(url, attempt + 1);
        }

        throw new Error(`Indexer request failed with status ${response.status}`);
      }

      const json = await response.json();
      const duration = performance.now() - started;
      console.info(`[Algoland] ${requestUrl} completed in ${duration.toFixed(0)}ms`);
      return json;
    } catch (error) {
      if (attempt + 1 < MAX_RETRIES) {
        const delayMs = Math.pow(2, attempt) * RETRY_BASE_DELAY_MS;
        await delay(delayMs);
        return fetchWithRetry(url, attempt + 1);
      }
      throw error;
    }
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function persistSnapshot(snapshot) {
    try {
      window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
    } catch (error) {
      console.warn('[Algoland] Unable to persist snapshot', error);
    }
  }

  function loadSnapshot() {
    try {
      const raw = window.localStorage.getItem(SNAPSHOT_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.timestamp) {
        return null;
      }
      return parsed;
    } catch (error) {
      console.warn('[Algoland] Unable to load snapshot', error);
      return null;
    }
  }

  function trimAllowlistLog(log) {
    if (!Array.isArray(log)) {
      return [];
    }
    const unique = [];
    log.forEach((entry) => {
      if (!entry || typeof entry !== 'object') {
        return;
      }
      const exists = unique.some((item) => item.week === entry.week && item.address === entry.address);
      if (!exists) {
        unique.push(entry);
      }
    });
    return unique.slice(-50);
  }

  function renderSnapshot(snapshot, { fromCache, warnings, cacheNotice } = {}) {
    if (!snapshot || !table) {
      return;
    }

    const entrantsCount = typeof snapshot.entrants?.count === 'number' ? snapshot.entrants.count : 0;
    setSummaryValue(summaryElements.entrants, entrantsCount);

    const week1 = snapshot.weeks.find((week) => week.week === 1);
    const week2 = snapshot.weeks.find((week) => week.week === 2);
    setSummaryValue(summaryElements.week1, week1 && typeof week1.completedCount === 'number' ? week1.completedCount : null);
    setSummaryValue(summaryElements.week2, week2 && typeof week2.completedCount === 'number' ? week2.completedCount : null);

    const overallCompleted = snapshot.weeks.reduce((total, week) => {
      if (!week || week.comingSoon || week.allowlistEmpty || typeof week.completedCount !== 'number') {
        return total;
      }
      return total + week.completedCount;
    }, 0);
    setSummaryValue(summaryElements.overall, overallCompleted);

    snapshot.weeks.forEach((week) => {
      const row = table.querySelector(`tr[data-week="${week.week}"]`);
      if (!row) {
        return;
      }

      const entrantsCell = row.querySelector('[data-col="entrants"]');
      if (entrantsCell) {
        entrantsCell.textContent = numberFormatter.format(entrantsCount);
      }

      const completedCell = row.querySelector('[data-col="completed"]');
      const conversionCell = row.querySelector('[data-col="conversion"]');

      if (!week.assetId) {
        if (completedCell) {
          completedCell.textContent = 'N/A';
          completedCell.classList.add('na-value');
        }
        if (conversionCell) {
          conversionCell.textContent = 'N/A';
          conversionCell.classList.add('na-value');
        }
        row.classList.remove('is-syncing');
        return;
      }

      const note = completedCell ? completedCell.querySelector('.status-note') : null;
      if (note) {
        note.remove();
      }

      if (completedCell) {
        if (week.allowlistEmpty || typeof week.completedCount !== 'number') {
          completedCell.textContent = 'N/A';
          completedCell.classList.add('na-value');
        } else {
          completedCell.textContent = numberFormatter.format(week.completedCount);
          completedCell.classList.remove('na-value');
        }
      }

      if (conversionCell) {
        if (week.allowlistEmpty || typeof week.conversion !== 'number') {
          conversionCell.textContent = 'N/A';
          conversionCell.classList.add('na-value');
        } else {
          conversionCell.textContent = percentFormatter.format(week.conversion);
          conversionCell.classList.remove('na-value');
        }
      }

      if (completedCell && week.warnings && week.warnings.length > 0) {
        const statusNote = document.createElement('div');
        statusNote.className = 'status-note';
        statusNote.textContent = week.warnings[0];
        completedCell.appendChild(statusNote);
      }

      row.classList.toggle('is-syncing', Boolean(week.syncing));
    });

    if (updatedElement) {
      const timestamp = snapshot.timestamp ? new Date(snapshot.timestamp) : new Date();
      const parts = [
        `Last updated ${timestamp.toLocaleString()}`,
        `Provider: ${snapshot.provider || snapshot.providerUsed || providerBase}`,
      ];
      if (fromCache) {
        parts.push('served from cache');
      }
      updatedElement.textContent = parts.join(' • ');
    }

    const alertMessages = Array.isArray(warnings) ? [...warnings] : [];
    const timestampValue = snapshot.timestamp ? Date.parse(snapshot.timestamp) : NaN;
    if (!Number.isNaN(timestampValue)) {
      const ageMs = Date.now() - timestampValue;
      if (ageMs > CACHE_MS) {
        alertMessages.push({
          type: 'warning',
          text: 'Snapshot age exceeds 10 minutes. Counts may not include the most recent activity.',
        });
      }
    }
    snapshot.weeks.forEach((week) => {
      if (Array.isArray(week.warnings)) {
        week.warnings.forEach((warning) => {
          alertMessages.push({ type: 'warning', text: `Week ${week.week}: ${warning}` });
        });
      }
      if (Array.isArray(week.allowlistSuggestions) && week.allowlistSuggestions.length > 0) {
        week.allowlistSuggestions.forEach((entry) => {
          alertMessages.push({
            type: 'info',
            text: `Week ${week.week}: Observed organiser sender ${shortenAddress(entry.address)} awaiting verification.`,
          });
        });
      }
    });

    if (cacheNotice) {
      alertMessages.push({ type: 'info', text: 'Cached results remain valid for 10 minutes. Live refresh will retry automatically.' });
    }

    renderAlerts(alertMessages);
  }

  function setSummaryValue(element, value) {
    if (!element) {
      return;
    }
    if (typeof value === 'number') {
      element.textContent = numberFormatter.format(value);
    } else {
      element.textContent = '—';
    }
  }

  function renderAlerts(messages) {
    if (!alertsContainer) {
      return;
    }

    alertsContainer.innerHTML = '';

    const filtered = Array.isArray(messages)
      ? messages.filter((message) => message && typeof message.text === 'string' && message.text.trim().length > 0)
      : [];

    if (filtered.length === 0) {
      alertsContainer.hidden = true;
      return;
    }

    alertsContainer.hidden = false;

    filtered.forEach((message) => {
      const alert = document.createElement('div');
      alert.className = 'algoland-alert';
      if (message.type === 'info') {
        alert.classList.add('algoland-alert--info');
      }
      alert.textContent = message.text;
      alertsContainer.appendChild(alert);
    });
  }
})();
