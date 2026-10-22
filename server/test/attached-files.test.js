// attached-files.test.js — earlier attachments stay in context, once each, newest version wins.

const test = require('node:test');
const assert = require('node:assert');
const { splitFile, stripFileBody, earlierFilesBlock } = require('../lib/attached-files');

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
