// @ts-check
// chat-context.js — what of a chat the model sees: the replayed history plus every file attached earlier.
// A user turn is stored as "<typed text>\n\n[File: name]\n<content>" (js/chat.js send).

const FILE_RE = /(?:^|\n\n)\[File:\s*([^\]\n]+)\]\n/;
const FILES_MAX_CHARS = 100000;   // same cap as one message plus its file
// models take ~1M tokens, but input above 272K tokens bills at 2x — history + files + prompt stay under it
const HIST_MAX_CHARS = 400000;    // ~100K tokens of code, more for Thai text
const HIST_MAX_MSGS  = 400;

/** @param {string} content @returns {{ text: string, name: string, body: string } | null} */
function splitFile(content) {
    const s = String(content || '');
    const m = FILE_RE.exec(s);
    if (!m) return null;
    return { text: s.slice(0, m.index), name: m[1].trim(), body: s.slice(m.index + m[0].length) };
}

/** Replayed user turn without the file body — the body travels once, in the files block. */
function stripFileBody(content) {
    const f = splitFile(content);
    if (!f) return String(content || '');
    return (f.text ? f.text + '\n\n' : '') + `[File: ${f.name}] (content is in "Files attached earlier in this chat")`;
}

/**
 * Newest version of each file attached earlier in the session, minus files the current message re-attaches.
 * @param {string[]} userContentsNewestFirst
 * @param {string} currentPrompt
 * @returns {string} a context block, or '' when there is nothing to remember
 */
function earlierFilesBlock(userContentsNewestFirst, currentPrompt, cap = FILES_MAX_CHARS) {
    const current = splitFile(currentPrompt);
    const seen = new Set(current ? [current.name] : []);
    const files = [];
    let used = 0;
    for (const c of userContentsNewestFirst) {
        const f = splitFile(c);
        if (!f || seen.has(f.name)) continue;
        seen.add(f.name);
        if (used + f.body.length > cap) continue;   // older and too big: the newer files win
        files.push(f);
        used += f.body.length;
    }
    if (!files.length) return '';
    return 'Files attached earlier in this chat. When the user mentions "the file", "the program" or '
        + 'its line numbers, they mean these:\n\n'
        + files.map(f => `[File: ${f.name}]\n${f.body}`).join('\n\n');
}

/**
 * The context for the next turn, and how full it is (the chat page's context ring).
 * @param {{ role: string, content: string }[]} rows  this chat's user/assistant turns, oldest first
 * @param {string} currentPrompt  the message being sent now ('' when only measuring)
 * @returns {{ history: { role: string, content: string }[], pct: number, dropped: number }}
 */
function buildChatContext(rows, currentPrompt) {
    const recent = rows.slice(-HIST_MAX_MSGS);
    const kept = [];
    let used = 0;
    for (let i = recent.length - 1; i >= 0; i--) {   // newest → oldest
        const m = recent[i];
        // file bodies travel once, in the files block, not inside every old turn
        const text = m.role === 'user' ? stripFileBody(m.content) : String(m.content || '');
        if (kept.length && used + text.length > HIST_MAX_CHARS) break;
        kept.push({ role: m.role, content: text.slice(0, HIST_MAX_CHARS) });
        used += Math.min(text.length, HIST_MAX_CHARS);
    }
    kept.reverse();
    const userNewestFirst = rows.filter(m => m.role === 'user').map(m => m.content).reverse();
    const files = earlierFilesBlock(userNewestFirst, currentPrompt);
    const history = files ? [{ role: 'user', content: files }, ...kept] : kept;
    const dropped = rows.length - kept.length;
    const pct = dropped ? 100 : Math.min(100, Math.round(100 * (used + files.length) / (HIST_MAX_CHARS + FILES_MAX_CHARS)));
    return { history, pct, dropped };
}

module.exports = { splitFile, stripFileBody, earlierFilesBlock, buildChatContext, FILES_MAX_CHARS, HIST_MAX_CHARS };
