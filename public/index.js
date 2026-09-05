// Base URL for analyzed data (points to reverse proxy worker / bucket)
const DATA_BASE_URL = 'https://royal-tooth-f2a6.razor-orange.workers.dev';

let chart = null;
let rawGroupData = null;
let currentData = null;
const cachedGroupData = {};

let savedUserCurrency = 'EUR';
let savedUserPlatform = 'ALL';
let savedUserOrderType = 'sell';
let selectedTimeRange = 'ALL';

const PALETTES = {
    dark: ['#60a5fa', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#f472b6', '#38bdf8'],
    light: ['#2563eb', '#059669', '#d97706', '#dc2626', '#7c3aed', '#db2777', '#0284c7'],
    'vaporwave-dark': ['#00f5ff', '#00ffb2', '#ffd93d', '#ff4d8d', '#a020f0', '#ff2e97', '#7fdcff'],
    'vaporwave-light': ['#067083', '#0d9e78', '#e8a716', '#d63384', '#7b2ff7', '#e0198a', '#3f8ea8'],
};

const ICON_SUN = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`;
const ICON_MOON = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;
const ICON_CLIPBOARD = `<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
const ICON_CHECK = `<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
const ICON_INFO = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;

function toggleTheme() {
    const isLight = document.body.classList.toggle('light-mode');
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
    updateThemeUI(isLight);

    // Fast repaint with existing data — no network refetch needed
    if (currentData && currentData.length > 0) {
        renderChart();
    }
}

function updateThemeUI(isLight) {
    const iconEl = document.getElementById('themeIcon');
    if (iconEl) iconEl.innerHTML = isLight ? ICON_MOON : ICON_SUN;
    document.getElementById('themeText').textContent = isLight ? 'Dark' : 'Light';
}

function initTheme() {
    const saved = localStorage.getItem('theme');
    const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    const isLight = saved === 'light' || (!saved && prefersLight);

    if (isLight) {
        document.body.classList.add('light-mode');
    }
    updateThemeUI(isLight);
}

const SKINS = ['modern', 'vaporwave'];

function applySkin(skin) {
    const modernLink = document.getElementById('skinModern');
    const vaporwaveLink = document.getElementById('skinVaporwave');
    if (!modernLink || !vaporwaveLink) return;

    modernLink.disabled = skin !== 'modern';
    vaporwaveLink.disabled = skin !== 'vaporwave';
    document.body.dataset.skin = skin;

    const textEl = document.getElementById('skinText');
    if (textEl) textEl.textContent = skin === 'modern' ? 'Retro' : 'Modern';

    // Chart colors are set inline per-render, so they need a repaint on skin change too
    if (currentData && currentData.length > 0) {
        renderChart();
    }
}

function toggleSkin() {
    const current = document.body.dataset.skin || 'modern';
    const next = current === 'modern' ? 'vaporwave' : 'modern';
    localStorage.setItem('skin', next);
    applySkin(next);
}

function initSkin() {
    const saved = localStorage.getItem('skin');
    const skin = SKINS.includes(saved) ? saved : 'modern';
    applySkin(skin);
}

function getFilters() {
    const platEl = document.getElementById('platform');
    return {
        currency: document.getElementById('currency').value,
        platform: platEl ? platEl.value : 'ALL',
        orderType: document.getElementById('orderType').value,
        groupBy: document.getElementById('groupBy').value,
        metric: document.getElementById('metric').value,
        aggType: document.getElementById('aggType').value,
        timeRange: selectedTimeRange,
        isLight: document.body.classList.contains('light-mode'),
        skin: document.body.dataset.skin || 'modern',
    };
}

function updateFilterControlsUI() {
    const groupBy = document.getElementById('groupBy').value;
    const curSelect = document.getElementById('currency');
    const platSelect = document.getElementById('platform');
    const typeSelect = document.getElementById('orderType');
    const chipsContainer = document.getElementById('currencyChips');
    const curLabel = document.getElementById('currencyLabel');
    const platLabel = document.getElementById('platformLabel');
    const typeLabel = document.getElementById('orderTypeLabel');

    // Currency filter control
    if (groupBy === 'currency') {
        if (!curSelect.disabled) {
            savedUserCurrency = curSelect.value;
        }
        curSelect.disabled = true;
        curSelect.value = 'ALL';
        if (curLabel) curLabel.textContent = 'Currency (Grouped)';
        if (chipsContainer) chipsContainer.classList.add('disabled');
    } else {
        if (curSelect.disabled) {
            curSelect.disabled = false;
            curSelect.value = savedUserCurrency;
        }
        if (curLabel) curLabel.textContent = 'Currency';
        if (chipsContainer) chipsContainer.classList.remove('disabled');
    }

    // Platform filter control
    if (platSelect) {
        if (groupBy === 'platform') {
            if (!platSelect.disabled) {
                savedUserPlatform = platSelect.value;
            }
            platSelect.disabled = true;
            platSelect.value = 'ALL';
            if (platLabel) platLabel.textContent = 'Platform (Grouped)';
        } else {
            if (platSelect.disabled) {
                platSelect.disabled = false;
                platSelect.value = savedUserPlatform;
            }
            if (platLabel) platLabel.textContent = 'Platform';
        }
    }

    // Order type filter control
    if (groupBy === 'order_type') {
        if (!typeSelect.disabled) {
            savedUserOrderType = typeSelect.value;
        }
        typeSelect.disabled = true;
        typeSelect.value = 'ALL';
        if (typeLabel) typeLabel.textContent = 'Order Type (Grouped)';
    } else {
        if (typeSelect.disabled) {
            typeSelect.disabled = false;
            typeSelect.value = savedUserOrderType;
        }
        if (typeLabel) typeLabel.textContent = 'Order Type';
    }

    updateChips(curSelect.value);
}

function updateChips(selectedCurrency) {
    document.querySelectorAll('.chip').forEach(chip => {
        const isMatch = chip.getAttribute('data-cur') === selectedCurrency;
        chip.classList.toggle('active', isMatch);
    });
}

function quickSelectCurrency(currency) {
    const curSelect = document.getElementById('currency');
    if (curSelect.disabled) return;
    curSelect.value = currency;
    savedUserCurrency = currency;
    updateChips(currency);
    applyFiltersAndRender();
}

function onCurrencySelectChange() {
    const currency = document.getElementById('currency').value;
    savedUserCurrency = currency;
    updateChips(currency);
    applyFiltersAndRender();
}

function onPlatformSelectChange() {
    const platform = document.getElementById('platform').value;
    savedUserPlatform = platform;
    applyFiltersAndRender();
}

function onOrderTypeChange() {
    const orderType = document.getElementById('orderType').value;
    savedUserOrderType = orderType;
    applyFiltersAndRender();
}

function onGroupByChange() {
    fetchAndDraw();
}

function onAnalyticsOptionChange() {
    renderChart();
}

function selectTimeRange(range) {
    selectedTimeRange = range;
    document.querySelectorAll('.range-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-range') === range);
    });
    renderChart();
}

function showOverlay(message) {
    document.getElementById('overlayText').textContent = message;
    document.getElementById('overlayMsg').classList.add('active');
}

function hideOverlay() {
    document.getElementById('overlayMsg').classList.remove('active');
}

function updateFilterHint() {
    const hintEl = document.getElementById('filterHint');
    if (!hintEl) return;

    const isVapor = hintEl.classList.contains('filter-hint-retro') || window.location.pathname.includes('vaporwave');
    const { currency, platform, orderType } = getFilters();
    const curLabel = currency === 'ALL' ? 'local fiat' : currency;
    const platLabel = platform === 'ALL' ? 'RoboSats & P2P platforms' : platform.toUpperCase();
    const prefix = isVapor ? '<span class="hint-tag">[INFO]</span>' : ICON_INFO;

    if (orderType === 'buy') {
        hintEl.innerHTML = `${prefix} <span><strong>Taker Buys BTC:</strong> Offers where you pay ${escapeHtml(curLabel)} to receive Bitcoin into your Lightning wallet via ${escapeHtml(platLabel)}.</span>`;
    } else if (orderType === 'sell') {
        hintEl.innerHTML = `${prefix} <span><strong>Taker Sells BTC:</strong> Offers where you send Bitcoin to receive ${escapeHtml(curLabel)} via payment transfer on ${escapeHtml(platLabel)}.</span>`;
    } else {
        hintEl.innerHTML = `${prefix} <span><strong>All Orders:</strong> Showing both Buy and Sell offers across ${escapeHtml(platLabel)} in ${escapeHtml(curLabel)}.</span>`;
    }
}

function applyFiltersAndRender() {
    updateFilterControlsUI();
    updateFilterHint();

    if (!rawGroupData || rawGroupData.length === 0) {
        currentData = null;
        resetKPIs();
        if (chart) {
            chart.destroy();
            chart = null;
        }
        return;
    }

    const { currency, platform, orderType, groupBy } = getFilters();

    let filtered = rawGroupData;
    if (groupBy !== 'currency' && currency !== 'ALL') {
        filtered = filtered.filter(row => row.currency === currency);
    }
    if (groupBy !== 'platform' && platform !== 'ALL') {
        filtered = filtered.filter(row => row.platform === platform);
    }
    if (groupBy !== 'order_type' && orderType !== 'ALL') {
        filtered = filtered.filter(row => row.order_type === orderType);
    }

    currentData = filtered;

    if (currentData.length === 0) {
        showOverlay('No records match current filter selection');
        resetKPIs();
        if (chart) {
            chart.destroy();
            chart = null;
        }
        return;
    }

    hideOverlay();
    updateKPIs(currentData);
    renderChart();
}

async function fetchAndDraw(forceRefetch = false) {
    updateFilterControlsUI();
    const { groupBy } = getFilters();

    if (!forceRefetch && cachedGroupData[groupBy]) {
        rawGroupData = cachedGroupData[groupBy];
        applyFiltersAndRender();
        return;
    }

    const fileUrl = `${DATA_BASE_URL}/analyzed/rolling_premium_${groupBy}.json`;
    showOverlay('Loading dataset...');

    try {
        const response = await fetch(fileUrl);
        if (!response.ok) {
            throw new Error(`Data not available for ${groupBy}`);
        }

        const data = await response.json();
        if (!Array.isArray(data) || data.length === 0) {
            throw new Error(`No records found for ${groupBy}`);
        }

        cachedGroupData[groupBy] = data;
        rawGroupData = data;
        hideOverlay();
        applyFiltersAndRender();

    } catch (err) {
        rawGroupData = null;
        currentData = null;
        showOverlay(err.message || 'Failed to load dataset');
        resetKPIs();
        if (chart) {
            chart.destroy();
            chart = null;
        }
    }
}

function formatPercent(value) {
    if (value == null || isNaN(value)) return '--';
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(2)}%`;
}

function parseUtcDate(isoString) {
    if (!isoString) return null;
    let s = String(isoString).trim();
    if (!s) return null;
    if (!s.endsWith('Z') && !/[+-]\d{2}:?\d{2}$/.test(s)) {
        s += 'Z';
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
}

function formatDateTime(isoString) {
    const date = parseUtcDate(isoString);
    if (!date) return '--';
    const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `${dateStr} ${timeStr}`;
}

function formatFullDateTime(isoString) {
    const date = parseUtcDate(isoString);
    if (!date) return '--';
    return date.toLocaleString([], {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short'
    });
}

function formatDuration(ms) {
    if (ms == null || isNaN(ms) || ms < 0) return null;
    const totalSecs = Math.floor(ms / 1000);
    const hours = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;
    if (hours > 0) return `${hours}h ${mins}m`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
}

function getOrderLastSeen(order) {
    if (!order || order.last_seen == null) {
        throw new Error(`Missing required 'last_seen' field on order ${order ? order.order_id : 'unknown'}`);
    }
    const d = parseUtcDate(order.last_seen);
    if (!d) {
        throw new Error(`Invalid 'last_seen' timestamp on order ${order.order_id}: ${order.last_seen}`);
    }
    return d.getTime();
}

function computeGlobal24hOrders(cutoff24h) {
    if (!allOrders || allOrders.length === 0) return null;
    return allOrders.filter(o => getOrderLastSeen(o) >= cutoff24h).length;
}

function formatBitcoinSum(sats, unit) {
    const ticker = unit || 'BTC';
    const btc = sats / 100000000;
    if (btc >= 0.01) {
        return `${btc.toFixed(3)} ${ticker}`;
    }
    return `${Math.round(sats).toLocaleString()} sats`;
}

function updateKPIs(data) {
    const { currency, platform, orderType, groupBy } = getFilters();
    const now = Date.now();
    const cutoff24h = now - (24 * 60 * 60 * 1000);

    // Filter unique active 24h orders for active filter selection
    let count24h = 0;
    let activeOrders24h = [];

    if (allOrders.length > 0) {
        activeOrders24h = allOrders.filter(o => {
            if (groupBy !== 'currency' && currency !== 'ALL' && o.currency !== currency) return false;
            if (groupBy !== 'platform' && platform !== 'ALL' && o.platform !== platform) return false;
            if (groupBy !== 'order_type' && orderType !== 'ALL' && o.order_type !== orderType) return false;
            return getOrderLastSeen(o) >= cutoff24h;
        });
        count24h = activeOrders24h.length;
    }

    const globalCount = computeGlobal24hOrders(cutoff24h);

    // Compute 24h trade volume (successful orders only)
    const successOrders24h = activeOrders24h.filter(o => o.status === 'success');
    let totalSats = 0;
    let totalFiat = 0;
    let hasFiat = false;

    const isAllCurrencies = (currency === 'ALL' || groupBy === 'currency');

    successOrders24h.forEach(o => {
        if (isAllCurrencies) {
            if (o.amount_sats > 0) totalSats += o.amount_sats;
        } else {
            if (o.amount > 0) totalSats += Number(o.amount);
            if (Array.isArray(o.fiat_amount)) {
                totalFiat += (Number(o.fiat_amount[0]) + Number(o.fiat_amount[1])) / 2;
                hasFiat = true;
            } else if (o.fiat_amount) {
                totalFiat += Number(o.fiat_amount);
                hasFiat = true;
            }
        }
    });

    const volCountStr = `${successOrders24h.length} successful order${successOrders24h.length === 1 ? '' : 's'}`;
    let volMainStr = '--';
    let volSubStr = successOrders24h.length > 0 ? volCountStr : '24h active window';
    if (totalSats > 0) {
        volMainStr = formatBitcoinSum(totalSats);
        const maxFiatDecimals = (currency === 'BTC' || currency === 'L-BTC') ? 4 : 0;
        volSubStr = (hasFiat && currency !== 'ALL')
            ? `≈ ${totalFiat.toLocaleString(undefined, { maximumFractionDigits: maxFiatDecimals })} ${currency}`
            : volCountStr;
    } else if (hasFiat && currency !== 'ALL') {
        if (currency === 'BTC' || currency === 'L-BTC') {
            volMainStr = formatBitcoinSum(totalFiat * 100000000, currency);
        } else {
            volMainStr = `${totalFiat.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${currency}`;
        }
        volSubStr = volCountStr;
    }

    const volEl = document.getElementById('statVolume24h');
    const volSubEl = document.getElementById('statVolume24hSub');
    if (volEl) volEl.textContent = volMainStr;
    if (volSubEl) volSubEl.textContent = volSubStr;

    // Compute buy / sell spread
    const spreadOrders = allOrders.filter(o => {
        if (groupBy !== 'currency' && currency !== 'ALL' && o.currency !== currency) return false;
        if (groupBy !== 'platform' && platform !== 'ALL' && o.platform !== platform) return false;
        return getOrderLastSeen(o) >= cutoff24h && o.premium != null && !isNaN(o.premium);
    });

    const buyPremiums = spreadOrders.filter(o => o.order_type === 'buy').map(o => Number(o.premium));
    const sellPremiums = spreadOrders.filter(o => o.order_type === 'sell').map(o => Number(o.premium));

    function calcMedian(arr) {
        if (!arr || arr.length === 0) return null;
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    const medBuy = calcMedian(buyPremiums);
    const medSell = calcMedian(sellPremiums);

    let spreadMainStr = '--';
    let spreadSubStr = 'Buy vs Sell premium';
    if (medBuy != null && medSell != null) {
        const spreadVal = medBuy - medSell;
        spreadMainStr = `${spreadVal >= 0 ? '+' : ''}${spreadVal.toFixed(2)}%`;
        spreadSubStr = `Buy ${formatPercent(medBuy)} | Sell ${formatPercent(medSell)}`;
    } else if (medBuy != null) {
        spreadMainStr = formatPercent(medBuy);
        spreadSubStr = 'Buy offers only';
    } else if (medSell != null) {
        spreadMainStr = formatPercent(medSell);
        spreadSubStr = 'Sell offers only';
    }

    const spreadEl = document.getElementById('statSpread');
    const spreadSubEl = document.getElementById('statSpreadSub');
    if (spreadEl) spreadEl.textContent = spreadMainStr;
    if (spreadSubEl) spreadSubEl.textContent = spreadSubStr;

    // Extract latest timestamp from rolling metric series
    const timestamps = data
        .map(r => (r && r.first_seen ? (parseUtcDate(r.first_seen)?.getTime() ?? null) : null))
        .filter(t => t != null && !isNaN(t));
    let lastUpdateStr = timestamps.length > 0 ? formatDateTime(new Date(Math.max(...timestamps)).toISOString()) : '--';

    const curLabel = (groupBy === 'currency') ? 'All Currencies' : (currency === 'ALL' ? 'All Currencies' : currency);
    const typeLabel = (groupBy === 'order_type') ? 'All Types' : (orderType === 'ALL' ? 'All Types' : orderType.toUpperCase());

    const global24hText = globalCount != null
        ? `Global: ${globalCount.toLocaleString()} total`
        : `${curLabel} (${typeLabel})`;

    document.getElementById('statOrders24h').textContent = count24h.toLocaleString();
    document.getElementById('statOrders24hSub').textContent = global24hText;

    // Rolling premium metrics
    const latest = data[data.length - 1];
    if (latest) {
        document.getElementById('statMedianPremium').textContent = formatPercent(latest.median);

        const medCard = document.getElementById('statMedianPremium').parentElement;
        medCard.classList.remove('green', 'red');
        if (latest.median > 0) medCard.classList.add('green');
        else if (latest.median < 0) medCard.classList.add('red');
    }

    // Data point totals
    document.getElementById('statDataPoints').textContent = data.length.toLocaleString();
    document.getElementById('statLastUpdate').textContent = `Latest: ${lastUpdateStr}`;
}

function resetKPIs() {
    document.getElementById('statOrders24h').textContent = '0';
    document.getElementById('statOrders24hSub').textContent = 'No data in active filter';
    const volEl = document.getElementById('statVolume24h');
    const volSubEl = document.getElementById('statVolume24hSub');
    if (volEl) volEl.textContent = '--';
    if (volSubEl) volSubEl.textContent = '24h active window';
    const spreadEl = document.getElementById('statSpread');
    const spreadSubEl = document.getElementById('statSpreadSub');
    if (spreadEl) spreadEl.textContent = '--';
    if (spreadSubEl) spreadSubEl.textContent = 'Buy vs Sell premium';
    document.getElementById('statMedianPremium').textContent = '--';
    document.getElementById('statDataPoints').textContent = '0';
    document.getElementById('statLastUpdate').textContent = 'Latest: --';
}

let highlightedDatasetIndex = null;

function hexToRgba(hex, alpha) {
    if (!hex || hex[0] !== '#') return hex;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function dimOtherDatasets(chartInstance, activeIndex) {
    if (highlightedDatasetIndex === activeIndex) return;
    highlightedDatasetIndex = activeIndex;

    chartInstance.data.datasets.forEach((ds, i) => {
        if (!ds._baseBorderColor) ds._baseBorderColor = ds.borderColor;
        const isBaseline = ds.label && ds.label.includes('Spot Baseline');
        if (i === activeIndex) {
            ds.borderColor = ds._baseBorderColor;
            ds.borderWidth = 3;
            ds.order = -1;
        } else {
            ds.borderColor = isBaseline ? ds._baseBorderColor : hexToRgba(ds._baseBorderColor, 0.15);
            ds.borderWidth = 2;
            ds.order = 0;
        }
    });
    chartInstance.update('none');
}

function resetDatasetOpacity(chartInstance) {
    if (highlightedDatasetIndex === null) return;
    highlightedDatasetIndex = null;

    chartInstance.data.datasets.forEach(ds => {
        if (ds._baseBorderColor) {
            ds.borderColor = ds._baseBorderColor;
        }
        ds.borderWidth = ds.label && ds.label.includes('Spot Baseline') ? 1.5 : 2;
        ds.order = ds.label && ds.label.includes('Spot Baseline') ? 999 : 0;
    });
    chartInstance.update('none');
}

function renderChart() {
    if (!currentData || currentData.length === 0) return;

    const { currency, platform, orderType, groupBy, metric, aggType, timeRange, isLight, skin } = getFilters();

    // Filter rows by active time range (24h / 7d / 30d / All)
    let chartRows = currentData;
    if (timeRange && timeRange !== 'ALL') {
        const now = Date.now();
        let rangeMs = 0;
        if (timeRange === '24h') rangeMs = 24 * 60 * 60 * 1000;
        else if (timeRange === '7d') rangeMs = 7 * 24 * 60 * 60 * 1000;
        else if (timeRange === '30d') rangeMs = 30 * 24 * 60 * 60 * 1000;

        if (rangeMs > 0) {
            const cutoff = now - rangeMs;
            chartRows = chartRows.filter(r => (parseUtcDate(r.first_seen)?.getTime() ?? 0) >= cutoff);
        }
    }

    if (chartRows.length === 0) {
        showOverlay('No data in selected time range');
        if (chart) {
            chart.destroy();
            chart = null;
        }
        return;
    }
    hideOverlay();

    // Extract unique timestamps and format labels for X-axis
    const timestamps = [...new Set(chartRows.map(row => row.first_seen))].sort();
    const labels = timestamps.map(formatDateTime);

    // Group rows into distinct series by category (Platform, Payment Method, etc.)
    const grouped = {};
    chartRows.forEach(row => {
        const category = row[groupBy] || 'All';
        if (!grouped[category]) grouped[category] = {};
        grouped[category][row.first_seen] = row[aggType];
    });

    // Build Chart.js datasets with theme palette
    const isVaporwave = skin === 'vaporwave';
    const paletteKey = isVaporwave ? (isLight ? 'vaporwave-light' : 'vaporwave-dark') : (isLight ? 'light' : 'dark');
    const palette = PALETTES[paletteKey];
    const datasets = Object.keys(grouped).map((category, idx) => {
        const color = palette[idx % palette.length];
        return {
            label: category,
            data: timestamps.map(ts => grouped[category][ts] ?? null),
            borderColor: color,
            backgroundColor: color,
            borderWidth: 2,
            tension: 0.4,
            cubicInterpolationMode: 'monotone',
            fill: false,
            spanGaps: true,
            pointRadius: timestamps.length > 50 ? 0 : 2,
            pointHoverRadius: 5,
            pointHoverBorderWidth: 2,
        };
    });

    // 0.00% Baseline Reference Line (Spot price) for premium metric
    if (metric === 'premium' && timestamps.length > 0) {
        const baselineColor = isVaporwave
            ? (isLight ? 'rgba(123, 47, 247, 0.45)' : 'rgba(184, 164, 232, 0.4)')
            : (isLight ? 'rgba(100, 116, 139, 0.45)' : 'rgba(156, 163, 175, 0.35)');
        datasets.push({
            label: '0.00% Spot Baseline',
            data: timestamps.map(() => 0),
            borderColor: baselineColor,
            borderWidth: 1.5,
            borderDash: [5, 5],
            pointRadius: 0,
            pointHoverRadius: 0,
            fill: false,
            order: 999,
        });
    }

    // Titles and axis labels
    const aggTitle = aggType.charAt(0).toUpperCase() + aggType.slice(1);
    const metricTitle = metric.charAt(0).toUpperCase() + metric.slice(1);
    const yLabel = aggType === 'count' ? 'Order Volume' : `${aggTitle} ${metricTitle} (%)`;

    const curDisplay = (groupBy === 'currency') ? 'All Currencies' : (currency === 'ALL' ? 'All Currencies' : currency);
    const platDisplay = (groupBy === 'platform' || platform === 'ALL') ? '' : `[${platform}] `;
    const typeDisplay = (groupBy === 'order_type') ? 'All Types' : (orderType === 'ALL' ? 'All Types' : orderType.toUpperCase());
    const rangeDisplay = (timeRange && timeRange !== 'ALL') ? ` (${timeRange})` : '';

    document.getElementById('chartTitle').textContent =
        `${platDisplay}${curDisplay} ${typeDisplay} - 12h Rolling ${metricTitle} (${aggTitle})${rangeDisplay}`;

    const textColor = isVaporwave
        ? (isLight ? '#8654b8' : '#b8a4e8')
        : (isLight ? '#475569' : '#9ca3af');
    const gridColor = isVaporwave
        ? (isLight ? 'rgba(123, 47, 247, 0.12)' : 'rgba(255, 46, 151, 0.12)')
        : (isLight ? '#f1f5f9' : '#1f293d');

    const canvas = document.getElementById('mainChart');
    const ctx = canvas.getContext('2d');
    if (chart) {
        chart.destroy();
    }
    highlightedDatasetIndex = null;
    canvas.onmouseleave = () => {
        if (chart) {
            resetDatasetOpacity(chart);
        }
    };

    chart = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 200 },
            interaction: {
                mode: 'index',
                intersect: false,
            },
            onHover: (evt, activeElements, chartInstance) => {
                if (evt.type === 'mouseout') {
                    resetDatasetOpacity(chartInstance);
                    return;
                }
                const nearest = chartInstance.getElementsAtEventForMode(
                    evt, 'nearest', { intersect: false, axis: 'xy' }, false
                );
                if (nearest.length > 0) {
                    dimOtherDatasets(chartInstance, nearest[0].datasetIndex);
                } else {
                    resetDatasetOpacity(chartInstance);
                }
            },
            plugins: {
                legend: {
                    position: 'top',
                    align: 'end',
                    onHover: (evt, legendItem, legend) => {
                        legend.chart.canvas.style.cursor = 'pointer';
                        dimOtherDatasets(legend.chart, legendItem.datasetIndex);
                    },
                    onLeave: (evt, legendItem, legend) => {
                        legend.chart.canvas.style.cursor = 'default';
                        resetDatasetOpacity(legend.chart);
                    },
                    labels: {
                        color: textColor,
                        boxWidth: 12,
                        boxHeight: 12,
                        usePointStyle: true,
                        font: { size: 11, family: 'system-ui' },
                    },
                },
                tooltip: {
                    backgroundColor: isVaporwave
                        ? (isLight ? '#fff0fb' : '#1a0b3d')
                        : (isLight ? '#ffffff' : '#111827'),
                    titleColor: isVaporwave
                        ? (isLight ? '#3a0d5e' : '#f5f0ff')
                        : (isLight ? '#0f172a' : '#f3f4f6'),
                    bodyColor: isVaporwave
                        ? (isLight ? '#8654b8' : '#b8a4e8')
                        : (isLight ? '#334155' : '#e5e7eb'),
                    borderColor: isVaporwave
                        ? (isLight ? '#e0198a' : '#ff2e97')
                        : (isLight ? '#cbd5e1' : '#374151'),
                    borderWidth: 1,
                    padding: 10,
                    callbacks: {
                        label: (item) => {
                            const val = item.raw;
                            if (val == null) return `${item.dataset.label}: --`;
                            const formatted = aggType === 'count' ? `${val}` : `${val > 0 ? '+' : ''}${val.toFixed(2)}%`;
                            return `${item.dataset.label}: ${formatted}`;
                        },
                    },
                },
            },
            scales: {
                x: {
                    ticks: {
                        color: textColor,
                        maxTicksLimit: 8,
                        font: { size: 11 },
                    },
                    grid: { color: gridColor },
                },
                y: {
                    title: {
                        display: true,
                        text: yLabel,
                        color: textColor,
                        font: { size: 12, weight: 'bold' },
                    },
                    ticks: {
                        color: textColor,
                        font: { size: 11 },
                    },
                    grid: { color: gridColor },
                },
            },
        },
    });
}

let allOrders = [];
let filteredOrders = [];
let ordersPage = 1;
const ORDERS_PER_PAGE = 25;
let sortColumn = 'first_seen';
let sortDirection = 'desc';

async function fetchOrders() {
    try {
        const res = await fetch(`${DATA_BASE_URL}/analyzed/orders.json`);
        if (!res.ok) throw new Error('Orders not available');
        allOrders = await res.json();
        if (!Array.isArray(allOrders)) allOrders = [];
    } catch {
        allOrders = [];
    }
    if (currentData) {
        updateKPIs(currentData);
    }
    filterAndRenderOrders();
}

function onOrdersFilterChange() {
    const statusSelect = document.getElementById('orderListStatus');
    const pendingBtn = document.getElementById('pendingToggleBtn');
    if (statusSelect && pendingBtn) {
        pendingBtn.classList.toggle('active', statusSelect.value === 'pending');
    }
    ordersPage = 1;
    filterAndRenderOrders();
}

function togglePendingOnly() {
    const statusSelect = document.getElementById('orderListStatus');
    const pendingBtn = document.getElementById('pendingToggleBtn');
    if (!statusSelect) return;

    if (statusSelect.value === 'pending') {
        statusSelect.value = 'ALL';
        if (pendingBtn) pendingBtn.classList.remove('active');
    } else {
        statusSelect.value = 'pending';
        if (pendingBtn) pendingBtn.classList.add('active');
    }
    onOrdersFilterChange();
}

function onOrdersSearchChange() {
    ordersPage = 1;
    filterAndRenderOrders();
}

function sortOrders(column) {
    if (sortColumn === column) {
        sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        sortColumn = column;
        sortDirection = (column === 'premium' || column === 'fiat_amount' || column === 'bond') ? 'asc' : 'desc';
    }

    // Update UI headers
    document.querySelectorAll('.orders-table th.sortable').forEach(th => {
        const col = th.getAttribute('data-col');
        const icon = document.getElementById(`sort-${col}`);
        if (col === sortColumn) {
            th.classList.add('sorted');
            if (icon) icon.textContent = sortDirection === 'asc' ? '▲' : '▼';
        } else {
            th.classList.remove('sorted');
            if (icon) icon.textContent = '↕';
        }
    });

    filterAndRenderOrders();
}

async function copyOrderId(orderId, btnElement) {
    if (!orderId) return;
    try {
        await navigator.clipboard.writeText(orderId);
        if (btnElement) {
            btnElement.innerHTML = ICON_CHECK;
            btnElement.classList.add('copied');
            setTimeout(() => {
                btnElement.innerHTML = ICON_CLIPBOARD;
                btnElement.classList.remove('copied');
            }, 1200);
        }
    } catch {
        // Fallback prompt if clipboard API is unavailable
        prompt('Order ID:', orderId);
    }
}

function getFiatSortValue(fiatAmount) {
    if (fiatAmount == null) return -Infinity;
    if (Array.isArray(fiatAmount) && fiatAmount.length > 0) {
        const num = Number(fiatAmount[0]);
        return isNaN(num) ? -Infinity : num;
    }
    if (typeof fiatAmount === 'string') {
        const first = fiatAmount.split(/[,-]/)[0];
        const num = Number(first.trim());
        return isNaN(num) ? -Infinity : num;
    }
    const num = Number(fiatAmount);
    return isNaN(num) ? -Infinity : num;
}

function formatFiatValue(val, currency) {
    if (isNaN(val)) return '';
    const maxDigits = (currency === 'BTC' || currency === 'L-BTC' || (val !== 0 && Math.abs(val) < 1)) ? 8 : 2;
    return val.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: maxDigits });
}

function formatFiatDisplay(fiatAmount, currency) {
    if (fiatAmount == null || fiatAmount === '') return '--';

    let parts = [];
    if (Array.isArray(fiatAmount)) {
        parts = fiatAmount;
    } else if (typeof fiatAmount === 'string' && fiatAmount.includes(',')) {
        parts = fiatAmount.split(',').map(s => s.trim());
    } else if (typeof fiatAmount === 'string' && fiatAmount.includes(' - ')) {
        parts = fiatAmount.split(' - ').map(s => s.trim());
    } else {
        parts = [fiatAmount];
    }

    const curSuffix = currency ? ` ${currency}` : '';

    if (parts.length === 2) {
        const min = Number(parts[0]);
        const max = Number(parts[1]);
        if (!isNaN(min) && !isNaN(max)) {
            if (min === max) {
                return `${formatFiatValue(min, currency)}${curSuffix}`;
            }
            return `${formatFiatValue(min, currency)} – ${formatFiatValue(max, currency)}${curSuffix}`;
        }
        return `${parts[0]} – ${parts[1]}${curSuffix}`;
    }

    const val = Number(parts[0]);
    if (!isNaN(val)) {
        return `${formatFiatValue(val, currency)}${curSuffix}`;
    }

    return `${parts[0]}${curSuffix}`;
}

function formatPaymentMethodsHtml(paymentMethods) {
    let methods = [];
    if (Array.isArray(paymentMethods)) {
        methods = paymentMethods.map(m => String(m).trim()).filter(Boolean);
    } else if (typeof paymentMethods === 'string' && paymentMethods.trim()) {
        methods = paymentMethods.split(',').map(m => m.trim()).filter(Boolean);
    }
    if (methods.length === 0) return '<span class="text-muted">--</span>';

    const fullTitle = escapeHtml(methods.join(', '));
    const MAX_VISIBLE = 2;

    if (methods.length <= MAX_VISIBLE) {
        return `<span class="payment-methods-cell" title="${fullTitle}">` +
            methods.map(m => `<span class="method-tag">${escapeHtml(m)}</span>`).join('') +
            `</span>`;
    }

    const visible = methods.slice(0, MAX_VISIBLE);
    const remainingCount = methods.length - MAX_VISIBLE;
    const remainingList = escapeHtml(methods.slice(MAX_VISIBLE).join(', '));

    return `<span class="payment-methods-cell" title="${fullTitle}">` +
        visible.map(m => `<span class="method-tag">${escapeHtml(m)}</span>`).join('') +
        `<span class="method-tag-more" title="+${remainingCount} more: ${remainingList}">+${remainingCount}</span>` +
        `</span>`;
}

function filterAndRenderOrders() {
    const search = (document.getElementById('ordersSearchInput')?.value || '').toLowerCase().trim();
    const currency = document.getElementById('orderListCurrency')?.value || 'ALL';
    const type = document.getElementById('orderListType')?.value || 'ALL';
    const status = document.getElementById('orderListStatus')?.value || 'ALL';

    filteredOrders = allOrders.filter(order => {
        if (currency !== 'ALL' && order.currency !== currency) return false;
        if (type !== 'ALL' && order.order_type !== type) return false;
        if (status !== 'ALL' && order.status !== status) return false;
        if (search) {
            const matchId = (order.order_id || '').toLowerCase().includes(search);
            const matchMethod = String(order.payment_methods || '').toLowerCase().includes(search);
            const matchPlatform = String(order.platform || '').toLowerCase().includes(search);
            const matchCurrency = (order.currency || '').toLowerCase().includes(search);
            if (!matchId && !matchMethod && !matchPlatform && !matchCurrency) return false;
        }
        return true;
    });

    // Sort filtered orders
    filteredOrders.sort((a, b) => {
        if (sortColumn === 'fiat_amount') {
            const valA = getFiatSortValue(a.fiat_amount);
            const valB = getFiatSortValue(b.fiat_amount);
            return sortDirection === 'asc' ? valA - valB : valB - valA;
        }

        if (sortColumn === 'premium' || sortColumn === 'bond') {
            const valA = (a[sortColumn] != null && !isNaN(a[sortColumn])) ? Number(a[sortColumn]) : (sortDirection === 'asc' ? Infinity : -Infinity);
            const valB = (b[sortColumn] != null && !isNaN(b[sortColumn])) ? Number(b[sortColumn]) : (sortDirection === 'asc' ? Infinity : -Infinity);
            return sortDirection === 'asc' ? valA - valB : valB - valA;
        }

        if (sortColumn === 'first_seen' || sortColumn === 'last_seen') {
            const valA = a[sortColumn] ? (parseUtcDate(a[sortColumn])?.getTime() ?? 0) : 0;
            const valB = b[sortColumn] ? (parseUtcDate(b[sortColumn])?.getTime() ?? 0) : 0;
            return sortDirection === 'asc' ? valA - valB : valB - valA;
        }

        const valA = (a[sortColumn] || '').toString().toLowerCase();
        const valB = (b[sortColumn] || '').toString().toLowerCase();
        if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
        if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
        return 0;
    });

    renderOrdersTable();
}

function renderOrdersTable() {
    const tbody = document.getElementById('ordersTableBody');
    const badge = document.getElementById('ordersCountBadge');
    const info = document.getElementById('paginationInfo');
    const prevBtn = document.getElementById('prevPageBtn');
    const nextBtn = document.getElementById('nextPageBtn');

    if (!tbody) return;

    const total = filteredOrders.length;
    if (badge) badge.textContent = `${total} orders`;

    if (total === 0) {
        tbody.innerHTML = '<tr><td colspan="9" class="table-empty">No matching orders found</td></tr>';
        if (info) info.textContent = 'Showing 0 of 0 orders';
        if (prevBtn) prevBtn.disabled = true;
        if (nextBtn) nextBtn.disabled = true;
        return;
    }

    const totalPages = Math.ceil(total / ORDERS_PER_PAGE);
    if (ordersPage > totalPages) ordersPage = totalPages;
    if (ordersPage < 1) ordersPage = 1;

    const startIdx = (ordersPage - 1) * ORDERS_PER_PAGE;
    const endIdx = Math.min(startIdx + ORDERS_PER_PAGE, total);
    const pageItems = filteredOrders.slice(startIdx, endIdx);

    const rowsHtml = pageItems.map(order => {
        const orderId = order.order_id || '';
        const shortId = orderId ? `${orderId.slice(0, 8)}...` : '--';
        const idHtml = orderId
            ? `<span class="order-id-cell" title="Order ID: ${escapeHtml(orderId)}">
                    <span>${escapeHtml(shortId)}</span>
                    <button class="copy-id-btn" onclick="copyOrderId('${escapeHtml(orderId)}', this)" title="Copy Order ID">${ICON_CLIPBOARD}</button>
               </span>`
            : '--';

        const typeClass = order.order_type === 'buy' ? 'badge-buy' : 'badge-sell';
        const typeLabel = (order.order_type || 'sell').toUpperCase();

        const statusClass = `badge-status badge-${(order.status || 'pending').toLowerCase()}`;
        const statusLabel = order.status || 'pending';

        let statusTitle = '';
        let statusSubtextHtml = '';

        if (order.status === 'success' && order.success_ts) {
            const successDate = parseUtcDate(order.success_ts);
            const fullSuccessStr = formatFullDateTime(order.success_ts);
            statusTitle = `Completed: ${fullSuccessStr}`;

            const baseCreatedStr = order.created_at || order.first_seen;
            const createdDate = baseCreatedStr ? parseUtcDate(baseCreatedStr) : null;

            if (createdDate && successDate && successDate >= createdDate) {
                const durMs = successDate.getTime() - createdDate.getTime();
                const durStr = formatDuration(durMs);
                if (durStr) {
                    statusTitle += ` (took ${durStr})`;
                    statusSubtextHtml = `<span class="order-subtext text-muted">took ${durStr}</span>`;
                }
            } else if (successDate) {
                const shortSuccess = formatDateTime(order.success_ts);
                statusSubtextHtml = `<span class="order-subtext text-muted">${shortSuccess}</span>`;
            }
        }

        const statusBadgeTitleAttr = statusTitle ? ` title="${escapeHtml(statusTitle)}"` : '';
        const statusHtml = `<div class="status-cell">
            <span class="${statusClass}"${statusBadgeTitleAttr}>${statusLabel}</span>
            ${statusSubtextHtml}
        </div>`;

        const premVal = order.premium;
        let premHtml = '--';
        if (premVal != null && !isNaN(premVal)) {
            const sign = premVal > 0 ? '+' : '';
            const pClass = premVal > 0 ? 'premium-pos' : (premVal < 0 ? 'premium-neg' : '');
            premHtml = `<span class="${pClass}">${sign}${premVal.toFixed(2)}%</span>`;
        }

        const bondVal = order.bond;
        const bondHtml = (bondVal != null && !isNaN(bondVal)) ? `${bondVal.toFixed(2)}%` : '--';

        const fiatDisplay = formatFiatDisplay(order.fiat_amount, order.currency);
        const baseTimeStr = order.first_seen || order.created_at;
        const timeDisplay = formatDateTime(baseTimeStr);

        // Build comprehensive lifecycle tooltip for Time cell
        const timeLines = [];
        if (order.created_at) {
            timeLines.push(`Created:   ${formatFullDateTime(order.created_at)}`);
        }
        if (order.first_seen) {
            timeLines.push(`First seen: ${formatFullDateTime(order.first_seen)}`);
        }
        if (order.last_seen) {
            timeLines.push(`Last seen:  ${formatFullDateTime(order.last_seen)}`);
        }
        if (order.success_ts) {
            timeLines.push(`Completed:  ${formatFullDateTime(order.success_ts)}`);
            const baseForDur = order.created_at || order.first_seen;
            const createdDate = baseForDur ? parseUtcDate(baseForDur) : null;
            const successDate = parseUtcDate(order.success_ts);
            if (createdDate && successDate && successDate >= createdDate) {
                const durStr = formatDuration(successDate.getTime() - createdDate.getTime());
                if (durStr) {
                    timeLines.push(`Duration:   ${durStr}`);
                }
            }
        }
        const fullTimeTitle = escapeHtml(timeLines.join('\n'));
        const methodsHtml = formatPaymentMethodsHtml(order.payment_methods);

        return `
            <tr>
                <td class="font-mono text-sm">${idHtml}</td>
                <td><span class="badge ${typeClass}">${typeLabel}</span></td>
                <td class="font-mono text-bold">${escapeHtml(fiatDisplay)}</td>
                <td class="font-mono">${premHtml}</td>
                <td class="font-mono text-muted">${bondHtml}</td>
                <td>${methodsHtml}</td>
                <td><span class="platform-tag">${escapeHtml(order.platform || '--')}</span></td>
                <td>${statusHtml}</td>
                <td class="text-muted font-mono text-sm" title="${fullTimeTitle}">${timeDisplay}</td>
            </tr>
        `;
    }).join('');

    tbody.innerHTML = rowsHtml;

    if (info) info.textContent = `Showing ${startIdx + 1}-${endIdx} of ${total} orders (Page ${ordersPage}/${totalPages})`;
    if (prevBtn) prevBtn.disabled = ordersPage <= 1;
    if (nextBtn) nextBtn.disabled = ordersPage >= totalPages;
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function prevOrdersPage() {
    if (ordersPage > 1) {
        ordersPage--;
        renderOrdersTable();
    }
}

function nextOrdersPage() {
    const totalPages = Math.ceil(filteredOrders.length / ORDERS_PER_PAGE);
    if (ordersPage < totalPages) {
        ordersPage++;
        renderOrdersTable();
    }
}

let autoRefreshInterval = null;

function updateSyncStatus() {
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const el = document.getElementById('syncStatus');
    if (el) el.textContent = `Synced: ${timeStr}`;
}

async function fetchLastAlive() {
    try {
        const res = await fetch(`${DATA_BASE_URL}/analyzed/last_alive.json`);
        if (!res.ok) return;
        const data = await res.json();
        const isStale = (Date.now() - new Date(data.last_alive)) >= 3600000;
        document.querySelector('.status-dot')?.classList.toggle('red', isStale);
    } catch {}
}

async function manualRefresh() {
    const btn = document.getElementById('refreshBtn');
    const icon = document.getElementById('refreshIcon');
    if (btn) btn.disabled = true;
    if (icon) icon.classList.add('spinning');

    try {
        await Promise.all([
            fetchAndDraw(true),
            fetchOrders(),
            fetchLastAlive()
        ]);
        updateSyncStatus();
    } finally {
        if (btn) btn.disabled = false;
        if (icon) icon.classList.remove('spinning');
    }
}

function toggleAutoRefresh(enabled) {
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
        autoRefreshInterval = null;
    }
    if (enabled) {
        autoRefreshInterval = setInterval(() => {
            manualRefresh();
        }, 60000);
    }
    localStorage.setItem('autoRefresh', enabled ? 'true' : 'false');
}

function initAutoRefresh() {
    const saved = localStorage.getItem('autoRefresh') === 'true';
    const toggle = document.getElementById('autoRefreshToggle');
    if (toggle) {
        toggle.checked = saved;
        if (saved) toggleAutoRefresh(true);
    }
}

function toggleGuide() {
    const drawer = document.getElementById('guideDrawer');
    const btnText = document.getElementById('guideBtnText');
    if (!drawer) return;

    const isCollapsed = drawer.classList.toggle('collapsed');
    if (btnText) {
        btnText.textContent = isCollapsed ? 'Guide & FAQ ▾' : 'Guide & FAQ ▴';
    }
    localStorage.setItem('guideCollapsed', isCollapsed ? 'true' : 'false');
}

function initGuide() {
    const saved = localStorage.getItem('guideCollapsed');
    // Default to collapsed for clean presentation
    const isCollapsed = saved !== 'false';
    const drawer = document.getElementById('guideDrawer');
    const btnText = document.getElementById('guideBtnText');
    if (drawer) {
        drawer.classList.toggle('collapsed', isCollapsed);
    }
    if (btnText) {
        btnText.textContent = isCollapsed ? 'Guide & FAQ ▾' : 'Guide & FAQ ▴';
    }
}

window.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initSkin();
    initGuide();
    initAutoRefresh();
    manualRefresh();
});

