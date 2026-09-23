/* Frontend runtime config — single source of truth for the API base URL (window.AppConfig.api(path)).
   Resolution: window.__API_BASE__ → same origin (https or :3001) → same host :3001 → localhost:3001 */
(function () {
    'use strict';

    function resolveBase() {
        try {
            // 1) server-injected override
            if (typeof window !== 'undefined' && window.__API_BASE__) {
                return String(window.__API_BASE__).replace(/\/+$/, '');
            }
            if (typeof window !== 'undefined' && window.location && window.location.hostname) {
                const loc = window.location;
                const host = loc.hostname;
                // Skip "file://" and exotic protocols
                if (host && host !== '') {
                    // 2) same origin: https behind a proxy/tunnel, or served by the backend on :3001
                    if (loc.protocol === 'https:' || loc.port === '3001' || loc.port === '') {
                        return loc.origin.replace(/\/+$/, '');
                    }
                    // 3) dev split-server: static :8080, backend :3001
                    return 'http://' + host + ':3001';
                }
            }
        } catch (_) { }
        // 4) last resort
        return 'http://localhost:3001';
    }

    const API_BASE = resolveBase();

    // Shown in the UI footers; bump alongside the git tag on every release.
    const APP_VERSION = 'v1.16.4';

    window.AppConfig = {
        API_BASE: API_BASE,
        VERSION: APP_VERSION,
        api: function (path) {
            if (!path) return API_BASE;
            return API_BASE + (path.charAt(0) === '/' ? path : '/' + path);
        },
    };

    // Keep a flat alias too — some legacy code uses BASE directly
    if (typeof window.BASE === 'undefined') window.BASE = API_BASE;

    // Friendly debug line (one per page load)
    try { console.info('[config] API_BASE = ' + API_BASE); } catch (_) { }
})();
