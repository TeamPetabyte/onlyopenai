// mock-ai.js — fake agent responses with a typewriter effect and token counting.

const MockAI = {
    /**
     * Simulate running an agent skill.
     * @param {string} skillId
     * @param {string} prompt
     * @param {Function} onChunk - called with each text chunk
     * @param {Function} onDone - called with { inputTokens, outputTokens, cost, durationMs, sessionId, stopped },
     *        the same shape _streamFromBackend emits
     */
    async run(skillId, prompt, onChunk, onDone) {
        const skill = PRICING.skills.find(s => s.id === skillId);
        if (!skill) {
            // same shape on an unknown skill so the UI never hangs in isRunning
            await onDone({
                inputTokens: 0, outputTokens: 0, cost: 0,
                durationMs: 0, sessionId: null, stopped: false,
            });
            return;
        }

        const startTime = Date.now();

        const inputTokens = PRICING.estimateTokens(prompt) + PRICING.estimateTokens(skill.systemPrompt);

        const responses = skill.mockResponses;
        const mockText = responses[Math.floor(Math.random() * responses.length)];

        const outputTokens = PRICING.estimateTokens(mockText);

        let cost = 0;
        try {
            if (typeof PRICING.calcCost === 'function') {
                cost = PRICING.calcCost(inputTokens, outputTokens);
            }
        } catch { /* swallow — cost is informational only */ }

        await this._delay(500 + Math.random() * 700);

        await this._streamText(mockText, onChunk, 18);

        const durationMs = Date.now() - startTime;
        await onDone({
            inputTokens, outputTokens, cost,
            durationMs, sessionId: null, stopped: false,
        });
    },

    /** Stream text in small chunks with a delay between them. */
    async _streamText(text, onChunk, chunkSize = 15) {
        let i = 0;
        while (i < text.length) {
            const end = Math.min(i + chunkSize + Math.floor(Math.random() * 8), text.length);
            onChunk(text.slice(i, end));
            i = end;
            // ~50ms per chunk
            await this._delay(30 + Math.random() * 40);
        }
    },

    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    },
};

window.MockAI = MockAI;
