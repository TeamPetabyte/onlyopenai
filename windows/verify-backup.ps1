# verify-backup.ps1 - prove the DB backup is really happening. Run ON THE SERVER:
#
#   powershell -ExecutionPolicy Bypass -File C:\petabyte\onlyopenai-master\windows\verify-backup.ps1
#   add -RestoreTest to also restore the newest dump into a scratch database, then drop it
#
# Checks, in order:
#   1. the scheduled task "PetabyteAi DB Backup" exists, is enabled, and its last run exited 0
#   2. the newest .dump in C:\petabyte\backups is younger than -MaxAgeHours (default 26)
#   3. pg_restore --list can read that dump (archive is intact)
#   4. (-RestoreTest) restore into <DB_NAME>_restoretest, count tbl_user rows, drop it again
# Exit 0 = all good, 1 = something to fix. Nothing here touches the live database.
# ASCII only on purpose - Windows PowerShell 5.1 mis-reads non-ASCII source files.

param(
    [string]$BackupDir = "C:\petabyte\backups",
    [string]$RepoDir   = "C:\petabyte\onlyopenai-master",
    [string]$TaskName  = "PetabyteAi DB Backup",
    [int]$MaxAgeHours  = 26,
    [string]$PgBin     = "",      # folder holding pg_restore.exe/psql.exe; default: newest under C:\Program Files\PostgreSQL
    [switch]$RestoreTest
)
$fail = 0
function Ok($m)   { Write-Host ("  OK   " + $m) -ForegroundColor Green }
function Bad($m)  { Write-Host ("  FAIL " + $m) -ForegroundColor Red; $script:fail++ }
function Info($m) { Write-Host ("  ...  " + $m) }

Write-Host "1) scheduled task"
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    Bad "task '$TaskName' is not registered. Register it (PowerShell as Administrator):"
    Write-Host ('     schtasks /Create /F /TN "' + $TaskName + '" /SC DAILY /ST 02:00 /RU SYSTEM /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ' + $RepoDir + '\windows\backup-db.ps1"')
} else {
    if ($task.State -eq 'Disabled') { Bad "task exists but is disabled" } else { Ok ("task registered, state " + $task.State) }
    $info = $task | Get-ScheduledTaskInfo
    if ($info.LastRunTime -lt (Get-Date).AddYears(-10)) { Bad "task has never run - run it once: schtasks /Run /TN `"$TaskName`"" }
    elseif ($info.LastTaskResult -ne 0) { Bad ("last run at " + $info.LastRunTime + " returned " + $info.LastTaskResult + " - see " + (Join-Path $BackupDir "backup.log")) }
    else { Ok ("last run " + $info.LastRunTime + " exit 0, next run " + $info.NextRunTime) }
}

Write-Host "2) newest dump"
$dump = Get-ChildItem $BackupDir -Filter "*.dump" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $dump) { Bad "no .dump files in $BackupDir" }
else {
    $age = (Get-Date) - $dump.LastWriteTime
    $sizeMb = [math]::Round($dump.Length / 1MB, 1)
    if ($age.TotalHours -gt $MaxAgeHours) { Bad ("newest dump " + $dump.Name + " is " + [math]::Round($age.TotalHours) + "h old (limit " + $MaxAgeHours + "h)") }
    elseif ($dump.Length -lt 10KB) { Bad ("newest dump " + $dump.Name + " is only " + $dump.Length + " bytes") }
    else { Ok ($dump.Name + ", " + $sizeMb + " MB, " + [math]::Round($age.TotalHours, 1) + "h old") }
}
$logFile = Join-Path $BackupDir "backup.log"
if (Test-Path $logFile) { Info "last log lines:"; Get-Content $logFile -Tail 3 | ForEach-Object { Write-Host ("       " + $_) } }

Write-Host "3) archive readable"
if ($PgBin) { $pgRestore = Get-Item (Join-Path $PgBin "pg_restore.exe") -ErrorAction SilentlyContinue }
else { $pgRestore = Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\pg_restore.exe" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1 }
if (-not $pgRestore) { Bad "pg_restore.exe not found (looked in " + $(if ($PgBin) { $PgBin } else { 'C:\Program Files\PostgreSQL\*\bin' }) + ") - pass -PgBin <folder>" }
elseif ($dump) {
    $listing = & $pgRestore.FullName --list $dump.FullName 2>&1
    if ($LASTEXITCODE -ne 0) { Bad ("pg_restore --list failed: " + ($listing | Select-Object -Last 1)) }
    else {
        $tables = @($listing | Where-Object { $_ -match ' TABLE DATA ' }).Count
        if ($tables -eq 0) { Bad "archive lists no TABLE DATA entries" } else { Ok ("archive intact, " + $tables + " tables with data") }
    }
}

if ($RestoreTest -and $dump -and $pgRestore) {
    Write-Host "4) restore test"
    # credentials come from server\.env exactly like backup-db.ps1; never from this file
    $envMap = @{}
    Get-Content (Join-Path $RepoDir "server\.env") | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) { $k, $v = $line.Split('=', 2); $envMap[$k.Trim()] = $v.Trim() }
    }
    $dbHost = 'localhost'; if ($envMap['DB_HOST']) { $dbHost = $envMap['DB_HOST'] }
    $dbPort = '5432';      if ($envMap['DB_PORT']) { $dbPort = $envMap['DB_PORT'] }
    $dbUser = 'postgres';  if ($envMap['DB_USER']) { $dbUser = $envMap['DB_USER'] }
    $dbName = 'OpenAI_DB'; if ($envMap['DB_NAME']) { $dbName = $envMap['DB_NAME'] }
    # lowercase + unquoted on purpose: PowerShell 5.1 mangles embedded double quotes in native args
    $scratch = ($dbName + "_restoretest").ToLower()
    $psql = Join-Path $pgRestore.DirectoryName "psql.exe"
    $env:PGPASSWORD = $envMap['DB_PASS']
    try {
        & $psql -h $dbHost -p $dbPort -U $dbUser -d postgres -q -c "DROP DATABASE IF EXISTS $scratch" 2>&1 | Out-Null
        & $psql -h $dbHost -p $dbPort -U $dbUser -d postgres -q -c "CREATE DATABASE $scratch" 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { Bad "could not create scratch database $scratch" }
        else {
            # warnings about missing roles are normal here; the row count below is the verdict
            & $pgRestore.FullName -h $dbHost -p $dbPort -U $dbUser -d $scratch --no-owner --no-privileges $dump.FullName 2>&1 | Out-Null
            $users = & $psql -h $dbHost -p $dbPort -U $dbUser -d $scratch -Atc "SELECT count(*) FROM tbl_user" 2>&1
            if ("$users" -match '^\d+$' -and [int]$users -gt 0) { Ok ("restored into " + $scratch + ": " + $users + " rows in tbl_user") }
            else { Bad ("restore into " + $scratch + " did not yield tbl_user rows: " + $users) }
            & $psql -h $dbHost -p $dbPort -U $dbUser -d postgres -q -c "DROP DATABASE IF EXISTS $scratch" 2>&1 | Out-Null
        }
    } finally { Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue }
}

Write-Host ""
if ($fail -eq 0) { Write-Host "BACKUP OK" -ForegroundColor Green; exit 0 }
Write-Host ("BACKUP NEEDS ATTENTION: " + $fail + " problem(s) above") -ForegroundColor Red
exit 1
