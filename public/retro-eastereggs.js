/**
 * 2005 Vaporwave Easter Eggs & Retro Window Window Manager
 * Handles:
 * 1. Static visitor counter from /count.json + mechanical roll
 * 2. Window titlebar controls (minimize rollup, maximize, close)
 * 3. CRT Scanline toggle
 * 4. Konami Code (↑ ↑ ↓ ↓ ← → ← → B A) Hyper Vapor popup
 */

(function () {
    // =========================================================================
    // 1. Static Visitor Counter
    // =========================================================================
    let currentVisitorCount = 48291;

    function renderOdometer(count) {
        const container = document.getElementById('odometerContainer');
        if (!container) return;

        const countStr = count.toString().padStart(7, '0');
        container.innerHTML = '';
        for (const char of countStr) {
            const digitEl = document.createElement('span');
            digitEl.className = 'odo-digit';
            digitEl.textContent = char;
            container.appendChild(digitEl);
        }
    }

    async function loadVisitorCount() {
        try {
            const res = await fetch('/count.json');
            if (res.ok) {
                const data = await res.json();
                if (typeof data.count === 'number') {
                    currentVisitorCount = data.count;
                }
            }
        } catch {
            // Keep default count if offline
        }
        renderOdometer(currentVisitorCount);
    }

    function initHitCounterClick() {
        const widget = document.getElementById('statsCounterWidget');
        if (!widget) return;

        widget.style.cursor = 'pointer';
        widget.addEventListener('click', () => {
            currentVisitorCount += 1;
            renderOdometer(currentVisitorCount);
            
            // Visual feedback pulse
            const odo = document.getElementById('odometerContainer');
            if (odo) {
                odo.classList.add('pulse-odo');
                setTimeout(() => odo.classList.remove('pulse-odo'), 250);
            }
        });
    }

    // =========================================================================
    // 2. Interactive Window Titlebars (Minimize Rollup, Maximize, Close)
    // =========================================================================
    function initWindowChrome() {
        const windows = document.querySelectorAll('.win-window');
        windows.forEach(win => {
            const titlebar = win.querySelector('.win-titlebar');
            const body = win.querySelector('.win-body');
            const minimizeBtn = win.querySelector('.win-btn-min');
            const maximizeBtn = win.querySelector('.win-btn-max');
            const closeBtn = win.querySelector('.win-btn-close');

            // Minimize / Roll-up
            const toggleMinimize = () => {
                win.classList.toggle('is-minimized');
                if (body) {
                    body.style.display = win.classList.contains('is-minimized') ? 'none' : '';
                }
            };

            if (minimizeBtn) {
                minimizeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    toggleMinimize();
                });
            }

            // Double click titlebar to roll up
            if (titlebar) {
                titlebar.addEventListener('dblclick', toggleMinimize);
            }

            // Maximize toggle
            if (maximizeBtn) {
                maximizeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    win.classList.toggle('is-maximized');
                });
            }

            // Close / Hide
            if (closeBtn) {
                closeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    win.style.transition = 'opacity 0.2s, transform 0.2s';
                    win.style.opacity = '0';
                    win.style.transform = 'scale(0.95)';
                    setTimeout(() => {
                        win.style.display = 'none';
                    }, 200);
                });
            }
        });
    }

    // =========================================================================
    // 3. CRT Scanline Toggle
    // =========================================================================
    function initCrtToggle() {
        const crtBtn = document.getElementById('crtToggleBtn');
        const crtOverlay = document.querySelector('.crt-overlay');
        if (!crtBtn || !crtOverlay) return;

        crtBtn.addEventListener('click', () => {
            const isHidden = crtOverlay.style.display === 'none';
            crtOverlay.style.display = isHidden ? 'block' : 'none';
            crtBtn.textContent = isHidden ? '[CRT: ON]' : '[CRT: OFF]';
            crtBtn.classList.toggle('active', isHidden);
        });
    }

    // =========================================================================
    // 4. Konami Code (↑ ↑ ↓ ↓ ← → ← → B A) Hyper Vapor Mode
    // =========================================================================
    const KONAMI_SEQUENCE = [
        'ArrowUp', 'ArrowUp',
        'ArrowDown', 'ArrowDown',
        'ArrowLeft', 'ArrowRight',
        'ArrowLeft', 'ArrowRight',
        'b', 'a'
    ];
    let konamiIndex = 0;

    function triggerHyperVaporModal() {
        // Toggle hyper vapor class on body
        const isHyper = document.body.classList.toggle('hyper-vapor-mode');

        // Create or show modal dialog
        let modal = document.getElementById('konamiModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'konamiModal';
            modal.className = 'win-window konami-dialog';
            modal.innerHTML = `
                <div class="win-titlebar">
                    <span class="win-title">[!] SYSTEM_ALERT.EXE - ILLEGAL AESTHETIC DETECTED</span>
                    <div class="win-controls">
                        <button class="win-btn win-close" id="closeKonamiBtn">×</button>
                    </div>
                </div>
                <div class="win-body konami-dialog-body">
                    <div class="konami-icon-error">⚠️</div>
                    <div class="konami-dialog-text">
                        <p><strong>ROBOSATS.EXE has performed an operation of pure aesthetics.</strong></p>
                        <p style="margin-top: 6px; font-size: 0.72rem; color: #00f0ff;">
                            HYPER_VAPOR_STATE = <strong>${isHyper ? 'ENABLED (MAX SPEED)' : 'NORMAL'}</strong><br>
                            NOSTR RELAY MATRIX SYNCHRONIZED.
                        </p>
                    </div>
                </div>
                <div class="konami-dialog-footer">
                    <button class="retro-btn" id="okKonamiBtn">[ OK ]</button>
                </div>
            `;
            document.body.appendChild(modal);

            const closeAction = () => {
                modal.style.display = 'none';
            };

            modal.querySelector('#closeKonamiBtn').addEventListener('click', closeAction);
            modal.querySelector('#okKonamiBtn').addEventListener('click', closeAction);
        } else {
            modal.style.display = 'block';
        }
    }

    function initKonamiListener() {
        window.addEventListener('keydown', (e) => {
            const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
            const expectedKey = KONAMI_SEQUENCE[konamiIndex].toLowerCase();

            if (key === expectedKey) {
                konamiIndex++;
                if (konamiIndex === KONAMI_SEQUENCE.length) {
                    konamiIndex = 0;
                    triggerHyperVaporModal();
                }
            } else {
                konamiIndex = (key === KONAMI_SEQUENCE[0].toLowerCase()) ? 1 : 0;
            }
        });
    }

    // =========================================================================
    // Initialization
    // =========================================================================
    function init() {
        loadVisitorCount();
        initHitCounterClick();
        initWindowChrome();
        initCrtToggle();
        initKonamiListener();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
