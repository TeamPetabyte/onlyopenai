// ╔═══════════════════════════════════════════════════════════╗
// ║  models.js — which model runs where, and at what effort   ║
// ╚═══════════════════════════════════════════════════════════╝
//
// Phase 46: lifted out of server.js unchanged. Pure lookup — no pool, no
// OpenAI client, no Express — so it can be exercised directly by a test
// rather than only through a live chat request.
//
// resolveModel needs the deployment's default model, which lives in an env
// var server.js owns. It is passed in rather than read here, so this module
// stays a pure function of its inputs.

const ALLOWED_MODELS = {
    'gpt-5.6-sol':   { path: 'responses', label: 'GPT-5.6 Sol',   supportsEffort: true },
    'gpt-5.6-terra': { path: 'responses', label: 'GPT-5.6 Terra', supportsEffort: true },
    'gpt-5.6-luna':  { path: 'responses', label: 'GPT-5.6 Luna',  supportsEffort: true },
    'gpt-5.5':       { path: 'chat',      label: 'GPT-5.5',       supportsEffort: false },
};
const MODEL_ALIASES = { 'gpt-5.6': 'gpt-5.6-sol' };
// Phase 43: trimmed to three. `max` measured worse than `xhigh` on every axis
// — more expensive, slower, and a SHORTER answer — so keeping it only invited
// someone to pick the worst option. `none` was never evaluated. Old values
// stored in a browser are mapped to the nearest survivor rather than silently
// reset, see resolveEffort.
const VALID_EFFORTS = ['low', 'medium', 'high'];
const EFFORT_ALIASES = { none: 'low', xhigh: 'high', max: 'high' };
const DEFAULT_EFFORT = 'medium';

// Resolve the client-supplied model to { model, path }. An EXPLICIT, known
// model from the request is honored (with its API path); anything else falls
// back to the env default MODEL on whichever path it belongs to — so if the
// request omits a model, behavior is unchanged from today (e.g. gpt-4o/gpt-5.5
// keep running on the Chat Completions loop). This keeps the rollout safe:
// only an explicit gpt-5.6-* request ever reaches the Responses API path.
function resolveModel(requested, defaultModel) {
    const aliased = MODEL_ALIASES[requested] || requested;
    if (aliased && ALLOWED_MODELS[aliased]) {
        return { model: aliased, path: ALLOWED_MODELS[aliased].path };
    }
    const dflt = MODEL_ALIASES[defaultModel] || defaultModel;
    return { model: dflt, path: ALLOWED_MODELS[dflt]?.path || 'chat' };
}
function resolveEffort(requested) {
    if (VALID_EFFORTS.includes(requested)) return requested;
    return EFFORT_ALIASES[requested] || DEFAULT_EFFORT;
}

module.exports = {
    ALLOWED_MODELS, MODEL_ALIASES,
    VALID_EFFORTS, EFFORT_ALIASES, DEFAULT_EFFORT,
    resolveModel, resolveEffort,
};
