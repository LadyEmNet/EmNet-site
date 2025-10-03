(function () {
  const root = document.querySelector('[data-algoland-root]');
  if (!root || typeof window.fetch !== 'function') {
    return;
  }

  const API_BASE = normaliseBase(root.dataset.apiBase || window.EMNET_ALGOLAND_API_BASE || '');
  const SNAPSHOT_KEY = 'emnet.algoland.snapshot.v2';
  const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
  const ONE_WEEK_IN_MS = 7 * 24 * 60 * 60 * 1000;
  const DEFAULT_DISTRIBUTOR = 'HHADCZKQV24QDCBER5GTOH7BOLF4ZQ6WICNHAA3GZUECIMJXIIMYBIWEZM';
  const APP_ID = 3215540125;

  const weeksConfig = [
    { week: 1, assetId: '3215542831', distributors: [DEFAULT_DISTRIBUTOR], opensOn: '2025-09-22' },
    { week: 2, assetId: '3215542840', distributors: [DEFAULT_DISTRIBUTOR], opensOn: '2025-09-29' },
    { week: 3, assetId: '', distributors: [DEFAULT_DISTRIBUTOR], opensOn: '2025-10-06' },
    { week: 4, assetId: '', distributors: [DEFAULT_DISTRIBUTOR], opensOn: '2025-10-13' },
    { week: 5, assetId: '', distributors: [DEFAULT_DISTRIBUTOR], opensOn: '2025-10-20' },
    { week: 6, assetId: '', distributors: [DEFAULT_DISTRIBUTOR], opensOn: '2025-10-27' },
    { week: 7, assetId: '', distributors: [DEFAULT_DISTRIBUTOR], opensOn: '2025-11-03' },
    { week: 8, assetId: '', distributors: [DEFAULT_DISTRIBUTOR], opensOn: '2025-11-10' },
    { week: 9, assetId: '', distributors: [DEFAULT_DISTRIBUTOR], opensOn: '2025-11-17' },
    { week: 10, assetId: '', distributors: [DEFAULT_DISTRIBUTOR], opensOn: '2025-11-24' },
    { week: 11, assetId: '', distributors: [DEFAULT_DISTRIBUTOR], opensOn: '2025-12-01' },
    { week: 12, assetId: '', distributors: [DEFAULT_DISTRIBUTOR], opensOn: '2025-12-08' },
    { week: 13, assetId: '', distributors: [DEFAULT_DISTRIBUTOR], opensOn: '2025-12-15' },
  ];

  const numberFormatter = new Intl.NumberFormat('en-GB');
  const percentFormatter = new Intl.NumberFormat('en-GB', {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const openDateFormatter = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  const openDateYearFormatter = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  function formatOpenDate(date, { includeYear = false } = {}) {
    const formatter = includeYear ? openDateYearFormatter : openDateFormatter;
    const formatted = formatter.format(date);
    return formatted.replace(/,/g, '');
  }

  const summaryElements = {
    entrants: root.querySelector('[data-summary="entrants"]'),
    overall: root.querySelector('[data-summary="overall"]'),
  };
  const alertsContainer = root.querySelector('[data-algoland-alerts]');
  const table = root.querySelector('[data-algoland-table]');
  const updatedElement = root.querySelector('[data-algoland-updated]');
  const weekCards = createWeekCardMap();

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
    renderWeeks(snapshot);
    renderAlerts(alerts, fromCache);
    renderUpdated(snapshot);
  }

  function renderSummary(snapshot) {
    const entrantsCount = typeof snapshot.entrants?.count === 'number' ? snapshot.entrants.count : null;
    const liveWeeks = snapshot.weeks.filter((week) => typeof week.completions === 'number');
    const overallCompleted = liveWeeks.reduce((total, week) => total + (week.completions || 0), 0);

    if (summaryElements.entrants) {
      summaryElements.entrants.textContent = entrantsCount !== null ? numberFormatter.format(entrantsCount) : '—';
    }
    if (summaryElements.overall) {
      summaryElements.overall.textContent = liveWeeks.length > 0 ? numberFormatter.format(overallCompleted) : '—';
    }
  }

  function renderWeeks(snapshot) {
    const now = new Date();
    snapshot.weeks.forEach((weekSnapshot) => {
      const card = weekCards.get(weekSnapshot.week);
      if (!card) {
        return;
      }
      const opensOn = card.opensOn;
      const manualOpen = card.defaultIsOpen;
      const isOpen = opensOn ? now >= opensOn || manualOpen : manualOpen;
      const openedForMs = opensOn ? now - opensOn : 0;
      const isCatchUp = isOpen && openedForMs >= ONE_WEEK_IN_MS;
      card.card.classList.toggle('is-open', isOpen);
      card.card.classList.toggle('is-upcoming', !isOpen);
      card.card.classList.toggle('is-catchup', isCatchUp);

      if (card.statusElement) {
        card.statusElement.classList.toggle('is-catchup', isCatchUp);
        if (isCatchUp) {
          card.statusElement.textContent = 'Catch up';
        } else if (isOpen) {
          card.statusElement.textContent = weekSnapshot.status === 'coming-soon' ? 'Open this week' : 'Open now';
        } else if (weekSnapshot.assetId && opensOn) {
          card.statusElement.textContent = 'Ready for Coming Monday';
        } else if (opensOn) {
          card.statusElement.textContent = `Opens ${formatOpenDate(opensOn)}`;
        } else {
          card.statusElement.textContent = 'Opens soon';
        }
      }

      if (card.openTextElement) {
        if (opensOn) {
          const formatted = formatOpenDate(opensOn, { includeYear: true });
          card.openTextElement.textContent = isOpen ? `Opened ${formatted}` : `Opens ${formatted}`;
        } else {
          card.openTextElement.textContent = isOpen ? 'Open now' : 'Opens soon';
        }
      }

      if (card.badgeElement) {
        if (weekSnapshot.assetId) {
          card.badgeElement.textContent = weekSnapshot.assetId;
          card.badgeElement.classList.remove('na-value');
        } else {
          card.badgeElement.textContent = 'Coming soon';
          card.badgeElement.classList.add('na-value');
        }
      }

      if (card.completionsElement) {
        if (typeof weekSnapshot.completions === 'number') {
          card.completionsElement.textContent = numberFormatter.format(weekSnapshot.completions);
        } else if (!isOpen) {
          card.completionsElement.textContent = 'N/A';
        } else {
          card.completionsElement.textContent = '—';
        }
      }
    });
  }

  function createWeekCardMap() {
    const entries = [];
    root.querySelectorAll('[data-week-card]').forEach((card) => {
      const week = Number.parseInt(card.dataset.week, 10);
      if (Number.isNaN(week)) {
        return;
      }
      const config = weeksConfig.find((item) => item.week === week);
      const opensOnSource = card.dataset.opensOn || config?.opensOn || null;
      let opensOn = null;
      if (opensOnSource) {
        const parsed = new Date(opensOnSource);
        if (!Number.isNaN(parsed.getTime())) {
          opensOn = parsed;
        }
      }
      entries.push([
        week,
        {
          card,
          opensOn,
          statusElement: card.querySelector('[data-week-status]'),
          completionsElement: card.querySelector('[data-week-completions]'),
          badgeElement: card.querySelector('[data-week-badge]'),
          openTextElement: card.querySelector('[data-week-open-text]'),
          defaultIsOpen: card.classList.contains('is-open'),
        },
      ]);
    });
    return new Map(entries);
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
