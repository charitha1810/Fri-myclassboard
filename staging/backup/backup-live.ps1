# Snapshots the LIVE site into backup\<timestamp>\ : code + web.config + backend\.env (site.zip),
# the portal database (mcb_portal.dump), the exact package versions (requirements.lock.txt),
# every file's hash (files.sha256) and CHANGES.md: that day's notes from the site's CHANGES.md plus
# the files added / changed / removed since the previous snapshot.
# Usage:  powershell -ExecutionPolicy Bypass -File staging\backup\backup-live.ps1 [-Force]
#         powershell -ExecutionPolicy Bypass -File staging\backup\backup-live.ps1 -NotesOnly   (rewrite CHANGES.md in every snapshot)
# Run it before and after every change to live. It does nothing when the live code is identical
# to the newest snapshot, so the newest snapshot always matches live and the older ones are rollback points.
param(
  [switch]$Force,
  [switch]$NotesOnly
)
$ErrorActionPreference = "Stop"
# The site root is the nearest folder above this script that holds web.config and the live app folder,
# so the script keeps backing up LIVE wherever the backup folder is moved inside the site.
$site = $PSScriptRoot
while ($site -and -not ((Test-Path (Join-Path $site "web.config")) -and (Test-Path (Join-Path $site "fri.myclassboard.com\backend")))) {
  $site = Split-Path -Parent $site
}
if (-not $site) { throw "Could not find the site root (web.config + fri.myclassboard.com\backend) above $PSScriptRoot." }
$backend = Join-Path $site "fri.myclassboard.com\backend"
$py = Join-Path $backend ".venv\Scripts\python.exe"
$changelog = Join-Path $site "CHANGES.md"

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# ---------------- snapshot notes (CHANGES.md in each snapshot) ----------------
# path -> SHA256 of every file in a snapshot: from files.sha256, or (older snapshots) from site.zip itself.
function Get-SnapshotFiles($dir) {
  $map = @{}
  $list = Join-Path $dir "files.sha256"
  if (Test-Path $list) {
    foreach ($l in Get-Content $list) { $p = $l.Split("|"); if ($p.Count -eq 2) { $map[$p[0]] = $p[1] } }
    return $map
  }
  $zipPath = Join-Path $dir "site.zip"
  if (-not (Test-Path $zipPath)) { return $null }
  $sha = [Security.Cryptography.SHA256]::Create()
  $z = [IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    foreach ($e in $z.Entries) {
      if ($e.FullName.EndsWith("/")) { continue }
      $s = $e.Open(); try { $map[$e.FullName] = [BitConverter]::ToString($sha.ComputeHash($s)).Replace("-", "") } finally { $s.Dispose() }
    }
  } finally { $z.Dispose() }
  return $map
}

# The "## yyyy-MM-dd" section of the site's CHANGES.md (without its heading), or $null.
function Get-DayNotes([string]$day) {
  if (-not (Test-Path $changelog)) { return $null }
  $out = @(); $on = $false
  foreach ($l in Get-Content $changelog -Encoding UTF8) {
    if ($l -match '^## (\d{4}-\d{2}-\d{2})') { if ($on) { break }; $on = ($Matches[1] -eq $day); continue }
    if ($on) { $out += $l }
  }
  if ($on -or $out.Count) { return ($out -join "`n").Trim() }
  return $null
}

function Write-SnapshotNotes($dir, $prevDir) {
  $name = Split-Path $dir -Leaf
  $when = [datetime]::ParseExact($name, "yyyyMMdd-HHmmss", $null)
  $day = $when.ToString("yyyy-MM-dd")
  $cur = Get-SnapshotFiles $dir
  $md = @("# Backup $name", "", "Taken: $($when.ToString('yyyy-MM-dd HH:mm:ss')) (server time)", "")
  $md += "## Changes done on $day", ""
  $notes = Get-DayNotes $day
  $md += $(if ($notes) { $notes } else { "_No description recorded for this day in CHANGES.md._" })
  $md += "", "## Files changed in this snapshot", ""
  if ($null -eq $cur) {
    $md += "_site.zip is missing, so the files cannot be listed._"
  } elseif (-not $prevDir) {
    $md += "First snapshot: $($cur.Count) files."
  } else {
    $prev = Get-SnapshotFiles $prevDir
    $prevName = Split-Path $prevDir -Leaf
    $added = @($cur.Keys | Where-Object { -not $prev.ContainsKey($_) } | Sort-Object)
    $removed = @($prev.Keys | Where-Object { -not $cur.ContainsKey($_) } | Sort-Object)
    $changed = @($cur.Keys | Where-Object { $prev.ContainsKey($_) -and $prev[$_] -ne $cur[$_] } | Sort-Object)
    $md += "Compared with the previous snapshot, $prevName."
    $md += ""
    if (-not ($added.Count + $removed.Count + $changed.Count)) { $md += "No file changes (taken with -Force, or only the portal database differs)." }
    foreach ($g in @(@("Changed", $changed), @("Added", $added), @("Removed", $removed))) {
      if ($g[1].Count) { $md += "**$($g[0])** ($($g[1].Count)):"; $md += ($g[1] | ForEach-Object { "- ``$_``" }); $md += "" }
    }
  }
  $md += "", "Restore: unzip site.zip over the site folder, restore mcb_portal.dump with pg_restore, then restart the app pool."
  [IO.File]::WriteAllText((Join-Path $dir "CHANGES.md"), (($md -join "`n").TrimEnd() + "`n"), (New-Object Text.UTF8Encoding $false))
}

$snapshots = @(Get-ChildItem $PSScriptRoot -Directory | Where-Object { $_.Name -match '^\d{8}-\d{6}$' } | Sort-Object Name)

if ($NotesOnly) {
  for ($i = 0; $i -lt $snapshots.Count; $i++) {
    Write-SnapshotNotes $snapshots[$i].FullName $(if ($i) { $snapshots[$i - 1].FullName } else { $null })
  }
  Write-Output "CHANGES.md written in $($snapshots.Count) snapshots."
  return
}

# ---------------- snapshot ----------------
# Live files only: not the virtualenv, caches, logs, the staging copy, the backups, git's own folder or the changelog.
$files = Get-ChildItem $site -Recurse -File -Force | Where-Object {
  $rel = $_.FullName.Substring($site.Length + 1)
  $rel -notmatch '^(staging|backup|logs|\.git)\\' -and $rel -notmatch '(^|\\)(\.venv|__pycache__)\\' -and $rel -ne 'CHANGES.md'
} | Sort-Object FullName

# One fingerprint for the whole of live: every file's path and content hash.
$lines = $files | ForEach-Object { $_.FullName.Substring($site.Length + 1) + "|" + (Get-FileHash $_.FullName -Algorithm SHA256).Hash }
$sha = [Security.Cryptography.SHA256]::Create()
$fingerprint = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($lines -join "`n"))).Replace("-", "")

$latest = $snapshots | Select-Object -Last 1
if ($latest -and -not $Force) {
  $mark = Join-Path $latest.FullName "live.sha256"
  if ((Test-Path $mark) -and ((Get-Content $mark -TotalCount 1).Trim() -eq $fingerprint)) {
    Write-SnapshotNotes $latest.FullName $(if ($snapshots.Count -gt 1) { $snapshots[-2].FullName } else { $null })   # pick up new CHANGES.md notes
    Write-Output "Live is unchanged since $($latest.FullName.Substring($site.Length + 1)); nothing to do."
    return
  }
}

$dest = Join-Path $PSScriptRoot (Get-Date -Format "yyyyMMdd-HHmmss")
New-Item -ItemType Directory -Force $dest | Out-Null

$zip = [IO.Compression.ZipFile]::Open((Join-Path $dest "site.zip"), "Create")
try {
  foreach ($f in $files) {
    $rel = $f.FullName.Substring($site.Length + 1).Replace("\", "/")
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $rel, "Optimal") | Out-Null
  }
} finally { $zip.Dispose() }
$lines | ForEach-Object { $_.Replace("\", "/") } | Out-File -Encoding ascii (Join-Path $dest "files.sha256")

& $py -m pip freeze | Out-File -Encoding ascii (Join-Path $dest "requirements.lock.txt")
& $py (Join-Path $PSScriptRoot "dump_portal_db.py") (Join-Path $backend ".env") (Join-Path $dest "mcb_portal.dump")
if ($LASTEXITCODE -ne 0) { throw "Portal database dump failed; see the message above." }

Write-SnapshotNotes $dest $(if ($latest) { $latest.FullName } else { $null })
# Written last: a snapshot without this file is incomplete and is never treated as current.
$fingerprint | Out-File -Encoding ascii (Join-Path $dest "live.sha256")
Write-Output "Backup written to $($dest.Substring($site.Length + 1)) ($($files.Count) files)."
