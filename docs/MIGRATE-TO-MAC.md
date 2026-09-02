# Migrate dev environment → another machine (macOS / Windows)

Quick checklist to continue working on this project from a second machine.
The app is plain Node.js + PostgreSQL + static files — fully cross-platform.

## 0. Before leaving the current machine
- [ ] **Back up `server/.env`** — it is gitignored (not on GitHub). Copy the file
      somewhere safe (password manager / encrypted note). You need these values:
      `OPENAI_API_KEY`, `OPENAI_ADMIN_KEY`, `OPENAI_ASSISTANT_ID`,
      `OPENAI_VECTOR_STORE_ID`, `DB_PASS`, `ENCRYPTION_KEY`.
      > ⚠ `ENCRYPTION_KEY` MUST be identical on the new machine, or encrypted
      > project API keys in the DB become unreadable.
- [ ] `git status` is clean and `git push origin master` is done.

## 1. Install prerequisites
```bash
# macOS — Homebrew (if not installed): https://brew.sh
brew install node git        # Node ≥ 20 (CI runs 20 and 24; dev machine is v24)
node --version && git --version
```
PostgreSQL is NOT needed locally — the DB lives on `192.168.69.125`.
(Install it only if you want app + DB on the new machine itself; see
`docs/deployment.md` for the local-PG variant.)

## 2. Get the code
```bash
git clone https://github.com/TeamPetabyte/onlyopenai.git ai-agent-dashboard
cd ai-agent-dashboard
npm install                  # dev tooling (eslint/vite/tsc); also wires .githooks as the pre-commit hook
cd server
npm install                  # runtime deps (pg, exceljs, ...)
```

## 3. Recreate the env file
```bash
# still inside server/
cp .env.example .env
# then paste your saved real values into .env (DB_PASS, OpenAI keys,
# ENCRYPTION_KEY — same value as before!)
```

## 4. Run it
```bash
npm run migrate     # safe on the existing DB — skips already-applied migrations
npm start           # or: ./start-server.sh   (start-server.bat is Windows-only)
```
Open http://localhost:3001/login.html

An unbuilt checkout serves the source tree as native ES modules, so this is
enough for development. `npm run build` at the repo root produces the minified
`dist/` that production serves (the server ignores a `dist/` built from a
different commit).

## 5. Before committing
```bash
npm run check       # at the repo root: lint + contracts + typecheck + 74 tests
```
The pre-commit hook (wired by step 2) runs `check` and `build` automatically.
If the hook is not firing, run `git config core.hooksPath .githooks` once.
`npm run smoke` exercises the chat money path and needs a reachable DB.

## 6. Reachability note
If the DB at `192.168.69.125` is on a different network/VPN than the new machine,
make sure it can reach it: `nc -vz 192.168.69.125 5432`.

## Windows-only files you can ignore on Mac
- `start-server.bat`, `server/install.bat`  → use `start-server.sh` / `server/install.sh`

## Claude Code
Works the same on macOS — just `cd` into the project and run `claude`.
Paths shift from `C:\Users\...` to `/Users/...`; nothing else changes.

`CLAUDE.md`, `docs/agents/` and the vendored skills under `.agents/skills/`
are committed, so the same `/wayfinder`, `/tdd`, `/code-review` … workflow
comes with the clone. `skills-lock.json` records their upstream
(`mattpocock/skills`) for `npx skills` updates. Local issue tracking lives in
`.scratch/<feature>/` (see `docs/agents/issue-tracker.md`).
