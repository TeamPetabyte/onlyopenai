// skill-runner.js — รัน prompt หนึ่ง skill หนึ่งคำถาม (Prompt Lab + evals ใช้ร่วมกัน)
const { PROMPT_COMMON_APPENDIX, applyCodePlaceholder, orgStandardsBlock } = require('../../lib/prompt');

module.exports = function createSkillRunner({ ai, tools }) {
const { openai, resolveModel, resolveEffort, PHASE4_TOOLS } = ai;
const { getOrgStandards, buildPreAnalysis, runResponsesTurn, executeTool } = tools;
// Phase 30 (eval harness): shared one-shot prompt runner. Applies the {code}
// placeholder convention, resolves the model/effort against the allowlist and
// routes to the right API path (Responses for gpt-5.6, Chat Completions
// otherwise, with a short tool loop). Used by BOTH the admin test endpoint
// and the eval batch runner so an exam answers exactly like a live test.
async function runSkillPromptOnce({ userId, skillContent, question, model, effort }) {
    // Phase 36: shared {code} handling — substitutes only when the message
    // actually looks like ABAP, so plain questions get answered directly.
    let { systemPrompt, userPrompt } = applyCodePlaceholder(skillContent, question);
    // Phase 35.1: same appendix as live chat — Lab/eval answers must be
    // collected under identical conditions to be usable as a baseline.
    // Phase 42: including the pre-fetched org standards, for the same reason.
    systemPrompt += PROMPT_COMMON_APPENDIX;
    systemPrompt += orgStandardsBlock(await getOrgStandards());
    systemPrompt += await buildPreAnalysis(question);

    const { model: reqModel, path: modelPath } = resolveModel(model);
    const reqEffort = resolveEffort(effort);
    const chatTools = PHASE4_TOOLS.filter(t => t.type === 'function');

    let inputTokens = 0, outputTokens = 0, answer = '';
    if (modelPath === 'responses') {
        const acc = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, fullText: '' };
        await runResponsesTurn({
            oai: openai, userId, model: reqModel, effort: reqEffort,
            instructions: systemPrompt, userPrompt, tools: chatTools,
            sendEvent: () => {}, acc, isAborted: () => false, setStream: () => {},
        });
        answer = acc.fullText; inputTokens = acc.inputTokens; outputTokens = acc.outputTokens;
    } else {
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt },
        ];
        // Phase 35.1: 3 turns matches live chat's MAX_TOOL_TURNS. On the last
        // turn tools are disabled so a tool-happy exchange (e.g. find_bapi →
        // search_knowledge) can never run out of turns and return ''.
        const MAX_TEST_TOOL_TURNS = 3;
        for (let turn = 0; turn < MAX_TEST_TOOL_TURNS; turn++) {
            const lastTurn   = turn === MAX_TEST_TOOL_TURNS - 1;
            const completion = await openai.chat.completions.create({
                model: reqModel,
                stream: false,
                max_completion_tokens: 3000,
                messages,
                tools: chatTools,
                tool_choice: lastTurn ? 'none' : 'auto',
            });
            const choice = completion.choices[0];
            const usage  = completion.usage || {};
            inputTokens  += usage.prompt_tokens     || 0;
            outputTokens += usage.completion_tokens || 0;

            if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls?.length) {
                messages.push(choice.message);
                for (const tc of choice.message.tool_calls) {
                    const args   = JSON.parse(tc.function.arguments || '{}');
                    const result = await executeTool(tc.function.name, args);
                    messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
                }
                continue;
            }
            answer = choice.message.content || '';
            break;
        }
    }
    return { answer, inputTokens, outputTokens, model: reqModel, effort: reqEffort };
}

return { runSkillPromptOnce };
};
