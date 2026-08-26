// prompt.test.js — how the system prompt is assembled.
//
// The case that matters most here is A1: applyCodePlaceholder was rewriting the
// user's own source before the model ever saw it, because String.replace treats
// $&, $', $` and $1 in the REPLACEMENT as substitution escapes. Nothing errored;
// the model simply reviewed code that was not what the user pasted.

const test = require('node:test');
const assert = require('node:assert');
const prompt = require('../lib/prompt');

const SKILL = 'You are a reviewer.\n<ABAP_code>\n{code}\n</ABAP_code>\nEnd.';
const PASTE = 'REPORT z.\nDATA x TYPE i.\nWRITE x.';

test('applyCodePlaceholder: passes a prompt without {code} straight through', () => {
    const r = prompt.applyCodePlaceholder('no placeholder here', 'ช่วยดูให้หน่อย');
    assert.equal(r.systemPrompt, 'no placeholder here');
    assert.equal(r.userPrompt, 'ช่วยดูให้หน่อย');
});

test('applyCodePlaceholder: substitutes pasted code', () => {
    const r = prompt.applyCodePlaceholder(SKILL, PASTE);
    assert.ok(r.systemPrompt.includes('DATA x TYPE i.'));
    assert.ok(!r.systemPrompt.includes('{code}'));
});

test('applyCodePlaceholder: $& in the source survives untouched', () => {
    const code = "REPORT z.\nWRITE: 'total $& here'.\nWRITE 1.";
    const r = prompt.applyCodePlaceholder(SKILL, code);
    assert.ok(r.systemPrompt.includes("'total $& here'"),
        'the literal was rewritten: ' + r.systemPrompt.split('\n').find(l => l.includes('total')));
});

test("applyCodePlaceholder: $' does not splice the rest of the prompt in", () => {
    const code = "REPORT z.\nWRITE: 'a $' b'.\nWRITE 1.";
    const r = prompt.applyCodePlaceholder(SKILL, code);
    assert.ok(r.systemPrompt.includes("'a $' b'"), 'the source was corrupted');
    // the tail of the skill must appear exactly once, not duplicated into the code
    assert.equal(r.systemPrompt.split('End.').length - 1, 1);
});

test('applyCodePlaceholder: $` and $1 survive untouched', () => {
    const code = 'REPORT z.\nWRITE: `$` and $1`.\nWRITE 1.';
    const r = prompt.applyCodePlaceholder(SKILL, code);
    assert.ok(r.systemPrompt.includes('$1'), '$1 was consumed');
});

test('applyCodePlaceholder: fills EVERY placeholder, not just the first', () => {
    const two = 'A {code} B {code} C';
    const r = prompt.applyCodePlaceholder(two, PASTE);
    assert.ok(!r.systemPrompt.includes('{code}'), 'a placeholder was left literal');
});

test('applyCodePlaceholder: a question is not treated as a paste', () => {
    const r = prompt.applyCodePlaceholder(SKILL, 'ช่วยแก้ตรงนี้ให้หน่อย');
    assert.equal(r.userPrompt, 'ช่วยแก้ตรงนี้ให้หน่อย');
    assert.ok(r.systemPrompt.includes('no code was pasted this turn'));
});

test('applyCodePlaceholder: a paste gets the neutral user turn', () => {
    // A user-role instruction outranks the system prompt, so this wording must
    // not tell the model to apply everything — the shared rules decide what may
    // be applied and what must only be reported.
    const r = prompt.applyCodePlaceholder(SKILL, PASTE);
    assert.ok(/respond according to your instructions/.test(r.userPrompt));
    assert.ok(!/apply the corrections/i.test(r.userPrompt));
});

// ── orgStandardsBlock ─────────────────────────────────────
test('orgStandardsBlock: nothing to say when there are no standards', () => {
    assert.equal(prompt.orgStandardsBlock(null), '');
    assert.equal(prompt.orgStandardsBlock({ text: '' }), '');
});

test('orgStandardsBlock: carries the text and cites the files', () => {
    const b = prompt.orgStandardsBlock({ text: 'RULE ONE', files: ['keystone.doc', 'bc402.pdf'] });
    assert.ok(b.includes('RULE ONE'));
    assert.ok(b.includes('keystone.doc · bc402.pdf'));
});

// ── supportingKnowledgeBlock ──────────────────────────────
// The registry is injected, so this needs no database.
const fakeSkills = (map) => ({
    getSkill: id => (map[id] ? { id, label: map[id].label || id, content: map[id].content } : null),
    knowledgeBlockOf: c => {
        const m = String(c).match(/<best_practices?>([\s\S]*?)<\/best_practices?>/i);
        return m ? m[1].trim() : '';
    },
});

test('supportingKnowledgeBlock: empty list adds nothing', () => {
    assert.equal(prompt.supportingKnowledgeBlock([], fakeSkills({})), '');
});

test('supportingKnowledgeBlock: skills with no knowledge add nothing', () => {
    const s = fakeSkills({ a: { content: 'no tags at all' } });
    assert.equal(prompt.supportingKnowledgeBlock(['a'], s), '');
});

test('supportingKnowledgeBlock: includes each skill under its label', () => {
    const s = fakeSkills({
        a: { label: 'Alpha', content: '<best_practices>RULE A</best_practices>' },
        b: { label: 'Beta',  content: '<best_practice>RULE B</best_practice>' },
    });
    const b = prompt.supportingKnowledgeBlock(['a', 'b'], s);
    assert.ok(b.includes('### Alpha') && b.includes('RULE A'));
    assert.ok(b.includes('### Beta') && b.includes('RULE B'));
});

test('supportingKnowledgeBlock: unknown ids are skipped, not thrown on', () => {
    const s = fakeSkills({ a: { content: '<best_practices>RULE A</best_practices>' } });
    const b = prompt.supportingKnowledgeBlock(['a', 'does_not_exist'], s);
    assert.ok(b.includes('RULE A'));
});

test('supportingKnowledgeBlock: stays within the character budget', () => {
    const big = 'x'.repeat(5000);
    const map = {};
    for (const id of ['a', 'b', 'c', 'd', 'e']) map[id] = { content: `<best_practices>${big}</best_practices>` };
    const b = prompt.supportingKnowledgeBlock(Object.keys(map), fakeSkills(map));
    assert.ok(b.length < prompt.MAX_SUPPORTING_CHARS + 1000, `block was ${b.length} chars`);
});

// ── the shared appendix ───────────────────────────────────
test('PROMPT_COMMON_APPENDIX: carries every section the product depends on', () => {
    const a = prompt.PROMPT_COMMON_APPENDIX;
    for (const heading of [
        'Language rule',
        'What this interface can and cannot do',
        'Knowledge base',
        'Citations',
        'What you may fix, and what you may only report',
        'Answer format for a code fix',
        'Depth',
        'Accuracy rules',
    ]) {
        assert.ok(a.includes(heading), `appendix lost its "${heading}" section`);
    }
});

test('PROMPT_COMMON_APPENDIX: still says *### goes in column 1', () => {
    // An indented *### is not a comment in ABAP — it is a syntax error in the
    // file the user downloads. Verified against abaplint, so the wording that
    // produces it matters.
    assert.ok(/column 1/.test(prompt.PROMPT_COMMON_APPENDIX));
});
