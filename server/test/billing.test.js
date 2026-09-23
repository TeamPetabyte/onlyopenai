// billing.test.js — the daily-cap gate with approved bonus quota.

const test = require('node:test');
const assert = require('node:assert');
const createBilling = require('../services/billing');

// fake pool: project pool ฿1000, then spent today, then cap row
function billingWith({ spent, base, bonus }) {
    return createBilling({ pool: { query: async (sql) => {
        if (/FROM tbl_daily_usage/.test(sql)) return { rows: [{ spent }] };
        if (/daily_cap AS base/.test(sql))    return { rowCount: 1, rows: [{ base, bonus }] };
        if (/FROM tbl_balance/.test(sql))     return { rowCount: 1, rows: [{ pool: 1000 }] };
        return { rowCount: 1, rows: [{ project_id: 'p1' }] };
    } } });
}

test('cap ฿100 + bonus ฿50: at ฿125 spent (฿25 bonus left) the user can still chat', async () => {
    const r = await billingWith({ spent: 125, base: 100, bonus: 25 }).checkChatBudget(1);
    assert.equal(r.ok, true);
    assert.equal(r.cap.effective, 150);
});

test('cap ฿100 + bonus ฿50: blocked once the bonus is used up at ฿150', async () => {
    const r = await billingWith({ spent: 150, base: 100, bonus: 0 }).checkChatBudget(1);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'daily_cap_exceeded');
});

test('under the base cap, bonus adds on top', async () => {
    const r = await billingWith({ spent: 40, base: 100, bonus: 50 }).checkChatBudget(1);
    assert.equal(r.ok, true);
    assert.equal(r.cap.effective, 150);
});
