# ╔═══════════════════════════════════════════════════════════╗
# ║ PetabyteAi — ติดตั้ง backend เป็น Windows Service (NSSM)   ║
# ╚═══════════════════════════════════════════════════════════╝
# รันใน PowerShell แบบ "Run as Administrator"
#   cd C:\petabyte\onlyopenai\windows
#   .\install-services.ps1
#
# สิ่งที่สคริปต์นี้ทำ:
#   - หา node.exe และโฟลเดอร์ server\ อัตโนมัติ
#   - สร้าง/อัปเดต Windows Service ชื่อ "PetabyteAi" ให้รัน `node server.js`
#   - ตั้งให้ auto-start ตอนบูต + เก็บ log ไว้ที่ server\logs\
#   - start service แล้วโชว์สถานะ
#
# แก้ path ให้ตรงเครื่องคุณได้ที่ตัวแปรด้านล่าง

# ── ปรับ path ตรงนี้ให้ตรงเครื่อง ─────────────────────────────
$NssmPath   = "C:\petabyte\nssm.exe"                       # ที่วาง nssm.exe (จาก nssm.cc)
$ServiceNm  = "PetabyteAi"

# ── auto-detect (ปกติไม่ต้องแก้) ─────────────────────────────
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerDir  = Resolve-Path (Join-Path $ScriptDir "..\server")
$NodeExe    = (Get-Command node -ErrorAction SilentlyContinue).Source
$LogDir     = Join-Path $ServerDir "logs"

# ── ตรวจสอบของที่ต้องมี ──────────────────────────────────────
if (-not (Test-Path $NssmPath)) {
    Write-Host "✗ ไม่พบ nssm.exe ที่ $NssmPath" -ForegroundColor Red
    Write-Host "  ดาวน์โหลดจาก https://nssm.cc/download แล้ววางไฟล์ (โฟลเดอร์ win64) ตาม path ด้านบน" -ForegroundColor Yellow
    exit 1
}
if (-not $NodeExe) {
    Write-Host "✗ ไม่พบ node — ติดตั้ง Node.js LTS จาก https://nodejs.org ก่อน" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path (Join-Path $ServerDir "server.js"))) {
    Write-Host "✗ ไม่พบ server.js ใน $ServerDir" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path (Join-Path $ServerDir ".env"))) {
    Write-Host "✗ ไม่พบ server\.env — copy จาก .env.production.example แล้วเติมค่าก่อน" -ForegroundColor Red
    exit 1
}
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Write-Host "node    : $NodeExe"
Write-Host "server  : $ServerDir"
Write-Host "service : $ServiceNm"
Write-Host ""

# ── ถ้ามี service เดิมอยู่แล้ว ลบก่อน (idempotent) ────────────
$existing = & $NssmPath status $ServiceNm 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "พบ service เดิม — กำลังลบเพื่อสร้างใหม่..." -ForegroundColor Yellow
    & $NssmPath stop   $ServiceNm | Out-Null
    & $NssmPath remove $ServiceNm confirm | Out-Null
    Start-Sleep -Seconds 2
}

# ── สร้าง service ────────────────────────────────────────────
& $NssmPath install $ServiceNm $NodeExe "server.js"
& $NssmPath set $ServiceNm AppDirectory   $ServerDir
& $NssmPath set $ServiceNm AppStdout      (Join-Path $LogDir "service-out.log")
& $NssmPath set $ServiceNm AppStderr      (Join-Path $LogDir "service-err.log")
& $NssmPath set $ServiceNm Start          SERVICE_AUTO_START
& $NssmPath set $ServiceNm AppRotateFiles 1
& $NssmPath set $ServiceNm AppRotateBytes 10485760     # หมุน log ทุก 10 MB
& $NssmPath set $ServiceNm DisplayName    "PetabyteAi Backend"
& $NssmPath set $ServiceNm Description    "PetabyteAi Express server (port 3001)"

# ── start + โชว์สถานะ ────────────────────────────────────────
& $NssmPath start $ServiceNm
Start-Sleep -Seconds 4
Write-Host ""
& $NssmPath status $ServiceNm

Write-Host ""
Write-Host "ทดสอบ: " -NoNewline
try {
    $r = Invoke-WebRequest -Uri "http://localhost:3001/api/health" -UseBasicParsing -TimeoutSec 5
    Write-Host "/api/health → HTTP $($r.StatusCode) ✓" -ForegroundColor Green
} catch {
    Write-Host "เรียก /api/health ไม่ได้ — ดู log ที่ $LogDir" -ForegroundColor Red
}

Write-Host ""
Write-Host "เสร็จแล้ว. คำสั่งที่ใช้บ่อย:" -ForegroundColor Cyan
Write-Host "  $NssmPath status  $ServiceNm"
Write-Host "  $NssmPath restart $ServiceNm     # หลังแก้ .env"
Write-Host "  $NssmPath stop    $ServiceNm"
Write-Host ""
Write-Host "ขั้นต่อไป: ติดตั้ง Cloudflare Tunnel (ดู docs\deployment-windows.md ขั้นที่ 5)" -ForegroundColor Cyan
