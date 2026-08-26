// models.test.js — resolving the client's model and effort request.
//
// Both values arrive straight from req.body. resolveEffort used to read them
// off an object without an own-property check, so "constructor" came back as a
// function and went on to the Responses API as reasoning.effort.

const test = require('node:test');
const assert = require('node:assert');
const models = require('../lib/models');

const DEFAULT = 'gpt-4o-mini';

test('resolveModel: an explicit known model is honoured, with its API path', () => {
    assert.deepEqual(models.resolveModel('gpt-5.6-sol', DEFAULT),
        { model: 'gpt-5.6-sol', path: 'responses' });
    assert.deepEqual(models.resolveModel('gpt-5.5', DEFAULT),
        { model: 'gpt-5.5', path: 'chat' });
});

test('resolveModel: gpt-5.6 is an alias for sol', () => {
    assert.deepEqual(models.resolveModel('gpt-5.6', DEFAULT),
        { model: 'gpt-5.6-sol', path: 'responses' });
});

test('resolveModel: an unknown or missing model falls back to the deployment default', () => {
    for (const req of ['nope', '', null, undefined]) {
        assert.deepEqual(models.resolveModel(req, DEFAULT), { model: DEFAULT, path: 'chat' });
    }
});

test('resolveModel: prototype keys do not resolve to a model', () => {
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
        const r = models.resolveModel(key, DEFAULT);
        assert.equal(typeof r.model, 'string', `${key} produced ${typeof r.model}`);
        assert.equal(r.model, DEFAULT);
    }
});

test('resolveEffort: the three valid values pass through', () => {
    for (const e of ['low', 'medium', 'high']) assert.equal(models.resolveEffort(e), e);
});

test('resolveEffort: retired values map to the nearest survivor', () => {
    // Browsers still hold `max`/`xhigh`/`none` in localStorage from before the
    // effort list was trimmed to three; mapping beats silently resetting.
    assert.equal(models.resolveEffort('max'), 'high');
    assert.equal(models.resolveEffort('xhigh'), 'high');
    assert.equal(models.resolveEffort('none'), 'low');
});

test('resolveEffort: anything unrecognised becomes the default', () => {
    for (const e of ['zzz', '', null, undefined, 42]) {
        assert.equal(models.resolveEffort(e), 'medium');
    }
});

test('resolveEffort: always returns one of the valid efforts, never a function', () => {
    // The bug: EFFORT_ALIASES['constructor'] returned Object, which
    // JSON.stringify then dropped from the request body without a word.
    for (const key of ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty']) {
        const got = models.resolveEffort(key);
        assert.equal(typeof got, 'string', `${key} produced a ${typeof got}`);
        assert.ok(models.VALID_EFFORTS.includes(got), `${key} produced ${got}`);
    }
});

test('every allowed model declares a path the chat loop understands', () => {
    for (const [id, cfg] of Object.entries(models.ALLOWED_MODELS)) {
        assert.ok(['responses', 'chat'].includes(cfg.path), `${id} has path ${cfg.path}`);
        assert.equal(typeof cfg.label, 'string');
    }
});

test('every alias points at a real model', () => {
    for (const [alias, target] of Object.entries(models.MODEL_ALIASES)) {
        assert.ok(models.ALLOWED_MODELS[target], `${alias} → ${target}, which is not allowed`);
    }
});
