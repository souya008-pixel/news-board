<#
  ニュースボード - ローカルサーバー

  国内外のニュース（RSS）とマーケット指数を取得し、http://localhost:8765/ で表示します。
  通常は start.bat から起動してください。
  このウィンドウを閉じる（または Ctrl+C）と終了します。

  -Export <フォルダ> を付けると、サーバーは起動せず news.json / quotes.json を書き出して終了します
  （GitHub Actions で GitHub Pages 用のデータを作るときに使います）。
#>
param(
  [int]$Port = 8765,
  [switch]$NoBrowser,
  [string]$Export = ''
)

$ErrorActionPreference = 'Stop'

$Root       = Split-Path -Parent $MyInvocation.MyCommand.Path
$PublicDir  = [IO.Path]::GetFullPath([IO.Path]::Combine($Root, 'public'))
$ConfigPath = [IO.Path]::Combine($Root, 'config.json')
$HealthText = 'newsboard-ok'

try { $Host.UI.RawUI.WindowTitle = 'ニュースボード（閉じると終了します）' } catch { }

# ---------------------------------------------------------------- ネットワーク
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
} catch {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}
Add-Type -AssemblyName System.Net.Http
Add-Type -AssemblyName System.Web.Extensions

$Json = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$Json.MaxJsonLength = [int]::MaxValue

$Handler = New-Object System.Net.Http.HttpClientHandler
$Handler.AutomaticDecompression = [Net.DecompressionMethods]::GZip -bor [Net.DecompressionMethods]::Deflate
$Http = New-Object System.Net.Http.HttpClient($Handler)
$Http.Timeout = [TimeSpan]::FromSeconds(15)
[void]$Http.DefaultRequestHeaders.TryAddWithoutValidation('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')
[void]$Http.DefaultRequestHeaders.TryAddWithoutValidation('Accept-Language', 'ja,en;q=0.8')

$Mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.ico'  = 'image/x-icon'
}
$HtmlCsp = "default-src 'self'; img-src 'self' https: http: data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

$script:Cache     = @{}
$script:NewsJob   = $null
$script:QuotesJob = $null

# ---------------------------------------------------------------- 共通
function Write-Log([string]$Message, [string]$Color = 'Gray') {
  Write-Host ('[{0}] {1}' -f (Get-Date).ToString('HH:mm:ss'), $Message) -ForegroundColor $Color
}

function Get-Opt($Dict, [string]$Key, $Default = $null) {
  if ($null -ne $Dict -and $Dict.ContainsKey($Key) -and $null -ne $Dict[$Key]) { return $Dict[$Key] }
  return $Default
}

function Read-Config {
  $text = [IO.File]::ReadAllText($ConfigPath, [Text.Encoding]::UTF8)
  try {
    return $Json.DeserializeObject($text)
  } catch {
    throw "config.json の書式に誤りがあります: $($_.Exception.Message)"
  }
}

function Get-Cached([string]$Key, [int]$MaxAgeSec) {
  $e = $script:Cache[$Key]
  if ($e -and ((Get-Date) - $e.Time).TotalSeconds -lt $MaxAgeSec) { return $e.Body }
  return $null
}

function Set-Cached([string]$Key, [string]$Body) {
  if ($script:Cache.Count -gt 80) { $script:Cache.Clear() }
  $script:Cache[$Key] = @{ Time = Get-Date; Body = $Body }
}

function Get-GoogleNewsUrl([string]$Query) {
  return 'https://news.google.com/rss/search?q=' + [Uri]::EscapeDataString($Query) + '&hl=ja&gl=JP&ceid=JP:ja'
}

function Get-FeedUrl($Feed) {
  $q = [string](Get-Opt $Feed 'googleQuery' '')
  if ($q) { return Get-GoogleNewsUrl $q }
  return [string](Get-Opt $Feed 'url' '')
}

function Get-ExcludeRegex($Cfg) {
  if (-not $Cfg.ContainsKey('excludeTitles') -or -not $Cfg['excludeTitles']) { return $null }
  $parts = @($Cfg['excludeTitles'] | Where-Object { $_ } | ForEach-Object { [regex]::Escape([string]$_) })
  if ($parts.Count -eq 0) { return $null }
  return New-Object regex(($parts -join '|'))
}

# ---------------------------------------------------------------- 並列ダウンロード
function Start-FetchAll([string[]]$Urls) {
  $tasks = [System.Collections.Generic.List[System.Threading.Tasks.Task]]::new()
  foreach ($u in $Urls) {
    try {
      $tasks.Add($Http.GetAsync($u))
    } catch {
      $tasks.Add([System.Threading.Tasks.Task]::FromException((New-Object Exception("URLが不正です: $u"))))
    }
  }
  return ,$tasks
}

function Wait-FetchAll($Tasks, [int]$TimeoutMs = 25000) {
  try { [void][System.Threading.Tasks.Task]::WaitAll($Tasks.ToArray(), $TimeoutMs) } catch { }
  $results = [System.Collections.Generic.List[object]]::new()
  foreach ($t in $Tasks) {
    $r = @{ Ok = $false; Bytes = $null; Error = '' }
    if ($t.Status -eq [System.Threading.Tasks.TaskStatus]::RanToCompletion) {
      $resp = $t.Result
      try {
        if ($resp.IsSuccessStatusCode) {
          $r.Bytes = $resp.Content.ReadAsByteArrayAsync().Result
          $r.Ok = $true
        } else {
          $r.Error = 'HTTP ' + [int]$resp.StatusCode
        }
      } finally { $resp.Dispose() }
    } elseif ($t.IsFaulted) {
      $ex = $t.Exception.GetBaseException()
      $r.Error = [string]$ex.Message
    } else {
      $r.Error = 'タイムアウト'
    }
    $results.Add($r)
  }
  return ,$results
}

# ---------------------------------------------------------------- RSS / Atom 解析
function Convert-HtmlToText([string]$Html) {
  if ([string]::IsNullOrEmpty($Html)) { return '' }
  $s = [regex]::Replace($Html, '(?is)<(script|style)\b[^>]*>.*?</\1\s*>', ' ')
  $s = [regex]::Replace($s, '(?s)<[^>]*>', ' ')
  $s = [Net.WebUtility]::HtmlDecode($s)
  $s = [regex]::Replace($s, '\s+', ' ')
  return $s.Trim()
}

function Resolve-ImageUrl([string]$Url) {
  $u = $Url.Trim()
  if ($u.StartsWith('//')) { $u = 'https:' + $u }
  if ($u -match '^https?://') { return $u }
  return ''
}

function Get-ItemLink($Node, $El) {
  if ($El.ContainsKey('link')) {
    $first = $El['link']
    if (-not $first.HasAttribute('href')) {
      $t = $first.InnerText.Trim()
      if ($t) { return $t }
    } else {
      $fallback = ''
      foreach ($c in $Node.ChildNodes) {
        if ($c.NodeType -ne [Xml.XmlNodeType]::Element -or $c.LocalName -ne 'link') { continue }
        $href = $c.GetAttribute('href')
        if (-not $href) { continue }
        $rel = $c.GetAttribute('rel')
        if (-not $rel -or $rel -eq 'alternate') { return $href }
        if (-not $fallback) { $fallback = $href }
      }
      if ($fallback) { return $fallback }
    }
  }
  foreach ($k in 'guid', 'id') {
    if ($El.ContainsKey($k)) {
      $g = $El[$k].InnerText.Trim()
      if ($g -match '^https?://') { return $g }
    }
  }
  return [string]$Node.GetAttribute('about', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#')
}

function Get-ItemImage($El, [string]$RawDesc) {
  $cands = [System.Collections.Generic.List[object]]::new()
  foreach ($k in 'thumbnail', 'content', 'enclosure') {
    if ($El.ContainsKey($k)) { $cands.Add($El[$k]) }
  }
  if ($El.ContainsKey('group')) {
    foreach ($c in $El['group'].ChildNodes) {
      if ($c.NodeType -eq [Xml.XmlNodeType]::Element) { $cands.Add($c) }
    }
  }
  foreach ($c in $cands) {
    $url = $c.GetAttribute('url')
    if (-not $url) { continue }
    $isImage = ($c.LocalName -eq 'thumbnail') -or ($c.GetAttribute('medium') -eq 'image') -or
               ($c.GetAttribute('type') -like 'image/*') -or ($url -match '\.(jpe?g|png|webp|gif)(\?|$)')
    if ($isImage) { return (Resolve-ImageUrl $url) }
  }
  if ($RawDesc) {
    $m = [regex]::Match($RawDesc, '<img[^>]+src\s*=\s*["'']([^"''>]+)["'']', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($m.Success) { return (Resolve-ImageUrl ([Net.WebUtility]::HtmlDecode($m.Groups[1].Value))) }
  }
  return ''
}

function ConvertFrom-FeedBytes([byte[]]$Bytes, $Feed, [string]$Category, $Exclude) {
  $out = [System.Collections.Generic.List[object]]::new()

  $settings = New-Object Xml.XmlReaderSettings
  $settings.DtdProcessing = [Xml.DtdProcessing]::Ignore
  $settings.XmlResolver = $null
  $stream = New-Object IO.MemoryStream(, $Bytes)
  $reader = [Xml.XmlReader]::Create($stream, $settings)
  $doc = New-Object Xml.XmlDocument
  $doc.XmlResolver = $null
  try { $doc.Load($reader) } finally { $reader.Close() }

  $feedName  = [string](Get-Opt $Feed 'name' '')
  $lang      = [string](Get-Opt $Feed 'lang' 'ja')
  $max       = [int](Get-Opt $Feed 'max' 40)
  $noSummary = [bool](Get-Opt $Feed 'noSummary' $false)
  $strip     = [string](Get-Opt $Feed 'stripTitle' '')
  $ellipsis  = [string][char]0x2026

  foreach ($n in $doc.SelectNodes("//*[local-name()='item' or local-name()='entry']")) {
    if ($out.Count -ge $max) { break }

    # 子要素を名前（名前空間なし）で引けるようにする（同名は先頭を優先）
    $el = @{}
    foreach ($c in $n.ChildNodes) {
      if ($c.NodeType -eq [Xml.XmlNodeType]::Element -and -not $el.ContainsKey($c.LocalName)) { $el[$c.LocalName] = $c }
    }
    if (-not $el.ContainsKey('title')) { continue }

    $title = Convert-HtmlToText $el['title'].InnerText
    $source = ''
    if ($el.ContainsKey('source')) { $source = Convert-HtmlToText $el['source'].InnerText }
    # Googleニュースは「タイトル - 媒体名」形式なので媒体名を外す
    if ($source -and $title.EndsWith(' - ' + $source)) { $title = $title.Substring(0, $title.Length - $source.Length - 3).TrimEnd() }
    if ($strip) { $title = [regex]::Replace($title, $strip, '').Trim() }
    if (-not $title) { continue }
    if ($null -ne $Exclude -and $Exclude.IsMatch($title)) { continue }

    $link = Get-ItemLink $n $el
    if ($link -notmatch '^https?://') { continue }

    $date = ''
    foreach ($k in 'pubDate', 'date', 'published', 'updated', 'issued', 'modified') {
      if ($el.ContainsKey($k)) { $date = $el[$k].InnerText.Trim(); break }
    }

    $rawDesc = ''
    foreach ($k in 'description', 'summary', 'encoded', 'content') {
      if ($el.ContainsKey($k) -and -not $el[$k].HasAttribute('url')) { $rawDesc = $el[$k].InnerText; break }
    }
    $summary = ''
    if (-not $noSummary) {
      $summary = Convert-HtmlToText $rawDesc
      if ($summary.StartsWith($title)) { $summary = '' }   # 見出しの繰り返し（Googleニュース等）は不要
      if ($summary.Length -gt 200) { $summary = $summary.Substring(0, 200).TrimEnd() + $ellipsis }
    }

    $image = Get-ItemImage $el $rawDesc
    if (-not $source) { $source = $feedName }

    $out.Add(@{
      title    = [string]$title
      link     = [string]$link
      date     = [string]$date
      summary  = [string]$summary
      image    = [string]$image
      source   = [string]$source
      feed     = $feedName
      category = $Category
      lang     = $lang
    })
  }
  return ,$out
}

# ---------------------------------------------------------------- ニュース
function Start-NewsJob {
  $cfg = Read-Config
  $feeds = @($cfg['feeds'])
  $urls = [string[]]@($feeds | ForEach-Object { Get-FeedUrl $_ })
  $script:NewsJob = @{ Started = Get-Date; Config = $cfg; Feeds = $feeds; Tasks = (Start-FetchAll $urls) }
}

function Get-NewsJson([bool]$Force) {
  $maxAge = 300
  if ($Force) { $maxAge = 20 }
  $cached = Get-Cached 'news' $maxAge
  if ($cached) { return $cached }

  if (-not $script:NewsJob -or ((Get-Date) - $script:NewsJob.Started).TotalSeconds -gt 60) { Start-NewsJob }
  $job = $script:NewsJob
  $script:NewsJob = $null

  $sw = [Diagnostics.Stopwatch]::StartNew()
  $results = Wait-FetchAll $job.Tasks
  $exclude = Get-ExcludeRegex $job.Config
  $items  = [System.Collections.Generic.List[object]]::new()
  $errors = [System.Collections.Generic.List[object]]::new()

  for ($i = 0; $i -lt $job.Feeds.Count; $i++) {
    $feed = $job.Feeds[$i]
    $r = $results[$i]
    $name = [string](Get-Opt $feed 'name' '')
    if (-not $r.Ok) {
      $errors.Add(@{ feed = $name; error = [string]$r.Error })
      continue
    }
    try {
      $parsed = ConvertFrom-FeedBytes $r.Bytes $feed ([string](Get-Opt $feed 'category' 'top')) $exclude
      $items.AddRange($parsed)
    } catch {
      $errors.Add(@{ feed = $name; error = '解析できません: ' + [string]$_.Exception.Message })
    }
  }

  $body = $Json.Serialize(@{
    fetchedAt  = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
    categories = $job.Config['categories']
    items      = $items
    errors     = $errors
  })
  Set-Cached 'news' $body
  $color = 'Green'
  if ($errors.Count -gt 0) { $color = 'Yellow' }
  Write-Log ('ニュース取得: {0}件（配信元 {1}件中 失敗 {2}件, {3:N1}秒）' -f $items.Count, $job.Feeds.Count, $errors.Count, $sw.Elapsed.TotalSeconds) $color
  foreach ($e in $errors) { Write-Log ('  取得失敗: {0} - {1}' -f $e.feed, $e.error) 'DarkYellow' }
  return $body
}

# ---------------------------------------------------------------- 指数・為替
function Start-QuotesJob {
  $cfg = Read-Config
  $markets = @($cfg['markets'])
  $urls = [string[]]@($markets | ForEach-Object {
    'https://query1.finance.yahoo.com/v8/finance/chart/' + [Uri]::EscapeDataString([string]$_['symbol']) + '?range=1d&interval=15m'
  })
  $script:QuotesJob = @{ Started = Get-Date; Markets = $markets; Tasks = (Start-FetchAll $urls) }
}

function Get-QuotesJson([bool]$Force) {
  $maxAge = 120
  if ($Force) { $maxAge = 20 }
  $cached = Get-Cached 'quotes' $maxAge
  if ($cached) { return $cached }

  if (-not $script:QuotesJob -or ((Get-Date) - $script:QuotesJob.Started).TotalSeconds -gt 60) { Start-QuotesJob }
  $job = $script:QuotesJob
  $script:QuotesJob = $null

  $results = Wait-FetchAll $job.Tasks 15000
  $quotes = [System.Collections.Generic.List[object]]::new()
  for ($i = 0; $i -lt $job.Markets.Count; $i++) {
    $m = $job.Markets[$i]
    $r = $results[$i]
    $q = @{}
    foreach ($k in $m.Keys) { $q[$k] = $m[$k] }
    $q['ok'] = $false
    if ($r.Ok) {
      try {
        $d = $Json.DeserializeObject([Text.Encoding]::UTF8.GetString($r.Bytes))
        $res = $d['chart']['result'][0]
        $meta = $res['meta']
        $prev  = Get-Opt $meta 'chartPreviousClose' (Get-Opt $meta 'previousClose' $null)
        $price = Get-Opt $meta 'regularMarketPrice' $null
        $time  = Get-Opt $meta 'regularMarketTime' $null
        $q['price']     = $null
        $q['prevClose'] = $null
        $q['time']      = $null
        if ($null -ne $price) { $q['price'] = [double]$price }
        if ($null -ne $prev)  { $q['prevClose'] = [double]$prev }
        if ($null -ne $time)  { $q['time'] = [long]$time }
        $period = Get-Opt $meta 'currentTradingPeriod' $null
        if ($period -and $period.ContainsKey('regular')) {
          $ps = Get-Opt $period['regular'] 'start' $null
          $pe = Get-Opt $period['regular'] 'end' $null
          if ($null -ne $ps -and $null -ne $pe) { $q['periodStart'] = [long]$ps; $q['periodEnd'] = [long]$pe }
        }
        $q['timestamps'] = @()
        $q['points'] = @()
        if ($res.ContainsKey('timestamp') -and $res['timestamp']) {
          $q['timestamps'] = $res['timestamp']
          $q['points'] = $res['indicators']['quote'][0]['close']
        }
        $q['ok'] = ($null -ne $q['price'] -and $null -ne $prev)
      } catch {
        $q['error'] = [string]$_.Exception.Message
      }
    } else {
      $q['error'] = [string]$r.Error
    }
    $quotes.Add($q)
  }

  $body = $Json.Serialize(@{ fetchedAt = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz'); quotes = $quotes })
  Set-Cached 'quotes' $body
  return $body
}

# ---------------------------------------------------------------- 検索（ウォッチリスト）
function Get-SearchJson([string[]]$Queries, [bool]$Force) {
  $qs = [System.Collections.Generic.List[string]]::new()
  foreach ($q in $Queries) {
    $t = ([string]$q).Trim()
    if ($t.Length -gt 60) { $t = $t.Substring(0, 60) }
    if ($t -and -not $qs.Contains($t) -and $qs.Count -lt 20) { $qs.Add($t) }
  }
  if ($qs.Count -eq 0) { return $Json.Serialize(@{ items = @(); errors = @() }) }

  $key = 'search:' + ($qs -join "`n")
  $maxAge = 300
  if ($Force) { $maxAge = 20 }
  $cached = Get-Cached $key $maxAge
  if ($cached) { return $cached }

  $urls = [string[]]@($qs | ForEach-Object {
    $query = $_
    if ($query -notmatch 'when:') { $query += ' when:7d' }
    Get-GoogleNewsUrl $query
  })
  $results = Wait-FetchAll (Start-FetchAll $urls) 20000
  $exclude = Get-ExcludeRegex (Read-Config)
  $items  = [System.Collections.Generic.List[object]]::new()
  $errors = [System.Collections.Generic.List[object]]::new()
  $feed = @{ name = 'Googleニュース'; lang = 'ja'; max = 30 }

  for ($i = 0; $i -lt $qs.Count; $i++) {
    $r = $results[$i]
    if (-not $r.Ok) { $errors.Add(@{ feed = $qs[$i]; error = [string]$r.Error }); continue }
    try {
      foreach ($it in (ConvertFrom-FeedBytes $r.Bytes $feed 'search' $exclude)) {
        $it['query'] = $qs[$i]
        $items.Add($it)
      }
    } catch {
      $errors.Add(@{ feed = $qs[$i]; error = '解析できません: ' + [string]$_.Exception.Message })
    }
  }

  $body = $Json.Serialize(@{ items = $items; errors = $errors })
  Set-Cached $key $body
  Write-Log ('検索: {0} → {1}件' -f ($qs -join ', '), $items.Count)
  return $body
}

# ---------------------------------------------------------------- HTTP
function Get-QueryParams([string]$RawUrl) {
  $list = [System.Collections.Generic.List[object]]::new()
  $i = $RawUrl.IndexOf('?')
  if ($i -lt 0) { return ,$list }
  foreach ($pair in $RawUrl.Substring($i + 1).Split('&')) {
    if (-not $pair) { continue }
    $eq = $pair.IndexOf('=')
    if ($eq -lt 0) { $k = $pair; $v = '' } else { $k = $pair.Substring(0, $eq); $v = $pair.Substring($eq + 1) }
    try {
      $list.Add(@([Uri]::UnescapeDataString($k.Replace('+', ' ')), [Uri]::UnescapeDataString($v.Replace('+', ' '))))
    } catch { }
  }
  return ,$list
}

function Get-QueryValues($Params, [string]$Name) {
  return [string[]]@($Params | Where-Object { $_[0] -eq $Name } | ForEach-Object { $_[1] })
}

function Send-Bytes($Ctx, [int]$Status, [string]$ContentType, [byte[]]$Bytes, [string]$Csp = '') {
  $res = $Ctx.Response
  $res.StatusCode = $Status
  $res.ContentType = $ContentType
  $res.AddHeader('X-Content-Type-Options', 'nosniff')
  $res.AddHeader('Referrer-Policy', 'no-referrer')
  $res.AddHeader('Cache-Control', 'no-store')
  if ($Csp) { $res.AddHeader('Content-Security-Policy', $Csp) }
  $res.ContentLength64 = $Bytes.Length
  if ($Ctx.Request.HttpMethod -ne 'HEAD') { $res.OutputStream.Write($Bytes, 0, $Bytes.Length) }
  $res.OutputStream.Close()
}

function Send-Text($Ctx, [int]$Status, [string]$Text, [string]$ContentType = 'text/plain; charset=utf-8') {
  Send-Bytes $Ctx $Status $ContentType ([Text.Encoding]::UTF8.GetBytes($Text))
}

function Send-Static($Ctx, [string]$Path) {
  if ($Path -eq '/' -or $Path -eq '') { $Path = '/index.html' }
  $full = $null
  try {
    $rel = [Uri]::UnescapeDataString($Path).TrimStart('/').Replace('/', '\')
    $full = [IO.Path]::GetFullPath([IO.Path]::Combine($PublicDir, $rel))
  } catch { $full = $null }
  if (-not $full -or -not $full.StartsWith($PublicDir + '\', [StringComparison]::OrdinalIgnoreCase) -or -not [IO.File]::Exists($full)) {
    Send-Text $Ctx 404 'Not Found'
    return
  }
  $ext = [IO.Path]::GetExtension($full).ToLowerInvariant()
  if (-not $Mime.ContainsKey($ext)) { Send-Text $Ctx 404 'Not Found'; return }
  $policy = ''
  if ($ext -eq '.html') { $policy = $HtmlCsp }
  Send-Bytes $Ctx 200 $Mime[$ext] ([IO.File]::ReadAllBytes($full)) $policy
}

# 受け付けるのは「このPC内部からの接続」（ブラウザ / Tailscale Serve の中継）で、
# 宛先が localhost か Tailscale のアドレス・名前のものだけ。
# （他人の端末からの直接接続や、DNSリバインディングによるのぞき見を防ぐ）
function Test-AllowedRequest($Req) {
  $ip = $Req.RemoteEndPoint.Address
  if ($ip.IsIPv4MappedToIPv6) { $ip = $ip.MapToIPv4() }
  if (-not [Net.IPAddress]::IsLoopback($ip)) { return $false }

  $hostHeader = ([string]$Req.UserHostName).Trim().ToLowerInvariant()
  $name = $hostHeader
  if ($hostHeader -match '^\[([^\]]+)\](:\d+)?$') { $name = $Matches[1] }
  elseif ($hostHeader -match '^([^:]+)(:\d+)?$') { $name = $Matches[1] }

  if ($name -eq 'localhost' -or $name -eq '127.0.0.1' -or $name -eq '::1') { return $true }
  if ($name.EndsWith('.ts.net')) { return $true }                          # MagicDNS の名前
  if ($name -match '^[a-z0-9-]+$') { return $true }                        # 短いマシン名（例: laptop-xxxx）
  if ($name -match '^100\.(\d+)\.\d+\.\d+$' -and [int]$Matches[1] -ge 64 -and [int]$Matches[1] -le 127) { return $true }  # Tailscale IPv4
  if ($name.StartsWith('fd7a:115c:a1e0:')) { return $true }               # Tailscale IPv6
  return $false
}

function Invoke-Request($Ctx) {
  $req = $Ctx.Request
  $raw = [string]$req.RawUrl
  $qi = $raw.IndexOf('?')
  $path = $raw
  if ($qi -ge 0) { $path = $raw.Substring(0, $qi) }
  try {
    if (-not (Test-AllowedRequest $req)) {
      Write-Log ('拒否: {0} (Host: {1})' -f $req.RemoteEndPoint, $req.UserHostName) 'DarkYellow'
      Send-Text $Ctx 403 'Forbidden'
      return
    }
    if ($req.HttpMethod -ne 'GET' -and $req.HttpMethod -ne 'HEAD') { Send-Text $Ctx 405 'Method Not Allowed'; return }
    $params = Get-QueryParams $raw
    $force = (@(Get-QueryValues $params 'force') -contains '1')
    if ($path -eq '/api/news') {
      Send-Text $Ctx 200 (Get-NewsJson $force) 'application/json; charset=utf-8'
    } elseif ($path -eq '/api/quotes') {
      Send-Text $Ctx 200 (Get-QuotesJson $force) 'application/json; charset=utf-8'
    } elseif ($path -eq '/api/search') {
      Send-Text $Ctx 200 (Get-SearchJson (Get-QueryValues $params 'q') $force) 'application/json; charset=utf-8'
    } elseif ($path -eq '/api/health') {
      Send-Text $Ctx 200 $HealthText
    } else {
      Send-Static $Ctx $path
    }
  } catch {
    $msg = [string]$_.Exception.Message
    Write-Log ('エラー: {0} {1}' -f $path, $msg) 'Red'
    try { Send-Text $Ctx 500 ($Json.Serialize(@{ error = $msg })) 'application/json; charset=utf-8' } catch { }
  }
}

# ---------------------------------------------------------------- 書き出し（GitHub Pages 用）
if ($Export) {
  $outDir = [IO.Path]::GetFullPath($Export)
  [void][IO.Directory]::CreateDirectory($outDir)
  $utf8 = New-Object Text.UTF8Encoding($false)
  Start-NewsJob
  Start-QuotesJob
  $news = Get-NewsJson $false
  $quotes = Get-QuotesJson $false
  [IO.File]::WriteAllText([IO.Path]::Combine($outDir, 'news.json'), $news, $utf8)
  [IO.File]::WriteAllText([IO.Path]::Combine($outDir, 'quotes.json'), $quotes, $utf8)
  $count = @($Json.DeserializeObject($news)['items']).Count
  Write-Log ('書き出し: {0}（記事 {1}件）' -f $outDir, $count) 'Green'
  if ($count -eq 0) { Write-Log '記事を1件も取得できませんでした。' 'Red'; exit 1 }
  exit 0
}

# ---------------------------------------------------------------- 起動
function Test-ExistingServer([int]$P) {
  try {
    $t = $Http.GetStringAsync("http://localhost:$P/api/health")
    if ($t.Wait(1500) -and $t.Result -eq $HealthText) { return $true }
  } catch { }
  return $false
}

if (Test-ExistingServer $Port) {
  Write-Log 'ニュースボードはすでに起動しています。ブラウザで開きます。' 'Yellow'
  if (-not $NoBrowser) { Start-Process "http://localhost:$Port/" }
  exit 0
}

# http://+:port/ は setup-phone.bat で一度だけ許可（URL予約）が必要。
# 許可がなければ従来どおり localhost のみで起動する。
$listener = $null
$PhoneReady = $false
for ($p = $Port; $p -lt $Port + 10; $p++) {
  foreach ($prefix in @("http://+:$p/", "http://localhost:$p/")) {
    $l = New-Object Net.HttpListener
    $l.Prefixes.Add($prefix)
    try {
      $l.Start()
      $listener = $l
      $Port = $p
      $PhoneReady = $prefix.StartsWith('http://+')
      break
    } catch {
      try { $l.Close() } catch { }
    }
  }
  if ($listener) { break }
}
if (-not $listener) {
  Write-Log "ポート $Port 付近がすべて使用中のため起動できませんでした。" 'Red'
  exit 1
}

# スマホ用（Tailscale Serve）のアドレスを調べる
function Get-PhoneUrl([int]$LocalPort) {
  $ts = [IO.Path]::Combine($env:ProgramFiles, 'Tailscale\tailscale.exe')
  if (-not [IO.File]::Exists($ts)) { return '' }
  try {
    # Serve はアクセス先の名前で振り分けるので、IPアドレスではなく MagicDNS 名（xxx.ts.net）を案内する
    $serve = (& $ts serve status --json 2>$null) -join "`n" | ConvertFrom-Json
    if (-not $serve -or -not $serve.Web) { return '' }
    $found = ''
    foreach ($site in $serve.Web.PSObject.Properties) {
      foreach ($handler in $site.Value.Handlers.PSObject.Properties) {
        if ([string]$handler.Value.Proxy -match ":$LocalPort/?$") {
          if (-not $found -or $site.Name -like '*.ts.net:*') { $found = $site.Name }
        }
      }
    }
    if ($found) {
      $hostName, $servePort = $found -split ':', 2
      if ($servePort -eq '80') { return "http://$hostName/" }
      return "http://${hostName}:$servePort/"
    }
  } catch { }
  return ''
}

# ブラウザが開くまでの間に取得を始めておく
try { Start-NewsJob; Start-QuotesJob } catch { Write-Log $_.Exception.Message 'Red' }

$url = "http://localhost:$Port/"
$phoneUrl = ''
if ($PhoneReady) { $phoneUrl = Get-PhoneUrl $Port }
Write-Host ''
Write-Host '  ニュースボードを起動しました' -ForegroundColor Cyan
Write-Host "  アドレス: $url"
if ($phoneUrl) { Write-Host "  スマホ（Tailscale）: $phoneUrl" -ForegroundColor Cyan }
Write-Host '  終了するには、このウィンドウを閉じるか Ctrl+C を押してください。' -ForegroundColor DarkGray
Write-Host ''
if (-not $NoBrowser) { Start-Process $url }

try {
  while ($listener.IsListening) {
    $pending = $listener.GetContextAsync()
    while (-not $pending.Wait(250)) { }
    Invoke-Request $pending.Result
  }
} finally {
  try { $listener.Stop(); $listener.Close() } catch { }
  try { $Http.Dispose() } catch { }
  Write-Log '終了しました。'
}
