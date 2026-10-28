<#
.SYNOPSIS
  One-command Zalo PC → Beeper history import (Windows).

.DESCRIPTION
  Wraps the existing steps so they need no manual key juggling:
    1. preflight: bridge container running, Beeper reachable, node + Git Bash present
    2. Zalo PC: (re)starts it with the local debug port 9229 if needed (asks first)
    3. lists your chats by NAME (from Zalo PC) and lets you pick them
    4. runs migrate-all.sh (export → rebuild in Beeper → verify → delete old room), showing progress
    5. prints the OK / FAIL summary
  Re-running is safe: chats already OK in work\done.txt are skipped.

.EXAMPLE
  pwsh scripts/zalo-pc/import.ps1                       # interactive picker
  pwsh scripts/zalo-pc/import.ps1 -Chats g123,4567     # given thread keys, no picker
  pwsh scripts/zalo-pc/import.ps1 -MediaDir /data/import-media   # with backup media (README step 2)
#>
param(
  # Thread keys to import ("g<groupId>" or a DM peer uid); omit to pick interactively
  [string[]]$Chats,
  # Working dir for exports + run.log + done.txt (gitignored; holds private messages)
  [string]$WorkDir = (Join-Path $PSScriptRoot '..\..\work'),
  # Your own Zalo uid; read from the bridge log when omitted
  [string]$OwnUid,
  # Backup media folder INSIDE the container (see README "Step 2"), optional
  [string]$MediaDir,
  [string]$Container = 'zalo-beeper-bridge',
  [int]$CdpPort = 9229
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$WorkDir = [IO.Path]::GetFullPath($WorkDir)
$cdpUrl = "http://127.0.0.1:$CdpPort/json/list"

function Step($text) { Write-Host "`n▶ $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host "✖ $text" -ForegroundColor Red; exit 1 }
function Test-Url($url) { try { Invoke-WebRequest $url -TimeoutSec 10 -UseBasicParsing | Out-Null; $true } catch { $false } }

# --- 1. preflight -------------------------------------------------------------
Step 'Kiểm tra môi trường'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Không tìm thấy node trong PATH.' }
if (-not (Get-Command podman -ErrorAction SilentlyContinue)) { Fail 'Không tìm thấy podman trong PATH.' }
$state = podman ps --filter "name=^$Container$" --format '{{.Status}}'
if (-not $state) { Fail "Container $Container không chạy — chạy 'podman compose up -d' trước." }
Write-Host "  bridge: $state"
if (-not (Test-Url 'https://matrix.beeper.com/_matrix/client/versions')) { Fail 'Không kết nối được Beeper.' }
# migrate-all.sh is bash: use Git for Windows' bash (WSL bash cannot see podman/node from Windows)
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
$bash = if ($git) { Join-Path (Split-Path (Split-Path $git)) 'bin\bash.exe' }
if (-not $bash -or -not (Test-Path $bash)) { Fail 'Không tìm thấy Git Bash (cài Git for Windows).' }

if (-not $OwnUid) {
  $OwnUid = (podman logs $Container 2>&1 | Select-String 'uid (\d+)' | Select-Object -Last 1).Matches.Groups[1].Value
  if (-not $OwnUid) { Fail 'Không đọc được Zalo uid từ log bridge — truyền -OwnUid <uid>.' }
}
Write-Host "  Zalo uid của bridge: $OwnUid (Zalo PC phải đăng nhập CÙNG account này)"

# --- 2. Zalo PC with the debug port ------------------------------------------------
Step 'Zalo PC'
if (-not (Test-Url $cdpUrl)) {
  $zaloRoot = Join-Path $env:LOCALAPPDATA 'Programs\Zalo'
  $exe = Get-ChildItem $zaloRoot -Directory -Filter 'Zalo-*' -ErrorAction SilentlyContinue |
    Sort-Object { [version]($_.Name -replace '^Zalo-', '') } -Descending |
    ForEach-Object { Join-Path $_.FullName 'Zalo.exe' } | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $exe) { Fail "Không tìm thấy Zalo.exe trong $zaloRoot." }
  if (Get-Process Zalo -ErrorAction SilentlyContinue) {
    $answer = Read-Host '  Zalo PC đang chạy KHÔNG có debug port. Đóng và mở lại? (y/N)'
    if ($answer -notmatch '^[yY]') { Fail 'Đã huỷ. Tự mở lại Zalo PC với --remote-debugging-port=9229 rồi chạy lại.' }
    Get-Process Zalo | Stop-Process -Force
    Start-Sleep -Seconds 3
  }
  Start-Process $exe -ArgumentList "--remote-debugging-port=$CdpPort"
  Write-Host '  Đang chờ Zalo PC khởi động (đăng nhập nếu được hỏi)...'
  $deadline = (Get-Date).AddMinutes(3)
  while (-not (Test-Url $cdpUrl)) {
    if ((Get-Date) -gt $deadline) { Fail 'Zalo PC không mở debug port sau 3 phút.' }
    Start-Sleep -Seconds 3
  }
}
Write-Host "  Zalo PC sẵn sàng trên 127.0.0.1:$CdpPort (chỉ máy này truy cập được)"

# --- 3. pick chats -------------------------------------------------------------
$exportDir = Join-Path $WorkDir 'export'
New-Item -ItemType Directory -Force $exportDir | Out-Null
if (-not $Chats) {
  Step 'Danh sách chat trong Zalo PC'
  node (Join-Path $here 'export-cdp.mjs') $exportDir --list
  if ($LASTEXITCODE) { Fail 'Không đọc được danh sách chat từ Zalo PC.' }
  $meta = Get-Content (Join-Path $exportDir 'conversations.json') -Raw | ConvertFrom-Json
  $nameOf = {
    param($c)
    $id = $c.key -replace '^g', ''
    $n = if ($c.isGroup) { $meta.gmap.$id ?? $meta.gmap.($c.key) } else { $meta.fmap.($c.key) }
    $n ?? '(không tên)'
  }
  $list = @($meta.convs | Sort-Object @{ e = { -not $_.pinned } }, @{ e = { [int]($_.numMsg ?? 0) }; Descending = $true })
  for ($i = 0; $i -lt $list.Count; $i++) {
    $c = $list[$i]
    '{0,4}. {1} {2,-40} {3,7} tin  [{4}]' -f ($i + 1), ($c.isGroup ? '👥' : '👤'), (& $nameOf $c), ($c.numMsg ?? '?'), $c.key
  }
  $pick = Read-Host "`nChọn chat: số/khoảng (vd 1,3,5-8), 'groups', 'dms' hoặc 'all'"
  $Chats = switch -Regex ($pick.Trim()) {
    '^all$' { $list.key }
    '^groups$' { ($list | Where-Object isGroup).key }
    '^dms$' { ($list | Where-Object { -not $_.isGroup }).key }
    default {
      foreach ($part in $pick -split ',') {
        $range = if ($part -match '^\s*(\d+)\s*-\s*(\d+)\s*$') { [int]$Matches[1]..[int]$Matches[2] }
        elseif ($part -match '^\s*(\d+)\s*$') { [int]$Matches[1] }
        # 1-based; out-of-range numbers are ignored (0 must not wrap to the last chat)
        $range | Where-Object { $_ -ge 1 -and $_ -le $list.Count } | ForEach-Object { $list[$_ - 1].key }
      }
    }
  }
  $Chats = @($Chats | Where-Object { $_ })
}
if (-not $Chats) { Fail 'Không có chat nào được chọn.' }
$order = Join-Path $WorkDir 'order.txt'
Set-Content -Path $order -Value $Chats -Encoding utf8NoBOM
Write-Host "  $($Chats.Count) chat → $order"

# --- 4. run the migration --------------------------------------------------------
Step 'Import (export → rebuild trong Beeper → kiểm tra → xoá room cũ)'
$log = Join-Path $WorkDir 'run.log'
$done = Join-Path $WorkDir 'done.txt'
$doneBefore = @(if (Test-Path $done) { Get-Content $done })
# Git Bash takes forward-slash Windows paths; quote each argument (Start-Process joins them with spaces)
$toBash = { param($p) '"{0}"' -f ($p -replace '\\', '/') }
$bashArgs = @((& $toBash (Join-Path $here 'migrate-all.sh')), (& $toBash $WorkDir), (& $toBash $order), $OwnUid)
if ($MediaDir) { $bashArgs += (& $toBash $MediaDir) }
$script:logSeen = if (Test-Path $log) { @(Get-Content $log).Count } else { 0 }
# Prints the new progress lines of run.log ("=== [n/total] key", the importer verdict, waits)
function Show-Progress {
  if (-not (Test-Path $log)) { return }
  $lines = @(Get-Content $log)
  if ($lines.Count -gt $script:logSeen) {
    $lines[$script:logSeen..($lines.Count - 1)] | Where-Object { $_ -match '^===|^\[import\] done|^--- waiting' } |
      ForEach-Object { Write-Host "  $_" }
  }
  $script:logSeen = $lines.Count
}
$proc = Start-Process $bash -ArgumentList $bashArgs -NoNewWindow -PassThru
while (-not $proc.HasExited) { Start-Sleep -Seconds 2; Show-Progress }
Show-Progress

# --- 5. summary ---------------------------------------------------------------
Step 'Kết quả'
$new = @(Get-Content $done | Select-Object -Skip $doneBefore.Count)
$ok = @($new | Where-Object { $_ -like 'OK *' }).Count
$failed = @($new | Where-Object { $_ -like 'FAIL *' })
Write-Host "  OK: $ok   FAIL: $($failed.Count)   (chi tiết: $log)"
$failed | ForEach-Object { Write-Host "  $_ — chạy lại script để thử lại, room cũ vẫn được giữ" -ForegroundColor Yellow }
Write-Host "`nLưu ý: debug port của Zalo PC vẫn mở. Thoát Zalo PC và mở lại bình thường khi xong." -ForegroundColor DarkGray
