// knowledge-dir.test.js — every file the local-knowledge tools read must exist under KNOWLEDGE_DIR.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { KNOWLEDGE_DIR } = require('../services/ai/client')({ pool: null });

test('KNOWLEDGE_DIR holds every file tools.js reads', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/ai/tools.js'), 'utf8');
    const names = [...src.matchAll(/join\(KNOWLEDGE_DIR, '([^']+)'\)/g)].map(m => m[1]);
    assert.ok(names.length > 0);
    for (const n of names) assert.ok(fs.existsSync(path.join(KNOWLEDGE_DIR, n)), n);
});
