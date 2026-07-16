// ╔═══════════════════════════════════════════════════════════╗
// ║ Phase 10 — Central request validation (zod)               ║
// ╚═══════════════════════════════════════════════════════════╝
// Two goals:
//   1. Reject malformed input early with a clear 400 so routes
//      can assume req.body has the shape they expect.
//   2. Strip unknown fields so an attacker can't mass-assign
//      privileged columns (e.g. role, is_deleted, admin_api_key).
//      Zod's default is `.strip()` — anything not in the schema
//      is removed before it reaches the route.
//
// We prefer `.strip()` over `.strict()` because existing clients
// may send extra harmless fields; strip silently drops them.
// Schemas are conservative on types (string/number/enum) and
// permissive on shape (optional everywhere possible) to avoid
// breaking existing HTML forms.

const { z } = require('zod');

const MAX_BALANCE = parseFloat(process.env.MAX_BALANCE) || 1000000;

// ── Primitive building blocks ──────────────────────────────
const username   = z.string().trim().min(1).max(64);
const password   = z.string().min(1).max(128);       // strength check is a separate helper
const displayStr = z.string().trim().max(128);       // used for name/surname/displayName
const longText   = z.string().max(1024);             // description etc.
const projectId  = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_\-]+$/,
    'projectId must be alphanumeric/_/-');
// Phase 30.3: 'trainer' (superadmin) is deliberately NOT accepted here —
// superadmin accounts are provisioned manually (SQL), never via the API.
const roleEnum   = z.enum(['admin', 'user']);

// Numbers may arrive as strings from HTML forms — coerce then clamp.
const amount     = z.coerce.number().finite()
    .min(0, 'amount must be >= 0').max(MAX_BALANCE, `amount must be <= ${MAX_BALANCE}`);
const amountPos  = z.coerce.number().finite()
    .gt(0, 'amount must be > 0').max(MAX_BALANCE, `amount must be <= ${MAX_BALANCE}`);
const rate       = z.coerce.number().finite()
    .min(0, 'rate must be >= 0').max(10000, 'rate too large');
const intId      = z.coerce.number().int().positive();

// ── Schemas per endpoint ───────────────────────────────────
const loginSchema = z.object({
    username: username,
    password: password,
});

const createUserSchema = z.object({
    username:    username,
    password:    password,
    displayName: displayStr.optional(),
    name:        displayStr.optional(),
    surname:     displayStr.optional(),
    role:        roleEnum.optional().default('user'),
    balance:     amount.optional(),                  // legacy (Concept B uses dailyCap)
    // Concept B: per-user daily spending limit set at creation.
    // null / omitted = no cap (unlimited, bounded only by the project pool).
    dailyCap:    z.coerce.number().finite().min(0).max(MAX_BALANCE).nullable().optional(),
    projectId:   projectId.optional(),
});

// PUT /api/users/:id — every field optional; role enum guards privilege escalation
const updateUserSchema = z.object({
    displayName: displayStr.optional(),
    name:        displayStr.optional(),
    surname:     displayStr.optional(),
    role:        roleEnum.optional(),
    balance:     amount.optional(),
    // projectId: string = assign, null = unassign, missing = no change
    projectId:   projectId.nullable().optional(),
    password:    password.optional(),
    accStatusId: z.coerce.number().int().min(1).max(5).optional(),
});

const changePasswordSchema = z.object({
    password: password,
});

const setBalanceSchema = z.object({
    balance: amount,
});

const createProjectSchema = z.object({
    name:        z.string().trim().min(1).max(128),
    projectId:   projectId.optional(),
    // Phase 16.2: bumped max from 128 → 256 — real OpenAI service-account keys
    // (sk-svcacct-…) and project keys (sk-proj-…) are ~167 chars.
    apiKey:      z.string().trim().max(256).optional(),
    description: longText.optional(),
    inputRate:   rate.optional(),
    outputRate:  rate.optional(),
    creditLimit: amount.optional(),
});

const updateProjectSchema = z.object({
    name:        z.string().trim().min(1).max(128).optional(),
    // Phase 16.2: bumped max from 128 → 256 — real OpenAI service-account keys
    // (sk-svcacct-…) and project keys (sk-proj-…) are ~167 chars.
    // Phase 16.5: also accept `null` so admin can CLEAR the stored key
    //   (PUT body { apiKey: null } → server overwrites column with NULL).
    apiKey:      z.union([z.string().trim().max(256), z.null()]).optional(),
    credits:     amount.optional(),
    description: longText.optional(),
    inputRate:   rate.optional(),
    outputRate:  rate.optional(),
    creditLimit: amount.optional(),
});

const topupSchema = z.object({
    amount: amountPos,
    // Phase 16.1 / 21.2: optional admin note (free text, capped at 500 chars).
    // Stored in tbl_topup_project.note. Mirrored into tbl_action_admin.extra.note.
    note:   z.string().trim().max(500).optional(),
});

// Phase 11 B3: daily cap. null or missing clears the cap.
const dailyCapSchema = z.object({
    dailyCap: z.coerce.number().finite()
        .min(0, 'dailyCap must be >= 0')
        .max(MAX_BALANCE, `dailyCap must be <= ${MAX_BALANCE}`)
        .nullable().optional(),
});

// Chat-style routes — keep loose because we don't dictate content
const chatSchema = z.object({
    message:   z.string().max(20000).optional(),
    prompt:    z.string().max(20000).optional(),
    threadId:  z.string().max(128).optional(),
    sessionId: z.coerce.number().int().positive().optional(),
    // Any other field is silently stripped
});

const historyAddSchema = z.object({
    prompt:        z.string().max(20000).optional().default(''),
    response:      z.string().max(200000).optional().default(''),
    inputTokens:   z.coerce.number().int().min(0).max(10_000_000).optional().default(0),
    outputTokens:  z.coerce.number().int().min(0).max(10_000_000).optional().default(0),
    cost:          z.coerce.number().min(0).max(MAX_BALANCE).optional().default(0),
    threadId:      z.string().max(128).optional(),
    sessionId:     z.coerce.number().int().positive().optional(),
});

const sessionCreateSchema = z.object({
    title:    z.string().max(256).optional(),
    threadId: z.string().max(128).optional(),
});

const sessionUpdateSchema = z.object({
    title:    z.string().max(256).optional(),
    threadId: z.string().max(128).optional(),
});

// ── The middleware factory ─────────────────────────────────
// Validates req[key] (default 'body') against the schema. On failure
// returns 400 with a single human-readable error message. On success
// replaces req[key] with the parsed+stripped data.
function validate(schema, key = 'body') {
    return function (req, res, next) {
        const result = schema.safeParse(req[key] || {});
        if (!result.success) {
            const first = result.error.errors[0] || {};
            const path  = (first.path || []).join('.') || 'input';
            const msg   = first.message || 'invalid input';
            return res.status(400).json({ ok: false, error: `${path}: ${msg}` });
        }
        req[key] = result.data;
        next();
    };
}

module.exports = {
    validate,
    schemas: {
        login:          loginSchema,
        createUser:     createUserSchema,
        updateUser:     updateUserSchema,
        changePassword: changePasswordSchema,
        setBalance:     setBalanceSchema,
        createProject:  createProjectSchema,
        updateProject:  updateProjectSchema,
        topup:          topupSchema,
        dailyCap:       dailyCapSchema,
        chat:           chatSchema,
        historyAdd:     historyAddSchema,
        sessionCreate:  sessionCreateSchema,
        sessionUpdate:  sessionUpdateSchema,
    },
};
