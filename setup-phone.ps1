<#
  ニュースボード: スマホ（Tailscale）から開けるようにする初回設定

  1. ニュースボードが Tailscale 経由のアクセスを受け付けられるよう、URL予約を追加（管理者の確認が1回出ます）
  2. Tailscale Serve で、Tailscale の自分の端末からのアクセスだけを PC 内のニュースボードに中継
  一度設定すれば、PC を再起動しても有効です。
  元に戻すときは:  setup-phone.bat -Remove
#>
param(
  [int]$Port = 8765,
  [int]$ServePort = 80,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$ts = [IO.Path]::Combine($env:ProgramFiles, 'Tailscale\tailscale.exe')
$reservation = "http://+:$Port/"

function Test-Reservation {
  $out = (& netsh.exe http show urlacl url=$reservation) -join "`n"
  return $out.Contains($reservation)
}

function Invoke-Elevated([string]$Arguments) {
  Write-Host '  管理者の確認画面が出たら「はい」を押してください。' -ForegroundColor Yellow
  $p = Start-Process -FilePath 'netsh.exe' -ArgumentList $Arguments -Verb RunAs -Wait -PassThru -WindowStyle Hidden
  return $p.ExitCode
}

if (-not (Test-Path $ts)) {
  Write-Host 'Tailscale が見つかりません。先に https://tailscale.com/download からインストールしてください。' -ForegroundColor Red
  exit 1
}

# ---------------------------------------------------------------- 解除
if ($Remove) {
  & $ts serve reset
  if (Test-Reservation) {
    try { [void](Invoke-Elevated "http delete urlacl url=$reservation") } catch { Write-Host "URL予約の削除を中止しました: $($_.Exception.Message)" -ForegroundColor Yellow }
  }
  Write-Host 'スマホ用の設定を解除しました。次回の start.bat 起動から、このPCだけで動きます。' -ForegroundColor Green
  exit 0
}

# ---------------------------------------------------------------- 設定
$state = (& $ts status --json | ConvertFrom-Json).BackendState
if ($state -ne 'Running') {
  Write-Host 'Tailscale にログインしていません。通知領域の Tailscale アイコンからログインしてください。' -ForegroundColor Red
  exit 1
}

Write-Host '[1/2] URL予約' -ForegroundColor Cyan
if (Test-Reservation) {
  Write-Host '  設定済みです。'
} else {
  # 自分のユーザーだけに許可する（SID で指定）
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  try {
    [void](Invoke-Elevated "http add urlacl url=$reservation sddl=D:(A;;GX;;;$sid)")
  } catch {
    Write-Host "  中止されました: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
  }
  if (-not (Test-Reservation)) { Write-Host '  URL予約を追加できませんでした。' -ForegroundColor Red; exit 1 }
  Write-Host '  追加しました。'
}

Write-Host '[2/2] Tailscale Serve' -ForegroundColor Cyan
& $ts serve --bg --http=$ServePort "http://127.0.0.1:$Port"
if ($LASTEXITCODE -ne 0) { Write-Host '  Tailscale Serve を設定できませんでした。' -ForegroundColor Red; exit 1 }

# Serve はアクセス先の名前で振り分けるので、MagicDNS 名（xxx.ts.net）で案内する
$dnsName = ((& $ts status --json | ConvertFrom-Json).Self.DNSName).TrimEnd('.')
$phoneUrl = if ($ServePort -eq 80) { "http://$dnsName/" } else { "http://${dnsName}:$ServePort/" }
Write-Host ''
Write-Host '設定が完了しました。' -ForegroundColor Green
Write-Host '  1. start.bat でニュースボードを起動（すでに起動中なら、黒いウィンドウを閉じて起動し直す）'
Write-Host '  2. スマホで Tailscale を接続した状態で、ブラウザで次のアドレスを開く'
Write-Host "       $phoneUrl" -ForegroundColor Cyan
