// chat.js — POST /api/chat — SSE streaming + คิดเงินใน transaction เดียว
const express = require('express');

module.exports = function (ctx) {
const router = express.Router();
const crypto = require('crypto');
const {
    applyCodePlaceholder,
    buildPreAnalysis,
    chatRateLimiter,
    checkChatBudget,
    executeTool,
    getActivePricing,
    getOrgStandards,
    getProjectOpenAI,
    HAS_API_KEY,
    isTempUnsupported,
    markProjectKeyInvalid,
    markTempUnsupported,
    MAX_SUPPORTING_SKILLS,
    OAI_TEMPERATURE,
    openai,
    orgStandardsBlock,
    PHASE4_TOOLS,
    pickSkillFromCatalog,
    pool,
    PROMPT_COMMON_APPENDIX,
    targetReleaseBlock,
    ragQueryOf,
    ragResultEvent,
    requireAuth,
    resolveEffort,
    resolveModel,
    runResponsesTurn,
    safeError,
    schemas,
    skillPrompts,
    skillsForCode,
    supportingKnowledgeBlock,
    validate,
} = ctx;
router.post('/api/chat', requireAuth, chatRateLimiter, validate(schemas.chat), async (req, res) => {
    if (!HAS_API_KEY) { res.json({ ok: false, useMock: true, reason: 'no_api_key' }); return; }

    // prompt มาจาก tbl_prompt, ราคาจาก tbl_pricing — ไม่รับจาก body
    const { prompt, useRouter = true, sessionId, skillId, model: bodyModel, effort: bodyEffort, regenerate } = req.body;
    if (!prompt) { res.status(400).json({ ok: false, error: 'prompt required' }); return; }

    // เกตเดียวเช็ค pool + daily cap (error code แยกให้ UI); fail-closed —
    // เช็คงบไม่ได้ต้องไม่เรียกโมเดล เพราะ OpenAI คิดเงินเราไปแล้ว
    try {
        const uid = req.session?.userId;
        if (uid) {
            const gate = await checkChatBudget(uid);
            if (!gate.ok) {
                const status = gate.error === 'project_pool_empty' ? 402 : 429;
                return res.status(status).json({ ok: false, ...gate });
            }
        }
    } catch (e) {
        console.error('[chat] budget gate failed — refusing the turn (fail-closed):', e.message);
        return res.status(503).json({ ok: false, error: 'budget_check_unavailable',
            message: '⚠️ ตรวจสอบเครดิตไม่ได้ชั่วคราว กรุณาลองใหม่ในอีกสักครู่' });
    }

    // มี sessionId = เช็คเจ้าของก่อน stream (กัน 401 กลาง SSE); ไม่มี = สร้างใหม่ผูก userId
    let chatSessionId = null;
    try {
        const uid = req.session && req.session.userId;
        if (uid) {
            if (sessionId) {
                const n = Number(sessionId);
                if (!Number.isInteger(n) || n <= 0) {
                    return res.status(400).json({ ok: false, error: 'Invalid sessionId' });
                }
                const own = await pool.query(
                    `SELECT user_id, is_deleted FROM tbl_chat_session WHERE session_id=$1`, [n]);
                const row = own.rows[0];
                if (!row || row.is_deleted || row.user_id !== uid) {
                    return res.status(404).json({ ok: false, error: 'Session not found' });
                }
                chatSessionId = n;
                if (regenerate) {
                    // drop the turn being redone, so it's neither replayed as history nor stored twice
                    // (its billing row in tbl_response stays)
                    const del = await pool.query(
                        `DELETE FROM tbl_chat_message
                          WHERE session_id = $1
                            AND message_id >= (SELECT MAX(message_id) FROM tbl_chat_message
                                                WHERE session_id = $1 AND role = 'user')`, [n]);
                    if (del.rowCount) {
                        await pool.query(
                            `UPDATE tbl_chat_session SET message_count = GREATEST(0, message_count - $1)
                              WHERE session_id = $2`, [del.rowCount, n]);
                    }
                }
            } else {
                const title = String(prompt).replace(/\s+/g, ' ').trim().slice(0, 60) || 'New chat';
                const ins = await pool.query(
                    `INSERT INTO tbl_chat_session (user_id, title)
                     VALUES ($1, $2) RETURNING session_id`,
                    [uid, title]);
                chatSessionId = ins.rows[0].session_id;
            }
        }
    } catch (sessErr) {
        // A session-setup failure must not block the chat; log and continue unpersisted.
        console.warn('[chat] session setup skipped:', sessErr.message);
    }

    // replay turn ก่อนหน้าเข้า context ไม่งั้นแชทจำอะไรไม่ได้
    let chatHistory = [];
    if (chatSessionId && sessionId) {   // existing session only — a fresh one has no past
        try {
            const HIST_MAX_MSGS  = 12;
            const HIST_MAX_CHARS = 24000;   // ~6k tokens of replayed context
            const h = await pool.query(
                `SELECT role, content FROM tbl_chat_message
                  WHERE session_id=$1 AND role IN ('user','assistant')
                  ORDER BY message_id DESC LIMIT $2`, [chatSessionId, HIST_MAX_MSGS]);
            let used = 0;
            for (const m of h.rows) {                 // newest → oldest
                const text = String(m.content || '');
                if (chatHistory.length && used + text.length > HIST_MAX_CHARS) break;
                chatHistory.push({ role: m.role, content: text.slice(0, HIST_MAX_CHARS) });
                used += text.length;
            }
            chatHistory.reverse();                    // chronological for the model
        } catch (e) {
            console.warn('[chat] history load skipped:', e.message);
        }
    }

    res.setHeader('Content-Type', 'text/event-stream');
    // no-transform + X-Accel-Buffering:no — กัน proxy/tunnel บัฟเฟอร์ stream
    res.setHeader('Cache-Control', 'no-store, no-transform');   // per-user payload; no shared cache
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    // heartbeat ทุก 15s กัน hop ระหว่างทางตัดสายตอนโมเดลคิดนาน; parser ฝั่งเว็บข้ามบรรทัด ':'
    const sseHeartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch (_) { /* connection gone */ }
    }, 15000);
    res.on('close', () => clearInterval(sseHeartbeat));

    const sendEvent = (data) => {
        // Client may already be gone (Stop); writing then throws.
        if (res.writableEnded) return;
        try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (_) {}
    };
    // a new chat's id goes out first — a Stop before `done` would otherwise lose it
    if (chatSessionId && !sessionId) sendEvent({ type: 'session', sessionId: chatSessionId });
    const startTime = Date.now();
    let inputTokens = 0, outputTokens = 0, cachedTokens = 0, reasoningTokens = 0, fullText = '';
    // Responses path only; stays 0 on Chat Completions.
    let apiCalls = 0, toolTurns = 0, continuations = 0;

    // Stop = abort ฝั่ง OpenAI ทันที แต่ persist สิ่งที่ได้มาแล้ว
    let clientAborted = false;
    let currentOpenAIStream = null;
    // ฟังทั้ง res/req close — req อย่างเดียวพลาดได้บน keep-alive
    const onClientGone = () => {
        if (clientAborted) return;
        if (res.writableEnded) return;
        clientAborted = true;
        console.log(`[chat] client aborted mid-stream (outTokens so far=${outputTokens}, fullText=${fullText.length} chars)`);
        if (currentOpenAIStream?.controller?.abort) {
            try { currentOpenAIStream.controller.abort(); } catch (_) {}
        }
    };
    res.on('close', onClientGone);
    req.on('close', onClientGone);
    req.on('aborted', onClientGone);

    try {
        // --- Step 1: intent detection (router) ---
        let detectedSkill = null;
        let supportingSkillIds = [];
        // skill ที่ client เลือกถูก resolve จาก catalog ฝั่ง server — ไม่รับเนื้อ prompt จาก body
        const pickedSkill = (skillId && skillId !== 'auto') ? skillPrompts.getSkill(skillId) : null;
        let finalSystemPrompt = pickedSkill?.content || 'คุณเป็น AI assistant ที่ช่วยงาน SAP ABAP';
        let finalUserPrompt   = prompt;
        if (pickedSkill) {
            detectedSkill = { skillId: pickedSkill.id, label: pickedSkill.name || pickedSkill.id,
                              intent: 'manual', confidence: 1, reason: 'user picked', source: 'manual' };
        }

        // resolve client ของ project ครั้งเดียว — router กับ main call ใช้ key เดียวกัน
        const oai = await getProjectOpenAI(req.session.userId);

        // auto-mode = ไม่ได้ระบุ skill หรือระบุมาแล้วหาไม่เจอใน catalog
        const isAutoMode = !pickedSkill;
        if (useRouter && isAutoMode) {
            // router เลือกจาก catalog — ส่ง history ด้วย ไม่งั้น follow-up สั้น ๆ ได้ "none"
            const catalogPick = await pickSkillFromCatalog(prompt, oai, chatHistory);
            if (catalogPick.skillId && catalogPick.content) {
                detectedSkill = {
                    skillId:    catalogPick.skillId,
                    label:      catalogPick.label,
                    intent:     'catalog',
                    confidence: catalogPick.confidence,
                    reason:     catalogPick.reason,
                    source:     catalogPick.source,
                };
                finalSystemPrompt = catalogPick.content;
            } else {
                detectedSkill = {
                    skillId:    null,
                    label:      'General',
                    intent:     'general',
                    confidence: catalogPick.confidence,
                    reason:     catalogPick.reason,
                    source:     catalogPick.source,
                };
            }
            // source = วิธีที่เลือก (llm/code-shape/catch-all) โชว์บน UI; skill รองส่งความรู้ร่วม
            supportingSkillIds = skillsForCode(prompt)
                .filter(id => id !== detectedSkill.skillId)
                .slice(0, MAX_SUPPORTING_SKILLS);
            sendEvent({ type: 'routed', skillId: detectedSkill.skillId, skillLabel: detectedSkill.label, intent: detectedSkill.intent, confidence: detectedSkill.confidence, source: detectedSkill.source, supporting: supportingSkillIds });
        }

        // --- Step 2: {code} placeholder (only when the message is code) ---
        const cp = applyCodePlaceholder(finalSystemPrompt, prompt);
        finalSystemPrompt = cp.systemPrompt;
        finalUserPrompt   = cp.userPrompt;

        // appendix กลาง — ชุดเดียวกับ Lab/eval
        finalSystemPrompt += PROMPT_COMMON_APPENDIX;
        // org standards จาก cache — ไม่ยิง tool round trip ทุกคำตอบ
        finalSystemPrompt += orgStandardsBlock(await getOrgStandards());
        // release the generated code must compile on — set per project by the admin (phase59-001)
        const relRow = await pool.query(
            `SELECT p.target_release FROM tbl_user u JOIN tbl_project p ON p.project_id = u.project_id
              WHERE u.user_id = $1`, [req.session.userId]);
        const targetRelease = relRow.rows[0]?.target_release;
        finalSystemPrompt += targetReleaseBlock(targetRelease);
        // ความรู้ skill รองต่อท้าย org standards — เอกสารองค์กรชนะเสมอ
        finalSystemPrompt += supportingKnowledgeBlock(supportingSkillIds);
        // static scan + matching documents up front, so the model spends its budget on judgement.
        finalSystemPrompt += await buildPreAnalysis(prompt, targetRelease);

        // function tools เท่านั้น — file_search ใช้กับ Chat Completions ไม่ได้ (RAG ผ่าน search_knowledge)
        const chatTools = PHASE4_TOOLS.filter(t => t.type === 'function');

        // gpt-5.6 → Responses API, ที่เหลือ → Chat Completions
        const { model: reqModel, path: modelPath } = resolveModel(bodyModel);
        const reqEffort = resolveEffort(bodyEffort);
        const acc = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, fullText: '' };

        // a failure after OpenAI already charged (tool call 2 times out, a later stream dies)
        // still bills and saves what was used; only a failure before any usage takes the error path
        let turnErr = null;
        try {
            if (modelPath === 'responses') {
                await runResponsesTurn({
                    oai, userId: req.session.userId, model: reqModel, effort: reqEffort,
                    instructions: finalSystemPrompt, userPrompt: finalUserPrompt,
                    history: chatHistory,   // replay this session's prior turns
                    tools: chatTools, sendEvent, acc,
                    isAborted: () => clientAborted,
                    setStream: (s) => { currentOpenAIStream = s; },
                    release: targetRelease,
                });
                inputTokens = acc.inputTokens; outputTokens = acc.outputTokens;
                cachedTokens = acc.cachedTokens; reasoningTokens = acc.reasoningTokens;
                fullText = acc.fullText;
                apiCalls = acc.apiCalls || 0; toolTurns = acc.toolTurns || 0;
                continuations = acc.continuations || 0;
            } else {

            const messages = [
                { role: 'system', content: finalSystemPrompt },
                ...chatHistory,   // replay this session's prior turns
                { role: 'user',   content: finalUserPrompt },
            ];

            const MAX_TOOL_TURNS = 3;
            // โดนตัดด้วย token cap → ให้เขียนต่ออัตโนมัติ — cap แยกจาก tool-turn budget
            const MAX_LENGTH_CONTINUATIONS = 4;
            let lastFinishReason = null;
            let lengthContinuations = 0;
            let toolTurn = 0;
            while (toolTurn < MAX_TOOL_TURNS) {
                if (clientAborted) break;
                const streamArgs = {
                    model: reqModel, stream: true, max_completion_tokens: 3000,
                    // ไม่มีบรรทัดนี้ chunk.usage เป็น null แล้วเงินถูกคิดจาก ตัวอักษร/3.5
                    stream_options: { include_usage: true },
                    messages,
                    tools:        chatTools,
                    tool_choice:  'auto',
                };
                // Only send temperature for models that accept a custom value.
                if (OAI_TEMPERATURE !== null && !isTempUnsupported()) {
                    streamArgs.temperature = OAI_TEMPERATURE;
                }
                // 401 from project key → fall back to global key; drop temperature if the model rejects it.
                let stream;
                try {
                    stream = await oai.chat.completions.create(streamArgs);
                } catch (e) {
                    if ((e?.status === 400) && /temperature/i.test(e?.message || '') && ('temperature' in streamArgs)) {
                        markTempUnsupported();                   // stop sending it next time
                        delete streamArgs.temperature;
                        console.warn(`[chat] model ${reqModel} rejects custom temperature — retrying without it`);
                        stream = await oai.chat.completions.create(streamArgs);
                    } else if ((e?.status === 401) && oai !== openai && openai) {
                        await markProjectKeyInvalid(req.session.userId, 'chat stream 401');
                        console.warn('[chat] stream: project key 401 — retrying with global');
                        stream = await openai.chat.completions.create(streamArgs);
                    } else {
                        throw e;
                    }
                }
                currentOpenAIStream = stream;

                let pendingToolCalls = [];
                let finishReason    = null;
                let turnText        = '';   // this API call's text only (for continuation re-prompts)

                try {
                    for await (const chunk of stream) {
                        if (clientAborted) break;
                        const delta = chunk.choices[0]?.delta;
                        finishReason = chunk.choices[0]?.finish_reason || finishReason;

                        if (delta?.content) {
                            fullText += delta.content;
                            turnText += delta.content;
                            sendEvent({ type: 'chunk', text: delta.content });
                        }

                        if (delta?.tool_calls) {
                            for (const tc of delta.tool_calls) {
                                const idx = tc.index ?? 0;
                                if (!pendingToolCalls[idx]) pendingToolCalls[idx] = { id: '', function: { name: '', arguments: '' } };
                                if (tc.id)                     pendingToolCalls[idx].id                    += tc.id;
                                if (tc.function?.name)         pendingToolCalls[idx].function.name         += tc.function.name;
                                if (tc.function?.arguments)    pendingToolCalls[idx].function.arguments    += tc.function.arguments;
                            }
                        }

                        if (chunk.usage) {
                            inputTokens     += chunk.usage.prompt_tokens     || 0;
                            outputTokens    += chunk.usage.completion_tokens || 0;
                            cachedTokens    += chunk.usage.prompt_tokens_details?.cached_tokens         || 0;
                            reasoningTokens += chunk.usage.completion_tokens_details?.reasoning_tokens   || 0;
                        }
                    }
                } catch (streamErr) {
                    // APIUserAbortError on controller.abort() is a clean user Stop, not a failure.
                    if (clientAborted) break;
                    throw streamErr;
                } finally {
                    currentOpenAIStream = null;
                }
                lastFinishReason = finishReason;

                // User stopped mid-stream → don't loop into another tool turn
                if (clientAborted) break;

                // finish=length → ต่อได้ไม่เกิน MAX_LENGTH_CONTINUATIONS
                if (finishReason === 'length' && lengthContinuations < MAX_LENGTH_CONTINUATIONS) {
                    lengthContinuations++;
                    console.warn(`[chat] response truncated (length) — continuing (${lengthContinuations}/${MAX_LENGTH_CONTINUATIONS})`);
                    messages.push({ role: 'assistant', content: turnText });
                    messages.push({ role: 'user', content: 'Continue exactly where you left off. Do not repeat any earlier text or restart the file.' });
                    continue;
                }

                // ถ้าไม่มี tool calls → จบ
                if (finishReason !== 'tool_calls' || pendingToolCalls.length === 0) break;

                // tool calls → execute and loop; attach the search query for the UI badge
                const rQuery = pendingToolCalls.map(tc => ragQueryOf(tc.function.name, tc.function.arguments)).find(q => q != null);
                sendEvent({ type: 'tool_call', tools: pendingToolCalls.map(tc => tc.function.name), ...(rQuery != null ? { search: { query: rQuery } } : {}) });

                messages.push({
                    role:       'assistant',
                    tool_calls: pendingToolCalls.map(tc => ({
                        id: tc.id, type: 'function',
                        function: { name: tc.function.name, arguments: tc.function.arguments },
                    })),
                });

                for (const tc of pendingToolCalls) {
                    // โมเดลส่ง arguments พังได้ — throw ตรงนี้จะทิ้งทั้ง turn โดยไม่คิดเงิน
                    let args = {};
                    try { args = JSON.parse(tc.function.arguments || '{}'); }
                    catch (_) { console.warn('[chat] bad tool arguments from model for', tc.function.name); }
                    const result = await executeTool(tc.function.name, args, { release: targetRelease });
                    if (tc.function.name === 'search_knowledge') sendEvent(ragResultEvent(result));
                    messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
                }
                toolTurn++;
            }

            // ครบ tool turns แต่ยังไม่มีคำตอบ → ยิงปิดท้าย tool_choice:'none' กันหน้าเปล่า
            if (!clientAborted && fullText.length === 0 && lastFinishReason === 'tool_calls') {
                console.warn(`[chat] hit MAX_TOOL_TURNS (${MAX_TOOL_TURNS}) with no answer yet — forcing a final turn`);
                const finalArgs = {
                    model: reqModel, stream: true, max_completion_tokens: 3000,
                    stream_options: { include_usage: true },   // without it this turn is never billed
                    messages,
                    tools:       chatTools,
                    tool_choice: 'none',
                };
                if (OAI_TEMPERATURE !== null && !isTempUnsupported()) {
                    finalArgs.temperature = OAI_TEMPERATURE;
                }
                try {
                    let finalStream;
                    try {
                        finalStream = await oai.chat.completions.create(finalArgs);
                    } catch (e) {
                        if ((e?.status === 400) && /temperature/i.test(e?.message || '') && ('temperature' in finalArgs)) {
                            markTempUnsupported();
                            delete finalArgs.temperature;
                            finalStream = await oai.chat.completions.create(finalArgs);
                        } else {
                            throw e;
                        }
                    }
                    currentOpenAIStream = finalStream;
                    for await (const chunk of finalStream) {
                        if (clientAborted) break;
                        const delta = chunk.choices[0]?.delta;
                        if (delta?.content) {
                            fullText += delta.content;
                            sendEvent({ type: 'chunk', text: delta.content });
                        }
                        if (chunk.usage) {
                            inputTokens     += chunk.usage.prompt_tokens     || 0;
                            outputTokens    += chunk.usage.completion_tokens || 0;
                            cachedTokens    += chunk.usage.prompt_tokens_details?.cached_tokens         || 0;
                            reasoningTokens += chunk.usage.completion_tokens_details?.reasoning_tokens   || 0;
                        }
                    }
                } catch (finalErr) {
                    if (!clientAborted) console.error('[chat] forced final-turn call failed:', finalErr.message);
                } finally {
                    currentOpenAIStream = null;
                }
            }
            }   // end Chat Completions path
        } catch (e) {
            turnErr = e;
            if (modelPath === 'responses') {   // acc fills call by call, so it holds what was charged
                inputTokens = acc.inputTokens; outputTokens = acc.outputTokens;
                cachedTokens = acc.cachedTokens; reasoningTokens = acc.reasoningTokens;
                fullText = acc.fullText;
            }
            if (!inputTokens && !outputTokens && !fullText) throw e;
            console.error('[chat] turn failed mid-way, billing what was used:', e.message);
        }

        if (inputTokens === 0) {
            inputTokens  = Math.ceil((prompt.length + finalSystemPrompt.length) / 3.5);
            outputTokens = Math.ceil(fullText.length / 3.5);
        }

        const durationMs = Date.now() - startTime;
        // ราคาจาก tbl_pricing เท่านั้น; ไม่มีแถว = default ฝั่ง server (ห้ามรับ rate จาก body)
        const pricing = await getActivePricing(reqModel);
        const useInput  = pricing.inputPrice;
        const useOutput = pricing.outputPrice;
        const useCached = pricing.cachedPrice;
        const nonCachedInputTokens = Math.max(0, (inputTokens || 0) - (cachedTokens || 0));
        // clamp ที่ 0 — cost ติดลบจะกลายเป็นการเพิ่มเครดิตตอน UPDATE ... - $1
        const cost = Math.max(0, (nonCachedInputTokens / 1000) * useInput
                   + ((cachedTokens || 0) / 1000) * useCached
                   + ((outputTokens || 0) / 1000) * useOutput);
        // log model/effort/จำนวน call — แยก turn ช้าจาก turn เร็ว
        const callInfo = apiCalls
            ? ` | ${apiCalls} calls(${toolTurns} tool, ${continuations} cont)`
            : '';
        if (supportingSkillIds.length) {
            console.log(`[chat] skills: ${detectedSkill?.skillId || 'none'} + ${supportingSkillIds.join(', ')}`);
        }
        console.log(`[chat] [${reqModel}/${reqEffort}] ${detectedSkill ? `[${detectedSkill.skillId || detectedSkill.intent}${supportingSkillIds.length ? '+' + supportingSkillIds.length : ''}] ` : ''}${inputTokens}in(${cachedTokens} cached)/${outputTokens}out(${reasoningTokens} reasoning) | ฿${cost.toFixed(4)} | rates ${pricing.fromDb?'from tbl_pricing':'fallback'}${callInfo} | ${durationMs}ms`);

        // เขียนจาก req.session.userId ฝั่ง server — ห้ามพึ่ง client POST ตามหลัง
        const userId = req.session && req.session.userId;
        if (userId) {
            // ทุก write ที่แตะเงินอยู่ใน tx เดียว — ล้มก็ล้มด้วยกัน
            let client;
            try {
                client = await pool.connect();
                await client.query('BEGIN');

                const uRow = await client.query('SELECT project_id FROM tbl_user WHERE user_id=$1', [userId]);
                const projectId = uRow.rows[0]?.project_id || null;
                if (projectId) {
                    const responseId = crypto.randomBytes(16).toString('hex');
                    await client.query(`
                        INSERT INTO tbl_response
                            (response_id, project_id, user_id, model, created_at, input_param, output_param,
                             input_tokens, input_cached_tokens, output_tokens, output_reasoning_tokens, total_tokens)
                        VALUES ($1,$2,$3,$4,NOW(),$5,$6,$7,$8,$9,$10,$11)`,
                        [responseId, projectId, userId, reqModel,
                         prompt || '', fullText || '',
                         inputTokens || 0, cachedTokens || 0,
                         outputTokens || 0, reasoningTokens || 0,
                         (inputTokens || 0) + (outputTokens || 0)]);
                    // หักจาก PROJECT POOL แบบ atomic — WHERE >= cost คือตัวกันติดลบจริง
                    const dedRes = await client.query(
                        `UPDATE tbl_balance SET project_credits = project_credits - $1
                         WHERE project_id=$2 AND project_credits >= $1
                         RETURNING project_credits AS balance_after`,
                        [cost || 0, projectId]);
                    if (dedRes.rowCount === 0 && (cost || 0) > 0) {
                        // pool ไม่พอ (request ขนาน) — หักเท่าที่เหลือแล้วบันทึกส่วนขาด ให้ ledger กับ daily_usage ตรงกัน
                        const cur = await client.query(
                            'SELECT COALESCE(project_credits,0) AS bal FROM tbl_balance WHERE project_id=$1 FOR UPDATE',
                            [projectId]);
                        const balBefore = parseFloat(cur.rows[0]?.bal || 0);
                        const drained   = Math.max(0, Math.min(balBefore, Number(cost)));
                        const shortfall = Number(cost) - drained;
                        if (drained > 0) {
                            await client.query(
                                'UPDATE tbl_balance SET project_credits = project_credits - $1 WHERE project_id=$2',
                                [drained, projectId]);
                        }
                        console.warn(`[chat] ⚠ project pool insufficient — project:${projectId} cost:${cost} drained:${drained} shortfall:${shortfall}`);
                        await client.query('SAVEPOINT credit_short');
                        try {
                            await client.query(`
                                INSERT INTO tbl_user_credit_transaction
                                    (user_id, project_id, transaction_type, amount,
                                     balance_before, balance_after, ref_type, ref_id, note, created_by)
                                VALUES ($1, $2, 'usage', $3, $4, $5, 'chat_shortfall', $6, $7, NULL)`,
                                [userId, projectId, -drained, balBefore, balBefore - drained, chatSessionId,
                                 `cost ${Number(cost).toFixed(4)} but pool had ${balBefore.toFixed(4)} — shortfall ${shortfall.toFixed(4)}`]);
                            await client.query('RELEASE SAVEPOINT credit_short');
                        } catch (shortErr) {
                            await client.query('ROLLBACK TO SAVEPOINT credit_short').catch(() => {});
                            console.warn('[chat] shortfall log INSERT failed:', shortErr.message);
                        }
                    } else if (dedRes.rowCount === 1 && (cost || 0) > 0) {
                        // journal เฉพาะเมื่อหักสำเร็จและ cost > 0; ref_id ชี้กลับ session ให้ admin ตามรอยได้
                        const balAfter  = parseFloat(dedRes.rows[0].balance_after);
                        const balBefore = balAfter + Number(cost);
                        // journal พังต้องไม่ล้ม tx เงินจริง — SAVEPOINT แล้ว roll back เฉพาะตรงนี้
                        await client.query('SAVEPOINT credit_log');
                        try {
                            await client.query(`
                                INSERT INTO tbl_user_credit_transaction
                                    (user_id, project_id, transaction_type, amount,
                                     balance_before, balance_after,
                                     ref_type, ref_id, created_by)
                                VALUES ($1, $2, 'usage', $3, $4, $5, 'chat', $6, NULL)`,
                                [userId, projectId, -Number(cost),
                                 balBefore, balAfter, chatSessionId]);
                            await client.query('RELEASE SAVEPOINT credit_log');
                        } catch (logErr) {
                            await client.query('ROLLBACK TO SAVEPOINT credit_log').catch(() => {});
                            console.warn('[chat] credit log INSERT failed:', logErr.message);
                        }
                    }
                }

                // message อยู่ใน tx เดียวกับการหักเงิน — สองอย่างนี้ห้ามเห็นไม่ตรงกัน
                if (chatSessionId) {
                    const skillId = detectedSkill?.skillId || null;
                    // skill_id = ตัวที่ตอบ; skills_used = ทุกตัวที่ความรู้ถึงโมเดล (NULL เมื่อไม่มี)
                    const skillsUsed = [skillId, ...supportingSkillIds].filter(Boolean).join(',') || null;
                    {
                        await client.query(
                            `INSERT INTO tbl_chat_message
                                (session_id, role, content, input_tokens, output_tokens, cost, model, skill_id, skills_used)
                             VALUES ($1, 'user',      $2, NULL, NULL, NULL, NULL, $3, $4)`,
                            [chatSessionId, prompt || '', skillId, skillsUsed]);
                        await client.query(
                            `INSERT INTO tbl_chat_message
                                (session_id, role, content, input_tokens, output_tokens, cost, model, skill_id, duration_ms, skills_used)
                             VALUES ($1, 'assistant', $2, $3,   $4,   $5,   $6,  $7,  $8,  $9)`,
                            [chatSessionId, fullText || '',
                             inputTokens || null, outputTokens || null,
                             // durationMs persisted, else the badge shows 0.0s on reload
                             cost || null, reqModel, skillId, durationMs || null, skillsUsed]);
                        await client.query(
                            `UPDATE tbl_chat_session
                             SET message_count = message_count + 2,
                                 total_cost    = total_cost + $1,
                                 updated_at    = NOW()
                             WHERE session_id = $2`,
                            [cost || 0, chatSessionId]);

                        // rollup 1 แถวต่อ (วัน,user) — รายละเอียดต่อ model/session อยู่ใน tbl_chat_message
                        if (projectId) {
                            // วันตาม Asia/Bangkok จาก DB — เที่ยงคืนไทย ไม่ใช่ UTC
                            const dateRow = await client.query(
                                `SELECT (NOW() AT TIME ZONE 'Asia/Bangkok')::date AS d`);
                            const usageDate = dateRow.rows[0].d;
                            // cost ฝั่งเรา (จ่าย OpenAI) จากแถว pricing; ไม่มีแถว = 0 ห้ามล้มการเขียนแชท
                            const priceRow = await client.query(
                                `SELECT input_cost, output_cost, cached_cost
                                 FROM tbl_pricing
                                 WHERE model = $1
                                   AND effective_from <= NOW()
                                   AND (effective_to IS NULL OR effective_to > NOW())
                                 ORDER BY effective_from DESC LIMIT 1`,
                                [reqModel]);
                            const pr = priceRow.rows[0] || { input_cost: 0, output_cost: 0, cached_cost: 0 };
                            const inT = inputTokens || 0;
                            const outT = outputTokens || 0;
                            const cachedT = cachedTokens || 0;
                            const reasonT = reasoningTokens || 0;
                            const turnOpenAICost =
                                  ((inT - cachedT) / 1000) * Number(pr.input_cost  || 0)
                                + (cachedT          / 1000) * Number(pr.cached_cost || pr.input_cost || 0)
                                + (outT             / 1000) * Number(pr.output_cost || 0);

                            const upRes = await client.query(
                                `INSERT INTO tbl_daily_usage
                                    (usage_date, user_id, project_id,
                                     input_tokens, cached_tokens, output_tokens, reasoning_tokens,
                                     request_count, total_cost, total_price)
                                 VALUES ($1, $2, $3,
                                         $4, $5, $6, $7,
                                         1, $8, $9)
                                 ON CONFLICT (usage_date, user_id)
                                 DO UPDATE SET
                                     project_id       = EXCLUDED.project_id,
                                     input_tokens     = tbl_daily_usage.input_tokens     + EXCLUDED.input_tokens,
                                     cached_tokens    = tbl_daily_usage.cached_tokens    + EXCLUDED.cached_tokens,
                                     output_tokens    = tbl_daily_usage.output_tokens    + EXCLUDED.output_tokens,
                                     reasoning_tokens = tbl_daily_usage.reasoning_tokens + EXCLUDED.reasoning_tokens,
                                     request_count    = tbl_daily_usage.request_count    + 1,
                                     total_cost       = tbl_daily_usage.total_cost       + EXCLUDED.total_cost,
                                     total_price      = tbl_daily_usage.total_price      + EXCLUDED.total_price,
                                     last_updated_at  = NOW()
                                 RETURNING total_price AS spent_after`,
                                [usageDate, userId, projectId,
                                 inT, cachedT, outT, reasonT,
                                 turnOpenAICost, cost || 0]);

                            // bonus ลดเฉพาะส่วนที่เกิน cap ของ turn นี้ — ข้ามวันได้ถูกโดยไม่ต้องมี cron
                            const turnCost = Number(cost || 0);
                            if (turnCost > 0) {
                                const capRow = await client.query(
                                    `SELECT daily_cap, COALESCE(bonus_balance,0) AS bonus_balance
                                       FROM tbl_user WHERE user_id = $1`, [userId]);
                                const capVal = capRow.rows[0]?.daily_cap;
                                const curBonus = parseFloat(capRow.rows[0]?.bonus_balance) || 0;
                                // Only meaningful when a cap exists AND bonus remains.
                                if (capVal !== null && capVal !== undefined && curBonus > 0) {
                                    const base = parseFloat(capVal);
                                    const spentAfter  = parseFloat(upRes.rows[0].spent_after) || 0;
                                    const spentBefore = Math.max(0, spentAfter - turnCost);
                                    const overBefore = Math.max(0, spentBefore - base);
                                    const overAfter  = Math.max(0, spentAfter  - base);
                                    const consume = Math.min(curBonus, overAfter - overBefore);
                                    if (consume > 0) {
                                        await client.query(
                                            `UPDATE tbl_user
                                                SET bonus_balance = GREATEST(0, COALESCE(bonus_balance,0) - $1)
                                              WHERE user_id = $2`,
                                            [consume, userId]);
                                    }
                                }
                            }
                        }

                    }
                }

                await client.query('COMMIT');
            } catch (txErr) {
                if (client) await client.query('ROLLBACK').catch(() => {});
                console.error('[chat] persist failed:', txErr.message);
            } finally {
                if (client) client.release();
            }
        }

        if (turnErr) {
            const safe = safeError(turnErr, req);
            sendEvent({ type: 'error', error: safe.error, ref: safe.ref });
        } else {
            sendEvent({ type: 'done', inputTokens, outputTokens, cost, durationMs, detectedSkill, sessionId: chatSessionId, stopped: clientAborted });
        }
        if (!res.writableEnded) res.end();

    } catch (err) {
        console.error('[chat] Error:', err.message);
        if (err.status === 401 || err.status === 429) {
            // show the real cause — a fake MockAI answer here would look like a real one
            sendEvent({ type: 'error', error: err.status === 429
                ? 'OpenAI is rate-limiting or out of quota — try again shortly'
                : 'OpenAI rejected the API key — tell an admin' });
        } else {
            // ข้อความจาก SDK/pg บอกชื่อตาราง/พาธ — ส่งแค่ ref เหมือน route อื่น
            const safe = safeError(err, req);
            sendEvent({ type: 'error', error: safe.error, ref: safe.ref });
        }
        if (!res.writableEnded) res.end();
    }
});

return router;
};
