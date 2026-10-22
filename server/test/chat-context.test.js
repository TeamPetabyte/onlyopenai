// chat-context.test.js — earlier attachments stay in context once each; history fills to the budget.

const test = require('node:test');
const assert = require('node:assert');
const { splitFile, stripFileBody, earlierFilesBlock, buildChatContext, HIST_MAX_CHARS } = require('../lib/chat-context');

const turn = (text, name, body) => (text ? text + '\n\n' : '') + `[File: ${name}]\n${body}`;

test('splitFile reads the typed text, the name and the body', () => {
    assert.deepStrictEqual(splitFile(turn('review this', 'ZA.abap', 'REPORT za.')),
        { text: 'review this', name: 'ZA.abap', body: 'REPORT za.' });
    assert.deepStrictEqual(splitFile(turn('', 'ZA.abap', 'X')), { text: '', name: 'ZA.abap', body: 'X' });
    assert.strictEqual(splitFile('no file here [File: x] inline'), null);
});

test('stripFileBody keeps the question and the file name, drops the body', () => {
    const s = stripFileBody(turn('review this', 'ZA.abap', 'REPORT za.\nWRITE 1.'));
    assert.ok(s.startsWith('review this\n\n[File: ZA.abap]'));
    assert.ok(!s.includes('WRITE 1.'));
    assert.strictEqual(stripFileBody('plain question'), 'plain question');
});

test('earlierFilesBlock: newest version of each file, none re-attached now, within the cap', () => {
    const newestFirst = [
        'a follow-up',
        turn('v2', 'ZA.abap', 'NEW A'),
        turn('', 'ZB.sql', 'SELECT 1'),
        turn('v1', 'ZA.abap', 'OLD A'),
    ];
    const block = earlierFilesBlock(newestFirst, 'fix line 3');
    assert.ok(block.includes('[File: ZA.abap]\nNEW A'));
    assert.ok(!block.includes('OLD A'));
    assert.ok(block.includes('[File: ZB.sql]\nSELECT 1'));

    const reattached = earlierFilesBlock(newestFirst, turn('again', 'ZA.abap', 'NEWER'));
    assert.ok(!reattached.includes('ZA.abap'));

    const capped = earlierFilesBlock([turn('', 'BIG.abap', 'x'.repeat(50)), turn('', 'SMALL.abap', 'y')], '', 10);
    assert.ok(!capped.includes('BIG.abap') && capped.includes('SMALL.abap'));

    assert.strictEqual(earlierFilesBlock(['no files'], 'q'), '');
});

test('buildChatContext: whole chat when it fits, oldest turns dropped past the budget', () => {
    const rows = [
        { role: 'user', content: turn('review', 'ZA.abap', 'REPORT za.') },
        { role: 'assistant', content: 'looks fine' },
        { role: 'user', content: 'and line 1?' },
    ];
    const small = buildChatContext(rows, 'next');
    assert.strictEqual(small.dropped, 0);
    assert.ok(small.pct >= 0 && small.pct < 5);
    assert.ok(small.history[0].content.startsWith('Files attached earlier'));
    assert.strictEqual(small.history.length, 4);

    const big = 'x'.repeat(HIST_MAX_CHARS / 2 + 1);
    const full = buildChatContext([{ role: 'user', content: big }, { role: 'assistant', content: big },
        { role: 'user', content: 'q' }], '');
    assert.strictEqual(full.dropped, 1);
    assert.strictEqual(full.pct, 100);
    assert.strictEqual(buildChatContext([], '').pct, 0);
});
