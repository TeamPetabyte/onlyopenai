// login.js — ลอกอิน (ย้ายมาจาก login.html)

/* exported handleLogin */

        // เวอร์ชันที่ footer — source of truth คือ AppConfig.VERSION
        (function () {
            const el = document.getElementById('app-version');
            if (el) el.textContent = (window.AppConfig && window.AppConfig.VERSION) || '';
        })();

        // ไม่มี role tab — server ตัดสิน role จาก user record เอง

        // Redirect if already logged in
        (function () {
            const session = Auth.getSession();
            if (session) {
                // pending pw change short-circuits everything else
                if (session.mustChangePassword) {
                    window.location.href = '/change-password';
                    return;
                }
                window.location.href = (session.role === 'admin' || session.role === 'trainer') ? '/admin' : '/';
            }
        })();

        // เด้งมาเพราะ session หมดอายุ (?expired=1) หรือ logout เอง (?loggedout=1) — บอกเหตุผลให้เห็น
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
                        // logout ปกติ — โทนกลาง ไม่ใช่แดงน่ากลัว
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
                    // surface locked-account messages distinctly
                    showError(result.locked
                        ? '🔒 ' + (result.error || 'Account locked')
                        : (result.error || 'Invalid credentials'));
                    btn.disabled = false;
                    btn.textContent = 'Log in';
                    return;
                }
                // forced password change → go to dedicated page first
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

        // ช่องเริ่มว่าง — ปล่อยให้ browser autocomplete เสนอเอง
