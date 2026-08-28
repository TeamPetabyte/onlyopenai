// change-password.js — เปลี่ยนรหัส (ย้ายมาจาก change-password.html)


        // Guard: must be logged in to be here
        (function () {
            const session = Auth.getSession();
            if (!session) { window.location.href = '/login'; return; }
            // Show username
            document.getElementById('who').textContent = '@' + session.username;
        })();

        function updateRules() {
            const pw = document.getElementById('new-pw').value;
            const pw2 = document.getElementById('new-pw2').value;
            const rules = {
                len:    pw.length >= 8 && pw.length <= 128,
                letter: /[A-Za-z]/.test(pw),
                digit:  /[0-9]/.test(pw),
                match:  pw && pw === pw2,
            };
            for (const k in rules) {
                const el = document.getElementById('r-' + k);
                el.className = 'pw-rule ' + (rules[k] ? 'met' : 'miss');
                el.textContent = (rules[k] ? '● ' : '○ ') + el.textContent.replace(/^[●○]\s*/, '');
            }
            const allOk = rules.len && rules.letter && rules.digit && rules.match;
            document.getElementById('submit-btn').disabled = !allOk;
        }

        function showError(msg) {
            const el = document.getElementById('error-msg');
            el.textContent = msg;
            el.classList.add('show');
        }
        function hideError() {
            document.getElementById('error-msg').classList.remove('show');
        }

        async function handleChange(e) {
            e.preventDefault();
            hideError();
            const pw  = document.getElementById('new-pw').value;
            const pw2 = document.getElementById('new-pw2').value;
            if (pw !== pw2) { showError('Passwords do not match'); return; }

            const btn = document.getElementById('submit-btn');
            btn.disabled = true;
            btn.textContent = 'Saving...';

            const result = await Auth.changePassword(pw);
            if (!result.ok) {
                showError(result.error || 'Password change failed');
                btn.disabled = false;
                btn.textContent = 'Change password';
                return;
            }
            // Done — redirect by role
            const session = Auth.getSession();
            window.location.href = (session && session.role === 'admin') ? '/admin' : '/';
        }

        function signOut() {
            Auth.logout();    // also clears token + redirects to login.html
        }

// ES module แล้ว — handler ที่ HTML (รวมที่ JS สร้าง) เรียก ต้องอยู่บน window
Object.assign(window, {
    handleChange,
    signOut,
    updateRules,
});
