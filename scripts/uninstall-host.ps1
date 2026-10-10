param([switch]$Chromium)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$expected = Join-Path $projectRoot 'dist\native-host.json'
$vendor = if ($Chromium) { 'Chromium' } else { 'Google\Chrome' }
$registryPath = "HKCU:\Software\$vendor\NativeMessagingHosts\com.voiceqa.companion"
if (Test-Path -LiteralPath $registryPath) {
  $existing = (Get-Item -LiteralPath $registryPath).GetValue('')
  if ($existing -ne $expected) { throw 'This registry entry belongs to a different installation; it was preserved.' }
  Remove-Item -LiteralPath $registryPath
}
Write-Output 'Native host registration removed. Saved reports and encrypted settings were preserved.'
