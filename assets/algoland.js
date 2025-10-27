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
  const ALGOLAND_ADDRESS_PATTERN = /^[A-Z2-7]{58}$/;
  const prizeDetailsCache = new Map();
  const prizeModal = createPrizeModal();
  const lookupModal = createLookupModal(root);

  const weeksConfig = [
    { week: 1, assetId: '3215542831', distributors: [DEFAULT_DISTRIBUTOR], opensOn: '2025-09-22' },
    { week: 2, assetId: '3215542840', distributors: [DEFAULT_DISTRIBUTOR], opensOn: '2025-09-29' },
    { week: 3, assetId: '3215542836', distributors: [DEFAULT_DISTRIBUTOR], opensOn: '2025-10-06' },
    { week: 4, assetId: '3257999517', distributors: [DEFAULT_DISTRIBUTOR], opensOn: '2025-10-13' },
    { week: 5, assetId: '3257999522', distributors: [DEFAULT_DISTRIBUTOR], opensOn: '2025-10-20' },
    { week: 6, assetId: '3257999512', distributors: [DEFAULT_DISTRIBUTOR], opensOn: '2025-10-27' },
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
  attachWeekCardInteractions();
  setupAddressSearch();

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

  function setupAddressSearch() {
    const form = root.querySelector('[data-algoland-search-form]');
    if (!form) {
      return;
    }
    const input = form.querySelector('[data-algoland-search-input]');
    const button = form.querySelector('[data-algoland-search-button]');
    const feedback = root.querySelector('[data-algoland-search-feedback]');
    if (!input) {
      return;
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const parsed = parseSearchInput(input.value || '');
      if (parsed.error) {
        setSearchFeedback(feedback, parsed.error, 'error');
        window.requestAnimationFrame(() => {
          input.focus();
          input.select();
        });
        return;
      }

      setSearchFeedback(feedback, 'Searching…');
      setSearchLoading(button, true);

      const searchValue = parsed.value;

      try {
        const payload = await fetchProfileLookup(searchValue);
        lookupModal.open({ query: searchValue, type: parsed.type, data: payload });
        setSearchFeedback(feedback, `Showing results for ${searchValue}.`, 'success');
      } catch (error) {
        const defaultMessage = 'Something went wrong fetching that profile. Please try again.';
        const message = error && typeof error.message === 'string' && error.message.length
          ? error.message
          : defaultMessage;
        console.error('[Algoland] Failed to fetch profile lookup', error);
        setSearchFeedback(feedback, message, 'error');
      } finally {
        setSearchLoading(button, false);
      }
    });

    input.addEventListener('input', () => {
      setSearchFeedback(feedback, '');
    });
  }

  async function fetchProfileLookup(searchValue) {
    const response = await window.fetch(
      buildApiUrl(`/api/algoland-stats?address=${encodeURIComponent(searchValue)}`),
      { headers: { Accept: 'application/json' } }
    );

    let payload = null;
    try {
      payload = await response.json();
    } catch (parseError) {
      payload = null;
    }

    if (!response.ok || payload === null || typeof payload !== 'object') {
      const message = payload && typeof payload.message === 'string' && payload.message.length
        ? payload.message
        : 'Unable to find that profile. Check the address or ID and try again.';
      const error = new Error(message);
      if (payload && typeof payload.error === 'string') {
        error.code = payload.error;
      }
      error.status = response.status;
      throw error;
    }

    return payload;
  }

  function parseSearchInput(rawValue) {
    const trimmed = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (trimmed.length === 0) {
      return { error: 'Enter an Algorand address or Algoland user ID.' };
    }
    if (/^\d+$/.test(trimmed)) {
      return { value: trimmed, type: 'id' };
    }
    const normalisedAddress = normaliseAlgorandAddress(trimmed);
    if (normalisedAddress) {
      return { value: normalisedAddress, type: 'address' };
    }
    return { error: 'Enter a 58-character Algorand address or numeric ID.' };
  }

  function normaliseAlgorandAddress(value) {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const uppercased = trimmed.toUpperCase();
    return ALGOLAND_ADDRESS_PATTERN.test(uppercased) ? uppercased : null;
  }

  function setSearchFeedback(element, message, status) {
    if (!element) {
      return;
    }
    element.textContent = message || '';
    element.classList.remove('is-error', 'is-success');
    if (!message) {
      return;
    }
    if (status === 'error') {
      element.classList.add('is-error');
    } else if (status === 'success') {
      element.classList.add('is-success');
    }
  }

  function setSearchLoading(button, isLoading) {
    if (!button) {
      return;
    }
    if (typeof button.dataset.originalLabel !== 'string') {
      button.dataset.originalLabel = button.textContent || 'Search';
    }
    if (isLoading) {
      button.disabled = true;
      button.textContent = 'Searching…';
    } else {
      button.disabled = false;
      button.textContent = button.dataset.originalLabel || 'Search';
    }
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
          card.statusElement.textContent = 'Open now';
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

  function attachWeekCardInteractions() {
    if (!prizeModal) {
      return;
    }
    weekCards.forEach((entry, week) => {
      if (!entry || !entry.card) {
        return;
      }
      const { card } = entry;
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.addEventListener('click', () => {
        openPrizeModalForWeek(week);
      });
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openPrizeModalForWeek(week);
        }
      });
    });
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

  function openPrizeModalForWeek(week) {
    if (!prizeModal) {
      return;
    }
    prizeModal.open(week);
  }

  async function fetchPrizeDetails(week) {
    const response = await fetch(buildApiUrl(`/api/prizes/${week}`), {
      headers: { accept: 'application/json' },
      credentials: 'omit',
    });
    if (!response.ok) {
      throw new Error(`Prize request failed with status ${response.status}`);
    }
    return response.json();
  }

  function createLookupModal(host) {
    const hostElement = host || document.body;
    let modal = hostElement.querySelector('[data-lookup-modal]');
    if (!modal) {
      modal = document.createElement('div');
      modal.className = 'lookup-modal';
      modal.hidden = true;
      modal.setAttribute('data-lookup-modal', '');

      const overlay = document.createElement('div');
      overlay.className = 'lookup-modal__overlay';
      overlay.setAttribute('data-lookup-dismiss', '');
      overlay.setAttribute('aria-hidden', 'true');

      const dialog = document.createElement('div');
      dialog.className = 'lookup-modal__dialog';
      dialog.setAttribute('data-lookup-dialog', '');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'lookup-modal-title');
      dialog.tabIndex = -1;

      const closeButton = document.createElement('button');
      closeButton.type = 'button';
      closeButton.className = 'lookup-modal__close';
      closeButton.setAttribute('data-lookup-dismiss', '');
      closeButton.setAttribute('aria-label', 'Close search results');
      closeButton.innerHTML = '&times;';

      const content = document.createElement('div');
      content.className = 'lookup-modal__content';

      const titleElement = document.createElement('h2');
      titleElement.id = 'lookup-modal-title';
      titleElement.setAttribute('data-lookup-title', '');
      titleElement.className = 'lookup-modal__title';
      titleElement.textContent = 'Algoland Progress Report';

      const bodyElement = document.createElement('div');
      bodyElement.className = 'lookup-modal__body';
      bodyElement.setAttribute('data-lookup-body', '');

      content.appendChild(titleElement);
      content.appendChild(bodyElement);
      dialog.appendChild(closeButton);
      dialog.appendChild(content);
      modal.appendChild(overlay);
      modal.appendChild(dialog);
      hostElement.appendChild(modal);
    }

    const dialog = modal.querySelector('[data-lookup-dialog]');
    const titleElement = modal.querySelector('[data-lookup-title]');
    const bodyElement = modal.querySelector('[data-lookup-body]');
    const dismissElements = modal.querySelectorAll('[data-lookup-dismiss]');

    dismissElements.forEach((element) => {
      element.addEventListener('click', () => {
        hide();
      });
    });

    modal.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && modal.dataset.open === 'true') {
        hide();
      }
    });

    function show(details) {
      if (!dialog || !titleElement || !bodyElement) {
        return;
      }
      const descriptor = details && typeof details === 'object' ? details : {};
      titleElement.textContent = 'Algoland Progress Report';
      renderLookupModalBody(bodyElement, descriptor);
      modal.hidden = false;
      modal.dataset.open = 'true';
      document.body.classList.add('lookup-modal-open');
      window.requestAnimationFrame(() => {
        try {
          dialog.focus({ preventScroll: true });
        } catch (error) {
          dialog.focus();
        }
      });
    }

    function hide() {
      if (modal.hidden) {
        return;
      }
      modal.hidden = true;
      modal.dataset.open = 'false';
      document.body.classList.remove('lookup-modal-open');
    }

    return {
      open(details) {
        show(details);
      },
      close: hide,
    };
  }

  function renderLookupModalBody(container, descriptor) {
    if (!container) {
      return;
    }
    container.textContent = '';
    const details = descriptor && typeof descriptor === 'object' ? descriptor : {};
    const data = details.data && typeof details.data === 'object' ? details.data : {};
    const query = typeof details.query === 'string' ? details.query : '';
    const lookupType = details.type === 'id' ? 'id' : 'address';

    const totalPoints = firstNumber(
      typeof data.points === 'number' ? data.points : null,
      data.points && firstNumber(data.points.total, data.points.current, data.points.balance, data.points.available),
      data.totalPoints,
      data.currentPoints,
      data.pointsTotal,
      data.pointsBalance
    );
    const redeemedPoints = firstNumber(
      data.points && firstNumber(data.points.redeemed, data.points.redeemedPoints, data.points.claimed),
      data.redeemedPoints,
      data.claimedPoints
    );
    const completedQuests = normaliseListItems(data.completedQuests || data.quests);
    const completedChallenges = normaliseListItems(data.completedChallenges || data.challenges);
    const referralDetails = buildReferralDetails(data);
    const referralsProvided = Array.isArray(data.referrals)
      || Array.isArray(data.referralsRelativeIds)
      || typeof data.referrals === 'number'
      || typeof data.referralsCount === 'number'
      || typeof data.referralCount === 'number';
    const referralsCount = firstNumber(
      data.referralsCount,
      data.referralCount,
      typeof data.referrals === 'number' ? data.referrals : null,
      referralsProvided && Array.isArray(data.referrals) ? data.referrals.length : null,
      referralsProvided && Array.isArray(data.referralsRelativeIds) ? data.referralsRelativeIds.length : null,
      referralsProvided ? referralDetails.length : null
    );
    const referralsSummary = referralsCount === null
      ? (referralsProvided ? '0' : 'Not available')
      : numberFormatter.format(referralsCount);
    const weeklyDrawDetails = normaliseWeeklyDraws(
      data.weeklyDraws ?? data.draws ?? data.weeklyDrawEligibility
    );
    const statusMessage = typeof data.statusMessage === 'string' && data.statusMessage.trim().length
      ? data.statusMessage.trim()
      : null;
    const hasParticipation = data.hasParticipation === true
      || (typeof totalPoints === 'number' && totalPoints > 0)
      || (typeof redeemedPoints === 'number' && redeemedPoints > 0)
      || completedQuests.length > 0
      || completedChallenges.length > 0
      || referralDetails.length > 0
      || (typeof weeklyDrawDetails.totalCount === 'number' && weeklyDrawDetails.totalCount > 0)
      || (typeof weeklyDrawDetails.eligibleCount === 'number' && weeklyDrawDetails.eligibleCount > 0);

    if (!hasParticipation) {
      const emptyMessage = statusMessage
        || (lookupType === 'id'
          ? 'We couldn’t find any Algoland activity for that user yet.'
          : 'This wallet hasn’t participated in Algoland yet.');
      container.appendChild(createLookupText(emptyMessage, 'lookup-modal__empty'));
    } else if (statusMessage) {
      container.appendChild(createLookupText(statusMessage));
    }

    const summarySection = createLookupSection('Summary', {
      icon: '📊',
      modifiers: ['summary'],
    });
    summarySection.appendChild(createStatGrid([
      { label: 'Points', value: formatNumberValue(totalPoints), icon: '⭐' },
      { label: 'Completed Challenges', value: formatNumberValue(completedChallenges.length), icon: '🏆' },
      { label: 'Referrals', value: referralsSummary, icon: '🤝' },
    ]));
    container.appendChild(summarySection);

    const questsTotal = firstNumber(
      data.totalQuestCount,
      data.questTotal,
      data.questsTotal,
      data.totalQuests,
      data.questCount,
      typeof data.quests === 'number' ? data.quests : null,
      completedQuests.length
    );
    container.appendChild(
      createProgressSection('Completed Quests', completedQuests, 'No quests completed yet.', {
        icon: '✓',
        total: questsTotal,
      })
    );

    const referralsEmptyMessage = referralsProvided
      ? 'No referrals recorded yet.'
      : 'Referral data is not available yet.';
    container.appendChild(
      createReferralSection('Referrals', referralDetails, referralsEmptyMessage, {
        icon: '👥',
        total: referralsCount,
      })
    );

    const weeklySection = createLookupSection('Weekly Draws', {
      icon: '🎟️',
      modifiers: ['highlight'],
    });
    const completedBadgeCount = completedChallenges.length;
    const eligibleWeeksCandidates = [
      typeof weeklyDrawDetails.eligibleCount === 'number' ? weeklyDrawDetails.eligibleCount : null,
      completedBadgeCount > 0 ? completedBadgeCount : null,
    ];
    const eligibleWeeks = eligibleWeeksCandidates.reduce((max, value) => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(max, value);
      }
      return max;
    }, 0);
    const totalWeekCandidates = [
      typeof weeklyDrawDetails.totalCount === 'number' ? weeklyDrawDetails.totalCount : null,
      Array.isArray(weeklyDrawDetails.list) ? weeklyDrawDetails.list.length : null,
      eligibleWeeks,
      completedBadgeCount > 0 ? completedBadgeCount : null,
    ];
    const totalWeeks = totalWeekCandidates.reduce((max, value) => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(max, value);
      }
      return max;
    }, 0);

    if (totalWeeks > 0) {
      const eligibilityNote = document.createElement('p');
      eligibilityNote.className = 'lookup-modal__progress-note';
      eligibilityNote.textContent = `${numberFormatter.format(eligibleWeeks)} of ${numberFormatter.format(totalWeeks)} weeks eligible`;
      weeklySection.appendChild(eligibilityNote);
    }

    if (weeklyDrawDetails.text) {
      weeklySection.appendChild(createLookupText(weeklyDrawDetails.text));
    }

    if (Array.isArray(weeklyDrawDetails.list) && weeklyDrawDetails.list.length > 0) {
      weeklySection.appendChild(
        createLookupList(weeklyDrawDetails.list, 'No weekly draw entries recorded yet.')
      );
    } else if (totalWeeks === 0) {
      weeklySection.appendChild(
        createLookupText(
          weeklyDrawDetails.emptyMessage || 'Weekly draw eligibility data is not available yet.',
          'lookup-modal__empty'
        )
      );
    }
    container.appendChild(weeklySection);
  }

  function createLookupSection(title, options = {}) {
    const section = document.createElement('div');
    section.className = 'lookup-modal__section';
    const modifierList = [];
    if (Array.isArray(options.modifiers)) {
      modifierList.push(...options.modifiers);
    }
    if (typeof options.modifier === 'string') {
      modifierList.push(options.modifier);
    }
    modifierList.forEach((modifier) => {
      if (modifier) {
        section.classList.add(`lookup-modal__section--${modifier}`);
      }
    });
    if (title) {
      const heading = document.createElement('h3');
      heading.className = 'lookup-modal__section-title';
      if (options.icon) {
        const icon = document.createElement('span');
        icon.className = 'lookup-modal__section-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = options.icon;
        heading.appendChild(icon);
      }
      const titleText = document.createElement('span');
      titleText.className = 'lookup-modal__section-title-text';
      titleText.textContent = title;
      heading.appendChild(titleText);
      section.appendChild(heading);
    }
    return section;
  }

  function createDefinitionList(items) {
    const list = document.createElement('dl');
    list.className = 'lookup-modal__definition-list';
    items.forEach((item) => {
      if (!item || !item.term) {
        return;
      }
      const dt = document.createElement('dt');
      dt.textContent = item.term;
      const dd = document.createElement('dd');
      if (item.value instanceof Node) {
        dd.appendChild(item.value);
      } else {
        dd.textContent = item.value != null && item.value !== '' ? String(item.value) : 'Not available';
      }
      list.appendChild(dt);
      list.appendChild(dd);
    });
    return list;
  }

  function createStatGrid(stats) {
    const grid = document.createElement('div');
    grid.className = 'lookup-modal__stat-grid';
    stats.forEach((stat) => {
      const card = document.createElement('div');
      card.className = 'lookup-modal__stat-card';
      if (stat.icon) {
        const icon = document.createElement('span');
        icon.className = 'lookup-modal__stat-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = stat.icon;
        card.appendChild(icon);
      }
      const label = document.createElement('span');
      label.className = 'lookup-modal__stat-label';
      label.textContent = stat.label;
      card.appendChild(label);
      const value = document.createElement('span');
      value.className = 'lookup-modal__stat-value';
      value.textContent = stat.value != null && stat.value !== '' ? String(stat.value) : 'Not available';
      card.appendChild(value);
      grid.appendChild(card);
    });
    return grid;
  }

  function createProgressSection(title, items, emptyMessage, options = {}) {
    const section = createLookupSection(title, {
      icon: options.icon,
      modifiers: ['progress'],
    });
    const totalCompleted = Array.isArray(items) ? items.length : 0;
    if (totalCompleted > 0) {
      const collapsible = document.createElement('details');
      collapsible.className = 'lookup-modal__collapsible';

      const summary = document.createElement('summary');
      summary.className = 'lookup-modal__collapsible-summary';
      summary.appendChild(createProgressNote(totalCompleted, options.total, 'span'));

      const icon = document.createElement('span');
      icon.className = 'lookup-modal__collapsible-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = '▾';
      summary.appendChild(icon);

      collapsible.appendChild(summary);
      const list = createProgressList(items, emptyMessage);
      collapsible.appendChild(list);
      section.appendChild(collapsible);
    } else {
      section.appendChild(createProgressNote(totalCompleted, options.total));
      section.appendChild(createProgressList(items, emptyMessage));
    }
    return section;
  }

  function createProgressNote(completed, total, elementTag = 'p') {
    const note = document.createElement(elementTag);
    note.className = 'lookup-modal__progress-note';
    const completedValue = numberFormatter.format(completed);
    const totalValue = typeof total === 'number' && Number.isFinite(total)
      ? Math.max(total, completed)
      : completed;
    note.textContent = `${completedValue} of ${numberFormatter.format(totalValue)} complete`;
    return note;
  }

  function createProgressList(items, emptyMessage = 'No data available.') {
    if (!Array.isArray(items) || items.length === 0) {
      return createLookupText(emptyMessage, 'lookup-modal__empty');
    }
    const list = document.createElement('ol');
    list.className = 'lookup-modal__progress-list';
    items.forEach((item, index) => {
      const listItem = document.createElement('li');
      listItem.className = 'lookup-modal__progress-item';

      const indexElement = document.createElement('span');
      indexElement.className = 'lookup-modal__progress-index';
      indexElement.textContent = numberFormatter.format(index + 1);
      listItem.appendChild(indexElement);

      const textElement = document.createElement('span');
      textElement.className = 'lookup-modal__progress-text';
      textElement.textContent = item;
      listItem.appendChild(textElement);

      const checkElement = document.createElement('span');
      checkElement.className = 'lookup-modal__progress-check';
      checkElement.setAttribute('aria-hidden', 'true');
      checkElement.textContent = '✓';
      listItem.appendChild(checkElement);

      list.appendChild(listItem);
    });
    return list;
  }

  function createReferralSection(title, referrals, emptyMessage, options = {}) {
    const section = createLookupSection(title, {
      icon: options.icon,
      modifiers: ['referrals'],
    });
    if (Array.isArray(referrals) && referrals.length > 0) {
      const collapsible = document.createElement('details');
      collapsible.className = 'lookup-modal__collapsible';

      const summary = document.createElement('summary');
      summary.className = 'lookup-modal__collapsible-summary';

      const label = document.createElement('span');
      label.className = 'lookup-modal__collapsible-label';
      const referralsTotal = typeof options.total === 'number' && Number.isFinite(options.total)
        ? options.total
        : referrals.length;
      label.textContent = `${numberFormatter.format(referralsTotal)} referral${referralsTotal === 1 ? '' : 's'}`;
      summary.appendChild(label);

      const icon = document.createElement('span');
      icon.className = 'lookup-modal__collapsible-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = '▾';
      summary.appendChild(icon);

      collapsible.appendChild(summary);

      const wrapper = document.createElement('div');
      wrapper.className = 'lookup-modal__referral-tags';
      referrals.forEach((referral) => {
        if (!referral || typeof referral.label !== 'string' || referral.label.trim().length === 0) {
          return;
        }
        const isInteractive = typeof referral.lookupValue === 'string'
          && referral.lookupValue.length > 0
          && (referral.lookupType === 'address' || referral.lookupType === 'id');
        const tag = document.createElement(isInteractive ? 'button' : 'span');
        tag.className = 'lookup-modal__referral-tag';
        tag.textContent = referral.label;
        if (isInteractive) {
          tag.type = 'button';
          tag.classList.add('lookup-modal__referral-tag--interactive');
          tag.dataset.lookupReferralValue = referral.lookupValue;
          tag.dataset.lookupReferralType = referral.lookupType;
          const title = `View progress for ${referral.label}`;
          tag.title = title;
          tag.setAttribute('aria-label', title);
          tag.addEventListener('click', () => {
            handleReferralTagClick(referral);
          });
        }
        wrapper.appendChild(tag);
      });
      collapsible.appendChild(wrapper);
      section.appendChild(collapsible);
    } else {
      section.appendChild(createLookupText(emptyMessage, 'lookup-modal__empty'));
    }
    return section;
  }

  async function handleReferralTagClick(referral) {
    if (!referral || typeof referral.lookupValue !== 'string' || !referral.lookupValue) {
      return;
    }
    const lookupValue = referral.lookupValue;
    const lookupType = referral.lookupType === 'id' ? 'id' : 'address';
    const feedbackElement = root.querySelector('[data-algoland-search-feedback]');
    const button = root.querySelector('[data-algoland-search-button]');
    const input = root.querySelector('[data-algoland-search-input]');
    if (input) {
      input.value = lookupValue;
    }

    setSearchLoading(button, true);
    if (feedbackElement) {
      setSearchFeedback(feedbackElement, 'Searching…');
    }

    const loadingMessage = referral.label
      ? `Loading progress for ${referral.label}…`
      : 'Loading referral progress…';
    lookupModal.open({
      query: lookupValue,
      type: lookupType,
      data: { statusMessage: loadingMessage },
    });

    try {
      const payload = await fetchProfileLookup(lookupValue);
      lookupModal.open({ query: lookupValue, type: lookupType, data: payload });
      if (feedbackElement) {
        setSearchFeedback(feedbackElement, `Showing results for ${lookupValue}.`, 'success');
      }
    } catch (error) {
      const defaultMessage = 'Unable to load that referral profile. Please try again.';
      const message = error && typeof error.message === 'string' && error.message.length
        ? error.message
        : defaultMessage;
      console.warn('[Algoland] Failed to load referral profile', {
        referral: referral.label,
        error,
      });
      lookupModal.open({ query: lookupValue, type: lookupType, data: { statusMessage: message } });
      if (feedbackElement) {
        setSearchFeedback(feedbackElement, message, 'error');
      }
    } finally {
      setSearchLoading(button, false);
    }
  }

  function buildReferralDetails(data) {
    if (!data || typeof data !== 'object') {
      return [];
    }
    const rawReferrals = Array.isArray(data.referrals) ? data.referrals : [];
    const relativeIds = Array.isArray(data.referralsRelativeIds)
      ? data.referralsRelativeIds.filter((value) => typeof value === 'number' && Number.isFinite(value))
      : [];
    const maxLength = Math.max(rawReferrals.length, relativeIds.length);
    const details = [];
    for (let index = 0; index < maxLength; index += 1) {
      const rawItem = index < rawReferrals.length ? rawReferrals[index] : undefined;
      const relativeId = index < relativeIds.length ? relativeIds[index] : undefined;
      const label = formatReferralLabel(rawItem, relativeId);
      if (!label) {
        continue;
      }
      const descriptor = { label };
      const query = getReferralQueryFromValue(rawItem, relativeId);
      if (typeof query === 'string' && query.trim().length > 0) {
        const parsed = parseSearchInput(query);
        if (!parsed.error) {
          descriptor.lookupValue = parsed.value;
          descriptor.lookupType = parsed.type;
        } else {
          const normalisedAddress = normaliseAlgorandAddress(query);
          if (normalisedAddress) {
            descriptor.lookupValue = normalisedAddress;
            descriptor.lookupType = 'address';
          } else {
            const numericQuery = query.trim();
            if (/^\d+$/.test(numericQuery)) {
              descriptor.lookupValue = numericQuery;
              descriptor.lookupType = 'id';
            }
          }
        }
      }
      details.push(descriptor);
    }
    return details;
  }

  function formatReferralLabel(rawItem, relativeId) {
    const labelCandidate = normaliseListItem(rawItem);
    if (typeof labelCandidate === 'string' && labelCandidate.trim().length > 0) {
      return labelCandidate.trim();
    }
    if (typeof rawItem === 'string' && rawItem.trim().length > 0) {
      return rawItem.trim();
    }
    if (typeof rawItem === 'number' && Number.isFinite(rawItem)) {
      return numberFormatter.format(rawItem);
    }
    if (typeof relativeId === 'number' && Number.isFinite(relativeId)) {
      return `Relative ID ${numberFormatter.format(relativeId)}`;
    }
    return null;
  }

  function getReferralQueryFromValue(value, fallbackId, depth = 0) {
    if (depth > 5) {
      return null;
    }
    if (typeof value === 'string') {
      const normalisedAddress = normaliseAlgorandAddress(value);
      if (normalisedAddress) {
        return normalisedAddress;
      }
      const digitsMatch = value.match(/\d+/);
      if (digitsMatch) {
        return digitsMatch[0];
      }
      return typeof fallbackId === 'number' && Number.isFinite(fallbackId)
        ? String(Math.trunc(fallbackId))
        : null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(Math.trunc(value));
    }
    if (typeof value === 'object' && value !== null) {
      if (typeof value.address === 'string') {
        const addressCandidate = normaliseAlgorandAddress(value.address);
        if (addressCandidate) {
          return addressCandidate;
        }
      }
      const candidateKeys = ['value', 'relativeId', 'id', 'referralId', 'userId', 'wallet'];
      for (const key of candidateKeys) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          continue;
        }
        const candidate = value[key];
        if (candidate === value) {
          continue;
        }
        const resolved = getReferralQueryFromValue(candidate, fallbackId, depth + 1);
        if (resolved) {
          return resolved;
        }
      }
    }
    if (typeof fallbackId === 'number' && Number.isFinite(fallbackId)) {
      return String(Math.trunc(fallbackId));
    }
    return null;
  }

  function createLookupList(items, emptyMessage = 'No data available.') {
    if (!Array.isArray(items) || items.length === 0) {
      return createLookupText(emptyMessage, 'lookup-modal__empty');
    }
    const list = document.createElement('ul');
    list.className = 'lookup-modal__list';
    items.forEach((item) => {
      const listItem = document.createElement('li');
      listItem.textContent = item;
      list.appendChild(listItem);
    });
    return list;
  }

  function createLookupText(text, className = 'lookup-modal__text') {
    const paragraph = document.createElement('p');
    paragraph.className = className;
    paragraph.textContent = text;
    return paragraph;
  }

  function normaliseWeeklyDraws(value) {
    if (value == null) {
      return {
        text: '',
        list: [],
        emptyMessage: 'Weekly draw eligibility data is not available yet.',
        eligibleCount: null,
        totalCount: 0,
      };
    }
    if (Array.isArray(value)) {
      const list = normaliseListItems(value);
      return {
        text: '',
        list,
        emptyMessage: 'No weekly draw entries recorded yet.',
        eligibleCount: countEligibleEntries(value),
        totalCount: list.length,
      };
    }
    if (typeof value === 'object') {
      const list = Array.isArray(value.weeks) ? normaliseListItems(value.weeks) : [];
      const eligible = typeof value.eligible === 'boolean'
        ? value.eligible
        : typeof value.isEligible === 'boolean'
          ? value.isEligible
          : null;
      const entries = firstNumber(
        value.entries,
        Array.isArray(value.entries) ? value.entries.length : null,
        value.entryCount,
        value.count
      );
      const summaryParts = [];
      if (eligible !== null) {
        summaryParts.push(eligible ? 'Eligible' : 'Not eligible');
      }
      if (entries !== null) {
        summaryParts.push(`${numberFormatter.format(entries)} entr${entries === 1 ? 'y' : 'ies'}`);
      }
      return {
        text: summaryParts.join(' • '),
        list,
        emptyMessage: list.length === 0 ? 'No weekly draw entries recorded yet.' : '',
        eligibleCount: typeof eligible === 'boolean'
          ? eligible
            ? Math.max(1, countEligibleEntries(value.weeks))
            : 0
          : countEligibleEntries(value.weeks),
        totalCount: list.length,
      };
    }
    if (typeof value === 'boolean') {
      return {
        text: value ? 'Eligible' : 'Not eligible',
        list: [],
        emptyMessage: '',
        eligibleCount: value ? 1 : 0,
        totalCount: value ? 1 : 0,
      };
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return {
        text: numberFormatter.format(value),
        list: [],
        emptyMessage: '',
        eligibleCount: null,
        totalCount: 0,
      };
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      const eligibility = inferEligibilityFromString(value);
      return {
        text: value,
        list: [],
        emptyMessage: '',
        eligibleCount: typeof eligibility === 'boolean' ? (eligibility ? 1 : 0) : null,
        totalCount: typeof eligibility === 'boolean' ? 1 : 0,
      };
    }
    return {
      text: '',
      list: [],
      emptyMessage: 'Weekly draw eligibility data is not available yet.',
      eligibleCount: null,
      totalCount: 0,
    };
  }

  function countEligibleEntries(items) {
    if (!Array.isArray(items)) {
      return 0;
    }
    return items.reduce((count, item) => {
      const eligibility = inferEligibility(item);
      return eligibility === true ? count + 1 : count;
    }, 0);
  }

  function inferEligibility(value) {
    if (value == null) {
      return null;
    }
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'object') {
      if (typeof value.eligible === 'boolean') {
        return value.eligible;
      }
      if (typeof value.isEligible === 'boolean') {
        return value.isEligible;
      }
      if (typeof value.status === 'string') {
        return inferEligibilityFromString(value.status);
      }
      if (typeof value.summary === 'string') {
        return inferEligibilityFromString(value.summary);
      }
      if (typeof value.description === 'string') {
        return inferEligibilityFromString(value.description);
      }
    }
    if (typeof value === 'string') {
      return inferEligibilityFromString(value);
    }
    return null;
  }

  function inferEligibilityFromString(text) {
    if (typeof text !== 'string') {
      return null;
    }
    const normalised = text.trim().toLowerCase();
    if (!normalised) {
      return null;
    }
    if (normalised.includes('not eligible')) {
      return false;
    }
    if (normalised.includes('eligible')) {
      return true;
    }
    return null;
  }

  function normaliseListItems(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((item) => normaliseListItem(item))
      .filter((item) => typeof item === 'string' && item.trim().length > 0);
  }

  function normaliseListItem(item) {
    if (item == null) {
      return null;
    }
    if (typeof item === 'string') {
      return item;
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      return numberFormatter.format(item);
    }
    if (typeof item === 'object') {
      if (typeof item.name === 'string' && item.name.trim()) {
        return item.name;
      }
      if (typeof item.title === 'string' && item.title.trim()) {
        return item.title;
      }
      if (typeof item.description === 'string' && item.description.trim()) {
        return item.description;
      }
      if (typeof item.value === 'string' && item.value.trim()) {
        return item.value;
      }
      if (typeof item.id === 'string' || typeof item.id === 'number') {
        return `ID ${item.id}`;
      }
      const week = selectFirst(item.week, item.weekNumber, item.id);
      const eligible = typeof item.eligible === 'boolean'
        ? item.eligible
        : typeof item.isEligible === 'boolean'
          ? item.isEligible
          : null;
      const entries = firstNumber(
        item.entries,
        Array.isArray(item.entries) ? item.entries.length : null,
        item.entryCount,
        item.count
      );
      const parts = [];
      if (week !== null && week !== undefined && week !== '') {
        parts.push(`Week ${week}`);
      }
      if (eligible !== null) {
        parts.push(eligible ? 'Eligible' : 'Not eligible');
      }
      if (entries !== null) {
        parts.push(`${numberFormatter.format(entries)} entr${entries === 1 ? 'y' : 'ies'}`);
      }
      if (parts.length > 0) {
        return parts.join(' • ');
      }
    }
    try {
      return JSON.stringify(item);
    } catch (error) {
      return String(item);
    }
  }

  function firstNumber(...candidates) {
    for (const candidate of candidates) {
      if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  function selectFirst(...candidates) {
    for (const candidate of candidates) {
      if (candidate === null || candidate === undefined) {
        continue;
      }
      if (typeof candidate === 'string' && candidate.trim().length === 0) {
        continue;
      }
      return candidate;
    }
    return null;
  }

  function formatNumberValue(value, fallback = 'Not available') {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return numberFormatter.format(value);
    }
    return fallback;
  }

  function createPrizeModal() {
    let modal = document.querySelector('[data-prize-modal]');
    if (!modal) {
      modal = document.createElement('div');
      modal.className = 'prize-modal';
      modal.hidden = true;
      modal.setAttribute('data-prize-modal', '');

      const overlay = document.createElement('div');
      overlay.className = 'prize-modal__overlay';
      overlay.setAttribute('data-prize-dismiss', '');
      overlay.setAttribute('aria-hidden', 'true');

      const dialog = document.createElement('div');
      dialog.className = 'prize-modal__dialog';
      dialog.setAttribute('data-prize-dialog', '');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'prize-modal-title');
      dialog.tabIndex = -1;

      const closeButton = document.createElement('button');
      closeButton.type = 'button';
      closeButton.className = 'prize-modal__close';
      closeButton.setAttribute('data-prize-dismiss', '');
      closeButton.setAttribute('data-prize-close', '');
      closeButton.setAttribute('aria-label', 'Close prize details');
      const closeIcon = document.createElement('span');
      closeIcon.setAttribute('aria-hidden', 'true');
      closeIcon.textContent = '×';
      closeButton.appendChild(closeIcon);

      const content = document.createElement('div');
      content.className = 'prize-modal__content';

      const titleElement = document.createElement('h2');
      titleElement.id = 'prize-modal-title';
      titleElement.setAttribute('data-prize-title', '');
      titleElement.textContent = 'Prize details';

      const bodyElement = document.createElement('div');
      bodyElement.className = 'prize-modal__body';
      bodyElement.setAttribute('data-prize-body', '');
      const loadingMessage = document.createElement('p');
      loadingMessage.className = 'prize-modal__message';
      loadingMessage.textContent = 'Loading prize details…';
      bodyElement.appendChild(loadingMessage);

      content.appendChild(titleElement);
      content.appendChild(bodyElement);

      dialog.appendChild(closeButton);
      dialog.appendChild(content);

      modal.appendChild(overlay);
      modal.appendChild(dialog);

      const host = document.body || root || document.documentElement;
      host.appendChild(modal);
    }

    const dialog = modal.querySelector('[data-prize-dialog]');
    const titleElement = modal.querySelector('[data-prize-title]');
    const bodyElement = modal.querySelector('[data-prize-body]');
    const dismissElements = modal.querySelectorAll('[data-prize-dismiss]');
    if (!dialog || !titleElement || !bodyElement) {
      return null;
    }
    let lastFocusedElement = null;
    let activeRequestId = 0;

    function cachePrizeDetails(week, details) {
      if (week === null || week === undefined) {
        return;
      }
      const cacheKey = String(week);
      try {
        prizeDetailsCache.set(cacheKey, details);
      } catch (error) {
        console.warn('[Algoland] Failed to cache prize details', error);
      }
    }

    function getCachedPrizeDetails(week) {
      if (week === null || week === undefined) {
        return null;
      }
      const cacheKey = String(week);
      return prizeDetailsCache.get(cacheKey) || null;
    }

    function open(week) {
      activeRequestId += 1;
      const requestId = activeRequestId;
      modal.hidden = false;
      modal.dataset.open = 'true';
      modal.dataset.week = String(week);
      document.body.classList.add('prize-modal-open');
      lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (titleElement) {
        titleElement.textContent = `Week ${week} prize`;
      }
      renderLoading();
      window.requestAnimationFrame(() => {
        const closeButton = modal.querySelector('[data-prize-close]');
        if (closeButton instanceof HTMLElement) {
          closeButton.focus();
        } else if (dialog instanceof HTMLElement) {
          dialog.focus();
        }
      });
      fetchPrizeDetails(week)
        .then((data) => {
          if (activeRequestId !== requestId) {
            return;
          }
          cachePrizeDetails(week, data);
          renderPrizeDetails(data, week);
        })
        .catch((error) => {
          if (activeRequestId !== requestId) {
            return;
          }
          console.warn('[Algoland] Failed to load prize details', error);
          const fallback = getCachedPrizeDetails(week);
          if (fallback) {
            renderPrizeDetails(fallback, week);
            renderFallbackNotice();
          } else {
            renderError();
          }
        });
    }

    function close() {
      if (modal.hidden) {
        return;
      }
      activeRequestId += 1;
      modal.hidden = true;
      modal.dataset.open = 'false';
      delete modal.dataset.week;
      document.body.classList.remove('prize-modal-open');
      if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
        lastFocusedElement.focus();
      }
    }

    function renderLoading() {
      if (!bodyElement) {
        return;
      }
      bodyElement.textContent = '';
      const paragraph = document.createElement('p');
      paragraph.className = 'prize-modal__message';
      paragraph.textContent = 'Loading prize details…';
      bodyElement.appendChild(paragraph);
    }

    function normaliseAssetId(value) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
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

    function collectPrizeAssetGroups({ winners, prizeAssets, mainAssetIds }) {
      const groups = new Map();
      const mainIds = Array.isArray(mainAssetIds)
        ? mainAssetIds
            .map((value) => normaliseAssetId(value))
            .filter((value) => value !== null)
        : [];

      function ensureGroup(assetId) {
        if (!groups.has(assetId)) {
          groups.set(assetId, {
            assetId,
            winners: [],
            asset: null,
          });
        }
        return groups.get(assetId);
      }

      prizeAssets.forEach((asset) => {
        const parsedId = normaliseAssetId(asset && asset.assetId);
        if (parsedId === null) {
          return;
        }
        const group = ensureGroup(parsedId);
        group.asset = asset;
      });

      winners.forEach((winner) => {
        if (!winner || typeof winner !== 'object') {
          return;
        }
        const available = Array.isArray(winner.availablePrizeAssetIds)
          ? winner.availablePrizeAssetIds
          : [];
        const claimed = Array.isArray(winner.claimedPrizeAssetIds)
          ? winner.claimedPrizeAssetIds
          : [];
        const allAssetIds = new Set();
        available.concat(claimed).forEach((value) => {
          const parsedId = normaliseAssetId(value);
          if (parsedId !== null) {
            allAssetIds.add(parsedId);
          }
        });
        if (allAssetIds.size === 0 && mainIds.length > 0) {
          mainIds.forEach((assetId) => {
            allAssetIds.add(assetId);
          });
        }
        allAssetIds.forEach((assetId) => {
          const group = ensureGroup(assetId);
          group.winners.push(winner);
        });
      });

      mainIds.forEach((assetId) => {
        if (!groups.has(assetId)) {
          groups.set(assetId, {
            assetId,
            winners: [],
            asset: null,
          });
        }
      });

      return groups;
    }

    function createWinnerStatus(winner, assetId) {
      const claimed = Array.isArray(winner.claimedPrizeAssetIds)
        ? winner.claimedPrizeAssetIds.some((value) => normaliseAssetId(value) === assetId)
        : false;
      const available = Array.isArray(winner.availablePrizeAssetIds)
        ? winner.availablePrizeAssetIds.some((value) => normaliseAssetId(value) === assetId)
        : false;
      if (claimed) {
        return { label: 'Claimed', modifier: 'claimed' };
      }
      if (available) {
        return { label: 'Awaiting claim', modifier: 'pending' };
      }
      return { label: 'Unassigned', modifier: 'unknown' };
    }

    function openWinnerProfile(winner) {
      if (!winner || !Number.isFinite(winner.relativeId)) {
        return;
      }
      const label = `Algoland ID ${winner.relativeId}`;
      handleReferralTagClick({
        lookupValue: String(winner.relativeId),
        lookupType: 'id',
        label,
      });
    }

    function createWinnerListItem(winner, assetId) {
      const item = document.createElement('li');
      item.className = 'prize-modal__winner';

      const header = document.createElement('div');
      header.className = 'prize-modal__winner-header';
      const idButton = document.createElement('button');
      idButton.type = 'button';
      idButton.className = 'prize-modal__winner-id';
      idButton.textContent = `Algoland ID ${winner.relativeId}`;
      idButton.addEventListener('click', () => {
        openWinnerProfile(winner);
      });
      header.appendChild(idButton);

      const status = createWinnerStatus(winner, assetId);
      if (status) {
        const statusElement = document.createElement('span');
        statusElement.className = 'prize-modal__winner-status';
        statusElement.textContent = status.label;
        statusElement.classList.add(`prize-modal__winner-status--${status.modifier}`);
        header.appendChild(statusElement);
      }

      item.appendChild(header);

      const address = document.createElement('p');
      address.className = 'prize-modal__winner-address';
      address.textContent = winner.address || 'Address unavailable';
      item.appendChild(address);

      const detailList = document.createElement('ul');
      detailList.className = 'prize-modal__winner-details';

      if (Number.isFinite(winner.weeklyDrawEntries)) {
        const entryItem = document.createElement('li');
        entryItem.textContent = `Draw entries: ${winner.weeklyDrawEntries}`;
        detailList.appendChild(entryItem);
      }

      if (Number.isFinite(winner.points)) {
        const pointsItem = document.createElement('li');
        pointsItem.textContent = `Points: ${winner.points}`;
        detailList.appendChild(pointsItem);
      }

      if (Number.isFinite(winner.numReferrals)) {
        const referralItem = document.createElement('li');
        referralItem.textContent = `Referrals: ${winner.numReferrals}`;
        detailList.appendChild(referralItem);
      }

      if (Array.isArray(winner.completedChallenges) && winner.completedChallenges.length > 0) {
        const challengesItem = document.createElement('li');
        challengesItem.textContent = `Challenges: ${winner.completedChallenges.join(', ')}`;
        detailList.appendChild(challengesItem);
      }

      if (Array.isArray(winner.completedQuests) && winner.completedQuests.length > 0) {
        const questsItem = document.createElement('li');
        questsItem.textContent = `Quests: ${winner.completedQuests.join(', ')}`;
        detailList.appendChild(questsItem);
      }

      if (detailList.children.length > 0) {
        item.appendChild(detailList);
      }

      return item;
    }

    function createWinnerContent(group) {
      const winners = Array.isArray(group?.winners) ? group.winners : [];
      if (winners.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'prize-modal__empty';
        empty.textContent = 'No VRF winners recorded yet.';
        return empty;
      }
      const list = document.createElement('ul');
      list.className = 'prize-modal__winner-list';
      winners.forEach((winner) => {
        list.appendChild(createWinnerListItem(winner, group.assetId));
      });
      return list;
    }

    function createClaimsContent(group) {
      const asset = group?.asset;
      if (!asset) {
        const empty = document.createElement('p');
        empty.className = 'prize-modal__empty';
        empty.textContent = 'No prize claim data available yet.';
        return empty;
      }
      if (asset.error) {
        const error = document.createElement('p');
        error.className = 'prize-modal__empty';
        error.textContent = asset.error;
        return error;
      }
      const holders = Array.isArray(asset.holders) ? asset.holders : [];
      if (holders.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'prize-modal__empty';
        empty.textContent = 'No wallets have claimed this prize yet.';
        return empty;
      }
      const list = document.createElement('ul');
      list.className = 'prize-modal__claim-list';
      holders.forEach((address, index) => {
        const amount = Array.isArray(asset.balances) && asset.balances[index]
          ? asset.balances[index].amount
          : null;
        const item = document.createElement('li');
        item.className = 'prize-modal__claim-item';
        item.textContent = amount ? `${address} (${amount})` : address;
        list.appendChild(item);
      });

      const container = document.createDocumentFragment();
      container.appendChild(list);

      const updatedLabel = formatPrizeTimestamp(asset.updatedAt);
      if (updatedLabel) {
        const meta = document.createElement('p');
        meta.className = 'prize-modal__meta';
        if (asset.stale) {
          meta.textContent = `Last updated ${updatedLabel} (stale)`;
        } else {
          meta.textContent = `Last updated ${updatedLabel}`;
        }
        container.appendChild(meta);
      }

      if (asset.meta && typeof asset.meta.uniqueHolders === 'number') {
        const countMeta = document.createElement('p');
        countMeta.className = 'prize-modal__meta';
        countMeta.textContent = `Claimed by ${asset.meta.uniqueHolders} wallet${asset.meta.uniqueHolders === 1 ? '' : 's'}`;
        container.appendChild(countMeta);
      }

      return container;
    }

    function buildPrizeGroupSection(group, headingPrefix) {
      const section = document.createElement('section');
      section.className = 'prize-modal__group';
      const heading = document.createElement('h3');
      heading.className = 'prize-modal__group-heading';
      if (group.assetId) {
        heading.textContent = `${headingPrefix} · ASA ${group.assetId}`;
      } else {
        heading.textContent = headingPrefix;
      }
      section.appendChild(heading);

      const winnersHeading = document.createElement('h4');
      winnersHeading.className = 'prize-modal__section-title';
      winnersHeading.textContent = 'VRF-selected winners';
      section.appendChild(winnersHeading);
      section.appendChild(createWinnerContent(group));

      const claimsHeading = document.createElement('h4');
      claimsHeading.className = 'prize-modal__section-title';
      claimsHeading.textContent = 'Prize claims';
      section.appendChild(claimsHeading);
      section.appendChild(createClaimsContent(group));

      return section;
    }

    function buildTabPanelContent(descriptor) {
      const panel = document.createElement('div');
      panel.className = 'prize-modal__tab-panel-inner';
      const groups = Array.isArray(descriptor?.groups) ? descriptor.groups : [];
      const visuals = Array.isArray(descriptor?.visuals) ? descriptor.visuals : [];

      if (visuals.length > 0) {
        const gallery = createPrizeGallery(visuals, { variant: 'inline' });
        if (gallery) {
          panel.appendChild(gallery);
        }
      }

      if (!descriptor || groups.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'prize-modal__empty';
        empty.textContent = descriptor && descriptor.emptyMessage
          ? descriptor.emptyMessage
          : 'No prize information is available yet.';
        panel.appendChild(empty);
        return panel;
      }
      groups.forEach((group) => {
        panel.appendChild(buildPrizeGroupSection(group, descriptor.headingPrefix));
      });
      return panel;
    }

    function createPrizeTabs(tabDescriptors) {
      const wrapper = document.createElement('div');
      wrapper.className = 'prize-modal__tabs';

      const buttonRow = document.createElement('div');
      buttonRow.className = 'prize-modal__tab-buttons';
      const panelsContainer = document.createElement('div');
      panelsContainer.className = 'prize-modal__tab-panels';

      let activeId = null;
      const buttons = new Map();
      const panels = new Map();

      function setActive(id) {
        if (!id || !buttons.has(id)) {
          return;
        }
        activeId = id;
        buttons.forEach((button, key) => {
          if (key === id) {
            button.classList.add('prize-modal__tab-button--active');
            button.setAttribute('aria-pressed', 'true');
          } else {
            button.classList.remove('prize-modal__tab-button--active');
            button.setAttribute('aria-pressed', 'false');
          }
        });
        panels.forEach((panel, key) => {
          panel.hidden = key !== id;
        });
      }

      tabDescriptors.forEach((descriptor) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'prize-modal__tab-button';
        button.textContent = descriptor.label;
        const hasGroups = Array.isArray(descriptor.groups) && descriptor.groups.length > 0;
        const hasVisuals = Array.isArray(descriptor.visuals) && descriptor.visuals.length > 0;
        const hasContent = hasGroups || hasVisuals;
        if (!hasContent) {
          button.disabled = true;
          button.classList.add('prize-modal__tab-button--disabled');
        }
        button.addEventListener('click', () => {
          if (button.disabled) {
            return;
          }
          setActive(descriptor.id);
        });
        buttons.set(descriptor.id, button);
        buttonRow.appendChild(button);

        const panel = document.createElement('div');
        panel.className = 'prize-modal__tab-panel';
        panel.setAttribute('data-prize-panel', descriptor.id);
        panel.appendChild(buildTabPanelContent(descriptor));
        panels.set(descriptor.id, panel);
        panelsContainer.appendChild(panel);
      });

      wrapper.appendChild(buttonRow);
      wrapper.appendChild(panelsContainer);

      const firstAvailable = tabDescriptors.find((descriptor) => {
        const hasGroups = Array.isArray(descriptor.groups) && descriptor.groups.length > 0;
        const hasVisuals = Array.isArray(descriptor.visuals) && descriptor.visuals.length > 0;
        return hasGroups || hasVisuals;
      }) || tabDescriptors[0];
      if (firstAvailable) {
        setActive(firstAvailable.id);
      }

      return wrapper;
    }

    function createPrizeGallery(items, { variant } = {}) {
      if (!Array.isArray(items) || items.length === 0) {
        return null;
      }
      const gallery = document.createElement('div');
      gallery.className = 'prize-modal__gallery';
      if (variant === 'inline') {
        gallery.classList.add('prize-modal__gallery--inline');
      }

      items.forEach((item) => {
        if (!item || typeof item !== 'object') {
          return;
        }
        const figure = document.createElement('figure');
        figure.className = 'prize-modal__gallery-item';

        if (item.image) {
          const image = document.createElement('img');
          image.className = 'prize-modal__gallery-image';
          image.src = buildPrizeImageUrl(item.image);
          image.alt = item.title ? item.title : 'Prize image';
          image.decoding = 'async';
          image.loading = 'lazy';
          figure.appendChild(image);
        }

        const captionParts = [];
        if (item.title) {
          captionParts.push(item.title);
        }
        if (item.asa || item.assetId) {
          const asaValue = item.asa || item.assetId;
          captionParts.push(`ASA ${asaValue}`);
        }
        if (captionParts.length > 0) {
          const caption = document.createElement('figcaption');
          caption.className = 'prize-modal__gallery-caption';
          caption.textContent = captionParts.join(' · ');
          figure.appendChild(caption);
        }

        if (figure.children.length > 0) {
          gallery.appendChild(figure);
        }
      });

      if (gallery.children.length === 0) {
        return null;
      }

      return gallery;
    }

    function renderPrizeDetails(data, week) {
      if (!bodyElement) {
        return;
      }
      if (!data || typeof data !== 'object') {
        renderError();
        return;
      }
      const selectedWinners = Array.isArray(data.selectedWinners) ? data.selectedWinners : [];
      const prizeAssets = Array.isArray(data.prizeAssets) ? data.prizeAssets : [];
      const mainPrizes = Array.isArray(data.mainPrizes) ? data.mainPrizes : [];
      const specialPrizes = Array.isArray(data.specialPrizes) ? data.specialPrizes : [];
      const mainAssetIds = Array.isArray(data.mainAssetIds)
        ? data.mainAssetIds
            .map((value) => normaliseAssetId(value))
            .filter((value) => value !== null)
        : [];
      const fallbackMainAssetId = normaliseAssetId(data.assetId);
      if (mainAssetIds.length === 0 && fallbackMainAssetId !== null) {
        mainAssetIds.push(fallbackMainAssetId);
      }
      if (mainAssetIds.length === 0 && mainPrizes.length > 0) {
        mainPrizes.forEach((item) => {
          const parsed = normaliseAssetId(item && item.assetId);
          if (parsed !== null && !mainAssetIds.includes(parsed)) {
            mainAssetIds.push(parsed);
          }
        });
      }
      const assetGroups = collectPrizeAssetGroups({
        winners: selectedWinners,
        prizeAssets,
        mainAssetIds,
      });
      const hasWinnerData = selectedWinners.length > 0;
      const hasAssetData = prizeAssets.length > 0;

      if (data.status === 'coming-soon' && !hasWinnerData && !hasAssetData) {
        renderComingSoon(data, week);
        return;
      }

      bodyElement.textContent = '';
      const fragment = document.createDocumentFragment();

      if (data.image && mainPrizes.length === 0) {
        const image = document.createElement('img');
        image.className = 'prize-modal__image';
        image.src = buildPrizeImageUrl(data.image);
        image.alt = `Week ${week} prize`;
        image.decoding = 'async';
        image.loading = 'lazy';
        fragment.appendChild(image);
      }

      const mainGallery = createPrizeGallery(mainPrizes);
      if (mainGallery) {
        fragment.appendChild(mainGallery);
      }

      if (data.asa) {
        const asaParagraph = document.createElement('p');
        asaParagraph.className = 'prize-modal__asa';
        asaParagraph.textContent = `Prize ASA: ${data.asa}`;
        fragment.appendChild(asaParagraph);
      }

      const overview = document.createElement('p');
      overview.className = 'prize-modal__message';
      overview.textContent = 'Select a prize category to review VRF winners and prize claims.';
      fragment.appendChild(overview);

      const mainGroups = mainAssetIds
        .map((assetId) => assetGroups.get(assetId))
        .filter((group) => Boolean(group));
      const specialGroups = Array.from(assetGroups.values()).filter((group) => {
        if (group.assetId === null) {
          return true;
        }
        return !mainAssetIds.includes(group.assetId);
      });

      const tabs = createPrizeTabs([
        {
          id: 'main',
          label: 'Main prize',
          headingPrefix: 'Main prize',
          groups: mainGroups,
          emptyMessage: 'No main prize winners have been recorded yet.',
        },
        {
          id: 'special',
          label: 'Special prizes',
          headingPrefix: 'Special prize',
          groups: specialGroups,
          emptyMessage: 'No special prize winners have been recorded yet.',
          visuals: specialPrizes,
        },
      ]);
      fragment.appendChild(tabs);

      const updatedLabel = formatPrizeTimestamp(data.updatedAt || data.draw?.fetchedAt);
      if (updatedLabel) {
        const meta = document.createElement('p');
        meta.className = 'prize-modal__meta';
        if (data.stale) {
          meta.textContent = `Last updated ${updatedLabel} (stale)`;
        } else {
          meta.textContent = `Last updated ${updatedLabel}`;
        }
        fragment.appendChild(meta);
      }

      const totalSelected = selectedWinners.length;
      if (totalSelected > 0) {
        const selectedMeta = document.createElement('p');
        selectedMeta.className = 'prize-modal__meta';
        selectedMeta.textContent = `VRF winners: ${totalSelected}`;
        fragment.appendChild(selectedMeta);
      }

      if (typeof data.winnersCount === 'number') {
        const countMeta = document.createElement('p');
        countMeta.className = 'prize-modal__meta';
        countMeta.textContent = `Prize claims recorded: ${data.winnersCount}`;
        fragment.appendChild(countMeta);
      }

      bodyElement.appendChild(fragment);
    }

    function renderComingSoon(data, week) {
      if (!bodyElement) {
        return;
      }
      bodyElement.textContent = '';
      const mainPrizes = Array.isArray(data?.mainPrizes) ? data.mainPrizes : [];
      if (data && data.image && mainPrizes.length === 0) {
        const image = document.createElement('img');
        image.className = 'prize-modal__image';
        image.src = buildPrizeImageUrl(data.image);
        image.alt = `Week ${week} prize`;
        image.decoding = 'async';
        image.loading = 'lazy';
        bodyElement.appendChild(image);
      }
      const gallery = createPrizeGallery(mainPrizes);
      if (gallery) {
        bodyElement.appendChild(gallery);
      }
      const message = document.createElement('p');
      message.className = 'prize-modal__message';
      const text = data && data.message ? data.message : 'Prize details coming soon. Check back soon.';
      message.textContent = text;
      bodyElement.appendChild(message);
      if (data && data.asa) {
        const asa = document.createElement('p');
        asa.className = 'prize-modal__asa';
        asa.textContent = `Prize ASA: ${data.asa}`;
        bodyElement.appendChild(asa);
      }
    }

    function renderFallbackNotice() {
      if (!bodyElement) {
        return;
      }
      const notice = document.createElement('p');
      notice.className = 'prize-modal__message';
      notice.textContent = 'Showing the most recently available prize details.';
      bodyElement.insertBefore(notice, bodyElement.firstChild);
    }

    function renderError() {
      if (!bodyElement) {
        return;
      }
      bodyElement.textContent = '';
      const message = document.createElement('p');
      message.className = 'prize-modal__message';
      message.textContent = 'Unable to load prize details right now. Please try again shortly.';
      bodyElement.appendChild(message);
    }

    dismissElements.forEach((element) => {
      element.addEventListener('click', (event) => {
        event.preventDefault();
        close();
      });
    });

    modal.addEventListener('click', (event) => {
      if (event.target === modal) {
        close();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && modal.dataset.open === 'true') {
        close();
      }
    });

    return { open, close };
  }

  function buildPrizeImageUrl(imageName) {
    if (!imageName) {
      return '';
    }
    if (typeof imageName !== 'string') {
      return '';
    }
    if (/^(https?:)?\/\//i.test(imageName) || imageName.startsWith('/')) {
      return imageName;
    }
    return `assets/${imageName}`;
  }

  function formatPrizeTimestamp(value) {
    if (!value) {
      return '';
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return '';
    }
    return parsed.toLocaleString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZoneName: 'short',
    });
  }
})();
