# PipekAI — AI Coding Assistant for SAP / ABAP

PipekAI is a multi-tenant AI assistant specialised for **SAP / ABAP** work: it
reviews ABAP against a curated skill catalog and the customer's own coding
standards, and it **writes complete programs** (ALV reports from a spec) that
compile on the release the customer runs. Every code block the model returns is
checked by the real ABAP parser (abaplint) before it is sent. Per-project credit
billing is built in.

> Backend serves both the REST/streaming API **and** the static frontend on a
> single port. Customers reach it over HTTPS via a Cloudflare tunnel.

---

## ✨ Features

- **Streaming chat** (SSE) with an SAP-specialist persona
- **Skill router** — `gpt-4o-mini` classifies each message and applies the
  best-matching prompt; skills whose code-shape rule fires add their knowledge
- **7 skills** — 6 review skills (obsolete statements, SELECT best practice,
  SELECT in loop, LIKE, commented-out code, general best practice) and
  `generate_alv_report`, which turns a written spec into a CL_SALV_TABLE report
  with every assumption written as a `*###` comment
- **Target SAP release per project** (`v731` / `v740sp08` / `v750` / `cloud`) —
  appended to every prompt so the model writes syntax that compiles there
- **Real syntax check** — the `check_abap_syntax` tool runs abaplint
  (`parser_error`, `check_syntax`, `unknown_types`, `check_ddic`) for that release;
  the answer format requires it on every code block before sending
- **Knowledge base** — the org's standards and SAP manuals in an OpenAI vector
  store (`search_knowledge`) plus local reference files behind function tools
  (`find_bapi`, `get_transaction_info`, `get_best_practice`, …)
- **Model picker** — GPT-6 Astra and the GPT-5.6 family (Responses API,
  reasoning effort low/medium/high) or GPT-5.5 (Chat Completions); `store: false`,
  conversation state is replayed by the server, nothing is kept at OpenAI
- **Multi-tenant** — each *project* = one customer/org; data is scoped by
  `project_id`, and each project can use its own OpenAI key
- **Credit billing** — usage is charged to a per-project pool, priced per model
  from `tbl_pricing` (price = cost x5), with a full transaction ledger, per-user
  daily caps and a quota-request flow
- **Trainer tools** — edit prompts in the UI (stored in the DB, hot-reloaded),
  Skills Lab, eval harness with an LLM judge (pass = ≥7/10 and no wrong claim)
- **Hardening** — session cookies + CSRF, per-user rate limits, account lockout,
  password policy, `currentPassword` on self password change, append-only audit
  tables, fail-closed budget gate, `no-store` on every API response

---

## 🏗️ Architecture

```
Browser ──HTTPS──▶ Cloudflare tunnel ──▶ Node/Express server (:3001)
                                              │  serves API + built frontend (dist/)
                                              ├──▶ PostgreSQL  (users, credits, history, prompts, pricing)
                                              ├──▶ abaplint    (in-process ABAP parser, per-project release)
                                              └──▶ OpenAI      (gpt-6 / gpt-5.6 / gpt-5.5 answer · gpt-4o-mini router · vector store)
```

- **Backend:** Node.js + Express — `server/server.js` wires `routes/` (HTTP) and
  `services/` (billing, audit, sessions, `services/ai/` for the model loop, tools
  and the router); pure helpers live in `server/lib/`.
- **Frontend:** ES-module HTML/JS built by **Vite** into `dist/` (hashed
  filenames). The server serves `dist/` only when its build matches `HEAD`,
  otherwise it falls back to the source tree (unhashed — browsers may cache it).
  One design-token set (`css/tokens.css`, light default, dark under
  `data-theme="dark"`) drives chat, admin and login; **Tailwind 4** utilities
  (`css/tailwind.css`, mapped onto those tokens) are used on the auth pages.
- **Database:** PostgreSQL with versioned SQL migrations (auto-applied on boot).
- **AI:** OpenAI — answer model chosen per message, router model fixed; prompts
  in `tbl_prompt` (seeded from `server/config/skill-prompts.json`, new file
  skills are seeded into existing databases on boot).

---

## 🧱 Tech Stack

| Layer | Tech |
|-------|------|
| Runtime | Node.js (≥ 18; CI runs 20 and 24) |
| Web | Express, CORS, Helmet |
| Auth | session cookie (HttpOnly) + CSRF, bcrypt, `express-rate-limit` |
| DB | PostgreSQL (`pg`) + SQL migrations |
| AI | `openai` SDK — Responses API (gpt-6-astra/sol/luna, gpt-5.6-sol/terra/luna) and Chat Completions (gpt-5.5); `gpt-4o-mini` router |
| ABAP | `@abaplint/core` (MIT) for syntax / variable / type checks, no SAP system needed |
| Frontend build | Vite + `@tailwindcss/vite` (`npm run build` → `dist/`) |
| Validation | `zod` |
| Logging | `pino` / `pino-http` / `pino-roll` |
| Misc | `multer` (uploads, in memory → vector store), `exceljs` (exports), `https-proxy-agent` |

---

## 📁 Project Structure

```
.
├── index.html / login.html / admin.html / change-password.html   # frontend pages
├── js/ · css/ · assets/                                          # frontend source (ES modules)
├── vite.config.mjs              # build → dist/ (gitignored)
├── server/
│   ├── server.js                # Express app: middleware, static (dist/ then source), route wiring
│   ├── routes/                  # auth, chat, chat-sessions, users, projects, quota, skills, evals, …
│   ├── services/                # billing, audit, session-store, usage-sync
│   │   └── ai/                  # client, tools + tool-defs, skill-router, skill-runner (Responses loop)
│   ├── lib/                     # abap-scan (rules + abaplint), prompt (appendix, target release), models
│   ├── skill-prompts.js         # DB-backed prompt registry (+ file fallback, seeds new file skills)
│   ├── config/skill-prompts.json# seed/fallback prompt catalog (7 skills)
│   ├── knowledge/               # 15 SAP/ABAP reference files (function-tool RAG)
│   ├── migrations/*.sql         # versioned schema migrations
│   ├── test/                    # unit tests (node --test)
│   ├── test-routes/             # HTTP tests on a throwaway Postgres
│   ├── migrate-schema.js        # migration runner (runs on boot)
│   ├── reset-admin.js           # admin password reset CLI (random password, prints once)
│   └── .env                     # secrets/config (gitignored — see .env.production.example)
├── windows/                     # install-services.ps1 (NSSM), backup-db.ps1, verify-backup.ps1
├── docs/                        # deployment, DB, schema, trainer guide
└── start.js · start-server.sh/.bat
```

---

## 🚀 Getting Started (local dev)

**Prerequisites:** Node.js ≥ 18, a PostgreSQL database, an OpenAI API key.

```bash
npm install                          # dev tooling (eslint/vite/tsc) + wires the pre-commit hook
cd server
npm install
cp .env.production.example .env      # then fill in your values (see below)
npm run migrate                      # create/seed the schema (also auto-runs on boot)
npm start                            # http://localhost:3001
```

Open `http://localhost:3001/login.html`. An unbuilt checkout serves the source tree
as native ES modules; `npm run build` (root) produces the minified `dist/` that
production serves. `npm run check` = lint + contracts + typecheck + unit tests, and
the pre-commit hook runs it (plus the build) before every commit.

`npm run test:routes` boots the real server on a throwaway database
(`petabyte_route_test`, dropped and recreated every run) and exercises login,
the auth gates, the money gates, tenant isolation and the skill catalog over
HTTP. It needs a reachable Postgres: `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASS`
(defaults `127.0.0.1:5433`, `postgres`). CI runs it against a Postgres service.

---

## ⚙️ Configuration (`server/.env`)

| Key | Description |
|-----|-------------|
| `NODE_ENV` | `production` enables secure cookies, HSTS and the mandatory CORS allow-list |
| `FORCE_HTTPS` | `true` turns the same on regardless of `NODE_ENV` — set it behind the tunnel |
| `TRUST_PROXY` | proxy hops to trust for the client IP (`1` behind cloudflared, default; `0` on a direct port) |
| `PORT` | server port (default `3001`) |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASS` | PostgreSQL connection (`localhost` if same host) |
| `OPENAI_API_KEY` | OpenAI key for chat |
| `OPENAI_MODEL` | fallback answer model when the client sends none or an unknown one |
| `OPENAI_TEMPERATURE` | number to use; empty to omit (reasoning models reject it) |
| `OPENAI_ASSISTANT_ID` / `OPENAI_VECTOR_STORE_ID` | assistant + vector store ids |
| `ENCRYPTION_KEY` | 64-hex AES key used to encrypt per-project OpenAI keys — losing it makes those keys unreadable |
| `ALLOWED_ORIGINS` | comma-separated allowed origins for CORS (include your domain) |
| `CHAT_RATE_LIMIT_PER_MIN`, `MAX_BALANCE`, `LOCKOUT_*`, `LOGIN_MAX_PER_15MIN`, `LOG_*` | tunables |

> `.env` is gitignored. Never commit real secrets — use `server/.env.production.example` as the template.

---

## 🤖 Models & Pricing

- **Answer models** (picked per message in the UI, registry in `server/lib/models.js`):
  `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra` (default), `gpt-5.6-luna` on the
  Responses API with reasoning effort; `gpt-5.5` on Chat Completions. Anything
  else falls back to `OPENAI_MODEL`.
- **Router model:** `gpt-4o-mini` (cheap/fast skill classification on every message).
- **Target release:** each project carries `target_release`; the prompt tells the
  model which ABAP release the code must compile on and abaplint checks it
  against the same version (`v731` is checked with abaplint's `v702` grammar).
- Per-model rates live in **`tbl_pricing`** (`*_cost` = paid to OpenAI, `*_price`
  = charged to the customer; THB per 1K tokens, effective-dated). Current rows are
  cost x5; the admin pricing page can change them without a deploy. Adding a
  model = one entry in `models.js` + one `tbl_pricing` migration.
- Money balances are stored at 4-decimal precision so the pool reconciles
  exactly with the credit ledger.

---

## 🗄️ Database

Migrations in `server/migrations/*.sql` are applied automatically on boot
(tracked in `_meta.schema_migrations` by filename + SHA-256 — never edit an
applied migration; add a new one).

Key tables: `tbl_user`, `tbl_project` (incl. `target_release`), `tbl_balance`
(project pool), `tbl_credits`, `tbl_user_credit_transaction` (ledger),
`tbl_daily_usage`, `tbl_quota_request`, `tbl_response`, `tbl_chat_session` /
`tbl_chat_message`, `tbl_prompt` (+history), `tbl_pricing`, `tbl_skill_test_log`,
`tbl_eval_run` / `tbl_eval_result`, `tbl_session`, `tbl_audit_log` and
`tbl_action_admin` (append-only by trigger).

See `docs/database-overview.md` and `docs/schema-current.sql`.

---

## 🚢 Deployment

Production runs on a Windows server as an NSSM service, exposed via a Cloudflare tunnel.

- **Full guide:** `docs/deployment-windows.md`
- **Service install (NSSM):** `windows/install-services.ps1`; daily DB backup: `windows/backup-db.ps1`
- **Update to the latest release** (PowerShell, one line):

```powershell
cd C:\petabyte\onlyopenai-master; git fetch origin; git reset --hard origin/master; npm run build; C:\petabyte\nssm.exe restart PetabyteAi
```

`npm run build` is required every time — `dist/` is gitignored and the server
skips a build from another commit. When a release changed `server/package.json`,
insert `cd server; npm install --omit=dev; cd ..;` before the build (root
`package.json`: `npm ci --include=dev;`). Migrations apply on boot. Set
`FORCE_HTTPS=true` and `TRUST_PROXY=1` in `server/.env` on the tunnel host.

For external (customer) access the app must be served over **HTTPS** — use a
Cloudflare named tunnel (auto-HTTPS) or a reverse proxy with a TLS certificate.

---

## 📜 Scripts

| Command | Where | What it does |
|---------|-------|--------------|
| `npm run check` | root | lint + global/require contracts + typecheck + unit tests |
| `npm run build` | root | Vite build → `dist/` |
| `npm run test:routes` | root | HTTP tests on a throwaway Postgres |
| `npm start` | server/ | run the server |
| `npm run dev` | server/ | run with nodemon (auto-reload) |
| `npm run migrate` / `migrate:status` | server/ | apply / show migrations |
| `node reset-admin.js [--user u] [--password p] [--list]` | server/ | reset a staff password (random when omitted), unlock, revoke sessions |

---

## 🔒 Security Notes

- Sessions use an HttpOnly, session-scoped cookie (closing the browser logs out)
  plus CSRF double-submit tokens and per-user rate limiting.
- Per-project OpenAI keys are encrypted at rest with `ENCRYPTION_KEY`.
- The seeded `admin` account has no usable password: a migration deactivates any
  account still on the historical default hash — run `node reset-admin.js` once
  on a fresh database. Changing your own password requires the current one.
- Customer code is sent to OpenAI with `store: false`; nothing is retained there
  beyond OpenAI's abuse-monitoring window. Uploaded knowledge files live in the
  OpenAI vector store, not on the server.
- Never expose the database port publicly — only the app (`:3001`) goes through
  the tunnel.

---

## 📚 Docs

- `docs/deployment-windows.md` — Windows + tunnel deployment
- `docs/deployment.md` — deployment notes incl. the Vite build step
- `docs/trainer-guide.md` / `docs/trainer-guide.th.md` — prompt and skill training
- `docs/database-overview.md` — schema overview
- `docs/credit-balance-concept.md` — billing model (Concept B)
- `docs/schema-current.sql` — current schema snapshot
