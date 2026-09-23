// abap-highlight.test.js — the ABAP grammar md.js registers with the vendored highlight.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
const ctx = { window: {}, self: {}, console };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'js/vendor/highlight.min.js'), 'utf8'), ctx);
const hljs = ctx.hljs || ctx.window.hljs;
ctx.window.hljs = hljs;
const md = fs.readFileSync(path.join(root, 'js/md.js'), 'utf8');
vm.runInContext(md.slice(md.indexOf('    const ABAP_KEYWORDS'), md.indexOf('    function postProcess'))
    + '\nregisterAbap();', ctx);

test('ABAP blocks are tokenised: comments, strings, keywords, sy- fields, templates', () => {
    const code = "* header\nDATA lv_x TYPE i. \" inline\nSELECT SINGLE * FROM mara INTO @DATA(ls) WHERE matnr = '123'.\n"
        + 'IF sy-subrc <> 0.\n  MOVE-CORRESPONDING a TO b.\n  lv_s = |Value { lv_x }|.\n* mid\nENDIF.';
    const html = hljs.highlight(code, { language: 'abap' }).value;
    for (const want of ['hljs-comment">* header', 'hljs-comment">* mid', 'hljs-comment">&quot; inline',
        'hljs-keyword">DATA', 'hljs-keyword">MOVE-CORRESPONDING', 'hljs-built_in">sy-subrc',
        'hljs-string">&#x27;123&#x27;', 'hljs-subst">{ lv_x }']) {
        assert.ok(html.includes(want), want);
    }
});

test('a * mid-line is multiplication, not a comment', () => {
    assert.ok(!hljs.highlight('lv_y = a * b.', { language: 'abap' }).value.includes('hljs-comment'));
});
