(function () {
  const root = document.querySelector('[data-algoland-root]');
  if (!root || typeof window.fetch !== 'function') {
    return;
  }

  const API_BASE = normaliseBase(root.dataset.apiBase || window.EMNET_ALGOLAND_API_BASE || '');
  const SNAPSHOT_KEY = 'emnet.algoland.snapshot.v2';
  const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
  const DEFAULT_DISTRIBUTOR = 'HHADCZKQV24QDCBER5GTOH7BOLF4ZQ6WICNHAA3GZUECIMJXIIMYBIWEZM';
  const APP_ID = 3215540125;

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

  const numberFormatter = new Intl.NumberFormat('en-GB');
  const percentFormatter = new Intl.NumberFormat('en-GB', {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const summaryElements = {
    entrants: root.querySelector('[data-summary="entrants"]'),
    week1: root.querySelector('[data-summary="week-1"]'),
    week2: root.querySelector('[data-summary="week-2"]'),
    overall: root.querySelector('[data-summary="overall"]'),
  };
  const alertsContainer = root.querySelector('[data-algoland-alerts]');
  const table = root.querySelector('[data-algoland-table]');
  const updatedElement = root.querySelector('[data-algoland-updated]');

  const state = {
    snapshot: loadSnapshot(),
    isRefreshing: false,
  };

  console.info('[Algoland] Initialised Algoland dashboard', { apiBase: API_BASE || 'relative' });

  initialiseStaticTable();

  if (state.snapshot) {
    renderSnapshot(state.snapshot, { fromCache: true, alerts: [] });
  }

  refreshData('initial load');
  window.setInterval(() => {
    refreshData('scheduled interval');
  }, REFRESH_INTERVAL_MS);

  function normaliseBase(base) {
    if (typeof base !== 'string' || base.length === 0) {
      return '';
    }
    return base.replace(/\/+$/, '');
  }

  function buildApiUrl(path) {
    const trimmedPath = path.startsWith('/') ? path : `/${path}`;
    if (!API_BASE) {
      return trimmedPath;
    }
    return `${API_BASE}${trimmedPath}`;
  }

  function initialiseStaticTable() {
    if (!table) {
      return;
    }
    const appExplorerUrl = `https://allo.info/application/${APP_ID}`;
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
      if (!config.assetId) {
        const completedCell = row.querySelector('[data-col="completed"]');
        const conversionCell = row.querySelector('[data-col="conversion"]');
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

  function loadSnapshot() {
    try {
      const raw = window.localStorage.getItem(SNAPSHOT_KEY);
      if (!raw) {
        return null;
      }
      return JSON.parse(raw);
    } catch (error) {
      console.warn('[Algoland] Failed to read cached snapshot', error);
      return null;
    }
  }

  function saveSnapshot(snapshot) {
    try {
      window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
    } catch (error) {
      console.warn('[Algoland] Failed to persist snapshot', error);
    }
  }

  function createBaseSnapshot(previousSnapshot) {
    const previous = previousSnapshot || {};
    const entrants = previous.entrants || { count: null, updatedAt: null, stale: false, source: null };
    const weeks = weeksConfig.map((config) => {
      const existing = Array.isArray(previous.weeks)
        ? previous.weeks.find((week) => week.week === config.week)
        : null;
      return {
        week: config.week,
        assetId: config.assetId || null,
        status: config.assetId ? 'live' : 'coming-soon',
        completions: existing && typeof existing.completions === 'number' ? existing.completions : null,
        updatedAt: existing ? existing.updatedAt || null : null,
        stale: Boolean(existing && existing.stale),
        source: existing ? existing.source || null : null,
        unavailable: existing ? Boolean(existing.unavailable) : false,
      };
    });
    return {
      timestamp: new Date().toISOString(),
      entrants,
      weeks,
    };
  }

  async function refreshData(reason) {
    if (state.isRefreshing) {
      return;
    }
    state.isRefreshing = true;
    console.info('[Algoland] Refreshing data', { reason });
    if (updatedElement) {
      updatedElement.textContent = 'Refreshing data…';
    }

    const nextSnapshot = createBaseSnapshot(state.snapshot);
    const alerts = [];

    try {
      const entrantsResult = await fetchEntrants();
      if (entrantsResult) {
        nextSnapshot.entrants = {
          count: entrantsResult.entrants,
          updatedAt: entrantsResult.updatedAt,
          source: entrantsResult.source || null,
          stale: Boolean(entrantsResult.stale),
        };
        if (entrantsResult.stale) {
          alerts.push({ type: 'warning', text: 'Entrant totals are stale until the indexer recovers.' });
        }
      } else if (!nextSnapshot.entrants || nextSnapshot.entrants.count === null) {
        alerts.push({ type: 'warning', text: 'Entrant totals are currently unavailable.' });
      }
    } catch (error) {
      console.warn('[Algoland] Failed to fetch entrants', error);
      if (!nextSnapshot.entrants || nextSnapshot.entrants.count === null) {
        alerts.push({ type: 'warning', text: 'Entrant totals are currently unavailable.' });
      } else {
        nextSnapshot.entrants.stale = true;
        alerts.push({ type: 'warning', text: 'Entrant totals were served from cache.' });
      }
    }

    const liveWeeks = weeksConfig.filter((config) => Boolean(config.assetId));
    for (const config of liveWeeks) {
      const weekRecord = nextSnapshot.weeks.find((week) => week.week === config.week);
      try {
        const result = await fetchCompletions(config.assetId);
        if (result) {
          weekRecord.completions = result.completions;
          weekRecord.updatedAt = result.updatedAt;
          weekRecord.source = result.source || null;
          weekRecord.stale = Boolean(result.stale);
          weekRecord.unavailable = false;
          if (result.stale) {
            alerts.push({ type: 'warning', text: `Week ${config.week} completions are stale until the indexer recovers.` });
          }
        } else if (weekRecord.completions === null) {
          weekRecord.unavailable = true;
          alerts.push({ type: 'warning', text: `Week ${config.week} completions are currently unavailable.` });
        } else {
          weekRecord.stale = true;
          alerts.push({ type: 'warning', text: `Week ${config.week} completions were served from cache.` });
        }
      } catch (error) {
        console.warn('[Algoland] Failed to fetch completions', { assetId: config.assetId, error });
        if (typeof weekRecord.completions === 'number') {
          weekRecord.stale = true;
          alerts.push({ type: 'warning', text: `Week ${config.week} completions were served from cache.` });
        } else {
          weekRecord.unavailable = true;
          alerts.push({ type: 'warning', text: `Week ${config.week} completions are currently unavailable.` });
        }
      }
    }

    nextSnapshot.timestamp = new Date().toISOString();
    state.snapshot = nextSnapshot;
    renderSnapshot(nextSnapshot, { fromCache: false, alerts, reason });
    saveSnapshot(nextSnapshot);
    state.isRefreshing = false;
    console.info('[Algoland] Refresh complete', {
      entrants: nextSnapshot.entrants?.count,
      weeks: nextSnapshot.weeks
        .filter((week) => typeof week.completions === 'number')
        .map((week) => ({ week: week.week, completions: week.completions, stale: week.stale })),
    });
  }

  async function fetchEntrants() {
    const response = await fetch(buildApiUrl('/api/entrants'), {
      headers: { accept: 'application/json' },
      credentials: 'omit',
    });
    if (!response.ok) {
      throw new Error(`Entrants request failed with status ${response.status}`);
    }
    const data = await response.json();
    if (typeof data.entrants !== 'number') {
      return null;
    }
    return data;
  }

  async function fetchCompletions(assetId) {
    const url = new URL(buildApiUrl('/api/completions'), window.location.origin);
    url.searchParams.set('asset', assetId);
    const response = await fetch(url.toString(), {
      headers: { accept: 'application/json' },
      credentials: 'omit',
    });
    if (!response.ok) {
      if (response.status >= 500) {
        throw new Error(`Completions request failed with status ${response.status}`);
      }
      return null;
    }
    const data = await response.json();
    if (typeof data.completions !== 'number') {
      return null;
    }
    return data;
  }

  function renderSnapshot(snapshot, { fromCache, alerts }) {
    renderSummary(snapshot);
    renderTable(snapshot);
    renderAlerts(alerts, fromCache);
    renderUpdated(snapshot);
  }

  function renderSummary(snapshot) {
    const entrantsCount = typeof snapshot.entrants?.count === 'number' ? snapshot.entrants.count : null;
    const week1 = snapshot.weeks.find((week) => week.week === 1);
    const week2 = snapshot.weeks.find((week) => week.week === 2);
    const liveWeeks = snapshot.weeks.filter((week) => typeof week.completions === 'number');
    const overallCompleted = liveWeeks.reduce((total, week) => total + (week.completions || 0), 0);

    if (summaryElements.entrants) {
      summaryElements.entrants.textContent = entrantsCount !== null ? numberFormatter.format(entrantsCount) : '—';
    }
    if (summaryElements.week1) {
      summaryElements.week1.textContent = typeof week1?.completions === 'number' ? numberFormatter.format(week1.completions) : '—';
    }
    if (summaryElements.week2) {
      summaryElements.week2.textContent = typeof week2?.completions === 'number' ? numberFormatter.format(week2.completions) : '—';
    }
    if (summaryElements.overall) {
      summaryElements.overall.textContent = liveWeeks.length > 0 ? numberFormatter.format(overallCompleted) : '—';
    }
  }

  function renderTable(snapshot) {
    if (!table) {
      return;
    }
    const entrantsCount = typeof snapshot.entrants?.count === 'number' ? snapshot.entrants.count : null;
    snapshot.weeks.forEach((weekSnapshot) => {
      const row = table.querySelector(`tr[data-week="${weekSnapshot.week}"]`);
      if (!row) {
        return;
      }
      const entrantsCell = row.querySelector('[data-col="entrants"]');
      if (entrantsCell) {
        if (entrantsCount !== null) {
          entrantsCell.textContent = numberFormatter.format(entrantsCount);
          entrantsCell.classList.remove('na-value');
        } else {
          entrantsCell.textContent = '—';
        }
      }
      const completedCell = row.querySelector('[data-col="completed"]');
      const conversionCell = row.querySelector('[data-col="conversion"]');
      if (!completedCell || !conversionCell) {
        return;
      }
      if (weekSnapshot.status === 'coming-soon') {
        completedCell.textContent = 'N/A';
        completedCell.classList.add('na-value');
        conversionCell.textContent = 'N/A';
        conversionCell.classList.add('na-value');
        return;
      }
      completedCell.classList.remove('na-value');
      conversionCell.classList.remove('na-value');
      if (typeof weekSnapshot.completions === 'number') {
        completedCell.textContent = numberFormatter.format(weekSnapshot.completions);
        if (entrantsCount && entrantsCount > 0) {
          const ratio = weekSnapshot.completions / entrantsCount;
          conversionCell.textContent = percentFormatter.format(ratio);
        } else {
          conversionCell.textContent = 'N/A';
          conversionCell.classList.add('na-value');
        }
      } else if (weekSnapshot.unavailable) {
        completedCell.textContent = 'Unavailable';
        conversionCell.textContent = 'N/A';
        conversionCell.classList.add('na-value');
      } else {
        completedCell.textContent = '—';
        conversionCell.textContent = entrantsCount ? 'N/A' : '—';
        if (!entrantsCount) {
          conversionCell.classList.add('na-value');
        }
      }
    });
  }

  function renderAlerts(alerts, fromCache) {
    if (!alertsContainer) {
      return;
    }
    alertsContainer.textContent = '';
    const uniqueAlerts = [];
    alerts.forEach((alert) => {
      if (!alert || !alert.text) {
        return;
      }
      if (!uniqueAlerts.some((item) => item.text === alert.text)) {
        uniqueAlerts.push(alert);
      }
    });
    if (fromCache && uniqueAlerts.length === 0) {
      uniqueAlerts.push({ type: 'info', text: 'Showing the last saved snapshot while fresh data loads.' });
    }
    uniqueAlerts.forEach((alert) => {
      const element = document.createElement('div');
      element.className = 'algoland-alert';
      if (alert.type === 'info') {
        element.classList.add('algoland-alert--info');
      }
      element.textContent = alert.text;
      alertsContainer.appendChild(element);
    });
  }

  function renderUpdated(snapshot) {
    if (!updatedElement) {
      return;
    }
    if (!snapshot) {
      updatedElement.textContent = '';
      return;
    }
    const updatedAt = snapshot.timestamp ? new Date(snapshot.timestamp) : null;
    if (!updatedAt || Number.isNaN(updatedAt.getTime())) {
      updatedElement.textContent = '';
      return;
    }
    const formatted = updatedAt.toLocaleString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZoneName: 'short',
    });
    const staleLabels = [];
    if (snapshot.entrants?.stale) {
      staleLabels.push('entrants');
    }
    snapshot.weeks.forEach((week) => {
      if (week.stale) {
        staleLabels.push(`week ${week.week}`);
      }
    });
    if (staleLabels.length > 0) {
      updatedElement.textContent = `Last updated ${formatted} (stale: ${staleLabels.join(', ')})`;
    } else {
      updatedElement.textContent = `Last updated ${formatted}`;
    }
  }
})();
