/**
 * ai-client.js — PetabyteAi Frontend AI Client
 * Reads real-time SSE stream from backend — each word appears as OpenAI generates it.
 * Auto-falls back to MockAI if server is offline or has no API key.
 */

const AIClient = {
    // Resolved from window.AppConfig (js/config.js) — falls back if not loaded
    BACKEND_URL: (typeof window !== 'undefined' && window.AppConfig && window.AppConfig.API_BASE) || 'http://localhost:3001',
    _mode: null,
    _modelName: null,
    // Active AbortController for the in-flight /api/chat request.
    // Exposed via cancel() so the UI can stop generation mid-stream.
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
        } catch (e) {
            this._mode = 'mock';
            console.log('[AIClient] Server offline → MockAI');
        }
        return this._mode;
    },

    /**
     * Run AI skill — drop-in replacement for MockAI.run()
     * @param {string}   skillId
     * @param {string}   prompt
     * @param {string}   systemPrompt
     * @param {Function} onChunk(text)  — called with each text chunk as it arrives
     * @param {Function} onDone(result) — { inputTokens, outputTokens, cost, durationMs }
     * @param {object}   rates          — { inputRate, outputRate }
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
        const inputRate = (rates && rates.inputRate) || 0.50;
        const outputRate = (rates && rates.outputRate) || 1.50;

        // Compose a user-triggerable abort (AIClient.cancel) with a two-stage
        // watchdog (Phase 31). The old fixed 90s deadline killed perfectly
        // healthy requests: gpt-5.6 at high/xhigh effort can THINK silently
        // for several minutes before the first token. Now:
        //   stage 1 — 90s until the first byte arrives (catches "server can't
        //             reach api.openai.com at all");
        //   stage 2 — after bytes start flowing, a 60s IDLE watchdog that
        //             resets on every read. The server emits an SSE heartbeat
        //             every 15s while the model thinks, so a healthy-but-
        //             thinking stream never trips it, while a genuinely dead
        //             connection still fails within a minute.
        const userCtrl  = new AbortController();
        this._abortCtrl = userCtrl;
        let watchdogId = setTimeout(() => userCtrl.abort('timeout'), 90000);
        const resetWatchdog = () => {
            clearTimeout(watchdogId);
            watchdogId = setTimeout(() => userCtrl.abort('timeout'), 60000);
        };

        try {
            // Phase 6.1: include Bearer token (server requires requireAuth on /api/chat)
            const headers = (typeof Auth !== 'undefined' && Auth.authHeaders)
                ? Auth.authHeaders()
                : { 'Content-Type': 'application/json' };
            const body = { skillId, prompt, systemPrompt, inputRate, outputRate };
            // Phase 34: model + reasoning effort chosen in the composer. The
            // server validates against its allowlist and falls back to the env
            // default when absent, so these are safe to always include.
            if (opts.model)  body.model  = opts.model;
            if (opts.effort) body.effort = opts.effort;
            // Phase 12: thread messages into an existing chat session (or
            // let the server create one on first send when sessionId is null).
            if (sessionId) body.sessionId = sessionId;
            const res = await fetch(`${this.BACKEND_URL}/api/chat`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: userCtrl.signal
            });

            // Phase 21.10 — Concept B credit gates. Server returns
            // 402 (project pool empty) or 429 (daily cap exceeded) BEFORE
            // streaming starts, with a JSON body containing { error, message, ... }.
            // Handle these by calling onError (if provided) so the UI can show
            // a distinct block message + "request more quota" path, instead of
            // trying to read the JSON as SSE chunks.
            if (!res.ok) {
                let info = null;
                try { info = await res.json(); } catch (_) { info = { error: 'http_' + res.status }; }
                if (typeof onError === 'function') {
                    onError({ status: res.status, ...info });
                } else {
                    console.warn('[AIClient] chat blocked:', res.status, info);
                }
                // Surface an empty done so caller can reset its UI (button etc.).
                await onDone({
                    inputTokens: 0, outputTokens: 0, cost: 0,
                    durationMs: Date.now() - startTime,
                    sessionId: sessionId || null,
                    blocked: true,
                });
                return;
            }

            // Read SSE line-by-line
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let sawDone = false;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                // Phase 31: any bytes (real chunks OR ': ping' heartbeats)
                // prove the stream is alive — push the idle deadline out.
                resetWatchdog();

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); // keep incomplete last line

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    let event;
                    try { event = JSON.parse(line.slice(6)); } catch (e) { continue; }

                    if (event.type === 'chunk') {
                        // Real OpenAI token — send directly to UI (no extra delay)
                        onChunk(event.text);

                    } else if (event.type === 'done') {
                        sawDone = true;
                        await onDone({
                            inputTokens: event.inputTokens,
                            outputTokens: event.outputTokens,
                            cost: event.cost,
                            durationMs: Date.now() - startTime,
                            sessionId: event.sessionId,   // Phase 12: so client can pin the new thread id
                            stopped: !!event.stopped,
                        });

                    } else if (event.type === 'use_mock') {
                        // Server DELIBERATELY asked for mock (e.g. no API key configured).
                        this._mode = 'mock';
                        console.warn('[AIClient] Server requested MockAI:', event.reason);
                        await MockAI.run(skillId, prompt, onChunk, onDone);
                        return;
                    } else if (event.type === 'error') {
                        // REAL backend/OpenAI failure (e.g. cannot reach api.openai.com).
                        // Show it instead of faking an answer with MockAI.
                        console.error('[AIClient] Backend error:', event.error);
                        if (typeof onError === 'function') {
                            onError({ status: 'stream_error', error: event.error, message: event.error });
                        }
                        await onDone({
                            inputTokens: 0, outputTokens: 0, cost: 0,
                            durationMs: Date.now() - startTime,
                            sessionId: sessionId || null,
                            blocked: true,
                        });
                        return;
                    }
                }
            }

            // Stream closed without a `done` event — treat as a benign
            // close (e.g. user cancelled). Still surface an onDone so the
            // caller can reset UI state.
            if (!sawDone) {
                await onDone({
                    inputTokens: 0, outputTokens: 0, cost: 0,
                    durationMs: Date.now() - startTime,
                    sessionId: sessionId || null,
                    stopped: true,
                });
            }

        } catch (err) {
            const abortReason = userCtrl.signal && userCtrl.signal.reason;
            // User pressed Stop — benign, stay silent.
            if (abortReason === 'user_cancel') {
                await onDone({
                    inputTokens: 0, outputTokens: 0, cost: 0,
                    durationMs: Date.now() - startTime,
                    sessionId: sessionId || null,
                    stopped: true,
                });
                return;
            }
            // Otherwise it's a REAL failure — the 90s safety timeout fired (server
            // never answered, usually because it can't reach api.openai.com) or a
            // network/stream error. Surface it instead of silently faking a MockAI
            // reply, so the user actually sees WHY nothing came back.
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
                sessionId: sessionId || null,
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
