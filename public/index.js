// =============================================================================
// RoboSats NIP-69 Orderbook Dashboard - Client Controller
// =============================================================================

// State
let chart = null;
let currentData = null;

const PALETTES = {
    dark: ['#60a5fa', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#f472b6', '#38bdf8'],
    light: ['#2563eb', '#059669', '#d97706', '#dc2626', '#7c3aed', '#db2777', '#0284c7'],
};

// -----------------------------------------------------------------------------
// 1. Theme Management
// -----------------------------------------------------------------------------
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
    document.getElementById('themeIcon').textContent = isLight ? '🌙' : '☀️';
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

// -----------------------------------------------------------------------------
// 2. Filter Inputs & Quick Currency Selection
// -----------------------------------------------------------------------------
function getFilters() {
    return {
        currency: document.getElementById('currency').value,
        orderType: document.getElementById('orderType').value,
        groupBy: document.getElementById('groupBy').value,
        metric: document.getElementById('metric').value,
        aggType: document.getElementById('aggType').value,
        isLight: document.body.classList.contains('light-mode'),
    };
}

function updateChips(selectedCurrency) {
    document.querySelectorAll('.chip').forEach(chip => {
        const isMatch = chip.getAttribute('data-cur') === selectedCurrency;
        chip.classList.toggle('active', isMatch);
    });
}

function quickSelectCurrency(currency) {
    document.getElementById('currency').value = currency;
    updateChips(currency);
    fetchAndDraw();
}

function onCurrencySelectChange() {
    const currency = document.getElementById('currency').value;
    updateChips(currency);
    fetchAndDraw();
}

// -----------------------------------------------------------------------------
// 3. UI Status Overlays
// -----------------------------------------------------------------------------
function showOverlay(message) {
    document.getElementById('overlayText').textContent = message;
    document.getElementById('overlayMsg').classList.add('active');
}

function hideOverlay() {
    document.getElementById('overlayMsg').classList.remove('active');
}

// -----------------------------------------------------------------------------
// 4. Data Fetching
// -----------------------------------------------------------------------------
async function fetchAndDraw() {
    const { currency, orderType, groupBy } = getFilters();
    const fileUrl = `analyzed/rolling_premium_${groupBy}_${currency}_${orderType}.json`;

    showOverlay('Loading dataset...');

    try {
        const response = await fetch(fileUrl);
        if (!response.ok) {
            throw new Error(`Data not available for ${currency} (${orderType})`);
        }

        const data = await response.json();
        if (!Array.isArray(data) || data.length === 0) {
            throw new Error(`No records found for ${currency} (${orderType})`);
        }

        currentData = data;
        hideOverlay();
        updateKPIs(data);
        renderChart();

    } catch (err) {
        currentData = null;
        showOverlay(err.message || 'Failed to load dataset');
        resetKPIs();
        if (chart) {
            chart.destroy();
            chart = null;
        }
    }
}

// -----------------------------------------------------------------------------
// 5. KPI Metric Calculations
// -----------------------------------------------------------------------------
function formatPercent(value) {
    if (value == null || isNaN(value)) return '--';
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(2)}%`;
}

function formatDateTime(isoString) {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return '--';
    const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `${dateStr} ${timeStr}`;
}

function updateKPIs(data) {
    const { currency, orderType } = getFilters();
    const now = Date.now();
    const cutoff24h = now - (24 * 60 * 60 * 1000);

    // Calculate orders active in the last 24h for the active dataset
    const timestamps = data
        .map(r => new Date(r.last_seen).getTime())
        .filter(t => !isNaN(t));
    let count24h = data.filter(r => new Date(r.last_seen).getTime() >= cutoff24h).length;
    let lastUpdateStr = timestamps.length > 0 ? formatDateTime(Math.max(...timestamps)) : '--';

    // Global 24h order count: all orders active in the last 24h
    let globalCount = null;
    if (allOrders.length > 0) {
        globalCount = allOrders.filter(o => new Date(o.last_seen).getTime() >= cutoff24h).length;
    }

    const global24hText = globalCount != null
        ? `Global: ${globalCount.toLocaleString()} total`
        : `${currency} (${orderType})`;

    document.getElementById('statOrders24h').textContent = count24h.toLocaleString();
    document.getElementById('statOrders24hSub').textContent = global24hText;

    // Rolling Premium Metrics (from latest row)
    const latest = data[data.length - 1];
    if (latest) {
        document.getElementById('statMedianPremium').textContent = formatPercent(latest.median);
        document.getElementById('statMeanPremium').textContent = formatPercent(latest.mean);

        const medCard = document.getElementById('statMedianPremium').parentElement;
        medCard.classList.remove('green', 'red');
        if (latest.median > 0) medCard.classList.add('green');
        else if (latest.median < 0) medCard.classList.add('red');
    }

    // Data Point Totals
    document.getElementById('statDataPoints').textContent = data.length.toLocaleString();
    document.getElementById('statLastUpdate').textContent = `Latest: ${lastUpdateStr}`;
}

function resetKPIs() {
    document.getElementById('statOrders24h').textContent = '0';
    document.getElementById('statOrders24hSub').textContent = 'No data in active filter';
    document.getElementById('statMedianPremium').textContent = '--';
    document.getElementById('statMeanPremium').textContent = '--';
    document.getElementById('statDataPoints').textContent = '0';
    document.getElementById('statLastUpdate').textContent = 'Latest: --';
}

// -----------------------------------------------------------------------------
// 6. Chart Rendering
// -----------------------------------------------------------------------------
function renderChart() {
    if (!currentData || currentData.length === 0) return;

    const { currency, orderType, groupBy, metric, aggType, isLight } = getFilters();

    // 1. Extract unique timestamps and format labels for X-axis
    const timestamps = [...new Set(currentData.map(row => row.first_seen))].sort();
    const labels = timestamps.map(formatDateTime);

    // 2. Group rows into distinct series by category (Platform, Payment Method, etc.)
    const grouped = {};
    currentData.forEach(row => {
        const category = row[groupBy] || 'All';
        if (!grouped[category]) grouped[category] = {};
        grouped[category][row.first_seen] = row[aggType];
    });

    // 3. Build Chart.js datasets with theme palette
    const palette = isLight ? PALETTES.light : PALETTES.dark;
    const datasets = Object.keys(grouped).map((category, idx) => {
        const color = palette[idx % palette.length];
        return {
            label: category,
            data: timestamps.map(ts => grouped[category][ts] ?? null),
            borderColor: color,
            backgroundColor: color,
            borderWidth: 2,
            tension: 0.25,
            fill: false,
            spanGaps: true,
            pointRadius: timestamps.length > 50 ? 1.5 : 3,
            pointHoverRadius: 5,
        };
    });

    // 4. Titles and axis labels
    const aggTitle = aggType.charAt(0).toUpperCase() + aggType.slice(1);
    const metricTitle = metric.charAt(0).toUpperCase() + metric.slice(1);
    const yLabel = aggType === 'count' ? 'Order Volume' : `${aggTitle} ${metricTitle} (%)`;

    document.getElementById('chartTitle').textContent =
        `${currency} ${orderType.toUpperCase()} - 12h Rolling ${metricTitle} (${aggTitle})`;

    const textColor = isLight ? '#475569' : '#9ca3af';
    const gridColor = isLight ? '#f1f5f9' : '#1f293d';

    const ctx = document.getElementById('mainChart').getContext('2d');
    if (chart) {
        chart.destroy();
    }

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
            plugins: {
                legend: {
                    position: 'top',
                    align: 'end',
                    labels: {
                        color: textColor,
                        boxWidth: 12,
                        boxHeight: 12,
                        usePointStyle: true,
                        font: { size: 11, family: 'system-ui' },
                    },
                },
                tooltip: {
                    backgroundColor: isLight ? '#ffffff' : '#111827',
                    titleColor: isLight ? '#0f172a' : '#f3f4f6',
                    bodyColor: isLight ? '#334155' : '#e5e7eb',
                    borderColor: isLight ? '#cbd5e1' : '#374151',
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

// -----------------------------------------------------------------------------
// 7. Orders List Controller
// -----------------------------------------------------------------------------
let allOrders = [];
let filteredOrders = [];
let ordersPage = 1;
const ORDERS_PER_PAGE = 25;

async function fetchOrders() {
    try {
        const res = await fetch('analyzed/orders.json');
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
    ordersPage = 1;
    filterAndRenderOrders();
}

function onOrdersSearchChange() {
    ordersPage = 1;
    filterAndRenderOrders();
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
            const matchMethod = (order.payment_methods || '').toLowerCase().includes(search);
            const matchPlatform = (order.platform || '').toLowerCase().includes(search);
            const matchCurrency = (order.currency || '').toLowerCase().includes(search);
            if (!matchId && !matchMethod && !matchPlatform && !matchCurrency) return false;
        }
        return true;
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
        tbody.innerHTML = '<tr><td colspan="8" class="table-empty">No matching orders found</td></tr>';
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
        const typeClass = order.order_type === 'buy' ? 'badge-buy' : 'badge-sell';
        const typeLabel = (order.order_type || 'sell').toUpperCase();

        const statusClass = `badge-status badge-${(order.status || 'pending').toLowerCase()}`;
        const statusLabel = order.status || 'pending';

        const premVal = order.premium;
        let premHtml = '--';
        if (premVal != null && !isNaN(premVal)) {
            const sign = premVal > 0 ? '+' : '';
            const pClass = premVal > 0 ? 'premium-pos' : (premVal < 0 ? 'premium-neg' : '');
            premHtml = `<span class="${pClass}">${sign}${premVal.toFixed(2)}%</span>`;
        }

        const bondVal = order.bond;
        const bondHtml = (bondVal != null && !isNaN(bondVal)) ? `${bondVal.toFixed(2)}%` : '--';

        const fiatDisplay = `${order.fiat_amount || '--'} ${order.currency || ''}`;
        const timeDisplay = formatDateTime(order.first_seen);

        return `
            <tr>
                <td><span class="badge ${typeClass}">${typeLabel}</span></td>
                <td class="font-mono text-bold">${escapeHtml(fiatDisplay)}</td>
                <td class="font-mono">${premHtml}</td>
                <td class="font-mono text-muted">${bondHtml}</td>
                <td>${escapeHtml(order.payment_methods || '--')}</td>
                <td><span class="platform-tag">${escapeHtml(order.platform || '--')}</span></td>
                <td><span class="${statusClass}">${statusLabel}</span></td>
                <td class="text-muted font-mono text-sm">${timeDisplay}</td>
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

// -----------------------------------------------------------------------------
// 8. App Initialization
// -----------------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
    initTheme();
    fetchAndDraw();
    fetchOrders();
});

