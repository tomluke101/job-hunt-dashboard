# Daily backup of the HuntHQ Supabase database -> OneDrive (cloud-synced).
# Runs the repo's logical export (scripts/backup-db.ts): every table to gzipped
# JSON, embeddings excluded (reproducible), 14-day rotation.
# Registered as scheduled task "ClaudeBrain-HuntHQDbBackup". Set up 2026-07-18.
$repo = "C:\Users\tomlu\OneDrive\Desktop\Money\Job hunt SaaS\job-hunt-dashboard"
$log  = "C:\Users\tomlu\OneDrive\Desktop\Money\Claude Brain\backup_hunthq_db.log"
# Scheduled tasks get a minimal PATH; make sure Node is on it.
$env:PATH = "C:\Program Files\nodejs;$env:PATH"
$npx = "C:\Program Files\nodejs\npx.cmd"   # full path — don't depend on PATH resolution
try {
    Set-Location $repo
    $out = & $npx tsx scripts/backup-db.ts 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0) {
        $line = ($out -split "`n" | Where-Object { $_ -match "Backup complete" } | Select-Object -Last 1).Trim()
        if (-not $line) { $line = "completed" }
        "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') OK - $line" | Out-File -FilePath $log -Append -Encoding utf8
    } else {
        $tail = ($out -split "`n" | Select-Object -Last 3) -join " | "
        "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ERROR exit=$LASTEXITCODE - $tail" | Out-File -FilePath $log -Append -Encoding utf8
    }
} catch {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ERROR - $_" | Out-File -FilePath $log -Append -Encoding utf8
}
