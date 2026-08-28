// chat.js — หน้าแชททั้งหมด (ย้ายมาจาก index.html)

/* exported autoResize, cancelDeleteChat, changePassword, clearSearch, closeOverlay, confirmDeleteChat, deleteSession, enterRenameMode, exportSession, handleFileSelect, handleInputKey, handleSessionKey, newChat, onEffortChange, onModelChange, onSearchInput, onSearchKey, onSendBtnClick, openChangePassword, openQuotaRequestModal, openUsage, overlayClick, toggleFavorite, toggleSidebar, toggleSidebarCollapsed, toggleTheme, toggleUserMenu */

        // ══════════════════════════════════════════════════════════
        // STATE
        // ══════════════════════════════════════════════════════════
        const State = {
            selectedSkill: 'auto',
            selectedModel: 'gpt-5.6-terra',   // Phase 34: model picker default
            selectedEffort: 'medium',          // Phase 34: reasoning effort default
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
                // Phase 34: restore the user's model + effort choice
                this.selectedModel  = localStorage.getItem('agenthub_model_'  + s.username) || this.selectedModel;
                // Phase 43: the picker went from six levels to three. Someone
                // who had chosen max/xhigh/none still has it saved here, so map
                // it to the nearest survivor — resetting them to the default
                // would silently undo a deliberate choice.
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
                // NOTE: usage is persisted + billed server-side by /api/chat
                // (tbl_response + project-pool deduction + credit ledger, all in
                // one place). The old POST /api/history here ran a SECOND pool
                // deduction → double-charge, so it was removed. The local
                // balance/history update above is UI-only.
            },
        };

        // ══════════════════════════════════════════════════════════
        // SESSION API HELPERS
        // ══════════════════════════════════════════════════════════
        // BASE comes from js/config.js (window.BASE) — loaded before this script.
        // Fallback to localhost only if config.js failed to load.
        if (typeof BASE === 'undefined') { var BASE = (window.AppConfig && window.AppConfig.API_BASE) || 'http://localhost:3001'; }

        // Show the app version in the sidebar footer (single source of
        // truth: js/config.js AppConfig.VERSION — bump it alongside the
        // git tag when a release ships).
        (function () {
            const el = document.getElementById('app-version');
            if (el) el.textContent = (window.AppConfig && window.AppConfig.VERSION) || '';
        })();

        // Phase 12: new API shape.
        //   list    → GET    /api/chat/sessions           → { sessions: [...] }
        //   one     → GET    /api/chat/sessions/:id       → { session, messages }
        //   create  → POST   /api/chat/sessions  body:{title?}
        //   rename  → PATCH  /api/chat/sessions/:id  body:{title}
        //   delete  → DELETE /api/chat/sessions/:id       (soft delete)
        //   export  → GET    /api/chat/sessions/:id/export → text/markdown
        // All endpoints enforce owner = req.session.userId server-side; the
        // old frontend passed userId as a query param but the server now
        // ignores that — the session cookie is the only trusted identity.
        async function apiLoadSessions(q) {
            try {
                // When caller doesn't pass q explicitly, keep the active
                // search filter so post-send reloads don't "unfilter" the list.
                const effective = (q !== undefined) ? q : (State.searchQuery || '');
                const url = BASE + '/api/chat/sessions' + (effective ? ('?q=' + encodeURIComponent(effective)) : '');
                const d = await fetch(url, { headers: Auth.authHeaders() }).then(r => r.json());
                if (d.ok) {
                    // Phase 19.7.1: coerce id to Number on receive. PostgreSQL
                    // BIGINT round-trips through node-pg as a *string* (e.g.
                    // "41"), but inline onclick handlers embed sessionId as a
                    // numeric literal (`toggleFavorite(event, 41)`). The
                    // mismatch made `State.sessions.find(s => s.id === id)`
                    // silently return undefined → toggleFavorite and the
                    // delete dialog's "find row" lookup just exited with no
                    // error. Coerce once at the boundary so the rest of the
                    // UI can rely on a consistent Number id.
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

        async function apiDeleteSession(sessionId) {
            try {
                await fetch(BASE + '/api/chat/sessions/' + sessionId, { method: 'DELETE', headers: Auth.authHeaders() });
            } catch { }
        }

        function apiExportSessionUrl(sessionId) {
            // fetch → blob → anchor download (lets us handle errors; the
            // session cookie rides along automatically). CSRF is not
            // required on GET. Opens a download dialog with .md file.
            return fetch(BASE + '/api/chat/sessions/' + sessionId + '/export', { headers: Auth.authHeaders() })
                .then(r => r.ok ? r.blob() : null);
        }

        // ══════════════════════════════════════════════════════════
        // INIT
        // ══════════════════════════════════════════════════════════
        document.addEventListener('DOMContentLoaded', async () => {
            if (!Auth.check('user')) return;
            const session = Auth.getSession();
            State.load();
            syncComposerControls();   // Phase 34: reflect restored model/effort into the pickers
            const displayName = session.displayName || session.username;
            document.getElementById('user-display-name').textContent = displayName;
            document.getElementById('user-avatar').textContent = displayName.charAt(0).toUpperCase();

            // Phase 19.3: track whether ANY init fetch failed so we can
            // surface a single toast instead of letting fetches die silently.
            // Used to be: silent catches → UI just sat at "฿—" forever with
            // no clue to the user why.
            let initHadError = false;

            // Load balance from server.
            // Phase 21.10 (Concept B): the spendable money is the PROJECT POOL,
            // not the per-user wallet (which is now always 0). Drive the sidebar
            // off /api/quota-status.projectPool so it reflects real funds.
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
                    // Phase 19.3: stop overwriting brand-avatar with the
                    // project initial — Phase 16.7 swapped it to an <img>
                    // of the Petabyte logo and this line was clobbering it
                    // (the logo only flashed for <100ms after page load).
                }
            }

            if (PRICING.skills.length > 0) selectSkill(PRICING.skills[0].id);
            updateBalanceDisplay();

            // Phase 19.3: tell the user once if any init fetch failed —
            // beats balance / history silently stuck at empty.
            if (initHadError) {
                showToast(t('u.err.loadPartialFailed'), 'error');
            }

            // Phase 19.4: restore the chat session from URL hash on refresh
            // (e.g. #s/42). Without this, refreshing the page always dumped
            // the user back to an empty "new chat" state — even if they were
            // mid-conversation. Invalid / deleted session ids are silently
            // ignored (loadSession's apiGetSession returns null → toast).
            const m = String(window.location.hash || '').match(/^#\/?s\/(\d+)$/);
            if (m && m[1]) {
                const sid = Number(m[1]);
                if (Number.isInteger(sid) && sid > 0) {
                    // Defer to next tick so the empty-state DOM is settled first
                    setTimeout(() => loadSession(sid), 0);
                }
            }
        });

        // Phase 19.4: respond to back/forward button so navigating between
        // chat sessions also updates the URL — and reloading keeps the same
        // session pinned.
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

        // ══════════════════════════════════════════════════════════
        // NEW CHAT
        // ══════════════════════════════════════════════════════════
        function newChat() {
            // Phase 19.3: close mobile drawer (no-op on desktop) after picking
            toggleSidebar(false);
            // Phase 19.4: clear the URL hash so refresh stays on "new chat"
            // (otherwise we'd snap back to the previous session). Use
            // replaceState to avoid bloating the history stack.
            try {
                if (window.location.hash && window.history && window.history.replaceState) {
                    window.history.replaceState(null, '', window.location.pathname + window.location.search);
                }
            } catch (_) { }
            State.currentSessionId = null;
            State.currentMessages = [];
            const area = document.getElementById('chat-area');
            // Phase 19.2: welcoming empty state on new chat.
            area.innerHTML = `
        <div class="chat-empty" id="chat-empty">
            <img class="chat-empty-mascot" src="/assets/mascot.png?v=2" alt="PipekAI" />
            <div class="chat-empty-title">${esc(t('u.chat.welcomeTitle'))}</div>
            <div class="chat-empty-sub">${esc(t('u.chat.welcomeSub'))}</div>
        </div>`;
            renderSessionList();
            document.getElementById('chat-input').focus();
        }

        // ══════════════════════════════════════════════════════════
        // LOAD SESSION FROM HISTORY
        // ══════════════════════════════════════════════════════════
        // Phase 19.5 a11y: keyboard activation for .session-item rows.
        // Enter/Space → load the session, but only when focus is on the row
        // itself (not on the action buttons, which have their own handlers).
        function handleSessionKey(e, sessionId) {
            if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
            // Skip if user is pressing inside one of the action buttons
            if (e.target && e.target.closest && e.target.closest('.session-actions')) return;
            e.preventDefault();
            loadSession(sessionId);
        }

        async function loadSession(sessionId) {
            if (State.isRunning) { showToast(t('u.err.pleaseWait'), 'error'); return; }
            // Phase 19.3: close mobile drawer on session pick
            toggleSidebar(false);
            const res = await apiGetSession(sessionId);
            if (!res) { showToast(t('u.err.sessionNotFound'), 'error'); return; }

            // Phase 19.7.1: server returns BIGINT as string — coerce so the
            // active-highlight check `s.id === State.currentSessionId` matches
            // the Number ids from apiLoadSessions.
            State.currentSessionId = Number(res.session.id);
            // Phase 19.4: pin the session into the URL so refresh restores it.
            // replaceState (not push) — each session click would otherwise
            // pollute the back-button history one entry per click.
            try {
                const want = '#s/' + res.session.id;
                if (window.location.hash !== want && window.history && window.history.replaceState) {
                    window.history.replaceState(null, '', want);
                }
            } catch (_) { }

            // Normalise message shape: server uses snake_case for some fields
            // (created_at, input_tokens, ...) but the renderer expects the
            // in-memory shape used by the old code (timestamp, cost, ...).
            State.currentMessages = (res.messages || []).map(m => ({
                role:         m.role,
                content:      m.content,
                timestamp:    m.created_at,
                cost:         m.cost != null ? Number(m.cost) : undefined,
                inputTokens:  m.input_tokens || 0,
                outputTokens: m.output_tokens || 0,
                // Phase 43: duration is stored now. Rows written before that
                // migration have none — keep it undefined rather than 0 so the
                // badge can leave the segment out instead of claiming "0.0s".
                durationMs:   m.duration_ms != null ? Number(m.duration_ms) : undefined,
                // Phase 47: every skill whose knowledge reached the model, not
                // just the one that answered. It was already being stored; the
                // reload path simply never asked for it, so the audit the
                // senior asked for could only be seen by querying Postgres.
                // skill_id is the skill that ANSWERED; skills_used is everything
                // whose knowledge reached the model. The server stores the
                // latter as [skillId, ...supporting].filter(Boolean), so when
                // the router picked nothing the first entry is a SUPPORTING
                // skill — printing it as the primary announced a skill that
                // never answered. Read them separately, as the server stores them.
                skillId:      m.skill_id || null,
                skillsUsed:   m.skills_used ? String(m.skills_used).split(',').filter(Boolean) : [],
            }));

            // Pick an appropriate skill if the session has a hint from the
            // most recent assistant message. If not, leave whatever was
            // selected alone.
            const lastSkillId = [...(res.messages || [])].reverse()
                .find(m => m.skill_id)?.skill_id;
            if (lastSkillId) selectSkill(lastSkillId);

            renderChatMessages(State.currentMessages);
            renderSessionList();
        }

        // ══════════════════════════════════════════════════════════
        // RENDER ALL MESSAGES IN CHAT AREA
        // ══════════════════════════════════════════════════════════
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
                    // Phase 45: recover the uploaded name from the user turn that
                    // prompted this answer, so a reopened chat downloads the same
                    // filename a live one would.
                    const askedWith = (messages[idx - 1] || {}).content || '';
                    const fileTag = /\[File:\s*([^\]\n]+)\]/.exec(askedWith);
                    if (actions) MD.attachMessageDownload(actions, msg.content || '',
                        fileTag ? fileTag[1].trim() : undefined);
                    if (actions && isLast) addRegenerateButton(actions);
                    // Phase 47: show the same 🎯 line a live answer shows, so
                    // reopening a chat does not quietly lose which checks ran.
                    if (msg.skillId || (msg.skillsUsed && msg.skillsUsed.length)) {
                        const sb = document.createElement('div');
                        sb.className = 'skill-badge';
                        const others = (msg.skillsUsed || []).filter(x => x !== msg.skillId);
                        // The live badge prints the skill's label; printing the
                        // raw id here made the same answer read differently
                        // before and after a refresh. PRICING.skills already
                        // holds the mapping, and the id is the honest fallback
                        // for a skill the catalog no longer lists.
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
                        // Phase 43: only claim a duration when we actually have
                        // one. Messages from before duration was stored print
                        // just the token count instead of a false "0.0s".
                        badge.textContent = tok.toLocaleString() + ' tokens'
                            + (msg.durationMs ? ' · ' + (msg.durationMs / 1000).toFixed(1) + 's' : '');
                        div.appendChild(badge);
                    }
                    area.appendChild(div);
                }
            });
            scrollToBottom(area, true);
        }

        // ══════════════════════════════════════════════════════════
        // RENDER SESSION LIST (SIDEBAR)
        //   Phase 19.7: favorites get a "⭐ Favorites" group pinned at the
        //   top, separate from the date-bucketed history. A single row
        //   helper keeps search/grouped/favorites rendering identical.
        // ══════════════════════════════════════════════════════════

        // Render a single session row as an HTML string. Centralised so
        // search results, favorites group, and date groups all share the
        // same markup (and same a11y / keyboard handling).
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
                // Phase 19.8: matched-set empty (search returned 0) vs
                // never-had-any-chat empty get different treatments.
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

            // While searching, skip grouping — show flat list of matches
            // (server already sorted favorites first, then by updatedAt DESC).
            if (searching) {
                let sh = '<div class="date-group-label">' + esc(tf('u.sess.searchResultsCount', { n: State.sessions.length })) + '</div>';
                State.sessions.forEach(s => { sh += _renderSessionRow(s); });
                list.innerHTML = sh;
                return;
            }

            // Split favorites out first — they're not also shown in date
            // buckets (Claude/Slack-style "starred = own section, no dupes").
            const favs   = State.sessions.filter(s => (s.isFavorite || s.is_favorite));
            const others = State.sessions.filter(s => !(s.isFavorite || s.is_favorite));

            // Group the non-favorite sessions by date (buckets relative to
            // today's local-midnight). Keys stay language-agnostic; the
            // display label is looked up separately so the language toggle
            // doesn't need to touch the grouping logic.
            const now = new Date();
            const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
            const yesterdayStart = todayStart - 86400000;
            const weekStart = todayStart - 7 * 86400000;
            const monthStart = todayStart - 30 * 86400000;

            const groups = { today: [], yesterday: [], week: [], month: [], older: [] };
            others.forEach(s => {
                // Server returns camelCase `updatedAt`; legacy code used
                // `updated_at`. Accept either for forwards-compat.
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

        // ══════════════════════════════════════════════════════════
        // SESSION ACTIONS — rename / export / delete
        // ══════════════════════════════════════════════════════════
        // Inline rename — double-click on title (or ✎ button) swaps the
        // span for an <input>. Enter / blur = save, Esc = cancel.
        // We guard against re-entering while already editing the same row,
        // and suppress loadSession() on the row while an input is present
        // (the input's stopPropagation does the heavy lifting).
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
            // Focus + select-all so the user can type immediately or
            // overwrite, matching Notion / ChatGPT behaviour.
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

        // ══════════════════════════════════════════════════════════
        // FAVORITE (Phase 19.7)
        //   Star/unstar a chat session. Optimistic UI: flip local state +
        //   re-render immediately, then PATCH the server. On failure roll
        //   back and toast.
        // ══════════════════════════════════════════════════════════
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

        // Phase 19: chat-delete uses a custom in-app modal (not window.confirm).
        // The pending session is stashed so the modal's Confirm button knows
        // which one to delete. We also re-fetch sessions from the server after
        // success — fixes the bug where the deleted row could pop back later
        // if any other code path triggered apiLoadSessions.
        let _pendingDeleteSessionId = null;

        function deleteSession(e, sessionId) {
            if (e && e.stopPropagation) e.stopPropagation();
            _pendingDeleteSessionId = sessionId;
            const sess = (State.sessions || []).find(s => s.id === sessionId);
            const titleEl = document.getElementById('confirm-delete-target');
            // Phase 19.6.1: if the chat has no title (or we couldn't find the
            // row in local state), hide the chip entirely instead of showing
            // "(ไม่พบแชท)" / "(ไม่มีชื่อ)" — the sentence reads fine without it:
            //   "[chip] จะถูกลบถาวร — ..."   becomes
            //   "จะถูกลบถาวร — ..."          which is still clear in context.
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
            // Phase 19.6: button text is now "Delete" (consistent with Cancel
            // in English to match the Claude-style look) — reset on every open.
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
            // 3) Resync from server in the background — handles the case where
            //    a concurrent action (e.g. a recently-sent chat) repopulated
            //    State.sessions from /api/chat/sessions. Without this the
            //    deleted item could "come back" on the next list fetch.
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

        // ══════════════════════════════════════════════════════════
        // SKILL SELECTION
        //   Phase 19.3: removed openSkillPicker() — the overlay & trigger
        //   were already disabled in Phase 19.1 (header just shows
        //   "PetabyteAi"). selectSkill is still called by the router /
        //   intent classifier on the server side.
        // ══════════════════════════════════════════════════════════
        function selectSkill(skillId) {
            State.selectedSkill = skillId;
            // Phase 19.1: keep the header label as "PetabyteAi" no matter which
            // skill the user picks (or the router selects). The skill is still
            // tracked in State.selectedSkill and sent to the backend — we just
            // don't surface the specific skill name in the chat header any more.
            // (Reverted from skill.emoji + ' ' + skill.name.)
            const el = document.getElementById('current-skill-name');
            if (el) el.textContent = 'PipekAI';   // emoji replaced by the mascot <img> beside it
        }

        // ══════════════════════════════════════════════════════════
        // SEND MESSAGE
        // ══════════════════════════════════════════════════════════
        async function sendMessage() {
            if (State.isRunning) return;
            const inputEl = document.getElementById('chat-input');
            let userText = inputEl.value.trim();
            if (!userText && !State.attachedFile) { showToast(t('u.err.enterMessage'), 'error'); return; }
            // Phase 19.8: align with the in-sidebar warning copy + emoji
            if (State.balance <= 0) {
                showToast(t('u.err.creditDepletedContactAdmin'), 'error');
                return;
            }
            // Default to 'auto' skill if nothing selected
            const selectedSkillId = State.selectedSkill || 'auto';
            const skill = PRICING.skills.find(s => s.id === selectedSkillId) || PRICING.skills[0];
            const displayText = userText || '[File: ' + (State.attachedFile ? State.attachedFile.name : '') + ']';
            let prompt = userText;
            // Phase 45: keep the uploaded name — removeFile() clears it, and the
            // Download button needs it so the corrected file comes back as
            // Zlmmrp29_batch.abap rather than pipekai-response.abap.
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

            // Flip send button → stop button. Keep enabled so the user
            // can click it to cancel; isRunning guards against re-send.
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

            // Phase 35.2: RAG badge — pinned above the answer bubble, created
            // as soon as the model starts a document search (often BEFORE the
            // first text chunk, so the shell must be creatable from either side).
            let ragBadgeEl = null, ragQuery = '';
            // Phase 40: the skill badge sits above the RAG badge — "which prompt
            // was applied" comes before "what it looked up".
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
                        // Phase 40: below the skill badge when both are present.
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

            // Phase 40: skill badge. The server has always told us which Skill
            // prompt its router matched (SSE `routed`), but the client dropped
            // the event — so a tester saw the 🔍 document-search badge and no
            // sign at all of the skill prompt, which is exactly why the skills
            // looked like they never ran. `source` also says HOW it was picked.
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
                    // Phase 45: the other checks that fed this answer. Named, not
                    // counted — "+3" tells the tester nothing about which check
                    // ran, and that is the question they are actually asking.
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

            // Phase 34: reveal at a capped pace instead of painting every SSE
            // chunk the instant it arrives. Raw tokens can burst in faster
            // than a user can react, so a long/fast answer used to "pop"
            // onto screen almost fully formed — no real window to notice
            // and hit Stop. Pacing the reveal also throttles DOM repaints
            // for long responses (fewer, steadier updates instead of one
            // per token).
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
                    // During streaming we escape (fast, safe). Markdown rendering
                    // happens once at finalize — partial markdown is unparseable.
                    if (streamBubble) streamBubble.textContent = accumulated.slice(0, displayedLen);
                    scrollToBottom(area);
                }, REVEAL_TICK_MS);
            }

            // Phase 21.10 — Concept B: server may block with 402 (pool empty)
            // or 429 (daily cap). Show a clear in-chat block bubble with the
            // right action (top-up vs request more).
            const onChatBlocked = (info) => {
                const typingEl = document.getElementById('typing-el'); if (typingEl) typingEl.remove();
                showBlockBubble(area, info);
            };

            await AIClient.run(skill.id, prompt, skill.systemPrompt,
                // onChunk
                chunk => {
                    accumulated += chunk;
                    const typingEl = document.getElementById('typing-el'); if (typingEl) typingEl.remove();
                    // Phase 35.2: the shell may already exist (RAG badge created
                    // it first) — only the text bubble itself is created here.
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
                    // Phase 31.1: the server finished but streamed no text at all
                    // (e.g. reasoning consumed the whole token budget). Without
                    // this, the user gets silent blank space below their bubble.
                    if (!streamBubble && accumulated === '' && !result.stopped && !result.blocked) {
                        // Phase 35.2: shell may already exist (RAG badge) — reuse it.
                        ensureResponseShell();
                        streamBubble = document.createElement('div');
                        streamBubble.className = 'msg-bubble';
                        streamBubble.textContent = t('chat.emptyAnswer',
                            '⚠️ โมเดลคิดนานจนหมดโควต้าคำตอบ — ลองส่งใหม่อีกครั้ง หรือลดระดับ effort ลงหนึ่งขั้น');
                        responseMsgEl.appendChild(streamBubble);
                    }
                    // Phase 30: trust the server's cost (tbl_pricing-based, same
                    // source tbl_daily_usage/spentToday uses) — no more local
                    // recompute off the legacy tbl_project rates, which could
                    // disagree with what was actually charged.
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

                    // Phase 12: the backend persisted both turns inside
                    // /api/chat and echoed back the sessionId. We just pin
                    // it locally and refresh the sidebar so the new thread
                    // appears (or moves to the top after subsequent sends).
                    if (result.sessionId) {
                        const wasFresh = !State.currentSessionId;
                        // Phase 19.7.1: coerce — see apiLoadSessions note.
                        State.currentSessionId = Number(result.sessionId);
                        // Phase 19.4: pin the new session into the URL so a
                        // mid-chat refresh keeps the thread loaded.
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

                    // Phase 34: fetch real post-spend numbers instead of just
                    // re-rendering the stale client-side State.balance — was
                    // only ever set once on page load, so the sidebar balance
                    // and cap-usage card wouldn't reflect this turn's cost
                    // until the next 60s poll (or a manual refresh).
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
                State.currentSessionId,   // Phase 12: thread into an existing chat
                onChatBlocked,             // Phase 21.10: 402/429 → block UI
                { model: State.selectedModel, effort: State.selectedEffort, onTool, onRouted }  // Phase 34 + 35.2 + 39
            );
        }

        // Phase 21.10 — render an inline "blocked" bubble in the chat area
        // when the server refuses the message (pool empty or cap reached).
        // Distinct copy for each cause + action button when applicable.
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
                    // Translate known error codes so the toast follows the
                    // user's language; unknown codes fall back to the server
                    // message (English).
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

        // ══════════════════════════════════════════════════════════
        // UI HELPERS
        // ══════════════════════════════════════════════════════════
        // Phase 19.8: when the balance is running out, paint the card and
        // surface a one-line warning inside it. Two thresholds:
        //   <= 0      → critical (red border + "เครดิตหมด" + block sends)
        //   < BALANCE_WARN_THRESHOLD → warn (orange border + "ใกล้หมด")
        //   otherwise → normal
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

        // Phase 28: sidebar cap-usage card — spent-today vs the user's
        // effective daily cap, with a progress bar. dailyCap === null means
        // no cap is set for this user (unlimited) — show spend only, no bar.
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

        // Phase 21.10 — Concept B: poll /api/quota-status, show 80% warning above input
        // + drive the sidebar cap-usage card. Fail-silent: a network/auth hiccup just
        // hides the banner; the real gate is server-side anyway.
        async function refreshQuotaWarning() {
            try {
                const r = await fetch(BASE + '/api/quota-status', { headers: Auth.authHeaders() });
                if (!r.ok) return;
                const d = await r.json();
                if (!d.ok) return;
                // Phase 34: this is also called right after each chat turn finishes,
                // so the sidebar balance updates with the real post-spend number
                // instead of waiting up to 60s for the next poll tick.
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
        // Phase 28: run right away (the sidebar card needs data on first paint,
        // not just the once-in-a-while input-area banner) + every 60s after.
        refreshQuotaWarning();
        setInterval(refreshQuotaWarning, 60_000);

        function overlayClick(e, id) { if (e.target === document.getElementById(id)) closeOverlay(id); }
        function closeOverlay(id) { document.getElementById(id).classList.remove('open'); }
        function toggleUserMenu() { document.getElementById('user-dropdown').classList.toggle('open'); }
        document.addEventListener('click', e => { if (!document.getElementById('user-area').contains(e.target)) document.getElementById('user-dropdown').classList.remove('open'); });

        // Phase 27: when the language switches, re-apply static labels and
        // re-render whatever is JS-built (session list, quota banner) so
        // those strings pick up the new language too — mirrors admin.js.
        window.addEventListener('i18n:change', () => {
            if (typeof I18N !== 'undefined') I18N.apply();
            try { renderSessionList(); } catch (_) {}
            try { refreshQuotaWarning(); } catch (_) {}
            // Re-render whichever empty state (if any) is currently showing —
            // leaves an in-progress conversation's history untouched.
            if (document.getElementById('chat-empty')) {
                try {
                    if (State.currentSessionId) renderChatMessages(State.currentMessages);
                    else newChat();
                } catch (_) {}
            }
        });

        // Phase 19.3: open/close the sidebar drawer on mobile. force=false
        // always closes, force=true always opens, omitted = toggle.
        // Also auto-closes when a session is clicked (handled by callers).
        function toggleSidebar(force) {
            const open = (typeof force === 'boolean') ? force : !document.body.classList.contains('sidebar-open');
            document.body.classList.toggle('sidebar-open', open);
        }

        // Phase 33 (v1.7.0): desktop sidebar collapse — persists across
        // reloads so a "wide reading mode" preference sticks.
        function toggleSidebarCollapsed() {
            const collapsed = !document.body.classList.contains('sidebar-collapsed');
            document.body.classList.toggle('sidebar-collapsed', collapsed);
            try { localStorage.setItem('pipek_sidebar_collapsed', collapsed ? '1' : '0'); } catch (_) {}
        }
        // Restore on load (before first paint of the chat area is fine — the
        // sidebar transition only animates on user toggles thereafter).
        try {
            if (localStorage.getItem('pipek_sidebar_collapsed') === '1') {
                document.body.classList.add('sidebar-collapsed');
            }
        } catch (_) {}

        // Phase 19.8: light ↔ dark theme. Persist via localStorage (key
        // 'ag_theme' — same as admin so the choice carries across pages).
        // The bootstrap script in <head> applies it before first paint so
        // there's no flash on subsequent loads.
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

        // Phase 19.3: cap attachment size before reading. Larger files
        // would (a) freeze the browser while FileReader gulps them down,
        // (b) blow past the model's context window if sent, and (c) leak
        // huge strings into State that survive until the next reload.
        // Phase 33: raised 256 KB → 1 MB to cover bigger ABAP source dumps;
        // server's express.json limit is 2 MB so this still leaves headroom.
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

        // ── Phase 34: model + reasoning-effort pickers ──────────────
        // Effort only applies to the gpt-5.6 reasoning family; hide it for
        // models that don't accept it (e.g. gpt-5.5) so we never send an
        // invalid param.
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

        // Unified send-button handler — while idle, send; while streaming,
        // clicking the (now-red square) button stops generation.
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

        // ── Session search ──────────────────────────────────────
        // Debounce 200ms so typing doesn't hammer the server. Clearing the
        // input reverts to the unfiltered listing.
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
        // Phase 19.3: escape quotes too so esc() is safe inside attribute
        // values like title="${esc(name)}". Was previously XSS-prone if a
        // session title contained a `"` (would break out of the attribute).
        function esc(t) {
            return String(t)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        // ══════════════════════════════════════════════════════════
        // SMART AUTO-SCROLL
        //   Only auto-scrolls when user is already near the bottom.
        //   If user has scrolled up to read earlier content, we leave
        //   them alone and show a "↓ new messages" button instead.
        // ══════════════════════════════════════════════════════════
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

        // ══════════════════════════════════════════════════════════
        // REGENERATE LAST ANSWER
        //   Attaches a ↻ button to the last assistant message's toolbar.
        //   Clicking removes the last assistant message and re-sends
        //   the previous user prompt — same skill, same input.
        // ══════════════════════════════════════════════════════════
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

            // Re-submit through the normal pipeline by pushing the prompt
            // into the input and calling sendMessage(). But sendMessage()
            // appends a new user row — so we instead pop the previous user
            // message first and let sendMessage re-add it identically.
            msgs.pop();   // remove the user we just re-rendered; sendMessage will re-append
            renderChatMessages(msgs);

            const inputEl = document.getElementById('chat-input');
            inputEl.value = lastUser.content;
            await sendMessage();
        }

        // ══════════════════════════════════════════════════════════
        // USAGE MODAL
        // ══════════════════════════════════════════════════════════
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

        // ══════════════════════════════════════════════════════════
        // CHANGE PASSWORD
        // ══════════════════════════════════════════════════════════
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
                // Phase 6.1: dedicated self-only endpoint (no admin rights needed)
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

        // ══════════════════════════════════════════════════════════
        // TOAST
        // ══════════════════════════════════════════════════════════
        function showToast(msg, type = 'info') {
            const c = document.getElementById('toast-container');
            const t = document.createElement('div'); t.className = 'toast ' + type; t.textContent = msg;
            c.appendChild(t);
            setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 2800);
        }
