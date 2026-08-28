// chat-sessions.js — session แชท: list/get/create/rename/delete/export
const express = require('express');

module.exports = function (ctx) {
const router = express.Router();
const {
    pool,
    requireAuth,
    safeError,
} = ctx;
/**
 * Verify the caller owns this session. Returns the row or sends a
 * response and returns null.  Note: sessions that are soft-deleted
 * return 404 (not 403) — we treat deletion as "does not exist" from
 * the user's perspective to avoid probing.
 */
async function loadOwnedSession(req, res, sessionId) {
    const uid = req.session && req.session.userId;
    if (!uid) { res.status(401).json({ ok: false, error: 'Not authenticated' }); return null; }
    const id = Number(sessionId);
    if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ ok: false, error: 'Invalid session id' });
        return null;
    }
    const r = await pool.query(
        `SELECT session_id, user_id, title, created_at, updated_at,
                is_deleted, message_count, total_cost, is_favorite
         FROM tbl_chat_session WHERE session_id=$1`,
        [id]);
    const row = r.rows[0];
    if (!row || row.is_deleted) {
        res.status(404).json({ ok: false, error: 'Session not found' });
        return null;
    }
    if (row.user_id !== uid) {
        // Same 404 shape on purpose — don't confirm "exists but forbidden"
        res.status(404).json({ ok: false, error: 'Session not found' });
        return null;
    }
    return row;
}

// GET /api/chat/sessions
//  list the caller's own sessions, most recent first, soft-deleted hidden.
//  Optional ?q= filter — matches session title OR any message content
//  via ILIKE (case-insensitive, %-wrapped). The match is escaped so
//  user-supplied % / _ behave as literals, not wildcards.
router.get('/api/chat/sessions', requireAuth, async (req, res) => {
    const uid = req.session.userId;
    // Clamp to 80 chars — anything longer is almost certainly not a real
    // search, just a URL-inflation attempt.
    const rawQ = String(req.query.q || '').trim().slice(0, 80);
    try {
        if (rawQ.length > 0) {
            // Escape ILIKE metacharacters so they match literally
            const safe = rawQ.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
            const pat  = '%' + safe + '%';
            const r = await pool.query(
                `SELECT s.session_id AS id, s.title, s.message_count,
                        s.total_cost, s.created_at, s.updated_at, s.is_favorite
                 FROM tbl_chat_session s
                 WHERE s.user_id=$1 AND s.is_deleted=FALSE
                   AND (s.title ILIKE $2 ESCAPE '\\'
                        OR EXISTS (
                            SELECT 1 FROM tbl_chat_message m
                            WHERE m.session_id = s.session_id
                              AND m.content ILIKE $2 ESCAPE '\\'))
                 ORDER BY s.is_favorite DESC, s.updated_at DESC
                 LIMIT 100`,
                [uid, pat]);
            // Phase 19.7: snake_case → camelCase for the frontend.
            const rows = r.rows.map(r => ({
                id: r.id, title: r.title,
                message_count: r.message_count, total_cost: r.total_cost,
                created_at: r.created_at, updated_at: r.updated_at,
                isFavorite: !!r.is_favorite,
            }));
            return res.json({ ok: true, sessions: rows, q: rawQ });
        }
        const r = await pool.query(
            `SELECT session_id AS id, title, message_count,
                    total_cost, created_at, updated_at, is_favorite
             FROM tbl_chat_session
             WHERE user_id=$1 AND is_deleted=FALSE
             ORDER BY is_favorite DESC, updated_at DESC
             LIMIT 100`,
            [uid]);
        const rows = r.rows.map(r => ({
            id: r.id, title: r.title,
            message_count: r.message_count, total_cost: r.total_cost,
            created_at: r.created_at, updated_at: r.updated_at,
            isFavorite: !!r.is_favorite,
        }));
        res.json({ ok: true, sessions: rows });
    } catch (e) { res.status(500).json({ ok: false, ...safeError(e, req) }); }
});

// GET /api/chat/sessions/:id   → { session, messages }
router.get('/api/chat/sessions/:id', requireAuth, async (req, res) => {
    const sess = await loadOwnedSession(req, res, req.params.id);
    if (!sess) return;
    try {
        const m = await pool.query(
            `SELECT message_id AS id, role, content, created_at,
                    input_tokens, output_tokens, cost, model, skill_id, duration_ms,
                    skills_used
             FROM tbl_chat_message
             WHERE session_id=$1
             ORDER BY created_at, message_id`,
            [sess.session_id]);
        res.json({
            ok: true,
            session: {
                id: sess.session_id, title: sess.title,
                messageCount: sess.message_count, totalCost: sess.total_cost,
                createdAt: sess.created_at, updatedAt: sess.updated_at,
                isFavorite: !!sess.is_favorite,
            },
            messages: m.rows,
        });
    } catch (e) { res.status(500).json({ ok: false, ...safeError(e, req) }); }
});

// POST /api/chat/sessions   body: { title? }
router.post('/api/chat/sessions', requireAuth, async (req, res) => {
    const uid = req.session.userId;
    const raw = (req.body && typeof req.body.title === 'string') ? req.body.title.trim() : '';
    const title = raw ? raw.slice(0, 200) : 'New chat';
    try {
        const r = await pool.query(
            `INSERT INTO tbl_chat_session (user_id, title)
             VALUES ($1, $2)
             RETURNING session_id, title, created_at, updated_at`,
            [uid, title]);
        res.json({ ok: true, session: {
            id: r.rows[0].session_id, title: r.rows[0].title,
            messageCount: 0, totalCost: 0,
            createdAt: r.rows[0].created_at, updatedAt: r.rows[0].updated_at,
        } });
    } catch (e) { res.status(500).json({ ok: false, ...safeError(e, req) }); }
});

// PATCH /api/chat/sessions/:id   body: { title? , favorite? }
//   Phase 19.7: now also accepts { favorite: bool } for star/unstar.
//   At least one of title / favorite must be provided.
//   Title change bumps updated_at; favorite toggle does NOT (we don't
//   want starring an old chat to make it jump to the top of the date
//   buckets — the favorite group is the "top" already).
router.patch('/api/chat/sessions/:id', requireAuth, async (req, res) => {
    const sess = await loadOwnedSession(req, res, req.params.id);
    if (!sess) return;
    const body = req.body || {};
    const t = typeof body.title === 'string' ? body.title.trim() : null;
    const hasFavorite = (typeof body.favorite === 'boolean');
    if (!t && !hasFavorite) {
        return res.status(400).json({ ok: false, error: 'title or favorite required' });
    }
    try {
        if (t && hasFavorite) {
            await pool.query(
                `UPDATE tbl_chat_session
                   SET title=$1, is_favorite=$2, updated_at=NOW()
                 WHERE session_id=$3`,
                [t.slice(0, 200), !!body.favorite, sess.session_id]);
        } else if (t) {
            await pool.query(
                `UPDATE tbl_chat_session SET title=$1, updated_at=NOW()
                 WHERE session_id=$2`,
                [t.slice(0, 200), sess.session_id]);
        } else {
            // favorite-only toggle — leave updated_at alone
            await pool.query(
                `UPDATE tbl_chat_session SET is_favorite=$1
                 WHERE session_id=$2`,
                [!!body.favorite, sess.session_id]);
        }
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, ...safeError(e, req) }); }
});

// DELETE /api/chat/sessions/:id   → soft delete
router.delete('/api/chat/sessions/:id', requireAuth, async (req, res) => {
    const sess = await loadOwnedSession(req, res, req.params.id);
    if (!sess) return;
    try {
        await pool.query(
            `UPDATE tbl_chat_session SET is_deleted=TRUE, updated_at=NOW()
             WHERE session_id=$1`,
            [sess.session_id]);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, ...safeError(e, req) }); }
});

// GET /api/chat/sessions/:id/export   → plain markdown file
router.get('/api/chat/sessions/:id/export', requireAuth, async (req, res) => {
    const sess = await loadOwnedSession(req, res, req.params.id);
    if (!sess) return;
    try {
        const m = await pool.query(
            `SELECT role, content, created_at, cost
             FROM tbl_chat_message WHERE session_id=$1
             ORDER BY created_at, message_id`,
            [sess.session_id]);
        let md = `# ${sess.title}\n\n`;
        md += `_Exported ${new Date().toISOString()} · ${m.rows.length} messages · ฿${Number(sess.total_cost).toFixed(4)}_\n\n---\n\n`;
        for (const row of m.rows) {
            const who = row.role === 'user' ? '👤 **You**'
                      : row.role === 'assistant' ? '🤖 **Assistant**'
                      : `_${row.role}_`;
            md += `### ${who}  \n*${new Date(row.created_at).toISOString()}*\n\n${row.content}\n\n`;
        }
        // Safe filename: strip anything that isn't alnum/underscore/hyphen
        const fname = (sess.title || 'chat').replace(/[^\w\-]+/g, '_').slice(0, 60) || 'chat';
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader('Content-Disposition',
            `attachment; filename="${fname}.md"`);
        res.send(md);
    } catch (e) { res.status(500).json({ ok: false, ...safeError(e, req) }); }
});


// ══════════════════════════════════════════════════════════
//  PHASE 3: KNOWLEDGE BASE ENDPOINTS
// ══════════════════════════════════════════════════════════


return router;
};
