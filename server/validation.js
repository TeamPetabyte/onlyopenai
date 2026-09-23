// Central request validation (zod). Schemas use zod's default .strip(), so unknown fields
// (role, is_deleted, admin_api_key, …) never reach a route — the mass-assignment guard.

const { z } = require('zod');

const MAX_BALANCE = parseFloat(process.env.MAX_BALANCE) || 1000000;

const username   = z.string().trim().min(1).max(64);
const password   = z.string().min(1).max(128);       // strength check is a separate helper
const displayStr = z.string().trim().max(128);       // used for name/surname/displayName
const longText   = z.string().max(1024);             // description etc.
const projectId  = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/,
    'projectId must be alphanumeric/_/-');
// 'trainer' (superadmin) is deliberately not accepted; superadmins are provisioned by SQL only.
const roleEnum   = z.enum(['admin', 'user']);

// Numbers may arrive as strings from HTML forms — coerce then clamp.
const amount     = z.coerce.number().finite()
    .min(0, 'amount must be >= 0').max(MAX_BALANCE, `amount must be <= ${MAX_BALANCE}`);
const amountPos  = z.coerce.number().finite()
    .gt(0, 'amount must be > 0').max(MAX_BALANCE, `amount must be <= ${MAX_BALANCE}`);
const rate       = z.coerce.number().finite()
    .min(0, 'rate must be >= 0').max(10000, 'rate too large');

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
    balance:     amount.optional(),                  // legacy; dailyCap is the live limit
    // null / omitted = no cap (bounded only by the project pool)
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
    // required by the route for a self-change; optional here because an admin reset does not send it
    currentPassword: z.string().max(200).optional(),
});

const setBalanceSchema = z.object({
    balance: amount,
});

const createProjectSchema = z.object({
    name:        z.string().trim().min(1).max(128),
    projectId:   projectId.optional(),
    // 256: real OpenAI keys (sk-svcacct-…, sk-proj-…) are ~167 chars
    apiKey:      z.string().trim().max(256).optional(),
    description: longText.optional(),
    inputRate:   rate.optional(),
    outputRate:  rate.optional(),
    creditLimit: amount.optional(),
});

const updateProjectSchema = z.object({
    name:        z.string().trim().min(1).max(128).optional(),
    // null clears the stored key; 256 fits real OpenAI keys (~167 chars)
    apiKey:      z.union([z.string().trim().max(256), z.null()]).optional(),
    credits:     amount.optional(),
    description: longText.optional(),
    inputRate:   rate.optional(),
    outputRate:  rate.optional(),
    creditLimit: amount.optional(),
    targetRelease: z.enum(Object.keys(require('./lib/prompt').TARGET_RELEASES)).optional(),
});

const topupSchema = z.object({
    amount: amountPos,
    // admin note; stored in tbl_topup_project.note, mirrored to tbl_action_admin.extra.note
    note:   z.string().trim().max(500).optional(),
});

// Daily cap; null or missing clears it.
const dailyCapSchema = z.object({
    dailyCap: z.coerce.number().finite()
        .min(0, 'dailyCap must be >= 0')
        .max(MAX_BALANCE, `dailyCap must be <= ${MAX_BALANCE}`)
        .nullable().optional(),
});

// systemPrompt/inputRate/outputRate/cachedInputRate ตั้งใจไม่อยู่ในนี้: prompt มาจาก tbl_prompt
// และราคามาจาก tbl_pricing เท่านั้น — .strip() จะทิ้งค่าที่ client ส่งมาทับ
const chatSchema = z.object({
    message:   z.string().max(100000).optional(),
    prompt:    z.string().max(100000).optional(),
    threadId:  z.string().max(128).optional(),
    sessionId: z.coerce.number().int().positive().optional(),
    skillId:   z.string().trim().max(64).optional(),
    model:     z.string().trim().max(64).optional(),
    effort:    z.string().trim().max(16).optional(),
    useRouter: z.coerce.boolean().optional(),
    regenerate: z.boolean().optional(),   // replace the session's last turn instead of appending
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

// Validates req[key] against the schema: 400 with one readable message on failure,
// req[key] replaced by the parsed+stripped data on success.
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
