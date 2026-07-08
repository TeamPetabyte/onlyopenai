/* =========================================================
   PetabyteAi — Frontend Runtime Config
   ─────────────────────────────────────────────────────────
   Single source of truth for the backend API base URL.
   Replaces hardcoded "http://localhost:3001" throughout JS.

   Resolution order:
     1. window.__API_BASE__   (server-injected at runtime, optional)
     2. Same origin   (HTTPS behind a proxy/tunnel, or backend on :3001)
     3. Same host : 3001   (dev split-server: static :8080 + backend :3001)
     4. Fallback: localhost:3001

   Usage in any module:
     const url = window.AppConfig.api('/api/users');
     fetch(window.AppConfig.api('/api/login'), { ... });
   ========================================================= */
(function () {
    'use strict';

    function resolveBase() {
        try {
            // 1) Server-injected override (from start.js or similar)
            if (typeof window !== 'undefined' && window.__API_BASE__) {
                return String(window.__API_BASE__).replace(/\/+$/, '');
            }
            if (typeof window !== 'undefined' && window.location && window.location.hostname) {
                const loc = window.location;
                const host = loc.hostname;
                // Skip "file://" and exotic protocols
                if (host && host !== '') {
                    // 2) Same-origin: when served over HTTPS (behind a reverse
                    //    proxy / tunnel like Cloudflare, Caddy, nginx) or directly
                    //    by the backend on :3001, the API lives at the SAME origin
                    //    as the page. Using location.origin keeps scheme+port in
                    //    sync and avoids mixed-content under HTTPS.
                    if (loc.protocol === 'https:' || loc.port === '3001' || loc.port === '') {
                        return loc.origin.replace(/\/+$/, '');
                    }
                    // 3) Dev split-server: static on :8080, backend on :3001
                    //    (same host, fixed backend port).
                    return 'http://' + host + ':3001';
                }
            }
        } catch (_) { }
        // 3) Last-resort fallback
        return 'http://localhost:3001';
    }

    const API_BASE = resolveBase();

    // Single source of truth for the version shown in the UI (sidebar
    // footer on index.html / admin.html, and the footer on login.html).
    // Bump this alongside the git tag whenever a release ships — e.g.
    // `git tag -a v1.2.0` → APP_VERSION here should read 'v1.2.0' too, so
    // what the tag says matches what the app shows on screen.
    const APP_VERSION = 'v1.3.4';

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
