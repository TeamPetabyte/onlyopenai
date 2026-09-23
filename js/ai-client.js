// ai-client.js — frontend AI client: streams /api/chat over SSE,
// falls back to MockAI when the server is offline or has no API key.

const AIClient = {
    BACKEND_URL: (typeof window !== 'undefined' && window.AppConfig && window.AppConfig.API_BASE) || 'http://localhost:3001',
    _mode: null,
    _modelName: null,
    // in-flight /api/chat request; cancel() aborts it
    _abortCtrl: null,

    /** Check backend health once, cache result */
    async checkBackend() {
        if (this._mode !== null) return this._mode;
        try {
            const res = await fetch(`${this.BACKEND_URL}/api/health`, {
                signal: AbortSignal.timeout(3000)
            });
            const data = await res.json();
            this._mode = data.mode;
            this._modelName = data.model;
            console.log(`[AIClient] ${data.message}`);
        } catch {
            // not cached: one slow health check must not switch the page to fake answers for good
            console.warn('[AIClient] /api/health unreachable — trying the backend anyway');
            return 'openai';
        }
        return this._mode;
    },

    /**
     * Run an AI skill (drop-in for MockAI.run).
     * @param {string}   skillId
     * @param {string}   prompt
     * @param {string}   systemPrompt
     * @param {Function} onChunk(text)
     * @param {Function} onDone(result) — { inputTokens, outputTokens, cost, durationMs }
     * @param {object}   rates — { inputRate, outputRate }
     */
    async run(skillId, prompt, systemPrompt, onChunk, onDone, rates, sessionId, onError, opts) {
        const mode = await this.checkBackend();
        if (mode === 'openai') {
            await this._streamFromBackend(skillId, prompt, systemPrompt, onChunk, onDone, rates, sessionId, onError, opts);
        } else {
            await MockAI.run(skillId, prompt, onChunk, onDone);
        }
    },

    /** Read SSE stream from backend in real-time */
    async _streamFromBackend(skillId, prompt, systemPrompt, onChunk, onDone, rates, sessionId, onError, opts = {}) {
        const startTime = Date.now();
        let liveSessionId = sessionId || null;   // a new chat's id arrives in the first `session` event
        const inputRate = (rates && rates.inputRate) || 0.50;
        const outputRate = (rates && rates.outputRate) || 1.50;

        // Two-stage watchdog: 90s to the first byte, then a 60s idle timer reset on every read.
        // The server heartbeats every 15s while the model thinks, so only a dead connection trips it.
        const userCtrl  = new AbortController();
        this._abortCtrl = userCtrl;
        let watchdogId = setTimeout(() => userCtrl.abort('timeout'), 90000);
        const resetWatchdog = () => {
            clearTimeout(watchdogId);
            watchdogId = setTimeout(() => userCtrl.abort('timeout'), 60000);
        };

        try {
            // Cookie auth; authHeaders() adds Content-Type + X-CSRF-Token.
            const headers = (typeof Auth !== 'undefined' && Auth.authHeaders)
                ? Auth.authHeaders()
                : { 'Content-Type': 'application/json' };
            const body = { skillId, prompt, systemPrompt, inputRate, outputRate };
            // Server validates model/effort against its allowlist and falls back to its default.
            if (opts.model)  body.model  = opts.model;
            if (opts.effort) body.effort = opts.effort;
            if (opts.regenerate) body.regenerate = true;
            if (sessionId) body.sessionId = sessionId;
            const res = await fetch(`${this.BACKEND_URL}/api/chat`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: userCtrl.signal
            });

            // 402 (pool empty) / 429 (daily cap) arrive as JSON before any SSE; route them to onError.
            if (!res.ok) {
                let info = null;
                try { info = await res.json(); } catch (_) { info = { error: 'http_' + res.status }; }
                if (typeof onError === 'function') {
                    onError({ status: res.status, ...info });
                } else {
                    console.warn('[AIClient] chat blocked:', res.status, info);
                }
                // empty done so the caller can reset its UI
                await onDone({
                    inputTokens: 0, outputTokens: 0, cost: 0,
                    durationMs: Date.now() - startTime,
                    sessionId: liveSessionId,
                    blocked: true,
                });
                return;
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let sawDone = false;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                // any bytes (chunks or ': ping' heartbeats) prove the stream is alive
                resetWatchdog();

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); // keep incomplete last line

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    let event;
                    try { event = JSON.parse(line.slice(6)); } catch { continue; }

                    if (event.type === 'chunk') {
                        onChunk(event.text);

                    } else if (event.type === 'session') {
                        liveSessionId = event.sessionId;

                    } else if (event.type === 'tool_call' || event.type === 'tool_result') {
                        // tool activity (RAG search etc.) for the live badge
                        if (typeof opts.onTool === 'function') {
                            try { opts.onTool(event); } catch (_) { /* badge is cosmetic — never kill the stream */ }
                        }

                    } else if (event.type === 'routed') {
                        // which skill prompt the router matched (or none) and how
                        if (typeof opts.onRouted === 'function') {
                            try { opts.onRouted(event); } catch (_) { /* badge is cosmetic — never kill the stream */ }
                        }

                    } else if (event.type === 'done') {
                        sawDone = true;
                        await onDone({
                            inputTokens: event.inputTokens,
                            outputTokens: event.outputTokens,
                            cost: event.cost,
                            durationMs: Date.now() - startTime,
                            sessionId: event.sessionId,   // lets the client pin the new thread id
                            stopped: !!event.stopped,
                        });

                    } else if (event.type === 'use_mock') {
                        // server deliberately asked for mock (e.g. no API key)
                        console.warn('[AIClient] Server requested MockAI:', event.reason);
                        await MockAI.run(skillId, prompt, onChunk, onDone);
                        return;
                    } else if (event.type === 'error') {
                        // real backend failure — show it rather than faking a MockAI answer
                        console.error('[AIClient] Backend error:', event.error);
                        if (typeof onError === 'function') {
                            onError({ status: 'stream_error', error: event.error, message: event.error });
                        }
                        await onDone({
                            inputTokens: 0, outputTokens: 0, cost: 0,
                            durationMs: Date.now() - startTime,
                            sessionId: liveSessionId,
                            blocked: true,
                        });
                        return;
                    }
                }
            }

            // closed without a done event (e.g. cancelled) — still surface onDone so the UI resets
            if (!sawDone) {
                await onDone({
                    inputTokens: 0, outputTokens: 0, cost: 0,
                    durationMs: Date.now() - startTime,
                    sessionId: liveSessionId,
                    stopped: true,
                });
            }

        } catch (err) {
            const abortReason = userCtrl.signal && userCtrl.signal.reason;
            // user pressed Stop — benign
            if (abortReason === 'user_cancel') {
                await onDone({
                    inputTokens: 0, outputTokens: 0, cost: 0,
                    durationMs: Date.now() - startTime,
                    sessionId: liveSessionId,
                    stopped: true,
                });
                return;
            }
            // real failure (watchdog fired or network error) — surface it so the user sees why
            const isTimeout = abortReason === 'timeout'
                || err.name === 'AbortError' || (userCtrl.signal && userCtrl.signal.aborted);
            const msg = isTimeout
                ? 'หมดเวลารอ — เซิร์ฟเวอร์ตอบ AI ไม่สำเร็จ (มักเกิดจากเซิร์ฟเวอร์ต่อ api.openai.com ไม่ได้ / ถูกไฟร์วอลล์บล็อก)'
                : ('เชื่อมต่อไม่สำเร็จ: ' + (err.message || 'unknown error'));
            console.error('[AIClient] Stream failure:', abortReason || err.message);
            if (typeof onError === 'function') {
                onError({ status: isTimeout ? 'timeout' : 'network_error', error: msg, message: msg });
            }
            await onDone({
                inputTokens: 0, outputTokens: 0, cost: 0,
                durationMs: Date.now() - startTime,
                sessionId: liveSessionId,
                blocked: true,
            });
        } finally {
            clearTimeout(watchdogId);
            if (this._abortCtrl === userCtrl) this._abortCtrl = null;
        }
    },

    /** Abort the in-flight /api/chat request, if any. */
    cancel() {
        if (this._abortCtrl) {
            try { this._abortCtrl.abort('user_cancel'); } catch (_) {}
            this._abortCtrl = null;
        }
    },

    getMode() { return this._mode; },
    getModelName() { return this._modelName; },
};

window.AIClient = AIClient;
