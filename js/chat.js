// chat.js — หน้าแชททั้งหมด (ย้ายมาจาก index.html)


        // ── STATE ──
        const State = {
            selectedSkill: 'auto',
            selectedModel: 'gpt-5.6-terra',   // model picker default
            selectedEffort: 'medium',          // reasoning effort default
            isRunning: false,
            balance: 100,
            usageHistory: [],       // for Usage modal
            sessions: [],           // sidebar session list
            currentSessionId: null, // active session
            currentMessages: [],    // messages in current chat
            searchQuery: '',        // active session-search filter (Tier 1)
            attachedFile: null,

            load() {
                const s = Auth.getSession(); if (!s) return;
                this.balance = parseFloat(localStorage.getItem('agenthub_balance_' + s.username) || '100');
                try { this.usageHistory = JSON.parse(localStorage.getItem('agenthub_history_' + s.username) || '[]'); } catch { this.usageHistory = []; }
                // restore the user's model + effort choice
                this.selectedModel  = localStorage.getItem('agenthub_model_'  + s.username) || this.selectedModel;
                // map ค่าเก่า max/xhigh/none เป็นตัวที่เหลือ — ไม่รีเซ็ตทิ้งตัวเลือกที่ user ตั้งใจไว้
                const EFFORT_MAP = { none: 'low', xhigh: 'high', max: 'high' };
                const savedEffort = localStorage.getItem('agenthub_effort_' + s.username);
                if (savedEffort) {
                    this.selectedEffort = EFFORT_MAP[savedEffort] || savedEffort;
                    if (EFFORT_MAP[savedEffort]) {
                        localStorage.setItem('agenthub_effort_' + s.username, this.selectedEffort);
                    }
                }
            },
            save() {
                const s = Auth.getSession(); if (!s) return;
                localStorage.setItem('agenthub_balance_' + s.username, this.balance.toString());
                localStorage.setItem('agenthub_history_' + s.username, JSON.stringify(this.usageHistory));
                localStorage.setItem('agenthub_balance', this.balance.toString());
                localStorage.setItem('agenthub_model_'  + s.username, this.selectedModel);
                localStorage.setItem('agenthub_effort_' + s.username, this.selectedEffort);
            },
            addUsageEntry(entry) {
                entry.id = Date.now(); entry.timestamp = new Date().toISOString();
                this.usageHistory.unshift(entry);
                if (this.usageHistory.length > 200) this.usageHistory = this.usageHistory.slice(0, 200);
                this.balance = Math.max(0, this.balance - (entry.cost || 0)); this.save();
                // เงินจริงคิดฝั่ง server ใน /api/chat ที่เดียว — ตรงนี้เป็นแค่ UI (POST /api/history เดิมหักซ้ำ เลยถูกถอด)
            },
        };

        // ── SESSION API HELPERS ──
        // BASE มาจาก js/config.js; fallback localhost เฉพาะตอน config.js โหลดไม่ขึ้น
        if (typeof BASE === 'undefined') { var BASE = (window.AppConfig && window.AppConfig.API_BASE) || 'http://localhost:3001'; }

        // เวอร์ชันที่ sidebar footer — source of truth คือ AppConfig.VERSION
        (function () {
            const el = document.getElementById('app-version');
            if (el) el.textContent = (window.AppConfig && window.AppConfig.VERSION) || '';
        })();

        // REST อยู่ใต้ /api/chat/sessions — ตัวตนมาจาก session cookie เท่านั้น (server เมิน query userId)
        async function apiLoadSessions(q) {
            try {
                // ไม่ส่ง q มา = คงคำค้นเดิม — รีโหลดหลังส่งแชทต้องไม่ล้าง filter
                const effective = (q !== undefined) ? q : (State.searchQuery || '');
                const url = BASE + '/api/chat/sessions' + (effective ? ('?q=' + encodeURIComponent(effective)) : '');
                const d = await fetch(url, { headers: Auth.authHeaders() }).then(r => r.json());
                if (d.ok) {
                    // BIGINT ผ่าน node-pg มาเป็น string — coerce เป็น Number ที่ขอบทางเข้า ไม่งั้น find(s.id === id) พลาดเงียบ
                    State.sessions = (d.sessions || []).map(s => ({
                        ...s,
                        id: typeof s.id === 'string' ? Number(s.id) : s.id,
                    }));
                    renderSessionList();
                }
            } catch { }
        }

        async function apiGetSession(sessionId) {
            try {
                const d = await fetch(BASE + '/api/chat/sessions/' + sessionId, { headers: Auth.authHeaders() }).then(r => r.json());
                if (d.ok) return d;   // { session, messages }
            } catch { }
            return null;
        }

        async function apiRenameSession(sessionId, title) {
            try {
                const d = await fetch(BASE + '/api/chat/sessions/' + sessionId, {
                    method: 'PATCH',
                    headers: Auth.authHeaders(),
                    body: JSON.stringify({ title })
                }).then(r => r.json());
                return d.ok === true;
            } catch { return false; }
        }

        function apiExportSessionUrl(sessionId) {
            // fetch → blob → anchor เพื่อจับ error ได้เอง; GET ไม่ต้องมี CSRF
            return fetch(BASE + '/api/chat/sessions/' + sessionId + '/export', { headers: Auth.authHeaders() })
                .then(r => r.ok ? r.blob() : null);
        }

        // ── INIT ──
        document.addEventListener('DOMContentLoaded', async () => {
            if (!Auth.check('user')) return;
            const session = Auth.getSession();
            State.load();
            syncComposerControls();   // reflect restored model/effort into the pickers
            const displayName = session.displayName || session.username;
            document.getElementById('user-display-name').textContent = displayName;
            document.getElementById('user-avatar').textContent = displayName.charAt(0).toUpperCase();

            // รวม error ตอน init ไว้เด้ง toast ครั้งเดียว — เดิม fail เงียบค้างที่ "฿—"
            let initHadError = false;

            // เงินที่ใช้ได้คือ PROJECT POOL (wallet ต่อ user = 0 เสมอ) — อ่านจาก /api/quota-status
            if (session.userId) {
                try {
                    const q = await fetch(BASE + '/api/quota-status', { headers: Auth.authHeaders() }).then(r => r.json());
                    if (q && q.ok) { State.balance = parseFloat(q.projectPool) || 0; State.save(); }
                    else { initHadError = true; }
                } catch { initHadError = true; }

                // Load usage history for stats
                try {
                    const d = await fetch(BASE + '/api/history?userId=' + session.userId, { headers: Auth.authHeaders() }).then(r => r.json());
                    if (d.ok && d.history.length > 0) {
                        State.usageHistory = d.history.map(h => ({
                            id: h.id, skillId: h.skill_id, skillName: h.skill_name, skillEmoji: h.skill_emoji,
                            prompt: h.prompt, response: h.response, inputTokens: h.input_tokens, outputTokens: h.output_tokens,
                            cost: parseFloat(h.cost), durationMs: h.duration_ms, timestamp: h.created_at
                        }));
                        State.save();
                    } else if (!d.ok) { initHadError = true; }
                } catch { initHadError = true; }

                // Load chat sessions for sidebar (owner is inferred server-side)
                try { await apiLoadSessions(); } catch { initHadError = true; }
            }

            // Load project name
            const projectId = session.projectId;
            if (projectId) {
                let projName = null;
                try {
                    const d = await fetch(BASE + '/api/projects', { headers: Auth.authHeaders() }).then(r => r.json());
                    if (d.ok) { const p = d.projects.find(p => String(p.id) === String(projectId)); if (p) projName = p.name; }
                    else      { initHadError = true; }
                } catch {
                    initHadError = true;
                    const projs = JSON.parse(localStorage.getItem('agenthub_projects') || '[]');
                    const p = projs.find(p => p.id === projectId); if (p) projName = p.name;
                }
                if (projName) {
                    document.getElementById('brand-project').textContent = projName;
                    document.getElementById('sidebar-project-label').textContent = projName;
                    // อย่าเขียนทับ brand-avatar — เป็น <img> โลโก้แล้ว เคยโดนทับจนโลโก้แวบหาย
                }
            }

            if (PRICING.skills.length > 0) selectSkill(PRICING.skills[0].id);
            updateBalanceDisplay();

            // บอก user ครั้งเดียวถ้า init ล้มเหลว
            if (initHadError) {
                showToast(t('u.err.loadPartialFailed'), 'error');
            }

            // กู้ session จาก URL hash (#s/42) ตอน refresh — id ที่ใช้ไม่ได้แค่ toast แล้วปล่อยผ่าน
            const m = String(window.location.hash || '').match(/^#\/?s\/(\d+)$/);
            if (m && m[1]) {
                const sid = Number(m[1]);
                if (Number.isInteger(sid) && sid > 0) {
                    // Defer to next tick so the empty-state DOM is settled first
                    setTimeout(() => loadSession(sid), 0);
                }
            }
        });

        // back/forward ต้องพา session ตาม และ reload ต้องอยู่ที่เดิม
        window.addEventListener('hashchange', () => {
            const m = String(window.location.hash || '').match(/^#\/?s\/(\d+)$/);
            const sid = m && m[1] ? Number(m[1]) : null;
            if (sid && sid !== State.currentSessionId) {
                loadSession(sid);
            } else if (!sid && State.currentSessionId) {
                // Hash cleared (user hit "New Chat" elsewhere or navigated)
                State.currentSessionId = null;
            }
        });

        // ── NEW CHAT ──
        function newChat() {
            // close mobile drawer (no-op on desktop) after picking
            toggleSidebar(false);
            // ล้าง hash ด้วย replaceState — refresh แล้วอยู่หน้า new chat และไม่ปั๊ม history
            try {
                if (window.location.hash && window.history && window.history.replaceState) {
                    window.history.replaceState(null, '', window.location.pathname + window.location.search);
                }
            } catch (_) { }
            State.currentSessionId = null;
            State.currentMessages = [];
            const area = document.getElementById('chat-area');
            // welcoming empty state on new chat.
            area.innerHTML = `
        <div class="chat-empty" id="chat-empty">
            <img class="chat-empty-mascot" src="/assets/mascot.png?v=2" alt="PipekAI" />
            <div class="chat-empty-title">${esc(t('u.chat.welcomeTitle'))}</div>
            <div class="chat-empty-sub">${esc(t('u.chat.welcomeSub'))}</div>
        </div>`;
            renderSessionList();
            document.getElementById('chat-input').focus();
        }

        // ── LOAD SESSION ──
        // Enter/Space บนแถว = เปิด session (เฉพาะโฟกัสที่ตัวแถว ไม่ใช่ปุ่มข้างใน)
        function handleSessionKey(e, sessionId) {
            if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
            // Skip if user is pressing inside one of the action buttons
            if (e.target && e.target.closest && e.target.closest('.session-actions')) return;
            e.preventDefault();
            loadSession(sessionId);
        }

        async function loadSession(sessionId) {
            if (State.isRunning) { showToast(t('u.err.pleaseWait'), 'error'); return; }
            // close mobile drawer on session pick
            toggleSidebar(false);
            const res = await apiGetSession(sessionId);
            if (!res) { showToast(t('u.err.sessionNotFound'), 'error'); return; }

            // server ส่ง BIGINT เป็น string — coerce ให้เทียบกับ Number จาก apiLoadSessions ได้
            State.currentSessionId = Number(res.session.id);
            // pin ลง URL ด้วย replaceState — ไม่ให้คลิก session ปั๊ม back-history ทีละอัน
            try {
                const want = '#s/' + res.session.id;
                if (window.location.hash !== want && window.history && window.history.replaceState) {
                    window.history.replaceState(null, '', want);
                }
            } catch (_) { }

            // แปลง snake_case จาก server เป็น shape ที่ renderer ใช้
            State.currentMessages = (res.messages || []).map(m => ({
                role:         m.role,
                content:      m.content,
                timestamp:    m.created_at,
                cost:         m.cost != null ? Number(m.cost) : undefined,
                inputTokens:  m.input_tokens || 0,
                outputTokens: m.output_tokens || 0,
                // แถวก่อน migration ไม่มี duration — ปล่อย undefined อย่าใส่ 0 ไม่งั้น badge อ้าง "0.0s"
                durationMs:   m.duration_ms != null ? Number(m.duration_ms) : undefined,
                // skill_id = ตัวที่ตอบ, skills_used = ทุกตัวที่ความรู้ถึงโมเดล — อ่านแยกกัน อย่าเอาตัวแรกมาแทนตัวตอบ
                skillId:      m.skill_id || null,
                skillsUsed:   m.skills_used ? String(m.skills_used).split(',').filter(Boolean) : [],
            }));

            // เลือก skill ตาม hint จากคำตอบล่าสุด ไม่มีก็คงของเดิม
            const lastSkillId = [...(res.messages || [])].reverse()
                .find(m => m.skill_id)?.skill_id;
            if (lastSkillId) selectSkill(lastSkillId);

            renderChatMessages(State.currentMessages);
            renderSessionList();
        }

        // ── RENDER MESSAGES ──
        function renderChatMessages(messages) {
            const area = document.getElementById('chat-area');
            area.innerHTML = '';
            if (!messages || messages.length === 0) {
                area.innerHTML = `
            <div class="chat-empty" id="chat-empty">
                <div class="chat-empty-icon">💬</div>
                <div class="chat-empty-title">${esc(t('u.chat.newRoomTitle'))}</div>
                <div class="chat-empty-sub">${esc(t('u.chat.newRoomSub'))}</div>
            </div>`;
                return;
            }
            messages.forEach((msg, idx) => {
                const isLast = (idx === messages.length - 1);
                if (msg.role === 'user') {
                    const div = document.createElement('div');
                    div.className = 'chat-msg user';
                    div.innerHTML = '<div class="msg-bubble">' + esc(msg.content) + '</div>';
                    area.appendChild(div);
                } else if (msg.role === 'assistant') {
                    const div = document.createElement('div');
                    div.className = 'chat-msg assistant';
                    const bubble = document.createElement('div');
                    bubble.className = 'msg-bubble md-rendered';
                    bubble.innerHTML = MD.render(msg.content || '');
                    MD.postProcess(bubble);
                    div.appendChild(bubble);
                    // ⧉ Copy + ↻ Regenerate toolbar
                    const actions = MD.attachMessageCopy(bubble, msg.content || '');
                    // เอาชื่อไฟล์จาก turn ที่ถามมา — reopen แล้วดาวน์โหลดได้ชื่อเดียวกับตอน live
                    const askedWith = (messages[idx - 1] || {}).content || '';
                    const fileTag = /\[File:\s*([^\]\n]+)\]/.exec(askedWith);
                    if (actions) MD.attachMessageDownload(actions, msg.content || '',
                        fileTag ? fileTag[1].trim() : undefined);
                    if (actions && isLast) addRegenerateButton(actions);
                    // reopen แล้วต้องเห็นแถบ 🎯 เหมือนตอน live
                    if (msg.skillId || (msg.skillsUsed && msg.skillsUsed.length)) {
                        const sb = document.createElement('div');
                        sb.className = 'skill-badge';
                        const others = (msg.skillsUsed || []).filter(x => x !== msg.skillId);
                        // พิมพ์ label ไม่ใช่ raw id — id เป็น fallback เมื่อ catalog ไม่รู้จักแล้ว
                        const skillLabel = (id) =>
                            (PRICING.skills.find(x => x.id === id) || {}).name || id;
                        sb.textContent = msg.skillId
                            ? '🎯 ' + t('chat.skillMatched', 'ใช้ Skill') + ': ' + skillLabel(msg.skillId)
                            : '🎯 ' + t('chat.skillNone', 'ไม่ได้ใช้ Skill เฉพาะ — ตอบแบบทั่วไป');
                        if (others.length) {
                            const extra = document.createElement('span');
                            extra.className = 'skill-badge-src';
                            extra.textContent = ' + ' + others.join(', ');
                            sb.appendChild(extra);
                        }
                        div.insertBefore(sb, bubble);
                    }
                    if (msg.cost !== undefined) {
                        const tok = (msg.inputTokens || 0) + (msg.outputTokens || 0);
                        const badge = document.createElement('div');
                        badge.className = 'cost-badge';
                        // ไม่มี duration จริงก็อย่าอ้าง "0.0s" — พิมพ์แค่ token
                        badge.textContent = tok.toLocaleString() + ' tokens'
                            + (msg.durationMs ? ' · ' + (msg.durationMs / 1000).toFixed(1) + 's' : '');
                        div.appendChild(badge);
                    }
                    area.appendChild(div);
                }
            });
            scrollToBottom(area, true);
        }

        // ── RENDER SESSION LIST ── favorites ปักบนสุด แยกจากกลุ่มวันที่

        // แถว session เป็น HTML string ที่เดียว — search/favorites/date ใช้ markup + a11y ชุดเดียวกัน
        function _renderSessionRow(s) {
            const active = s.id === State.currentSessionId ? 'active' : '';
            const isFav  = (s.isFavorite || s.is_favorite) ? 'is-favorite' : '';
            const favLabel = (s.isFavorite || s.is_favorite) ? t('u.sess.unfavorite') : t('u.sess.favorite');
            const favIcon  = (s.isFavorite || s.is_favorite) ? '★' : '☆';
            const renameLabel = t('u.sess.rename'), exportLabel = t('u.sess.exportMd'), delLabel = t('btn.deletePlain');
            return `<div class="session-item ${active} ${isFav}" data-sid="${s.id}"
                onclick="loadSession(${s.id})"
                onkeydown="handleSessionKey(event,${s.id})"
                role="button" tabindex="0" aria-label="${esc(s.title)}">
                <span class="session-emoji">💬</span>
                <span class="session-title" title="${esc(s.title)}" ondblclick="enterRenameMode(event,${s.id})">${esc(s.title)}</span>
                <div class="session-actions">
                    <button class="session-act-btn session-fav" onclick="toggleFavorite(event,${s.id})" title="${favLabel}" aria-label="${favLabel}" aria-pressed="${!!(s.isFavorite || s.is_favorite)}">${favIcon}</button>
                    <button class="session-act-btn" onclick="enterRenameMode(event,${s.id})" title="${renameLabel}" aria-label="${renameLabel}">✎</button>
                    <button class="session-act-btn" onclick="exportSession(event,${s.id})" title="${exportLabel}" aria-label="Export">⬇</button>
                    <button class="session-act-btn session-del" onclick="deleteSession(event,${s.id})" title="${delLabel}" aria-label="${delLabel}">×</button>
                </div>
            </div>`;
        }

        function renderSessionList() {
            const list = document.getElementById('history-list');
            const searching = (State.searchQuery || '').length > 0;
            if (!State.sessions || State.sessions.length === 0) {
                // ค้นแล้วว่าง vs ยังไม่เคยมีแชท — คนละข้อความ
                if (searching) {
                    list.innerHTML =
                        '<div class="history-empty no-result">' +
                            '<div class="he-icon">🔍</div>' +
                            '<div class="he-title">' + esc(t('u.sess.searchNoResultsTitle')) + '</div>' +
                            '<div class="he-sub">' + esc(t('u.sess.searchNoResultsSub')) + '</div>' +
                        '</div>';
                } else {
                    list.innerHTML =
                        '<div class="history-empty">' +
                            '<div class="he-icon">💬</div>' +
                            '<div class="he-title">' + esc(t('u.history.emptyTitle')) + '</div>' +
                            '<div class="he-sub">' + esc(t('u.history.emptySub')) + '</div>' +
                            '<button type="button" class="he-cta" onclick="newChat()">' + esc(t('u.history.startFirst')) + '</button>' +
                        '</div>';
                }
                return;
            }

            // ตอนค้นหาไม่จัดกลุ่ม — server เรียง favorites ก่อนแล้ว
            if (searching) {
                let sh = '<div class="date-group-label">' + esc(tf('u.sess.searchResultsCount', { n: State.sessions.length })) + '</div>';
                State.sessions.forEach(s => { sh += _renderSessionRow(s); });
                list.innerHTML = sh;
                return;
            }

            // favorites อยู่ section เดียว ไม่โผล่ซ้ำใน bucket วันที่
            const favs   = State.sessions.filter(s => (s.isFavorite || s.is_favorite));
            const others = State.sessions.filter(s => !(s.isFavorite || s.is_favorite));

            // จัดกลุ่มตามวัน (เทียบเที่ยงคืน local) — key เป็นภาษากลาง ป้ายค่อย lookup ตามภาษา
            const now = new Date();
            const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
            const yesterdayStart = todayStart - 86400000;
            const weekStart = todayStart - 7 * 86400000;
            const monthStart = todayStart - 30 * 86400000;

            const groups = { today: [], yesterday: [], week: [], month: [], older: [] };
            others.forEach(s => {
                // รับทั้ง updatedAt และ updated_at
                const when = s.updatedAt || s.updated_at;
                const ts = new Date(when).getTime();
                const d = new Date(when);
                const dayT = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
                if (dayT >= todayStart) groups.today.push(s);
                else if (dayT >= yesterdayStart) groups.yesterday.push(s);
                else if (ts >= weekStart) groups.week.push(s);
                else if (ts >= monthStart) groups.month.push(s);
                else groups.older.push(s);
            });
            const groupLabelKeys = { today: 'date.today', yesterday: 'date.yesterday', week: 'date.last7days', month: 'date.thisMonth', older: 'date.older' };

            let html = '';
            // Favorites group at the top (only when there are any)
            if (favs.length > 0) {
                html += '<div class="date-group-label fav-group">Favorites · ' + favs.length + '</div>';
                favs.forEach(s => { html += _renderSessionRow(s); });
            }
            // Date-bucketed history below
            for (const [key, items] of Object.entries(groups)) {
                if (items.length === 0) continue;
                html += '<div class="date-group-label">' + esc(t(groupLabelKeys[key])) + '</div>';
                items.forEach(s => { html += _renderSessionRow(s); });
            }
            list.innerHTML = html;
        }

        // ── SESSION ACTIONS: rename / export / delete ──
        // dblclick หรือ ✎ สลับ span เป็น <input>; Enter/blur = save, Esc = cancel
        function enterRenameMode(e, sessionId) {
            e.stopPropagation();
            if (e.preventDefault) e.preventDefault();
            const row = document.querySelector('.session-item[data-sid="' + sessionId + '"]');
            if (!row) return;
            if (row.classList.contains('is-editing')) return;
            const titleEl = row.querySelector('.session-title');
            if (!titleEl) return;

            const sess = State.sessions.find(s => s.id === sessionId);
            const current = (sess ? sess.title : titleEl.textContent) || '';

            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'session-title-input';
            input.value = current;
            input.maxLength = 200;
            input.setAttribute('aria-label', t('u.sess.titleAriaLabel'));
            // Prevent parent row's onclick (loadSession) from firing
            const stop = (ev) => ev.stopPropagation();
            input.addEventListener('mousedown', stop);
            input.addEventListener('click', stop);
            input.addEventListener('dblclick', stop);

            let committed = false;
            const cleanup = (newTitle) => {
                if (committed) return;
                committed = true;
                const span = document.createElement('span');
                span.className = 'session-title';
                span.title = newTitle;
                span.textContent = newTitle;
                span.setAttribute('ondblclick', 'enterRenameMode(event,' + sessionId + ')');
                input.replaceWith(span);
                row.classList.remove('is-editing');
            };

            const commit = async () => {
                const trimmed = input.value.trim();
                if (!trimmed || trimmed === current) {
                    cleanup(current);
                    return;
                }
                const finalTitle = trimmed.slice(0, 200);
                cleanup(finalTitle);  // optimistic UI
                const ok = await apiRenameSession(sessionId, finalTitle);
                if (ok) {
                    if (sess) sess.title = finalTitle;
                    showToast(t('u.sess.renameSuccess'));
                } else {
                    // Roll back title text on failure
                    if (sess) sess.title = current;
                    renderSessionList();
                    showToast(t('u.sess.renameFailed'), 'error');
                }
            };

            input.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') {
                    ev.preventDefault();
                    input.blur(); // triggers commit via blur handler
                } else if (ev.key === 'Escape') {
                    ev.preventDefault();
                    // Cancel — restore previous label without API call
                    input.removeEventListener('blur', onBlur);
                    cleanup(current);
                }
            });
            const onBlur = () => { commit(); };
            input.addEventListener('blur', onBlur);

            row.classList.add('is-editing');
            titleEl.replaceWith(input);
            // focus + select-all ให้พิมพ์ทับได้ทันที
            input.focus();
            input.select();
        }

        async function exportSession(e, sessionId) {
            e.stopPropagation();
            const blob = await apiExportSessionUrl(sessionId);
            if (!blob) { showToast(t('u.sess.exportFailed'), 'error'); return; }
            const url = URL.createObjectURL(blob);
            const sess = State.sessions.find(s => s.id === sessionId);
            const safe = (sess?.title || 'chat').replace(/[^\w\-]+/g, '_').slice(0, 60) || 'chat';
            const a = document.createElement('a');
            a.href = url; a.download = safe + '.md';
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }

        // ── FAVORITE ── optimistic: flip local ก่อนแล้ว PATCH; ล้มเหลวค่อย roll back + toast
        async function toggleFavorite(e, sessionId) {
            if (e && e.stopPropagation) e.stopPropagation();
            const sess = (State.sessions || []).find(s => s.id === sessionId);
            if (!sess) return;
            const wasFav = !!(sess.isFavorite || sess.is_favorite);
            const nowFav = !wasFav;
            // Optimistic flip
            sess.isFavorite = nowFav;
            sess.is_favorite = nowFav;
            renderSessionList();
            try {
                const r = await fetch(BASE + '/api/chat/sessions/' + sessionId, {
                    method: 'PATCH',
                    headers: Auth.authHeaders(),
                    body: JSON.stringify({ favorite: nowFav }),
                });
                if (!r.ok) throw new Error('HTTP ' + r.status);
                showToast(nowFav ? t('u.sess.pinned') : t('u.sess.unpinned'), 'success');
            } catch (err) {
                // Roll back optimistic change
                sess.isFavorite = wasFav;
                sess.is_favorite = wasFav;
                renderSessionList();
                showToast(t('u.sess.pinFailedPrefix') + err.message, 'error');
            }
        }

        // ลบแชทผ่าน modal ใน-แอป — จำ id ให้ปุ่ม Confirm และ re-fetch หลังลบกันแถวเด้งกลับ
        let _pendingDeleteSessionId = null;

        function deleteSession(e, sessionId) {
            if (e && e.stopPropagation) e.stopPropagation();
            _pendingDeleteSessionId = sessionId;
            const sess = (State.sessions || []).find(s => s.id === sessionId);
            const titleEl = document.getElementById('confirm-delete-target');
            // ไม่มีชื่อแชท → ซ่อน chip ไปเลย — ประโยค "จะถูกลบถาวร" อ่านรู้เรื่องอยู่แล้ว
            const title = (sess && sess.title) ? String(sess.title).trim() : '';
            if (titleEl) {
                if (title) {
                    titleEl.textContent = title;
                    titleEl.style.display = '';
                } else {
                    titleEl.textContent = '';
                    titleEl.style.display = 'none';
                }
            }
            const btn = document.getElementById('confirm-delete-btn');
            // รีเซ็ตปุ่มทุกครั้งที่เปิด
            if (btn) { btn.disabled = false; btn.textContent = 'Delete'; }
            const overlay = document.getElementById('confirm-delete-chat');
            overlay.classList.add('open');
            // Move focus to Cancel so accidental Enter doesn't delete.
            setTimeout(() => {
                const cancel = overlay.querySelector('.btn-confirm-cancel');
                if (cancel) cancel.focus();
            }, 50);
        }

        function cancelDeleteChat(ev) {
            // overlay click — only close if user clicked the backdrop, not the box
            if (ev && ev.target && ev.target.id !== 'confirm-delete-chat' && ev.type === 'click') {
                if (!ev.target.classList?.contains('confirm-overlay')) return;
            }
            _pendingDeleteSessionId = null;
            document.getElementById('confirm-delete-chat').classList.remove('open');
        }

        async function confirmDeleteChat() {
            const id = _pendingDeleteSessionId;
            if (!id) { cancelDeleteChat(); return; }
            const btn = document.getElementById('confirm-delete-btn');
            if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
            try {
                // Properly await + check response so silent failures surface.
                const r = await fetch(BASE + '/api/chat/sessions/' + id, {
                    method: 'DELETE',
                    headers: Auth.authHeaders(),
                });
                const ok = r.ok;
                if (!ok) {
                    showToast(tf('u.sess.deleteFailedHttp', { code: r.status }), 'error');
                    if (btn) { btn.disabled = false; btn.textContent = 'Delete'; }
                    return;
                }
            } catch (err) {
                showToast('Network error: ' + err.message, 'error');
                if (btn) { btn.disabled = false; btn.textContent = 'Delete'; }
                return;
            }
            // 1) Drop from local state immediately for instant UX feedback
            State.sessions = (State.sessions || []).filter(s => s.id !== id);
            const wasCurrent = State.currentSessionId === id;
            // 2) If we deleted the active chat, reset the chat area to empty
            if (wasCurrent) newChat();
            else renderSessionList();
            // resync จาก server — กันแถวที่ลบแล้วเด้งกลับจาก fetch อื่นที่ค้างอยู่
            apiLoadSessions();
            // 4) Close the modal + toast
            _pendingDeleteSessionId = null;
            document.getElementById('confirm-delete-chat').classList.remove('open');
            showToast(t('u.sess.deleted'));
        }

        // Esc-to-close for the confirm modal
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') {
                const overlay = document.getElementById('confirm-delete-chat');
                if (overlay && overlay.classList.contains('open')) cancelDeleteChat();
            }
        });

        // ── SKILL SELECTION ── (picker ถูกถอดแล้ว — router ฝั่ง server เป็นคนเลือก)
        function selectSkill(skillId) {
            State.selectedSkill = skillId;
            // header คงคำว่า "PetabyteAi" เสมอ — skill ยังถูก track และส่งไป backend ตามปกติ
            const el = document.getElementById('current-skill-name');
            if (el) el.textContent = 'PipekAI';   // emoji replaced by the mascot <img> beside it
        }

        // ── SEND MESSAGE ──
        async function sendMessage() {
            if (State.isRunning) return;
            const inputEl = document.getElementById('chat-input');
            let userText = inputEl.value.trim();
            if (!userText && !State.attachedFile) { showToast(t('u.err.enterMessage'), 'error'); return; }
            // align with the in-sidebar warning copy + emoji
            if (State.balance <= 0) {
                showToast(t('u.err.creditDepletedContactAdmin'), 'error');
                return;
            }
            // Default to 'auto' skill if nothing selected
            const selectedSkillId = State.selectedSkill || 'auto';
            const skill = PRICING.skills.find(s => s.id === selectedSkillId) || PRICING.skills[0];
            const displayText = userText || '[File: ' + (State.attachedFile ? State.attachedFile.name : '') + ']';
            let prompt = userText;
            // เก็บชื่อไฟล์ก่อน removeFile() ล้าง — ไฟล์ที่แก้แล้วต้องกลับไปชื่อเดิม ไม่ใช่ pipekai-response.abap
            const uploadedName = State.attachedFile ? State.attachedFile.name : null;
            if (State.attachedFile) { prompt = (prompt ? prompt + '\n\n' : '') + '[File: ' + State.attachedFile.name + ']\n' + State.attachedFile.content; removeFile(); }
            inputEl.value = ''; inputEl.style.height = 'auto';

            // Add user message to current messages
            const userMsg = { role: 'user', content: displayText, timestamp: new Date().toISOString() };
            State.currentMessages.push(userMsg);

            // Render user bubble
            const area = document.getElementById('chat-area');
            const emptyEl = document.getElementById('chat-empty'); if (emptyEl) emptyEl.remove();
            const userDiv = document.createElement('div'); userDiv.className = 'chat-msg user';
            userDiv.innerHTML = '<div class="msg-bubble">' + esc(displayText) + '</div>';
            area.appendChild(userDiv); area.scrollTop = area.scrollHeight;

            // ปุ่ม send กลายเป็นปุ่ม stop — คงกดได้เพื่อยกเลิก, isRunning กันส่งซ้ำ
            State.isRunning = true;
            const sendBtn = document.getElementById('send-btn');
            sendBtn.classList.add('is-stop');
            sendBtn.setAttribute('aria-label', t('u.stop.ariaLabel'));
            sendBtn.title = t('u.stop.ariaLabel') + ' (Esc)';

            // Typing indicator
            const typingDiv = document.createElement('div'); typingDiv.className = 'chat-msg assistant'; typingDiv.id = 'typing-el';
            typingDiv.innerHTML = '<div class="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>';
            area.appendChild(typingDiv); area.scrollTop = area.scrollHeight;

            const session = Auth.getSession();
            const projs = JSON.parse(localStorage.getItem('agenthub_projects') || '[]');
            const proj = projs.find(p => p.id === session?.projectId);
            const rates = proj ? { inputRate: proj.inputRate, outputRate: proj.outputRate } : { inputRate: 0.50, outputRate: 1.50 };

            let accumulated = '', responseMsgEl = null, streamBubble = null;

            // RAG badge อาจมาก่อน text chunk แรก — shell ต้องสร้างได้จากทั้งสองฝั่ง
            let ragBadgeEl = null, ragQuery = '';
            // skill badge อยู่เหนือ RAG badge — "ใช้ prompt ไหน" มาก่อน "ค้นอะไร"
            let skillBadgeEl = null;
            function ensureResponseShell() {
                if (!responseMsgEl) {
                    responseMsgEl = document.createElement('div');
                    responseMsgEl.className = 'chat-msg assistant';
                    area.appendChild(responseMsgEl);
                }
            }
            const onTool = (ev) => {
                if (ev.type === 'tool_call' && ev.search) {
                    ragQuery = ev.search.query || '';
                    ensureResponseShell();
                    if (!ragBadgeEl) {
                        ragBadgeEl = document.createElement('div');
                        // below the skill badge when both are present.
                        responseMsgEl.insertBefore(ragBadgeEl,
                            skillBadgeEl ? skillBadgeEl.nextSibling : responseMsgEl.firstChild);
                    }
                    ragBadgeEl.className = 'rag-badge searching';
                    ragBadgeEl.textContent = '🔍 ' + t('chat.ragSearching', 'กำลังค้นเอกสาร') + (ragQuery ? ': "' + ragQuery + '"' : '') + '…';
                    scrollToBottom(area);
                } else if (ev.type === 'tool_result' && ev.name === 'search_knowledge' && ragBadgeEl) {
                    ragBadgeEl.className = 'rag-badge';
                    ragBadgeEl.textContent = '';
                    const head = document.createElement('div');
                    head.className = 'rag-badge-head';
                    head.textContent = '🔍 ' + t('chat.ragSearched', 'ค้นเอกสาร') + (ragQuery ? ': "' + ragQuery + '"' : '');
                    ragBadgeEl.appendChild(head);
                    if (ev.found && Array.isArray(ev.files) && ev.files.length) {
                        for (const f of ev.files) {
                            const line = document.createElement('div');
                            line.className = 'rag-badge-file';
                            line.textContent = '📄 ' + f;
                            ragBadgeEl.appendChild(line);
                        }
                    } else {
                        const line = document.createElement('div');
                        line.className = 'rag-badge-file';
                        line.textContent = t('chat.ragNotFound', '— ไม่พบเนื้อหาที่เกี่ยวข้องในคลังเอกสาร');
                        ragBadgeEl.appendChild(line);
                    }
                    scrollToBottom(area);
                }
            };

            // SSE routed = router จับ skill ไหน/เลือกยังไง — เดิม client ทิ้ง event จน skill ดูไม่ทำงาน
            const onRouted = (ev) => {
                ensureResponseShell();
                if (!skillBadgeEl) {
                    skillBadgeEl = document.createElement('div');
                    skillBadgeEl.className = 'skill-badge';
                    responseMsgEl.insertBefore(skillBadgeEl, responseMsgEl.firstChild);
                }
                skillBadgeEl.textContent = '';
                if (ev.skillId) {
                    skillBadgeEl.appendChild(document.createTextNode(
                        '🎯 ' + t('chat.skillMatched', 'ใช้ Skill') + ': ' + (ev.skillLabel || ev.skillId)));
                    const srcKey = ev.source === 'code-shape' ? 'chat.skillSrcCode'
                                 : ev.source === 'catch-all'  ? 'chat.skillSrcCatchAll'
                                 : ev.source === 'llm'        ? 'chat.skillSrcLlm' : null;
                    if (srcKey) {
                        const src = document.createElement('span');
                        src.className = 'skill-badge-src';
                        src.textContent = ' · ' + t(srcKey, '');
                        skillBadgeEl.appendChild(src);
                    }
                    // โชว์ชื่อ check ที่ร่วมตอบ ไม่ใช่ "+3" — tester อยากรู้ว่าตัวไหนรัน
                    if (Array.isArray(ev.supporting) && ev.supporting.length) {
                        const extra = document.createElement('span');
                        extra.className = 'skill-badge-src';
                        extra.textContent = ' + ' + ev.supporting.join(', ');
                        skillBadgeEl.appendChild(extra);
                    }
                } else {
                    skillBadgeEl.textContent =
                        '🎯 ' + t('chat.skillNone', 'ไม่ได้ใช้ Skill เฉพาะ — ตอบแบบทั่วไป');
                }
                scrollToBottom(area);
            };

            // เผยข้อความแบบจำกัดความเร็ว — กันคำตอบโผล่พรวดจนกด Stop ไม่ทัน และลด DOM repaint
            let displayedLen = 0;
            let revealTimer = null;
            const REVEAL_TICK_MS = 20;
            const REVEAL_CHARS_PER_TICK = 5;   // ~250 chars/sec reveal rate

            function stopReveal() {
                if (revealTimer) { clearInterval(revealTimer); revealTimer = null; }
            }
            function startReveal() {
                if (revealTimer) return;
                revealTimer = setInterval(() => {
                    if (displayedLen >= accumulated.length) return;
                    displayedLen = Math.min(accumulated.length, displayedLen + REVEAL_CHARS_PER_TICK);
                    // ระหว่าง stream ใช้ textContent (เร็ว/ปลอดภัย) — markdown render ทีเดียวตอนจบ
                    if (streamBubble) streamBubble.textContent = accumulated.slice(0, displayedLen);
                    scrollToBottom(area);
                }, REVEAL_TICK_MS);
            }

            // 402 = pool หมด, 429 = ติด daily cap — bubble คนละข้อความคนละปุ่ม
            const onChatBlocked = (info) => {
                const typingEl = document.getElementById('typing-el'); if (typingEl) typingEl.remove();
                showBlockBubble(area, info);
            };

            await AIClient.run(skill.id, prompt, skill.systemPrompt,
                // onChunk
                chunk => {
                    accumulated += chunk;
                    const typingEl = document.getElementById('typing-el'); if (typingEl) typingEl.remove();
                    // shell อาจมีแล้ว (RAG badge สร้างก่อน) — ตรงนี้สร้างเฉพาะ text bubble
                    ensureResponseShell();
                    if (!streamBubble) {
                        streamBubble = document.createElement('div');
                        streamBubble.className = 'msg-bubble';
                        responseMsgEl.appendChild(streamBubble);
                    }
                    startReveal();
                },
                async result => {
                    stopReveal();
                    const typingEl = document.getElementById('typing-el'); if (typingEl) typingEl.remove();
                    // จบแบบไม่มี text เลย (เช่น reasoning กินโควตาหมด) — ต้องมี bubble ไม่ปล่อยว่าง
                    if (!streamBubble && accumulated === '' && !result.stopped && !result.blocked) {
                        // shell may already exist (RAG badge) — reuse it.
                        ensureResponseShell();
                        streamBubble = document.createElement('div');
                        streamBubble.className = 'msg-bubble';
                        streamBubble.textContent = t('chat.emptyAnswer',
                            '⚠️ โมเดลคิดนานจนหมดโควต้าคำตอบ — ลองส่งใหม่อีกครั้ง หรือลดระดับ effort ลงหนึ่งขั้น');
                        responseMsgEl.appendChild(streamBubble);
                    }
                    // ใช้ cost จาก server — เลิกคำนวณเองจาก rate เก่าที่อาจไม่ตรงกับที่หักจริง
                    const cost = result.cost != null ? result.cost : 0;

                    // Finalize bubble: render markdown, highlight code, attach copy/regenerate
                    if (responseMsgEl && streamBubble) {
                        streamBubble.classList.add('md-rendered');
                        streamBubble.innerHTML = MD.render(accumulated);
                        MD.postProcess(streamBubble);
                        const actions = MD.attachMessageCopy(streamBubble, accumulated);
                        if (actions) MD.attachMessageDownload(actions, accumulated, uploadedName);
                        if (actions) addRegenerateButton(actions);

                        const badge = document.createElement('div'); badge.className = 'cost-badge';
                        badge.textContent = (result.inputTokens + result.outputTokens).toLocaleString() + ' tokens · ' + (result.durationMs / 1000).toFixed(1) + 's';
                        responseMsgEl.appendChild(badge);
                    }

                    // Add assistant message to State.currentMessages
                    const assistantMsg = {
                        role: 'assistant', content: accumulated,
                        inputTokens: result.inputTokens, outputTokens: result.outputTokens,
                        cost, durationMs: result.durationMs, timestamp: new Date().toISOString()
                    };
                    State.currentMessages.push(assistantMsg);

                    // backend บันทึกทั้งสอง turn แล้ว echo sessionId — pin ไว้แล้ว refresh sidebar
                    if (result.sessionId) {
                        const wasFresh = !State.currentSessionId;
                        // coerce — see apiLoadSessions note.
                        State.currentSessionId = Number(result.sessionId);
                        // pin ลง URL — refresh กลางแชทแล้วยังอยู่ thread เดิม
                        try {
                            const want = '#s/' + result.sessionId;
                            if (window.location.hash !== want && window.history && window.history.replaceState) {
                                window.history.replaceState(null, '', want);
                            }
                        } catch (_) { }
                        await apiLoadSessions();
                        if (wasFresh) renderSessionList();
                    }

                    // Usage history
                    State.addUsageEntry({
                        skillId: skill.id, skillName: skill.name, skillEmoji: skill.emoji,
                        prompt: displayText.substring(0, 100), response: accumulated.substring(0, 200),
                        inputTokens: result.inputTokens, outputTokens: result.outputTokens, cost, durationMs: result.durationMs
                    });

                    // ดึงตัวเลขจริงหลังหักเงิน — ไม่รอ poll 60s
                    refreshQuotaWarning();
                    if (result.stopped) {
                        showToast(t('u.stop.stoppedGenerating'), 'success');
                    } else {
                        showToast(t('u.done'), 'success');
                    }
                    State.isRunning = false;
                    const sb = document.getElementById('send-btn');
                    sb.classList.remove('is-stop');
                    sb.disabled = false;
                    sb.setAttribute('aria-label', 'Send');
                    sb.title = '';
                },
                rates,
                State.currentSessionId,   // thread into an existing chat
                onChatBlocked,             // 402/429 → block UI
                { model: State.selectedModel, effort: State.selectedEffort, onTool, onRouted }  // Phase 34 + 35.2 + 39
            );
        }

        // bubble "โดนบล็อก" ในแชท — pool หมด/ติด cap คนละ copy คนละปุ่ม
        function showBlockBubble(area, info) {
            const div = document.createElement('div');
            div.className = 'chat-msg assistant';
            const isCapHit = info && info.error === 'daily_cap_exceeded';
            const isPoolEmpty = info && info.error === 'project_pool_empty';
            let title, body, action = '';
            if (isPoolEmpty) {
                title = t('u.block.poolEmptyTitle');
                body  = t('u.block.poolEmptyBody');
            } else if (isCapHit) {
                title = t('u.block.capHitTitle');
                const spent = (info.spentToday || 0).toFixed(2);
                const cap   = (info.effective || info.dailyCap || 0).toFixed(2);
                body  = tf('u.block.capHitBody', { spent, cap });
                if (info.canRequestMore) {
                    action = '<button type="button" class="block-action-btn" onclick="openQuotaRequestModal()">' + esc(t('u.quota.requestMore')) + '</button>';
                }
            } else {
                title = t('u.block.sendFailedTitle');
                body  = (info && info.message) || (info && info.error) || t('u.block.tryAgain');
            }
            div.innerHTML =
                '<div class="msg-bubble block-bubble">'
                + '<div class="block-title">' + title + '</div>'
                + '<div class="block-body">' + esc(body) + '</div>'
                + (action ? '<div class="block-action">' + action + '</div>' : '')
                + '</div>';
            area.appendChild(div);
            area.scrollTop = area.scrollHeight;
            // Also reset the send button state in case the caller relied on onDone.
            State.isRunning = false;
            const sb = document.getElementById('send-btn');
            if (sb) { sb.classList.remove('is-stop'); sb.disabled = false; sb.setAttribute('aria-label', t('u.send.ariaLabel')); sb.title = ''; }
        }

        // Phase 21.10 — Quota request modal (asks server to grant a today-only bonus)
        function openQuotaRequestModal() {
            const amountStr = prompt(t('u.quota.promptAmount'), '50');
            if (amountStr === null) return;
            const amt = parseFloat(amountStr);
            if (!Number.isFinite(amt) || amt <= 0) { showToast(t('u.quota.invalidAmount'), 'error'); return; }
            const reason = prompt(t('u.quota.promptReason'), '') || '';
            fetch(BASE + '/api/quota-requests', {
                method: 'POST',
                headers: Object.assign({ 'Content-Type': 'application/json' }, Auth.authHeaders()),
                body: JSON.stringify({ requestedExtra: amt, reason: reason }),
            })
            .then(r => r.json())
            .then(d => {
                if (!d.ok) {
                    // แปล error code ที่รู้จักตามภาษา user; ไม่รู้จักใช้ข้อความจาก server
                    const msg = d.error === 'pending_request_exists'
                        ? t('u.quota.pendingExists')
                        : (d.message || d.error || t('u.quota.requestFailed'));
                    showToast(msg, 'error');
                    return;
                }
                showToast(t('u.quota.requestSent'), 'success');
            })
            .catch(e => showToast('Error: ' + e.message, 'error'));
        }
        // Expose for the inline onclick in the block bubble.
        window.openQuotaRequestModal = openQuotaRequestModal;

        // ── UI HELPERS ──
        // การ์ด balance: <= 0 แดง + บล็อกส่ง, ต่ำกว่า threshold ส้มเตือน
        const BALANCE_WARN_THRESHOLD = 10;        // baht — adjust if needed
        function updateBalanceDisplay() {
            const card = document.getElementById('balance-card');
            const amt  = document.getElementById('sidebar-balance');
            const warn = document.getElementById('balance-warn');
            const v = Number(State.balance) || 0;
            if (amt) amt.textContent = '฿' + v.toFixed(2);
            if (!card || !warn) return;
            card.classList.remove('is-low', 'is-empty');
            warn.classList.remove('warn', 'critical');
            if (v <= 0) {
                card.classList.add('is-empty');
                warn.classList.add('critical');
                warn.textContent = t('u.err.creditDepletedContactAdmin');
                warn.style.display = '';
            } else if (v < BALANCE_WARN_THRESHOLD) {
                card.classList.add('is-low');
                warn.classList.add('warn');
                warn.textContent = tf('u.balance.lowWarn', { v: v.toFixed(2) });
                warn.style.display = '';
            } else {
                warn.style.display = 'none';
            }
        }

        // การ์ด cap-usage: spend วันนี้ vs cap; dailyCap null = ไม่มี cap โชว์แค่ spend
        function updateCapUsageCard(d) {
            const spentEl = document.getElementById('cap-usage-spent');
            const ofEl    = document.getElementById('cap-usage-of');
            const fill    = document.getElementById('cap-usage-bar-fill');
            if (!spentEl || !ofEl || !fill) return;
            const spent = Number(d.spentToday) || 0;
            spentEl.textContent = '฿' + spent.toFixed(2);
            if (d.dailyCap == null) {
                ofEl.textContent = t('u.cap.noLimit');
                fill.style.width = '0%';
                fill.classList.remove('warn', 'critical');
            } else {
                ofEl.textContent = '/ ฿' + Number(d.effectiveCap || 0).toFixed(2);
                const pct = Math.max(0, Math.min(100, Math.round((d.usageRatio || 0) * 100)));
                fill.style.width = pct + '%';
                fill.classList.toggle('critical', !!d.capExceeded);
                fill.classList.toggle('warn', !d.capExceeded && !!d.warning80);
            }
        }

        // poll /api/quota-status — fail เงียบได้ เกตจริงอยู่ฝั่ง server
        async function refreshQuotaWarning() {
            try {
                const r = await fetch(BASE + '/api/quota-status', { headers: Auth.authHeaders() });
                if (!r.ok) return;
                const d = await r.json();
                if (!d.ok) return;
                // ถูกเรียกหลังจบแต่ละ turn ด้วย — sidebar เห็นตัวเลขจริงไม่ต้องรอ poll
                State.balance = parseFloat(d.projectPool) || 0;
                State.save();
                updateBalanceDisplay();
                updateCapUsageCard(d);
                const banner = document.getElementById('quota-warn-banner');
                const text   = document.getElementById('quota-warn-text');
                if (!banner || !text) return;
                if (d.capExceeded) {
                    banner.classList.add('visible');
                    text.textContent = tf('u.quota.capReachedFull', {
                        spent: Number(d.spentToday).toFixed(2), cap: Number(d.effectiveCap).toFixed(2)
                    });
                } else if (d.warning80) {
                    banner.classList.add('visible');
                    const pct = Math.round((d.usageRatio || 0) * 100);
                    text.textContent = tf('u.quota.usedPercent', {
                        pct, spent: Number(d.spentToday).toFixed(2),
                        cap: Number(d.effectiveCap).toFixed(2), remaining: Number(d.remaining).toFixed(2)
                    });
                } else {
                    banner.classList.remove('visible');
                }
            } catch (_) { /* silent */ }
        }
        // รันทันทีหนึ่งครั้ง (การ์ดต้องมีข้อมูลตั้งแต่ paint แรก) แล้ววนทุก 60s
        refreshQuotaWarning();
        setInterval(refreshQuotaWarning, 60_000);

        function overlayClick(e, id) { if (e.target === document.getElementById(id)) closeOverlay(id); }
        function closeOverlay(id) { document.getElementById(id).classList.remove('open'); }
        function toggleUserMenu() { document.getElementById('user-dropdown').classList.toggle('open'); }
        document.addEventListener('click', e => { if (!document.getElementById('user-area').contains(e.target)) document.getElementById('user-dropdown').classList.remove('open'); });

        // สลับภาษา → re-apply label คงที่ + re-render ส่วนที่ JS สร้าง (เหมือน admin.js)
        window.addEventListener('i18n:change', () => {
            if (typeof I18N !== 'undefined') I18N.apply();
            try { renderSessionList(); } catch (_) {}
            try { refreshQuotaWarning(); } catch (_) {}
            // re-render เฉพาะ empty state ที่โชว์อยู่ — ไม่แตะบทสนทนา
            if (document.getElementById('chat-empty')) {
                try {
                    if (State.currentSessionId) renderChatMessages(State.currentMessages);
                    else newChat();
                } catch (_) {}
            }
        });

        // sidebar มือถือ: force=false ปิด, true เปิด, ไม่ส่ง = toggle
        function toggleSidebar(force) {
            const open = (typeof force === 'boolean') ? force : !document.body.classList.contains('sidebar-open');
            document.body.classList.toggle('sidebar-open', open);
        }

        // ยุบ sidebar เดสก์ท็อป — จำข้าม reload
        function toggleSidebarCollapsed() {
            const collapsed = !document.body.classList.contains('sidebar-collapsed');
            document.body.classList.toggle('sidebar-collapsed', collapsed);
            try { localStorage.setItem('pipek_sidebar_collapsed', collapsed ? '1' : '0'); } catch (_) {}
        }
        // restore ตอนโหลด — transition ค่อยเล่นตอน user กดเอง
        try {
            if (localStorage.getItem('pipek_sidebar_collapsed') === '1') {
                document.body.classList.add('sidebar-collapsed');
            }
        } catch (_) {}

        // สลับ light/dark — key 'ag_theme' ใช้ร่วมกับ admin; bootstrap ใน <head> กัน flash
        function toggleTheme() {
            const html = document.documentElement;
            const now = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
            html.setAttribute('data-theme', now);
            try { localStorage.setItem('ag_theme', now); } catch (_) { }
            _refreshThemeUI();
        }
        function _refreshThemeUI() {
            const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
            const moon  = document.getElementById('theme-icon-moon');
            const sun   = document.getElementById('theme-icon-sun');
            const label = document.getElementById('theme-toggle-label');
            const btn   = document.getElementById('theme-toggle-btn');
            if (moon)  moon.style.display  = isDark ? 'none' : '';
            if (sun)   sun.style.display   = isDark ? '' : 'none';
            if (label) label.textContent   = isDark ? t('theme.light') : t('theme.dark');
            if (btn) {
                btn.setAttribute('aria-pressed', isDark ? 'true' : 'false');
                btn.setAttribute('aria-label', isDark
                    ? t('u.theme.switchToLight')
                    : t('u.theme.switchToDark'));
            }
        }
        // Sync icon/label once DOM is ready
        document.addEventListener('DOMContentLoaded', _refreshThemeUI);

        // cap ไฟล์แนบ 1MB — กัน FileReader ค้าง/ทะลุ context/สตริงยักษ์ค้างใน State (express.json รับ 2MB)
        const MAX_ATTACHMENT_BYTES = 1024 * 1024;

        function handleFileSelect(e) {
            const file = e.target.files[0]; if (!file) return;
            if (file.size > MAX_ATTACHMENT_BYTES) {
                const kb = (file.size / 1024).toFixed(0);
                showToast(tf('u.file.tooLarge', { kb }), 'error');
                e.target.value = '';
                return;
            }
            const reader = new FileReader();
            reader.onload = ev => {
                State.attachedFile = { name: file.name, content: ev.target.result };
                document.getElementById('attached-file-display').innerHTML =
                    '<div class="attached-file">📄 ' + esc(file.name) + '<button onclick="removeFile()">×</button></div>';
            };
            reader.onerror = () => {
                showToast(t('u.file.readFailed'), 'error');
            };
            reader.readAsText(file); e.target.value = '';
        }

        function removeFile() { State.attachedFile = null; document.getElementById('attached-file-display').innerHTML = ''; }

        // ── MODEL + EFFORT PICKERS ── effort มีเฉพาะตระกูล gpt-5.6 — ซ่อนเพื่อไม่ส่ง param ผิด
        function onModelChange(v) {
            State.selectedModel = v; State.save();
            const eff = document.getElementById('effort-select');
            if (eff) eff.style.display = v.startsWith('gpt-5.6') ? '' : 'none';
        }
        function onEffortChange(v) { State.selectedEffort = v; State.save(); }
        // Reflect restored State into the two <select>s on load.
        function syncComposerControls() {
            const m = document.getElementById('model-select');
            const e = document.getElementById('effort-select');
            if (m) m.value = State.selectedModel;
            if (e) { e.value = State.selectedEffort; e.style.display = State.selectedModel.startsWith('gpt-5.6') ? '' : 'none'; }
        }

        // ปุ่มเดียว: idle = send, กำลัง stream = stop
        function onSendBtnClick() {
            if (State.isRunning) { stopGeneration(); }
            else                 { sendMessage(); }
        }
        function stopGeneration() {
            if (!State.isRunning) return;
            const sb = document.getElementById('send-btn');
            sb.disabled = true;   // prevent double-click while abort in-flight
            AIClient.cancel();
            // onDone (with stopped=true) will reset button + toast.
        }
        // Esc while streaming → stop. Also Ctrl/Cmd+K → focus search.
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && State.isRunning) {
                e.preventDefault();
                stopGeneration();
                return;
            }
            if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
                e.preventDefault();
                const input = document.getElementById('history-search');
                if (input) { input.focus(); input.select(); }
            }
        });

        // ── SESSION SEARCH ── debounce 200ms; ล้าง input = กลับ list เต็ม
        let _searchTimer = null;
        function onSearchInput(val) {
            const q = String(val || '');
            State.searchQuery = q.trim();
            document.getElementById('history-search-clear').style.display = q.length ? '' : 'none';
            clearTimeout(_searchTimer);
            _searchTimer = setTimeout(() => apiLoadSessions(State.searchQuery), 200);
        }
        function onSearchKey(e) {
            if (e.key === 'Escape') {
                e.preventDefault();
                clearSearch();
                e.target.blur();
            }
        }
        function clearSearch() {
            const input = document.getElementById('history-search');
            if (input) input.value = '';
            State.searchQuery = '';
            document.getElementById('history-search-clear').style.display = 'none';
            apiLoadSessions();
        }
        function handleInputKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }
        function autoResize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; }
        // escape เครื่องหมายคำพูดด้วย — esc() ถูกใช้ใน attribute, เคย XSS ได้ถ้า title มี "
        function esc(t) {
            return String(t)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        // ── SMART AUTO-SCROLL ── เลื่อนตามเฉพาะตอน user อยู่ใกล้ล่างสุด ไม่งั้นโชว์ปุ่ม ↓ แทน
        const SCROLL_THRESHOLD = 80;    // px from bottom still counts as "at bottom"
        function isNearBottom(area) {
            return area.scrollHeight - area.scrollTop - area.clientHeight < SCROLL_THRESHOLD;
        }
        function scrollToBottom(area, force) {
            if (force || isNearBottom(area)) {
                area.scrollTop = area.scrollHeight;
                hideNewMsgIndicator();
            } else {
                showNewMsgIndicator();
            }
        }
        function ensureNewMsgButton() {
            let btn = document.getElementById('new-msg-btn');
            if (btn) return btn;
            btn = document.createElement('button');
            btn.id = 'new-msg-btn';
            btn.type = 'button';
            btn.className = 'scroll-to-bottom-btn';
            btn.innerHTML = esc(t('u.newMessage'));
            btn.addEventListener('click', () => {
                const area = document.getElementById('chat-area');
                area.scrollTop = area.scrollHeight;
                hideNewMsgIndicator();
            });
            // append to .main (position:relative) so it floats over chat-area
            const main = document.querySelector('.main');
            if (main) main.appendChild(btn);
            return btn;
        }
        function showNewMsgIndicator() { ensureNewMsgButton().classList.add('visible'); }
        function hideNewMsgIndicator() { const b = document.getElementById('new-msg-btn'); if (b) b.classList.remove('visible'); }

        // Hide the indicator once the user scrolls to the bottom themselves.
        document.addEventListener('DOMContentLoaded', () => {
            const area = document.getElementById('chat-area');
            if (!area) return;
            area.addEventListener('scroll', () => { if (isNearBottom(area)) hideNewMsgIndicator(); });
        });

        // ── REGENERATE ── ปุ่ม ↻ ท้ายคำตอบล่าสุด: ถอดคำตอบแล้วส่ง prompt เดิมซ้ำ
        function addRegenerateButton(actionsEl) {
            if (!actionsEl || actionsEl.querySelector('.msg-action-regen')) return;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'msg-action-btn msg-action-regen';
            btn.setAttribute('aria-label', t('u.regen.ariaLabel'));
            btn.innerHTML = '<span class="msg-action-icon">↻</span><span class="msg-action-label">Regenerate</span>';
            btn.addEventListener('click', regenerateLast);
            actionsEl.appendChild(btn);
        }

        async function regenerateLast() {
            if (State.isRunning) return;
            // Find the last user message
            const msgs = State.currentMessages;
            let lastUserIdx = -1;
            for (let i = msgs.length - 1; i >= 0; i--) {
                if (msgs[i].role === 'user') { lastUserIdx = i; break; }
            }
            if (lastUserIdx === -1) { showToast(t('u.regen.noPrevQuestion'), 'error'); return; }
            const lastUser = msgs[lastUserIdx];

            // Drop the last assistant message (we'll re-generate it)
            if (msgs.length > lastUserIdx + 1 && msgs[msgs.length - 1].role === 'assistant') {
                msgs.pop();
            }
            // Re-render the whole list so the old answer disappears cleanly
            renderChatMessages(msgs);

            // pop user message เดิมก่อน — sendMessage() จะ append กลับมาเองไม่ให้ซ้ำ
            msgs.pop();   // remove the user we just re-rendered; sendMessage will re-append
            renderChatMessages(msgs);

            const inputEl = document.getElementById('chat-input');
            inputEl.value = lastUser.content;
            await sendMessage();
        }

        // ── USAGE MODAL ──
        function openUsage() {
            document.getElementById('user-dropdown').classList.remove('open');
            document.getElementById('usage-balance').textContent = '฿ ' + State.balance.toFixed(2);
            document.getElementById('usage-requests').textContent = State.usageHistory.length;
            const tokens = State.usageHistory.reduce((s, h) => s + (h.inputTokens || 0) + (h.outputTokens || 0), 0);
            const cost = State.usageHistory.reduce((s, h) => s + (h.cost || 0), 0);
            document.getElementById('usage-tokens').textContent = tokens.toLocaleString();
            document.getElementById('usage-cost').textContent = '฿ ' + cost.toFixed(2);
            document.getElementById('usage-modal').classList.add('open');
        }

        // ── CHANGE PASSWORD ──
        function openChangePassword() {
            document.getElementById('user-dropdown').classList.remove('open');
            document.getElementById('password-modal').classList.add('open');
        }

        async function changePassword() {
            const newPwd = document.getElementById('new-password').value;
            const confirmPwd = document.getElementById('confirm-password').value;
            if (!newPwd) { showToast(t('u.pw.enterNew'), 'error'); return; }
            if (newPwd !== confirmPwd) { showToast(t('err.pwMismatch'), 'error'); return; }
            const session = Auth.getSession(); if (!session) return;
            try {
                // dedicated self-only endpoint (no admin rights needed)
                const r = await fetch(BASE + '/api/users/' + session.userId + '/password', {
                    method: 'PUT',
                    headers: Auth.authHeaders(),
                    body: JSON.stringify({ password: newPwd })
                });
                const d = await r.json();
                if (!d.ok) { showToast(t('u.pw.changeFailedPrefix') + (d.error || ''), 'error'); return; }
            } catch (e) { showToast(t('u.err.somethingWrong'), 'error'); return; }
            closeOverlay('password-modal');
            document.getElementById('new-password').value = '';
            document.getElementById('confirm-password').value = '';
            showToast(t('u.pw.changed'), 'success');
        }

        // ── TOAST ──
        function showToast(msg, type = 'info') {
            const c = document.getElementById('toast-container');
            const t = document.createElement('div'); t.className = 'toast ' + type; t.textContent = msg;
            c.appendChild(t);
            setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 2800);
        }

// ES module แล้ว — handler ที่ HTML (รวมที่ JS สร้าง) เรียก ต้องอยู่บน window
Object.assign(window, {
    loadSession,
    removeFile,
    autoResize,
    cancelDeleteChat,
    changePassword,
    clearSearch,
    closeOverlay,
    confirmDeleteChat,
    deleteSession,
    enterRenameMode,
    exportSession,
    handleFileSelect,
    handleInputKey,
    handleSessionKey,
    newChat,
    onEffortChange,
    onModelChange,
    onSearchInput,
    onSearchKey,
    onSendBtnClick,
    openChangePassword,
    openQuotaRequestModal,
    openUsage,
    overlayClick,
    toggleFavorite,
    toggleSidebar,
    toggleSidebarCollapsed,
    toggleTheme,
    toggleUserMenu,
});
