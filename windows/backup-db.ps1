# PetabyteAi - daily PostgreSQL backup: pg_dump (custom format) -> C:\petabyte\backups, เก็บ 30 วัน, log ที่ backup.log
# credentials อ่านจาก server\.env (repo เป็น public - ห้าม hardcode รหัสผ่านในไฟล์นี้)
# ตั้งเวลา (PowerShell แบบ Run as Administrator):
#   schtasks /Create /F /TN "PetabyteAi DB Backup" /SC WEEKLY /D MON /ST 02:00 /RU SYSTEM `
#     /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\petabyte\onlyopenai-master\windows\backup-db.ps1"
# กู้คืน: pg_restore -h localhost -U <DB_USER> -d OpenAI_DB -c "C:\petabyte\backups\OpenAI_DB_<date>.dump"
# สตริงในโค้ดเป็น ASCII ล้วนโดยตั้งใจ - Windows PowerShell 5.1 อ่าน non-ASCII ผิดแล้ว parser พัง

# --- ปรับ path ให้ตรงเครื่อง ---
$RepoDir   = "C:\petabyte\onlyopenai-master"
$BackupDir = "C:\petabyte\backups"          # อยู่นอกโฟลเดอร์ repo — git reset จะไม่แตะ
$KeepDays  = 30

# --- ไม่ต้องแก้ใต้บรรทัดนี้ ---
$EnvFile = Join-Path $RepoDir "server\.env"
$LogFile = Join-Path $BackupDir "backup.log"

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

function Write-Log($msg) {
    $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Add-Content -Path $LogFile -Value $line
    Write-Host $line
}

# --- 1) อ่าน credentials จาก server\.env ---
# .Trim() จำเป็น: .env บน Windows มักเป็น CRLF, ไม่ trim แล้ว password จะมี \r ติดท้าย
if (-not (Test-Path $EnvFile)) { Write-Log "ERROR: env file not found: $EnvFile"; exit 1 }
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
if (-not $envMap['DB_PASS']) { Write-Log "ERROR: DB_PASS not found in .env"; exit 1 }

# --- 2) หา pg_dump.exe ---
$pgDump = Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\pg_dump.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1
if (-not $pgDump) { Write-Log "ERROR: pg_dump.exe not found under C:\Program Files\PostgreSQL\*\bin"; exit 1 }

# --- 3) dump ---
$stamp   = Get-Date -Format "yyyyMMdd-HHmm"
$outFile = Join-Path $BackupDir ("{0}_{1}.dump" -f $dbName, $stamp)
$env:PGPASSWORD = $envMap['DB_PASS']
try {
    & $pgDump.FullName -h $dbHost -p $dbPort -U $dbUser -F c -f $outFile $dbName
    if ($LASTEXITCODE -ne 0) { Write-Log "ERROR: pg_dump failed (exit $LASTEXITCODE)"; exit 1 }
} finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue   # อย่าทิ้งรหัสไว้ใน env
}
$sizeKb = [math]::Round((Get-Item $outFile).Length / 1KB, 0)
Write-Log ("OK: backup done -> {0} ({1} KB)" -f (Split-Path $outFile -Leaf), $sizeKb)

# --- 4) retention: ลบไฟล์เก่ากว่า $KeepDays วัน ---
$old = Get-ChildItem $BackupDir -Filter "*.dump" |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) }
if ($old) {
    $old | Remove-Item -Force
    Write-Log ("CLEAN: removed {0} old backup(s) (older than {1} days)" -f $old.Count, $KeepDays)
}

# --- 5) สรุปสถานะพื้นที่ ---
$all = Get-ChildItem $BackupDir -Filter "*.dump"
$totalMb = [math]::Round(($all | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Log ("TOTAL: {0} backup file(s), {1} MB" -f $all.Count, $totalMb)
