param([switch]$Chromium)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$expected = Join-Path $projectRoot 'dist\native-host.json'
$vendors = if ($Chromium) { @('Chromium') } else { @('Google\Chrome', 'Chromium') }
foreach ($vendor in $vendors) {
  $registryPath = "HKCU:\Software\$vendor\NativeMessagingHosts\com.voiceqa.companion"
  if (Test-Path -LiteralPath $registryPath) {
    $existing = (Get-Item -LiteralPath $registryPath).GetValue('')
    if ($existing -ne $expected) { throw 'This registry entry belongs to a different installation; it was preserved.' }
  }
}
foreach ($vendor in $vendors) {
  $registryPath = "HKCU:\Software\$vendor\NativeMessagingHosts\com.voiceqa.companion"
  if (Test-Path -LiteralPath $registryPath) { Remove-Item -LiteralPath $registryPath }
}
Write-Output 'Native host registration removed. Saved reports and encrypted settings were preserved.'
