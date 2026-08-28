// misc.js — health + version fingerprint
const express = require('express');

module.exports = function (ctx) {
const router = express.Router();
const {
    getAssistantId,
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
        mode:          HAS_API_KEY ? 'openai' : 'mock',
        model:         HAS_API_KEY ? MODEL : null,
        assistantId:   getAssistantId(),
        vectorStoreId: getVectorStoreId(),
        rag:           !!getVectorStoreId(),
    });
});

// Phase 11 B2: /api/version — admin-only deployment fingerprint.
// Exposes version, uptime, node version, migration state. Used by
// ops to verify which build is live and whether any migrations are
// pending/modified. Admin-gated because migration state is
// deployment-sensitive info.
const _BOOT_TIME = Date.now();
router.get('/api/version', requireAdmin, async (req, res) => {
    let migrations = null;
    try {
        const s = await migrationStatus(pool);
        migrations = {
            applied:  s.applied.length,
            pending:  s.pending.length,
            modified: s.modified.length,
            // only list the problematic ones explicitly — applied list
            // can be long and noisy
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
