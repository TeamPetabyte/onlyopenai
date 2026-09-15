# PetabyteAi - deploy the latest origin/master on the Windows box.
# Run:  powershell -ExecutionPolicy Bypass -File C:\petabyte\onlyopenai-master\windows\deploy.ps1
# npm install only runs when a package-lock.json changed (or node_modules is missing);
# the Vite build always runs because dist/ is gitignored and a stale build is skipped by the server.

$ErrorActionPreference = 'Stop'
$Repo = 'C:\petabyte\onlyopenai-master'
$Nssm = 'C:\petabyte\nssm.exe'
$Svc  = 'PetabyteAi'

Set-Location $Repo
$before = git rev-parse HEAD
git fetch origin
git reset --hard origin/master
$after = git rev-parse HEAD
$changed = @(git diff --name-only $before $after)
Write-Host "deploy $($before.Substring(0,7)) -> $($after.Substring(0,7)), $($changed.Count) file(s) changed"

if (-not (Test-Path 'node_modules') -or ($changed -match '^package-lock\.json$')) {
    Write-Host 'root deps changed -> npm ci --include=dev'
    npm ci --include=dev
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
if (-not (Test-Path 'server\node_modules') -or ($changed -match '^server/package-lock\.json$')) {
    Write-Host 'server deps changed -> npm install --omit=dev'
    Push-Location server
    npm install --omit=dev
    $rc = $LASTEXITCODE
    Pop-Location
    if ($rc -ne 0) { exit $rc }
}

npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& $Nssm restart $Svc
Write-Host "restarted $Svc at $($after.Substring(0,7))"
