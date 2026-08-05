// ╔═══════════════════════════════════════════════════════════╗
// ║ Sync knowledge/ docs (txt/md/pdf/docx) → OpenAI v.store   ║
// ╚═══════════════════════════════════════════════════════════╝
// One-shot script — uploads any local knowledge file that isn't
// already in the vector store. Safe to re-run.
//
// Run:  node sync-knowledge.js

'use strict';

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const OpenAI = require('openai');

const API_KEY = process.env.OPENAI_API_KEY;
const VS_ID   = process.env.OPENAI_VECTOR_STORE_ID;
const KB_DIR  = path.join(__dirname, 'knowledge');

if (!API_KEY)  { console.error('FATAL: OPENAI_API_KEY not set');        process.exit(2); }
if (!VS_ID)    { console.error('FATAL: OPENAI_VECTOR_STORE_ID not set'); process.exit(2); }
if (!fs.existsSync(KB_DIR)) { console.error('FATAL: knowledge/ dir missing'); process.exit(2); }

const openai = new OpenAI({ apiKey: API_KEY });

(async () => {
    const local = fs.readdirSync(KB_DIR).filter(f => /\.(txt|md|pdf|docx?|html?)$/i.test(f)).sort();
    console.log(`[local]  ${local.length} files under knowledge/`);

    // Resolve filenames currently in the vector store — for-await walks ALL
    // pages (a bare list() returns one ~20-item page; the truncated diff was
    // re-uploading old files as "missing" once the store grew past that).
    const existing = new Set();
    for await (const vf of openai.vectorStores.files.list(VS_ID, { limit: 100 })) {
        try {
            const meta = await openai.files.retrieve(vf.id);
            if (meta?.filename) existing.add(meta.filename);
        } catch (e) {
            console.warn(`  (!) skipping ${vf.id}: ${e.message}`);
        }
    }
    console.log(`[remote] ${existing.size} files currently in vector store ${VS_ID}`);

    const missing = local.filter(f => !existing.has(f));
    if (missing.length === 0) {
        console.log('\n✅ Nothing to do — knowledge base already in sync.');
        process.exit(0);
    }

    console.log(`\n[upload] ${missing.length} file(s):`);
    const ids = [];
    for (const filename of missing) {
        try {
            const uploaded = await openai.files.create({
                file:    fs.createReadStream(path.join(KB_DIR, filename)),
                purpose: 'assistants',
            });
            ids.push(uploaded.id);
            console.log(`  ✅ ${filename}  →  ${uploaded.id}`);
        } catch (e) {
            console.warn(`  ❌ ${filename}: ${e.message}`);
        }
    }

    if (ids.length === 0) { console.error('\nNo files uploaded.'); process.exit(1); }

    console.log(`\n[index] indexing ${ids.length} new file(s) in vector store…`);
    const batch = await openai.vectorStores.fileBatches.createAndPoll(VS_ID, { file_ids: ids });
    console.log(`[index] batch status: ${batch.status} (success=${batch.file_counts?.completed || 0}, failed=${batch.file_counts?.failed || 0})`);

    if (batch.status === 'completed' && (batch.file_counts?.failed || 0) === 0) {
        console.log('\n✅ Done — vector store updated.');
        process.exit(0);
    }
    console.error('\n⚠️  Indexing finished with issues. Check vector store in OpenAI dashboard.');
    process.exit(1);
})().catch(e => { console.error('\nFATAL', e); process.exit(2); });
