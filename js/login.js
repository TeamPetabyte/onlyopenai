// login.js — ลอกอิน (ย้ายมาจาก login.html)

/* exported handleLogin */

        // Show the app version in the footer (single source of truth:
        // js/config.js AppConfig.VERSION — bump it alongside the git tag
        // whenever a release ships).
        (function () {
            const el = document.getElementById('app-version');
            if (el) el.textContent = (window.AppConfig && window.AppConfig.VERSION) || '';
        })();

        // Phase 16.26: removed role tabs — server decides role from the
        // user record after login, no need to pre-select on the form.

        // Redirect if already logged in
        (function () {
            const session = Auth.getSession();
            if (session) {
                // Phase 8: pending pw change short-circuits everything else
                if (session.mustChangePassword) {
                    window.location.href = '/change-password';
                    return;
                }
                window.location.href = (session.role === 'admin' || session.role === 'trainer') ? '/admin' : '/';
            }
        })();

        // Phase 19.5: show a friendly message when we got bounced here
        // because the previous session expired (?expired=1) or the user
        // explicitly logged out (?loggedout=1).
        (function () {
            try {
                const q = new URLSearchParams(window.location.search);
                if (q.get('expired') === '1') {
                    const el = document.getElementById('error-msg');
                    if (el) {
                        el.textContent = '⏱ Your session expired — please log in again';
                        el.classList.add('show');
                    }
                } else if (q.get('loggedout') === '1') {
                    const el = document.getElementById('error-msg');
                    if (el) {
                        // Soften the styling for "successful logout" — same
                        // element, neutral text, no scary red.
                        el.textContent = '✓ Logged out';
                        el.classList.add('show');
                        el.style.background = 'rgba(34, 197, 94, 0.10)';
                        el.style.borderColor = 'rgba(34, 197, 94, 0.30)';
                        el.style.color = '#15803d';
                    }
                }
            } catch (_) { /* ignore — purely cosmetic */ }
        })();

        function showError(msg) {
            const el = document.getElementById('error-msg');
            el.textContent = msg;
            el.classList.add('show');
        }

        function hideError() {
            document.getElementById('error-msg').classList.remove('show');
        }

        async function handleLogin(e) {
            e.preventDefault();
            hideError();
            const username = document.getElementById('username').value.trim();
            const password = document.getElementById('password').value;
            const btn = document.getElementById('login-btn');

            btn.disabled = true;
            btn.textContent = 'Signing in...';

            try {
                const result = await Auth.login(username, password);
                if (!result.ok) {
                    // Phase 8: surface locked-account messages distinctly
                    showError(result.locked
                        ? '🔒 ' + (result.error || 'Account locked')
                        : (result.error || 'Invalid credentials'));
                    btn.disabled = false;
                    btn.textContent = 'Log in';
                    return;
                }
                // Phase 8: forced password change → go to dedicated page first
                if (result.mustChangePassword) {
                    window.location.href = '/change-password';
                    return;
                }
                window.location.href = (result.session.role === 'admin' || result.session.role === 'trainer') ? '/admin' : '/';
            } catch (e) {
                showError('Something went wrong. Please try again.');
                btn.disabled = false;
                btn.textContent = 'Log in';
            }
        }

        // Fields start blank — users type their own credentials.
        // (Browser may still offer saved logins via autocomplete.)
