// responses-turn.test.js — การร้อย context ของ Responses API เมื่อไม่ให้ OpenAI เก็บบทสนทนา
//
// store:false แปลว่าไม่มี state ฝั่งผู้ให้บริการให้อ้างถึง ทุก call จึงต้องพก
// reasoning + function_call ของ turn ก่อนหน้ามาเอง พลาดตรงนี้แล้วโมเดลลืมว่าเพิ่งเรียก tool อะไร
// (และเคยแก้ด้วย previous_response_id ซึ่งบังคับให้ต้อง store:true)
// ทดสอบด้วย client ปลอม — ไม่มีการต่อเน็ตและไม่มีค่าใช้จ่าย

const test = require('node:test');
const assert = require('node:assert');
const createAiTools = require('../services/ai/tools');

const { runResponsesTurn } = createAiTools({
    ai: {
        HAS_API_KEY: true,
        openai: null,
        getVectorStoreId: () => null,
        markProjectKeyInvalid: async () => null,
        KNOWLEDGE_DIR: __dirname,
    },
});

function streamOf(events) {
    return { async *[Symbol.asyncIterator]() { for (const ev of events) yield ev; } };
}

/** client ปลอมที่บันทึก args ของทุก call ไว้ให้ตรวจ */
function fakeClient(turns) {
    const seen = [];
    return {
        seen,
        responses: {
            create: async (args) => {
                seen.push(structuredClone(args));
                return streamOf(turns[seen.length - 1] || []);
            },
        },
    };
}

const TOOL_CALL_ITEM = {
    type: 'function_call', id: 'fc_1', call_id: 'call_1',
    name: 'no_such_tool', arguments: '{"q":"x"}',
};

// turn 1: โมเดลขอเรียก tool | turn 2: ตอบเป็นข้อความ
const TURNS = [
    [
        { type: 'response.output_item.added', item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'no_such_tool' } },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"q":"x"}' },
        { type: 'response.completed', response: {
            id: 'resp_1', usage: { input_tokens: 100, output_tokens: 20 },
            output: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'enc' }, TOOL_CALL_ITEM] } },
    ],
    [
        { type: 'response.output_text.delta', delta: 'คำตอบสุดท้าย' },
        { type: 'response.completed', response: {
            id: 'resp_2', usage: { input_tokens: 250, output_tokens: 40 },
            output: [{ type: 'message', id: 'msg_1' }] } },
    ],
];

async function run(turns = TURNS, opts = {}) {
    const oai = fakeClient(turns);
    const acc = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, fullText: '' };
    const events = [];
    await runResponsesTurn({
        oai, userId: 1, model: 'gpt-5.6-sol', effort: 'medium',
        instructions: 'SYSTEM PROMPT', userPrompt: 'ช่วยดูโค้ดนี้',
        history: opts.history || [], tools: [],
        sendEvent: (e) => events.push(e), acc,
        isAborted: () => false, setStream: () => {},
    });
    return { calls: oai.seen, acc, events };
}

test('responses turn: ไม่ขอให้ OpenAI เก็บบทสนทนา และไม่อ้าง previous_response_id', async () => {
    const { calls } = await run();
    assert.equal(calls.length, 2);
    for (const c of calls) {
        assert.equal(c.store, false, 'ทุก call ต้อง store:false');
        assert.equal(c.previous_response_id, undefined, 'ห้ามอ้าง state ฝั่งผู้ให้บริการ');
        assert.deepEqual(c.include, ['reasoning.encrypted_content']);
        assert.equal(c.instructions, 'SYSTEM PROMPT', 'system prompt ต้องส่งใหม่ทุก call');
    }
});

test('responses turn: turn ถัดไปพก reasoning, function_call และผลของ tool ไปเอง', async () => {
    const { calls } = await run();
    const first = calls[0].input;
    assert.deepEqual(first, [{ role: 'user', content: 'ช่วยดูโค้ดนี้' }]);

    const second = calls[1].input;
    const types = second.map(i => i.type || `role:${i.role}`);
    assert.deepEqual(types, ['role:user', 'reasoning', 'function_call', 'function_call_output']);
    assert.equal(second[2].call_id, 'call_1');
    assert.equal(second[3].call_id, 'call_1');
    assert.match(second[3].output, /Unknown tool/);
});

test('responses turn: ประวัติของห้องแชทถูกส่งไปก่อนข้อความล่าสุด', async () => {
    const { calls } = await run(TURNS, { history: [
        { role: 'user', content: 'คำถามก่อนหน้า' },
        { role: 'assistant', content: 'คำตอบก่อนหน้า' },
    ] });
    assert.deepEqual(calls[0].input.map(i => i.content),
        ['คำถามก่อนหน้า', 'คำตอบก่อนหน้า', 'ช่วยดูโค้ดนี้']);
});

test('responses turn: usage รวมจากทุก call — ไม่ใช่แค่ call สุดท้าย', async () => {
    const { acc } = await run();
    assert.equal(acc.inputTokens, 350);
    assert.equal(acc.outputTokens, 60);
    assert.equal(acc.fullText, 'คำตอบสุดท้าย');
    assert.equal(acc.apiCalls, 2);
});

test('responses turn: คำตอบที่ถูกตัดจะขอต่อโดยยังพก context เดิมไว้', async () => {
    const truncated = [
        [
            { type: 'response.output_text.delta', delta: 'ครึ่งแรก' },
            { type: 'response.incomplete', response: {
                id: 'resp_1', usage: { input_tokens: 10, output_tokens: 5 },
                incomplete_details: { reason: 'max_output_tokens' },
                output: [{ type: 'message', id: 'msg_1' }] } },
        ],
        [
            { type: 'response.output_text.delta', delta: 'ครึ่งหลัง' },
            { type: 'response.completed', response: { id: 'resp_2', usage: { input_tokens: 12, output_tokens: 6 }, output: [] } },
        ],
    ];
    const { calls, acc } = await run(truncated);
    assert.equal(acc.fullText, 'ครึ่งแรกครึ่งหลัง');
    const second = calls[1].input;
    assert.equal(second.length, 3, 'user เดิม + message ที่ถูกตัด + คำสั่งให้เขียนต่อ');
    assert.match(second[2].content, /Continue exactly where you left off/);
});
