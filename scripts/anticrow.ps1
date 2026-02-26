# anticrow.ps1
param(
    [string]$FolderPath = "",
    [int]$CdpPort = 9333
)

$AntigravityExe = Join-Path $env:LOCALAPPDATA "Programs\antigravity\Antigravity.exe"

if (-not (Test-Path $AntigravityExe)) {
    $msg = "Antigravity.exe not found: $AntigravityExe"
    $wsh = New-Object -ComObject Wscript.Shell
    $wsh.Popup($msg, 0, "Antigravity Launch Error", 16)
    exit 1
}

# 固定ポートを使用
$freePort = $CdpPort

$cdpPortDir = Join-Path $env:APPDATA "Antigravity\User\globalStorage\lucianlamp.anti-crow\cdp_ports"
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

