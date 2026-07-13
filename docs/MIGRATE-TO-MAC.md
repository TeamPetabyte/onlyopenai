# Migrate dev environment → macOS

Quick checklist to continue working on this project from a Mac.
The app is plain Node.js + PostgreSQL + static files — fully cross-platform.

## 0. Before leaving the Windows machine
- [ ] **Back up `server/.env`** — it is gitignored (not on GitHub). Copy the file
      somewhere safe (password manager / encrypted note). You need these values:
      `OPENAI_API_KEY`, `OPENAI_ADMIN_KEY`, `OPENAI_ASSISTANT_ID`,
      `OPENAI_VECTOR_STORE_ID`, `DB_PASS`, `ENCRYPTION_KEY`.
      > ⚠ `ENCRYPTION_KEY` MUST be identical on the new machine, or encrypted
      > project API keys in the DB become unreadable.
- [ ] Push latest code: `git push origin master` (already done during this prep).

## 1. Install prerequisites on the Mac
```bash
# Homebrew (if not installed): https://brew.sh
brew install node git        # Node ≥ 18 (project tested on v24)
node --version && git --version
```
PostgreSQL is NOT needed locally — the DB lives on `192.168.69.125`.
(Install it only if you want app + DB on the Mac itself.)

## 2. Get the code
```bash
git clone https://github.com/TeamPetabyte/onlyopenai.git ai-agent-dashboard
cd ai-agent-dashboard/server
npm install                  # installs pg, exceljs, etc.
```

## 3. Recreate the env file
```bash
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

## 5. Reachability note
If the DB at `192.168.69.125` is on a different network/VPN than the Mac,
make sure the Mac can reach it: `nc -vz 192.168.69.125 5432`.

## Windows-only files you can ignore on Mac
- `start-server.bat`, `server/install.bat`  → use `start-server.sh` / `server/install.sh`

## Claude Code
Works the same on macOS — just `cd` into the project and run `claude`.
Paths shift from `C:\Users\...` to `/Users/...`; nothing else changes.
