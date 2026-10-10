param([ValidatePattern('^[a-p]{32}$')][string]$ExtensionId)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$manifestPath = Join-Path $projectRoot 'dist\native-host.json'
if (!(Test-Path -LiteralPath $manifestPath)) { throw 'Local engine is not registered. Run scripts\install-host.ps1 with the extension ID first.' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if (!(Test-Path -LiteralPath $manifest.path)) { throw "Companion executable missing: $($manifest.path). Build or extract it before registration." }
if ($ExtensionId -and "chrome-extension://$ExtensionId/" -notin $manifest.allowed_origins) { throw 'The registered extension ID is different. Register the ID shown in the VoiceQA connection screen.' }
foreach ($vendor in @('Google\Chrome','Chromium')) {
  $key = "HKCU:\Software\$vendor\NativeMessagingHosts\com.voiceqa.companion"
  if (!(Test-Path -LiteralPath $key) -or (Get-Item -LiteralPath $key).GetValue('') -ne $manifestPath) { throw "Registration missing for $vendor. Run the updated installer." }
}
# Probe with isolated data so the diagnostic cannot change real runs or credentials.
$probeDir = Join-Path ([System.IO.Path]::GetTempPath()) ('voiceqa-probe-' + [guid]::NewGuid().ToString('N'))
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $manifest.path
$start.Arguments = '--stdio'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.EnvironmentVariables['VOICEQA_DATA_DIR'] = $probeDir
$process = [System.Diagnostics.Process]::Start($start)
try {
  $request = '{"version":1,"id":"diagnostic","type":"hello","payload":{}}'
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($request)
  $writer = $process.StandardInput.BaseStream
  $writer.Write([BitConverter]::GetBytes([uint32]$bytes.Length),0,4)
  $writer.Write($bytes,0,$bytes.Length); $writer.Flush()
  $header = New-Object byte[] 4
  $offset = 0
  while ($offset -lt 4) {
    $task = $process.StandardOutput.BaseStream.ReadAsync($header,$offset,(4-$offset))
    if (!$task.Wait(5000)) { throw 'Companion startup timed out.' }
    $count = $task.Result
    if ($count -eq 0) { throw ('Companion exited before startup: ' + $process.StandardError.ReadToEnd()) }
    $offset += $count
  }
  $length = [BitConverter]::ToUInt32($header,0)
  if ($length -eq 0 -or $length -gt 524288) { throw 'Companion sent an invalid startup response.' }
  $body = New-Object byte[] $length
  $offset = 0
  while ($offset -lt $length) {
    $task = $process.StandardOutput.BaseStream.ReadAsync($body,$offset,($length-$offset))
    if (!$task.Wait(5000) -or $task.Result -eq 0) { throw 'Companion response was incomplete.' }
    $offset += $task.Result
  }
  $response = [System.Text.Encoding]::UTF8.GetString($body) | ConvertFrom-Json
  if ($response.payload.error -or $response.payload.result.version -ne 1) { throw 'Companion startup handshake failed.' }
  Write-Output "Local engine replied: $($response.payload.result.hostVersion). Registration is valid for Chrome and Chromium."
} finally {
  if (!$process.HasExited) { $process.Kill() }
  $process.Dispose()
  if (Test-Path -LiteralPath $probeDir) {
    $resolvedProbe = [System.IO.Path]::GetFullPath($probeDir)
    $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    if (!$resolvedProbe.StartsWith($tempRoot,[System.StringComparison]::OrdinalIgnoreCase) -or [System.IO.Path]::GetFileName($resolvedProbe) -notmatch '^voiceqa-probe-[a-f0-9]{32}$') { throw 'Diagnostic cleanup path was outside its temporary directory.' }
    Remove-Item -LiteralPath $resolvedProbe -Recurse -Force
  }
}
