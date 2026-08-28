/**
 * mock-ai.js — Mock OpenAI Agent Response Engine
 * Simulates AI responses with typewriter effect + token counting
 */

const MockAI = {
    /**
     * Simulate running an agent skill
     * @param {string} skillId
     * @param {string} prompt
     * @param {Function} onChunk - called with each text chunk (streaming effect)
     * @param {Function} onDone - called when complete with
     *        { inputTokens, outputTokens, cost, durationMs, sessionId, stopped }
     *        Phase 19.3: shape now matches what _streamFromBackend emits, so
     *        the caller (sendMessage) doesn't see `result.stopped === undefined`
     *        and incorrectly flash "✅ เสร็จแล้ว" when the user pressed Stop.
     */
    async run(skillId, prompt, onChunk, onDone) {
        const skill = PRICING.skills.find(s => s.id === skillId);
        if (!skill) {
            // Phase 19.3: still call onDone with a consistent shape so the UI
            // doesn't hang in "isRunning" forever on an unknown skill.
            await onDone({
                inputTokens: 0, outputTokens: 0, cost: 0,
                durationMs: 0, sessionId: null, stopped: false,
            });
            return;
        }

        const startTime = Date.now();

        // Estimate input tokens
        const inputTokens = PRICING.estimateTokens(prompt) + PRICING.estimateTokens(skill.systemPrompt);

        // Pick a mock response
        const responses = skill.mockResponses;
        const mockText = responses[Math.floor(Math.random() * responses.length)];

        // Estimate output tokens
        const outputTokens = PRICING.estimateTokens(mockText);

        // Estimate cost using PRICING so the UI shows realistic numbers.
        let cost = 0;
        try {
            if (typeof PRICING.calcCost === 'function') {
                cost = PRICING.calcCost(inputTokens, outputTokens);
            }
        } catch (e) { /* swallow — cost is informational only */ }

        // Simulate thinking delay (500–1200ms)
        await this._delay(500 + Math.random() * 700);

        // Stream text character by character (grouped in small chunks)
        await this._streamText(mockText, onChunk, 18);

        const durationMs = Date.now() - startTime;
        await onDone({
            inputTokens, outputTokens, cost,
            durationMs, sessionId: null, stopped: false,
        });
    },

    /**
     * Stream text in small chunks with delay between them
     */
    async _streamText(text, onChunk, chunkSize = 15) {
        let i = 0;
        while (i < text.length) {
            const end = Math.min(i + chunkSize + Math.floor(Math.random() * 8), text.length);
            onChunk(text.slice(i, end));
            i = end;
            // Average typing speed ~50ms per chunk
            await this._delay(30 + Math.random() * 40);
        }
    },

    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    },
};

window.MockAI = MockAI;
