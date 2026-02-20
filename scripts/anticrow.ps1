# anticrow.ps1
param(
    [string]$FolderPath = ""
)

$AntigravityExe = Join-Path $env:LOCALAPPDATA "Programs\antigravity\Antigravity.exe"

if (-not (Test-Path $AntigravityExe)) {
    $msg = "Antigravity.exe not found: $AntigravityExe"
    $wsh = New-Object -ComObject Wscript.Shell
    $wsh.Popup($msg, 0, "Antigravity Launch Error", 16)
    exit 1
}

$usedPorts = @()
try {
    $listening = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue
    $usedPorts = $listening | ForEach-Object { $_.LocalPort }
} catch {
    $usedPorts = @()
}

$freePort = $null
$candidates = 49152..65535 | Get-Random -Count 200
foreach ($port in $candidates) {
    if ($usedPorts -notcontains $port) {
        $freePort = $port
        break
    }
}

if (-not $freePort) {
    $fallbackRange = 9000..9005 + 9330..9340
    foreach ($port in $fallbackRange) {
        if ($usedPorts -notcontains $port) {
            $freePort = $port
            break
        }
    }
}

if (-not $freePort) {
    $wsh = New-Object -ComObject Wscript.Shell
    $wsh.Popup("No free port found in ephemeral or fallback range.", 0, "Antigravity Launch Error", 16)
    exit 1
}

$cdpPortDir = Join-Path $env:APPDATA "Antigravity\User\globalStorage\ytvar.anti-crow\cdp_ports"
if (-not (Test-Path $cdpPortDir)) {
    New-Item -ItemType Directory -Path $cdpPortDir -Force | Out-Null
}

$launchArgs = @("--remote-debugging-port=$freePort")
if ($FolderPath -ne "") {
    $launchArgs += $FolderPath
}
$proc = Start-Process -FilePath $AntigravityExe -ArgumentList $launchArgs -PassThru

$portFile = Join-Path $cdpPortDir "port_$($proc.Id).txt"
Set-Content -Path $portFile -Value $freePort -NoNewline

