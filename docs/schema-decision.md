# Schema-of-record decision (May 2026)

## Background

Designer provided `schema-drawsql-2.sql` (drawn in drawSQL). After comparing to
the live PostgreSQL DB (`<DB_HOST>/OpenAI_DB`) we have two candidate
"source of truth" documents:

| | Designer file | Live DB |
|---|---|---|
| Tables | 13 | **15** |
| Migrations history | none | 21 applied (`server/migrations/`) |
| `tbl_chat_message` | ❌ missing | ✅ |
| `tbl_sync_state`   | ❌ missing | ✅ |
| `tbl_chat_session.is_favorite` (Phase 19.7) | ❌ missing | ✅ |
| DEFAULT literal bugs (drawSQL export issue) | ❌ has them | clean |
| FK count | 16 | 17 |

## Decision

**Use the live DB as canonical.** Generate the design document FROM it
(via `server/dump-schema.js`) rather than the other way around. Replace
`schema-drawsql-2.sql` with `docs/schema-current.sql` as the artifact
shared with PM / designer.

### Why not switch to the designer's schema?

1. **Missing critical tables** — `tbl_chat_message` (chat history) and
   `tbl_sync_state` (background usage sync) are not optional; the app
   reads/writes them on every chat turn and every 15-min sync tick.
2. **Lost features** — `is_favorite` (Phase 19.7), top-up history table
   split (Phase 16.1), encrypted API keys (Phase 17.1) all evolved past
   the snapshot the designer captured.
3. **Code is locked to live shape** — `server.js` queries reference
   columns + tables that don't exist in the designer file. Switching =
   rewrite the chat path, the sync job, and the favorite feature.
4. **drawSQL export has bugs** — every TEXT/VARCHAR column with a
   default has a broken literal like
   `DEFAULT 'DEFAULT CAST(''''New chat'''' AS VARCHAR)'` which would
   insert the keyword `DEFAULT` as the actual value on every row.

## Improvements found in the designer file — worth cherry-picking?

| Item | Verdict | Reason |
|------|---------|--------|
| FK `tbl_action_admin.role_id → tbl_user_role.role_id` | ✅ ADD | Missing in current DB — adds referential integrity (admin role can't be deleted while admin actions reference it). Low risk. |
| FK `tbl_user.user_id → tbl_balance.user_id` | ❌ Skip | Circular reference (user FK'd to balance FK'd back). `tbl_balance.user_id` isn't unique, so this FK wouldn't even apply correctly. Probably a drawSQL mis-modelling. |
| FK `tbl_response.session_id → tbl_chat_session.session_id` | ❌ Skip | The column `tbl_response.session_id` doesn't exist in our current design (we have `tbl_chat_message` for that linkage). |
| `tbl_balance` split into 3 money columns (`balance + amount + top_up_amount`) | ❌ Skip | Current design (1 column + `tbl_topup_history` table) is more normalised. The 3-column design embeds history in summary rows — worse for audit trail. |
| `tbl_response` collapsing chat content (`role`, `content`, `session_id`) | ❌ Skip | We deliberately split this in Phase 12 into `tbl_chat_message`. Reverting would merge user input + AI response into one table — worse separation of concerns. |

**Action**: write one new migration `phase19-002-add-action-admin-role-fk.sql`
to add the single missing FK. Defer if PM hasn't reviewed.

## Bonus finding — legacy tables still in DB

The DB contains 3 leftover non-`tbl_*` tables from the original schema
(before the Phase 6 rename):

| Table | Rows | Status |
|-------|------|--------|
| `users` | 4 | Old data, no code reads it |
| `projects` | 3 | Old data, no code reads it |
| `usage_history` | 19 | Old data, no code reads it |

These have orphaned FKs (`usage_history.user_id → users.id`,
`users.project_id → projects.id`) that show up in the FK inspector but
no production code path touches them.

**Recommendation**: leave them alone for now. If they're confirmed
unused (PM sign-off), drop in a future migration:
```sql
DROP TABLE IF EXISTS usage_history CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS projects CASCADE;
```

## Workflow going forward

### Where the schema lives

- **`server/migrations/*.sql`** — immutable history. Every schema change
  must land here as a NEW file. This is what the DB actually replays
  on a fresh deploy.
- **`docs/schema-current.sql`** — auto-generated snapshot of the
  current state, regenerated on demand:
  ```bash
  cd server && node dump-schema.js > ../docs/schema-current.sql
  ```
  Share this with PM / designer when they ask for "the current schema".

### When PM/designer sends a new schema proposal

1. Open `docs/schema-current.sql` side-by-side with their file.
2. List concrete differences (new column? new table? new FK?).
3. For each: decide ADD / SKIP / DISCUSS.
4. For each ADD: write a new migration file in `server/migrations/`.
5. Update `server/migrations/README.md` Timeline table.
6. Regenerate `docs/schema-current.sql` after the migration runs.

### When dev (us) wants to change schema

1. Write a migration file:
   `server/migrations/phaseXX-NNN-short-description.sql`
2. Restart server — `migrate-schema.js` picks it up on boot.
3. Regenerate `docs/schema-current.sql`.
4. Commit both: the migration AND the regenerated snapshot.
