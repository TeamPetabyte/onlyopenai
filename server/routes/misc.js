// misc.js — health + version fingerprint
const express = require('express');

module.exports = function (ctx) {
const router = express.Router();
const {

    getVectorStoreId,
    HAS_API_KEY,
    migrationStatus,
    MODEL,
    pkg,
    pool,
    requireAdmin,
    safeError,
} = ctx;
router.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        // Unauthenticated: booleans only; model and OpenAI object ids live on /api/version (admin).
        mode:          HAS_API_KEY ? 'openai' : 'mock',
        rag:           !!getVectorStoreId(),
    });
});

// /api/version — fingerprint ของ deploy; admin เท่านั้น เพราะสถานะ migration เป็นข้อมูล sensitive
const _BOOT_TIME = Date.now();
router.get('/api/version', requireAdmin, async (req, res) => {
    let migrations = null;
    try {
        const s = await migrationStatus(pool);
        migrations = {
            applied:  s.applied.length,
            pending:  s.pending.length,
            modified: s.modified.length,
            // the applied list can be long; list only pending/modified
            pendingFiles:  s.pending,
            modifiedFiles: s.modified,
        };
    } catch (e) {
        migrations = { ...safeError(e, req) };
    }
    res.json({
        ok:          true,
        name:        pkg.name,
        version:     pkg.version,
        node:        process.version,
        platform:    `${process.platform}/${process.arch}`,
        mode:        HAS_API_KEY ? 'openai' : 'mock',
        model:       HAS_API_KEY ? MODEL : null,
        bootTime:    new Date(_BOOT_TIME).toISOString(),
        uptimeSec:   Math.round(process.uptime()),
        migrations,
    });
});



return router;
};
