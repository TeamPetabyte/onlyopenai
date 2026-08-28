// knowledge.js — ไฟล์ knowledge ใน vector store
const express = require('express');

module.exports = function (ctx) {
const router = express.Router();
const fs_mod   = require('fs');
const path_mod = require('path');
const {
    ensureVectorStore,
    expensiveRateLimiter,
    getVectorStoreId,
    HAS_API_KEY,
    KB_FILE_RE,
    KNOWLEDGE_DIR,
    openai,
    requireAdmin,
    requireAuth,
    safeError,
} = ctx;
// multer for file upload
const multer = require('multer');
// 100MB — large SAP training manuals (e.g. BC430 PDF ~37MB) must fit;
// OpenAI's own per-file cap is 512MB so this stays well inside it.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
// นามสกุลชุดเดียวกับ KB_FILE_RE ที่ boot ใช้ — เคยมีสองสำเนาแล้ว drift
const KNOWLEDGE_EXT_LIST = '.txt .md .pdf .doc .docx .html .htm';

// GET /api/knowledge — list files in vector store
router.get('/api/knowledge', requireAuth, async (req, res) => {
    if (!HAS_API_KEY || !getVectorStoreId()) return res.json({ ok: true, files: [], vectorStoreId: null });
    try {
        // walk all pages — a bare list() truncates at ~20 files.
        const entries = [];
        for await (const f of openai.vectorStores.files.list(getVectorStoreId(), { limit: 100 })) entries.push(f);
        const files = await Promise.all(entries.map(async f => {
            try {
                const info = await openai.files.retrieve(f.id);
                return { id: f.id, name: info.filename, size: info.bytes, status: f.status, created: f.created_at };
            } catch { return { id: f.id, name: f.id, status: f.status }; }
        }));
        res.json({ ok: true, vectorStoreId: getVectorStoreId(), files });
    } catch (e) {
        res.json({ ok: false, ...safeError(e, req), files: [] });
    }
});

// POST /api/knowledge/upload — upload doc to vector store
router.post('/api/knowledge/upload', requireAdmin, expensiveRateLimiter, upload.single('file'), async (req, res) => {
    if (!HAS_API_KEY) return res.json({ ok: false, error: 'No API key' });
    if (!req.file) return res.json({ ok: false, error: 'No file provided' });
    // Match what sync-knowledge.js can actually ingest. Without this the store
    // accepts anything up to 100MB, including types the pipeline will never read.
    if (!KB_FILE_RE.test(req.file.originalname || '')) {
        return res.json({ ok: false, error: 'Unsupported file type — allowed: ' + KNOWLEDGE_EXT_LIST });
    }
    try {
        const vsId = getVectorStoreId() || await ensureVectorStore();
        // upload file to OpenAI
        const { Readable } = require('stream');
        const stream = Readable.from(req.file.buffer);
        stream.path = req.file.originalname;  // OpenAI needs filename
        const uploaded = await openai.files.create({ file: stream, purpose: 'assistants' });
        // add to vector store
        await openai.vectorStores.files.createAndPoll(vsId, { file_id: uploaded.id });
        // ชื่อไฟล์มาจาก client = เป็น path ไม่ใช่ id — basename + เช็ค resolve อยู่ใน dir
        const safeName = path_mod.basename(req.file.originalname || 'upload');
        const localPath = path_mod.join(KNOWLEDGE_DIR, safeName);
        if (!localPath.startsWith(path_mod.resolve(KNOWLEDGE_DIR) + path_mod.sep)
            && path_mod.dirname(localPath) !== path_mod.resolve(KNOWLEDGE_DIR)) {
            return res.json({ ok: false, error: 'Invalid filename' });
        }
        // เขียนแบบ async — บัฟเฟอร์ 100MB เขียน sync จะ block ทุก stream ใน process
        await fs_mod.promises.writeFile(localPath, req.file.buffer);
        console.log(`[☁️ RAG] Uploaded: ${req.file.originalname}`);
        res.json({ ok: true, fileId: uploaded.id, name: req.file.originalname });
    } catch (e) {
        console.error('[knowledge/upload]', e.message);
        res.json({ ok: false, ...safeError(e, req) });
    }
});

// DELETE /api/knowledge/:fileId — remove file from vector store
router.delete('/api/knowledge/:fileId', requireAdmin, async (req, res) => {
    if (!HAS_API_KEY || !getVectorStoreId()) return res.json({ ok: false });
    try {
        await openai.vectorStores.files.del(getVectorStoreId(), req.params.fileId);
        await openai.files.del(req.params.fileId);
        res.json({ ok: true });
    } catch (e) {
        res.json({ ok: false, ...safeError(e, req) });
    }
});



return router;
};
