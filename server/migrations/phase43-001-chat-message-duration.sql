-- Phase 43: remember how long an answer took.
--
-- tbl_chat_message stores tokens, cost, model and skill for every turn, but
-- never the wall-clock duration. The chat badge shows it live from the SSE
-- `done` event, then the value is gone: reopening the conversation, or simply
-- refreshing the page, re-renders the same answer as "89,917 tokens · 0.0s".
-- The frontend had `durationMs: 0, // not persisted historically` hard-coded at
-- the load path, which is exactly where it was lost.
--
-- Duration is the number the team has been using all week to judge whether a
-- change made things faster, so losing it on refresh matters more than it looks.
--
-- Nullable on purpose: every message written before this migration genuinely
-- has no duration, and NULL says that honestly. The UI omits the segment rather
-- than printing a made-up 0.0s.

ALTER TABLE tbl_chat_message
    ADD COLUMN IF NOT EXISTS duration_ms INTEGER;

COMMENT ON COLUMN tbl_chat_message.duration_ms IS
    'Wall-clock milliseconds for the assistant turn. NULL for rows written before phase43, and for user rows.';
