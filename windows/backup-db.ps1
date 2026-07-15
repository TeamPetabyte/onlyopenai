# ╔═══════════════════════════════════════════════════════════╗
# ║ PetabyteAi — daily PostgreSQL backup (pg_dump + retention) ║
# ╚═══════════════════════════════════════════════════════════╝
# ตั้งเวลารันอัตโนมัติทุกวัน (สั่งครั้งเดียว ใน PowerShell แบบ Run as Administrator):
#
#   schtasks /Create /F /TN "PetabyteAi DB Backup" /SC DAILY /ST 02:00 /RU SYSTEM `
#     /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\petabyte\onlyopenai-master\windows\backup-db.ps1"
#
# ทดสอบรันมือ:  powershell -ExecutionPolicy Bypass -File .\backup-db.ps1
#
# สิ่งที่สคริปต์ทำ:
#   - อ่าน DB_HOST/PORT/NAME/USER/PASS จาก server\.env (ไม่มี secret ในไฟล์นี้ —
#     repo เป็น public ห้าม hardcode รหัสผ่านเด็ดขาด)
#   - pg_dump แบบ custom format (-F c, บีบอัดในตัว) → C:\petabyte\backups\
#   - ลบ backup ที่เก่ากว่า 30 วัน
#   - เขียน log ที่ C:\petabyte\backups\backup.log
#
# กู้คืน (restore):
#   pg_restore -h localhost -U <DB_USER> -d OpenAI_DB -c "C:\petabyte\backups\OpenAI_DB_<วันที่>.dump"
#   (-c = ล้าง object เดิมก่อนสร้างใหม่ — ใช้กับ DB เดิมที่พังครึ่งๆ กลางๆ)

# ── ปรับ path ตรงนี้ให้ตรงเครื่อง ─────────────────────────────
$RepoDir   = "C:\petabyte\onlyopenai-master"
$BackupDir = "C:\petabyte\backups"          # อยู่นอกโฟลเดอร์ repo — git reset จะไม่แตะ
$KeepDays  = 30

# ── ไม่ต้องแก้ใต้บรรทัดนี้ ───────────────────────────────────
$EnvFile = Join-Path $RepoDir "server\.env"
$LogFile = Join-Path $BackupDir "backup.log"

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

function Write-Log($msg) {
    $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Add-Content -Path $LogFile -Value $line
    Write-Host $line
}

# ── 1) อ่าน credentials จาก server\.env ──────────────────────
# หมายเหตุ: .Trim() สำคัญมาก — ไฟล์ .env บน Windows มักเป็น CRLF
# ถ้าไม่ trim ค่า password จะมี \r ติดท้ายแล้วต่อ DB ไม่ได้แบบเงียบๆ
if (-not (Test-Path $EnvFile)) { Write-Log "✗ ไม่พบ $EnvFile"; exit 1 }
$envMap = @{}
Get-Content $EnvFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
        $k, $v = $line.Split('=', 2)
        $envMap[$k.Trim()] = $v.Trim()
    }
}
$dbHost = if ($envMap['DB_HOST']) { $envMap['DB_HOST'] } else { 'localhost' }
$dbPort = if ($envMap['DB_PORT']) { $envMap['DB_PORT'] } else { '5432' }
$dbName = if ($envMap['DB_NAME']) { $envMap['DB_NAME'] } else { 'OpenAI_DB' }
$dbUser = if ($envMap['DB_USER']) { $envMap['DB_USER'] } else { 'postgres' }
if (-not $envMap['DB_PASS']) { Write-Log "✗ ไม่พบ DB_PASS ใน .env"; exit 1 }

# ── 2) หา pg_dump.exe (มากับตัวติดตั้ง PostgreSQL) ───────────
$pgDump = Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\pg_dump.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1
if (-not $pgDump) { Write-Log "✗ ไม่พบ pg_dump.exe ใน C:\Program Files\PostgreSQL\*\bin"; exit 1 }

# ── 3) dump ──────────────────────────────────────────────────
$stamp   = Get-Date -Format "yyyyMMdd-HHmm"
$outFile = Join-Path $BackupDir ("{0}_{1}.dump" -f $dbName, $stamp)
$env:PGPASSWORD = $envMap['DB_PASS']
try {
    & $pgDump.FullName -h $dbHost -p $dbPort -U $dbUser -F c -f $outFile $dbName
    if ($LASTEXITCODE -ne 0) { Write-Log "✗ pg_dump ล้มเหลว (exit $LASTEXITCODE)"; exit 1 }
} finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue   # อย่าทิ้งรหัสไว้ใน env
}
$sizeKb = [math]::Round((Get-Item $outFile).Length / 1KB, 0)
Write-Log ("✓ backup สำเร็จ → {0} ({1} KB)" -f (Split-Path $outFile -Leaf), $sizeKb)

# ── 4) retention: ลบไฟล์เก่ากว่า $KeepDays วัน ────────────────
$old = Get-ChildItem $BackupDir -Filter "*.dump" |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) }
if ($old) {
    $old | Remove-Item -Force
    Write-Log ("🧹 ลบ backup เก่า {0} ไฟล์ (เกิน {1} วัน)" -f $old.Count, $KeepDays)
}

# ── 5) สรุปสถานะพื้นที่ ──────────────────────────────────────
$all = Get-ChildItem $BackupDir -Filter "*.dump"
$totalMb = [math]::Round(($all | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Log ("📦 ตอนนี้มี backup {0} ไฟล์ รวม {1} MB" -f $all.Count, $totalMb)
