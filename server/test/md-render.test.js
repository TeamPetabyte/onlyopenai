// md-render.test.js — md.js fixes a Sources line left in an open fence, and names code-block downloads.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const md = fs.readFileSync(path.join(__dirname, '..', '..', 'js/md.js'), 'utf8');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(md.slice(md.indexOf('    function sourcesOutsideFence'), md.indexOf('    // DOMPurify config'))
    + '\nglobalThis.fn = sourcesOutsideFence;', ctx);
const fix = ctx.fn;
const SRC = '📚 Sources: SAP ABAP standards COPY keystone.doc';

test('an empty, unclosed fence before the Sources line disappears', () => {
    assert.strictEqual(fix('Answer.\n\n```sql\n\n\n' + SRC), 'Answer.\n\n' + SRC);
});

test('code in an unclosed fence is kept and the fence closes before Sources', () => {
    assert.strictEqual(fix('```abap\nWRITE 1.\n' + SRC), '```abap\nWRITE 1.\n```\n' + SRC);
});

test('Sources wrapped inside a closed fence moves after it', () => {
    assert.strictEqual(fix('```abap\nWRITE 1.\n' + SRC + '\n```'), '```abap\nWRITE 1.\n```\n' + SRC);
});

test('a well-formed answer is untouched', () => {
    const ok = '```abap\nWRITE 1.\n```\n\n' + SRC;
    assert.strictEqual(fix(ok), ok);
    assert.strictEqual(fix('no sources here\n```sql\nSELECT 1'), 'no sources here\n```sql\nSELECT 1');
});

// md.js: a code block downloads with its own language's extension
const ctx2 = {};
vm.createContext(ctx2);
vm.runInContext(md.slice(md.indexOf('    const LANG_EXT'), md.indexOf('    // Client-side download'))
    + '\nglobalThis.fn = codeFilename;', ctx2);

test('code block file name: attached base name + the block language extension', () => {
    assert.strictEqual(ctx2.fn('abap', 'ZSD_REPORT.abap'), 'ZSD_REPORT.abap');
    assert.strictEqual(ctx2.fn('sql', 'ZSD_REPORT.abap'), 'ZSD_REPORT.sql');
    assert.strictEqual(ctx2.fn('ABAP', 'ZNOEXT'), 'ZNOEXT.abap');
    assert.match(ctx2.fn('json'), /^pipekai-code-[\dT-]+\.json$/);
    assert.match(ctx2.fn('code'), /\.txt$/);
});
