// @ts-check
// models.js — which model runs on which API path, and at what effort.
// Pure lookup: the default model is passed in rather than read from env, so this stays testable.

const ALLOWED_MODELS = {
    'gpt-6-astra':   { path: 'responses', label: 'GPT-6 Astra',   supportsEffort: true },
    'gpt-6-sol':     { path: 'responses', label: 'GPT-6 Sol',     supportsEffort: true },
    'gpt-6-luna':    { path: 'responses', label: 'GPT-6 Luna',    supportsEffort: true },
    'gpt-5.6-sol':   { path: 'responses', label: 'GPT-5.6 Sol',   supportsEffort: true },
    'gpt-5.6-terra': { path: 'responses', label: 'GPT-5.6 Terra', supportsEffort: true },
    'gpt-5.6-luna':  { path: 'responses', label: 'GPT-5.6 Luna',  supportsEffort: true },
    'gpt-5.5':       { path: 'chat',      label: 'GPT-5.5',       supportsEffort: false },
};
const MODEL_ALIASES = { 'gpt-5.6': 'gpt-5.6-sol' };
// `max` measured worse than `xhigh` on every axis, so only three efforts remain;
// old values stored in a browser map to the nearest survivor (resolveEffort).
const VALID_EFFORTS = ['low', 'medium', 'high'];
const EFFORT_ALIASES = { none: 'low', xhigh: 'high', max: 'high' };
const DEFAULT_EFFORT = 'medium';

// Resolve the requested model to { model, path }: an explicit known model is honored, anything
// else falls back to the env default — only an explicit gpt-5.6-* request reaches the Responses path.
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
    // Validate the RESULT, not the key: req.body may send "constructor"/"__proto__" and the lookup
    // would return something from Object.prototype instead of an effort.
    const aliased = EFFORT_ALIASES[requested];
    return VALID_EFFORTS.includes(aliased) ? aliased : DEFAULT_EFFORT;
}

module.exports = {
    ALLOWED_MODELS, MODEL_ALIASES,
    VALID_EFFORTS, EFFORT_ALIASES, DEFAULT_EFFORT,
    resolveModel, resolveEffort,
};
