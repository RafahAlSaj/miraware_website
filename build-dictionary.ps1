$ErrorActionPreference = 'Stop'

$base = Join-Path $env:TEMP 'miraware_dict_build'
if (Test-Path $base) {
  Remove-Item $base -Recurse -Force
}
New-Item -ItemType Directory -Path $base | Out-Null

$sources = @(
  'https://raw.githubusercontent.com/linuxscout/ayaspell/master/dict/builddict/stopwords.dic',
  'https://raw.githubusercontent.com/linuxscout/ayaspell/master/dict/builddict/tools.dic',
  'https://raw.githubusercontent.com/linuxscout/ayaspell/master/dict/builddict/names.dic',
  'https://raw.githubusercontent.com/linuxscout/ayaspell/master/dict/builddict/verb.huns.dic',
  'https://raw.githubusercontent.com/linuxscout/ayaspell/master/dict/builddict/Condidate3.4.dic'
)

$words = New-Object 'System.Collections.Generic.HashSet[string]'
$list = New-Object 'System.Collections.Generic.List[string]'

foreach ($source in $sources) {
  $fileName = [System.IO.Path]::GetFileName($source)
  $downloadPath = Join-Path $base $fileName
  Invoke-WebRequest -Uri $source -OutFile $downloadPath

  $lines = Get-Content -LiteralPath $downloadPath -Encoding UTF8
  if ($lines.Count -gt 0 -and $lines[0] -match '^[0-9]+$') {
    $lines = $lines[1..($lines.Count - 1)]
  }

  foreach ($line in $lines) {
    $entry = $line.Trim()
    if (-not $entry) { continue }
    if ($entry.StartsWith('#')) { continue }
    if ($words.Add($entry)) {
      [void]$list.Add($entry)
    }
  }
}

$target = 'd:\xampp\htdocs\miraware_site\vendor\dicts\ar.dic'
$targetLines = @($list.Count.ToString()) + $list
Set-Content -LiteralPath $target -Encoding UTF8 -Value $targetLines

Write-Output ('mergedCount=' + $list.Count)
Write-Output ('target=' + $target)
Write-Output ('size=' + (Get-Item $target).Length)
