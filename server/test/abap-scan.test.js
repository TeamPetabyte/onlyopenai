// ╔═══════════════════════════════════════════════════════════╗
// ║  abap-scan.test.js — the rules that decide what the model  ║
// ║  is told about the user's code                             ║
// ╚═══════════════════════════════════════════════════════════╝
//
// Phase 47. Every case here comes from a defect that shipped and went
// unnoticed, because nothing in this project ever ran these functions with a
// deliberate input. They are pure functions of a string — there was never a
// reason they could not be checked, only no habit of doing it.
//
//   node --test server/test/
//
// The router is not cosmetic: picking the wrong skill means the model is
// handed the wrong knowledge, and the answer is wrong in a way no error
// message will ever report.

const test = require('node:test');
const assert = require('node:assert');
const scan = require('../lib/abap-scan');

// ── looksLikeAbapCode ─────────────────────────────────────
test('looksLikeAbapCode: real ABAP is code', () => {
    assert.equal(scan.looksLikeAbapCode('REPORT z.\nDATA x TYPE i.\nWRITE x.'), true);
});

test('looksLikeAbapCode: a wrapped English question is NOT code', () => {
    // Three lines and the word "data" — but a person asking, not a paste.
    // Treating it as code substitutes the question into the skill's
    // <ABAP_code> block and runs a static scan plus a RAG lookup over prose.
    assert.equal(scan.looksLikeAbapCode(
        'How do I select the right\ndata type for a currency\nfield in a class?'), false);
});

test('looksLikeAbapCode: short text is never code', () => {
    assert.equal(scan.looksLikeAbapCode('DATA x TYPE i.'), false);
    assert.equal(scan.looksLikeAbapCode(''), false);
});

// ── proseOf ───────────────────────────────────────────────
// The bare-paste fast path fires when proseOf() comes back empty: no words
// means no instruction to obey, so the code's shape may decide the skill.
// An instruction that gets eaten here is an instruction silently ignored.
test('proseOf: keeps an English instruction that starts with an ABAP keyword', () => {
    for (const ask of [
        'Create a unit test for this class.',
        'Write a unit test for this.',
        'Delete the commented code please.',
        'Check this program for performance.',
        'Read through this and tell me what is wrong.',
        'Generate a unit test for this.',
    ]) {
        const got = scan.proseOf(ask + '\nREPORT z.\nDATA x TYPE i.\nWRITE x.');
        assert.ok(got.includes(ask.split(' ')[0]),
            `instruction was eaten: ${JSON.stringify(ask)} → ${JSON.stringify(got)}`);
    }
});

test('proseOf: keeps a SHORT instruction that names no giveaway word', () => {
    // The first two attempts at this listed English words to reject. Both were
    // incomplete, and the second still ate "Create a unit test." and "Delete
    // unused variables." — the original defect — while passing its own test,
    // because the fixture happened to say "for this class". A blocklist of a
    // natural language cannot be finished; the rule now asks whether the line
    // carries a mark only ABAP has.
    for (const ask of [
        'Create a unit test.',
        'Delete unused variables.',
        'Check for performance issues.',
        'Read it carefully.',
        'Set up error handling.',
        'Move to new syntax.',
        'Write a summary of it.',
        'Do you see the problem?',
        'Do not use nested queries',
        'Select the right data type',
        'optimize and speed up',
        'Refactor into a class',
        'Convert from FORM to METHOD',
        'add error handling and logging',
    ]) {
        assert.notEqual(scan.proseOf(ask + '\nREPORT z.\nDATA x TYPE i.\nWRITE x.'), '',
            `instruction was eaten: ${JSON.stringify(ask)}`);
    }
});

test('looksLikeAbapCode: three English sentences are not a paste', () => {
    // Three lines of instruction, each opening with an ABAP keyword, were being
    // substituted into the skill's <ABAP_code> block and statically scanned.
    assert.equal(scan.looksLikeAbapCode(
        'Delete unused variables.\nCheck for performance issues.\nWrite a short summary.'), false);
});

test('proseOf: comma-less Open SQL is still code', () => {
    // Classic `SELECT a b c FROM t` — no commas, no underscores, no operators.
    // It is the syntax this product exists to modernise, so it cannot be read
    // as something the user typed.
    assert.equal(scan.proseOf(
        'REPORT z.\nSELECT carrid connid fldate bookid\n  FROM sbook\n  INTO TABLE gb.'), '');
});

test('hasSelectInsideLoop: a sentence beginning "Do" or "While" is not a loop', () => {
    // Anchoring to the line start was one level too shallow.
    assert.equal(scan.hasSelectInsideLoop(
        'Do you see the problem?\nSELECT * FROM mara INTO TABLE lt.'), false);
    assert.equal(scan.hasSelectInsideLoop(
        'While reviewing this note it\nSELECT * FROM mara INTO TABLE lt.'), false);
});

test('hasCommentedOutCode: a disabled statement may carry a trailing note', () => {
    // Two terminator rules disagreed: isStatementLine allows a trailing " note,
    // a second stricter test here rejected it. People annotate disabled code.
    assert.equal(scan.hasCommentedOutCode(
        '*DATA lv TYPE c. " old\n*PERFORM x. " disabled 2019\nWRITE 1.'), true);
});

test('proseOf: keeps a Thai instruction', () => {
    assert.ok(scan.proseOf('ช่วยดูโค้ดนี้ให้หน่อย\nREPORT z.\nDATA x TYPE i.').length > 0);
});

test('proseOf: a bare paste really is bare', () => {
    assert.equal(scan.proseOf('REPORT z.\nDATA x TYPE i.\nWRITE x.'), '');
});

test('proseOf: strips real statements even when they read like words', () => {
    // "DATA x TYPE i." is a statement; it ends in a period and has no prose.
    assert.equal(scan.proseOf('SELECT * FROM mara INTO TABLE lt.'), '');
});

test('proseOf: a real multi-line paste leaves nothing behind', () => {
    // The bare-paste fast path fires only when this is empty. Statement OPENERS
    // — `SELECT carrid connid`, `CALL FUNCTION 'Z_X'` — finish on a later line
    // and so carry no terminator; treating them as prose meant a genuinely bare
    // paste never took the fast path and always paid for a router call.
    const paste = [
        'REPORT ztest.',
        'SELECT carrid, connid',
        '  FROM sflight',
        '  INTO TABLE @gt',
        ' WHERE carrid IN @s_carrid.',
        "CALL FUNCTION 'Z_X'",
        '  EXPORTING',
        '    a = 1',
        '  IMPORTING',
        '    r = v.',
    ].join('\n');
    assert.equal(scan.proseOf(paste), '');
});

test('firstProseLine: finds the question, not the code', () => {
    assert.equal(
        scan.firstProseLine('REPORT z.\nDATA x TYPE i.\nช่วยแก้ SELECT ให้หน่อย\nWRITE x.'),
        'ช่วยแก้ SELECT ให้หน่อย');
    assert.equal(scan.firstProseLine('REPORT z.\nDATA x TYPE i.\nWRITE x.'), '');
});

// ── hasSelectInsideLoop ───────────────────────────────────
test('hasSelectInsideLoop: finds a SELECT in a LOOP', () => {
    assert.equal(scan.hasSelectInsideLoop(
        'LOOP AT lt INTO wa.\n  SELECT SINGLE a FROM t INTO v WHERE k = wa-k.\nENDLOOP.'), true);
});

test('hasSelectInsideLoop: finds a SELECT in a DO block', () => {
    assert.equal(scan.hasSelectInsideLoop(
        'DO 5 TIMES.\n  SELECT SINGLE a FROM t INTO v.\nENDDO.'), true);
});

test('hasSelectInsideLoop: the English word "do" is not a loop', () => {
    // skillsForCode runs on the WHOLE message, prose included. "please do this"
    // opened a loop that never closed, so every later SELECT looked nested.
    assert.equal(scan.hasSelectInsideLoop(
        'please do this fix\nREPORT z.\nSELECT * FROM mara INTO TABLE lt.'), false);
});

test('hasSelectInsideLoop: "while" inside a sentence is not a loop', () => {
    assert.equal(scan.hasSelectInsideLoop(
        'check this while you are at it\nREPORT z.\nSELECT * FROM mara INTO TABLE lt.'), false);
});

test('hasSelectInsideLoop: a SELECT outside the loop is not inside it', () => {
    assert.equal(scan.hasSelectInsideLoop(
        'LOOP AT lt INTO wa.\n  WRITE wa.\nENDLOOP.\nSELECT * FROM mara INTO TABLE lt2.'), false);
});

// ── hasCommentedOutCode ───────────────────────────────────
test('hasCommentedOutCode: finds genuinely disabled statements', () => {
    assert.equal(scan.hasCommentedOutCode(
        '*DATA lv_a TYPE c.\n*PERFORM check_it.\n*MOVE lv_a TO lv_b.\nWRITE 1.'), true);
});

test('hasCommentedOutCode: a bare *& header with no prose words is NOT dead code', () => {
    // The first fix leaned on prose markers, and this header has none —
    // "Report ZTEST", "Data 01.01.2020", "Function: prints" all read as
    // statements. Caught by hand-checking after the suite was already green,
    // which is exactly the case the suite has to own from now on.
    assert.equal(scan.hasCommentedOutCode(
        '*& Report ZTEST\n*& Data 01.01.2020\n*& Function: prints\nREPORT z.\nWRITE 1.'), false);
});

test('hasCommentedOutCode: a standard ABAP header block is NOT dead code', () => {
    // Every ABAP program opens like this. Counting it as dead code routed a
    // perfectly clean file to delete_commented_code with confidence 1.0 and no
    // LLM call at all.
    assert.equal(scan.hasCommentedOutCode(
        '*&---------------------------------------------------------------------*\n'
      + '*& Report ZTEST\n'
      + '*& Data 01.01.2020\n'
      + '*& Function: prints a list\n'
      + '*&---------------------------------------------------------------------*\n'
      + 'REPORT ztest.\nWRITE 1.'), false);
});

test('hasCommentedOutCode: prose comments are not dead code', () => {
    assert.equal(scan.hasCommentedOutCode(
        '* this report writes the data\n* the class handles it\n* function called daily\nWRITE 1.'), false);
});

test('hasCommentedOutCode: one disabled line is not enough', () => {
    // The threshold is two, not three. Three was needed only because the old
    // test was loose enough that header blocks reached it; with "must strip to
    // a terminated statement, must not be a *& header" it was hiding real
    // two-line blocks — including the one in this project's own test program.
    assert.equal(scan.hasCommentedOutCode('*DATA a TYPE c.\nWRITE 1.'), false);
});

test('hasCommentedOutCode: two disabled lines are dead code', () => {
    assert.equal(scan.hasCommentedOutCode(
        '*DATA lv_legacy_flag TYPE c.\n*PERFORM check_something USING lv_legacy_flag.\nWRITE 1.'), true);
});

// ── hasCommentedParamsInCall ──────────────────────────────
test('hasCommentedParamsInCall: finds disabled parameters in a call', () => {
    assert.equal(scan.hasCommentedParamsInCall(
        "CALL FUNCTION 'Z_TEST'\n  EXPORTING\n    a = 1\n*   TABLES\n*     it_data =\n  IMPORTING\n    r = v."), true);
});

test('hasCommentedParamsInCall: a clean call has none', () => {
    assert.equal(scan.hasCommentedParamsInCall(
        "CALL FUNCTION 'Z_X'\n  EXPORTING\n    a = 1\n  IMPORTING\n    r = v."), false);
});

test('hasCommentedParamsInCall: a one-line call ends at its own period', () => {
    // The CALL branch `continue`d before the end-of-statement check, so inCall
    // stayed true forever and the next ordinary comment containing "=" was
    // reported as a disabled parameter that does not exist.
    assert.equal(scan.hasCommentedParamsInCall(
        "CALL FUNCTION 'Z_FOO'.\n* lv_total = 0 old value\nDATA lv TYPE i."), false);
});

test('hasCommentedParamsInCall: comments before any call are ignored', () => {
    assert.equal(scan.hasCommentedParamsInCall('* it_data = something\nDATA x TYPE i.'), false);
});

// ── the rule table ────────────────────────────────────────
const idsFor = t => scan.matchingSkillIds(t);

test('like_check: fires on an obsolete LIKE declaration', () => {
    assert.ok(idsFor('DATA ztime LIKE sy-timlo.').includes('like_check'));
});

test('like_check: a SQL LIKE on another line is not a LIKE declaration', () => {
    // `[^.]*` matches newlines — a dot inside a character class is literal —
    // so an unterminated DATA chain swallowed a LIKE three lines away.
    assert.ok(!idsFor(
        'DATA: lv_a TYPE i,\n      lv_b TYPE c\nSELECT matnr FROM mara WHERE matnr LIKE lv_b.'
    ).includes('like_check'));
});

test('obsolete_check: fires on TABLES with and without a colon', () => {
    // checkAbapSyntax calls `TABLES mara.` an error while the router rule
    // ignored it — two detectors in one file disagreeing about the single most
    // cited obsolete statement in this product's prompts.
    assert.ok(idsFor('REPORT z.\nTABLES: mara.\nWRITE 1.').includes('obsolete_check'));
    assert.ok(idsFor('REPORT z.\nTABLES mara.\nWRITE 1.').includes('obsolete_check'));
});

test('matchingSkillIds: a clean program matches nothing', () => {
    assert.deepEqual(idsFor('REPORT z.\nDATA gv TYPE i.\nWRITE gv.'), []);
});

test('matchingSkillIds: the test program matches every rule it should', () => {
    const code = [
        'REPORT zpipek_test.',
        'TABLES: sflight.',
        'DATA ztime LIKE sy-timlo.',
        '*DATA lv_legacy TYPE c.',
        '*PERFORM check_something.',
        '*MOVE lv_a TO lv_b.',
        'SELECT * FROM sflight INTO TABLE gt.',
        'LOOP AT gt INTO gs.',
        '  SELECT SINGLE seatsocc FROM sflight INTO v WHERE carrid = gs-carrid.',
        'ENDLOOP.',
        'SELECT a FROM sbook INTO TABLE gb FOR ALL ENTRIES IN gt WHERE c = gt-c.',
        "CALL FUNCTION 'Z_TEST'",
        '  EXPORTING',
        '    e1 = 1',
        '*   TABLES',
        '*     it_data =',
        '  IMPORTING',
        '    r = v.',
    ].join('\n');
    const ids = idsFor(code);
    for (const want of ['obsolete_check', 'like_check', 'delete_commented_code',
                        'select_best_practice', 'select_loop_check',
                        'FAE_CHECK_01', 'COMMENT_IN_FUNCTION_SYNTAX']) {
        assert.ok(ids.includes(want), `missing ${want} — got ${ids.join(', ')}`);
    }
});

// ── codeShapeSkillId ──────────────────────────────────────
test('codeShapeSkillId: one rule firing gives a confident pick', () => {
    assert.equal(scan.codeShapeSkillId('REPORT z.\nDATA ztime LIKE sy-timlo.\nWRITE 1.'), 'like_check');
});

test('codeShapeSkillId: several rules firing gives no pick', () => {
    assert.equal(scan.codeShapeSkillId('TABLES: mara.\nDATA x LIKE sy-timlo.\nSELECT * FROM t INTO TABLE lt.'), null);
});

test('codeShapeSkillId: a clean file gives no pick', () => {
    assert.equal(scan.codeShapeSkillId('REPORT z.\nDATA gv TYPE i.\nWRITE gv.'), null);
});

// ── checkAbapSyntax ───────────────────────────────────────
const sev = (r, s) => (r.issues || []).filter(i => i.severity === s);

test('checkAbapSyntax: reports TABLES as an error', () => {
    const r = scan.checkAbapSyntax('REPORT z.\nTABLES mara.\nWRITE 1.');
    assert.equal(sev(r, 'error').length, 1);
    assert.equal(r.valid, false);
});

test('checkAbapSyntax: catches SELECT...ENDSELECT across lines', () => {
    // The rule was applied per line, so the one pattern that spans lines — and
    // the only `error` besides TABLES — could never match. The pre-analysis
    // block then told the model the file had no errors.
    const r = scan.checkAbapSyntax(
        'REPORT z.\nSELECT * FROM mara INTO wa.\nWRITE wa-matnr.\nENDSELECT.');
    assert.ok(JSON.stringify(r.issues).includes('ENDSELECT'),
        'SELECT...ENDSELECT was not reported');
    assert.equal(r.valid, false);
});

test('checkAbapSyntax: catches CLEAR followed by REFRESH', () => {
    const r = scan.checkAbapSyntax('REPORT z.\nCLEAR lt_tab.\nREFRESH lt_tab.\nWRITE 1.');
    assert.ok(JSON.stringify(r.issues).includes('FREE'), 'CLEAR+REFRESH was not reported');
});

test('checkAbapSyntax: ignores commented-out code', () => {
    // buildPreAnalysis hands these to the model as "detected by a static scan,
    // line numbers are exact, treat them as given" — so the model was told to
    // go and fix lines that do not execute.
    const r = scan.checkAbapSyntax(
        "REPORT z.\n* MOVE lv_a TO lv_b.\n* SELECT * FROM mara.\nWRITE 1.");
    const onComments = (r.issues || []).filter(i => /^\s*[*"]/.test(i.code || ''));
    assert.deepEqual(onComments, [], 'reported findings on comment lines');
});

test('checkAbapSyntax: the loop error names the loop, not a correct SELECT above it', () => {
    // A regex finds the LEFTMOST match, so /SELECT[\s\S]*?ENDSELECT/ opened at
    // the first SELECT in the file. With a correct `SELECT SINGLE ... .` above
    // the real loop, the error was pinned to the correct statement — and the
    // model is told these line numbers are exact and the finding is given.
    const r = scan.checkAbapSyntax([
        'REPORT ztest.',
        'SELECT SINGLE matnr FROM mara INTO lv_m WHERE matnr = 1.',
        'WRITE lv_m.',
        'SELECT * FROM vbak INTO wa.',
        '  WRITE wa-vbeln.',
        'ENDSELECT.',
    ].join('\n'));
    const errs = (r.issues || []).filter(i => i.severity === 'error');
    assert.equal(errs.length, 1);
    assert.equal(errs[0].line, 4, 'error was pinned to the wrong line');
});

test('checkAbapSyntax: reports every SELECT...ENDSELECT, not just the first', () => {
    const r = scan.checkAbapSyntax([
        'REPORT z.',
        'SELECT * FROM a INTO w.', 'WRITE w.', 'ENDSELECT.',
        'SELECT * FROM b INTO w2.', 'WRITE w2.', 'ENDSELECT.',
    ].join('\n'));
    assert.equal((r.issues || []).filter(i => i.severity === 'error').length, 2);
});

test('checkAbapSyntax: a lone SELECT SINGLE is not a loop', () => {
    assert.equal(scan.checkAbapSyntax('REPORT z.\nSELECT SINGLE a FROM t INTO v.\nWRITE v.').valid, true);
});

test('checkAbapSyntax: TABLES inside CALL FUNCTION is not the obsolete statement', () => {
    // Broadening the pattern to TABLES[\s:] caught the parameter section of
    // every CALL FUNCTION — current syntax — and told the model a clean call
    // contained an obsolete declaration.
    const call = "CALL FUNCTION 'Z_READ'\n  EXPORTING\n    iv = 1\n  TABLES\n    it = lt.";
    assert.equal(scan.checkAbapSyntax(call).valid, true);
    assert.ok(!idsFor(call).includes('obsolete_check'));
    assert.equal(scan.checkAbapSyntax("CALL FUNCTION 'Z'\n  TABLES it = lt.").valid, true);
});

test('checkAbapSyntax: a clean program is valid', () => {
    const r = scan.checkAbapSyntax('REPORT z.\nDATA gv TYPE i.\ngv = 1.');
    assert.equal(r.valid, true);
    assert.equal(r.issueCount, 0);
});

test('checkAbapSyntax: AND RETURN advice names the right replacement', () => {
    // AND RETURN is an addition to CALL TRANSACTION / LEAVE TO TRANSACTION.
    // CALL METHOD replaces a different obsolete form entirely, and this text
    // is fed to the model as an established finding.
    const r = scan.checkAbapSyntax("REPORT z.\nLEAVE TO TRANSACTION 'SE38' AND RETURN.\nWRITE 1.");
    const msg = JSON.stringify(r.issues);
    assert.ok(msg.includes('AND RETURN'), 'AND RETURN was not reported');
    assert.ok(!msg.includes('CALL METHOD'), 'still recommends CALL METHOD, which is unrelated');
});
