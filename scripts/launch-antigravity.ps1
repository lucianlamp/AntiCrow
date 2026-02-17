# launch-antigravity.ps1
# エフェメラルポート範囲（49152-65535）からランダムに空きポートを選択して
# Antigravity を CDP 有効で起動する。
# 選択したポート番号を cdp_ports/ ディレクトリにファイル書き出し。

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

# 使用中ポートを取得
$usedPorts = @()
try {
    $listening = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue
    $usedPorts = $listening | ForEach-Object { $_.LocalPort }
} catch {
    $usedPorts = @()
}

# エフェメラルポート範囲（49152-65535）からランダムに空きポートを選択
$freePort = $null
$candidates = 49152..65535 | Get-Random -Count 200
foreach ($port in $candidates) {
    if ($usedPorts -notcontains $port) {
        $freePort = $port
        break
    }
}

# エフェメラル範囲で見つからなければ従来の固定範囲にフォールバック
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

# ポート番号をファイルに記録（拡張機能が読み取る）
$cdpPortDir = Join-Path $env:APPDATA "Antigravity\User\globalStorage\ytvar.anti-crow\cdp_ports"
if (-not (Test-Path $cdpPortDir)) {
    New-Item -ItemType Directory -Path $cdpPortDir -Force | Out-Null
}

# 起動
$launchArgs = @("--remote-debugging-port=$freePort")
if ($FolderPath -ne "") {
    $launchArgs += $FolderPath
}
$proc = Start-Process -FilePath $AntigravityExe -ArgumentList $launchArgs -PassThru

# PID ベースのポートファイルを書き出し
$portFile = Join-Path $cdpPortDir "port_$($proc.Id).txt"
Set-Content -Path $portFile -Value $freePort -NoNewline

