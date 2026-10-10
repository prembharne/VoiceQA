param([Parameter(Mandatory=$true)][ValidatePattern('^[a-p]{32}$')][string]$ExtensionId,[switch]$Chromium)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$hostExe = Join-Path $projectRoot 'dist\voiceqa-host.exe'
if (!(Test-Path -LiteralPath $hostExe)) { throw 'Build the companion first: npm run build:all' }
$hostName = 'com.voiceqa.companion'
$manifestPath = Join-Path $projectRoot 'dist\native-host.json'
$manifest = @{ name=$hostName; description='VoiceQA local QA companion'; path=$hostExe; type='stdio'; allowed_origins=@("chrome-extension://$ExtensionId/") }
$vendors = if ($Chromium) { @('Chromium') } else { @('Google\Chrome', 'Chromium') }
foreach ($vendor in $vendors) {
  $registryPath = "HKCU:\Software\$vendor\NativeMessagingHosts\$hostName"
  if (Test-Path -LiteralPath $registryPath) {
    $existing = (Get-Item -LiteralPath $registryPath).GetValue('')
    if ($existing -and $existing -ne $manifestPath) { throw "A different VoiceQA installation owns $registryPath. Uninstall it first." }
  }
}
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 4), [System.Text.UTF8Encoding]::new($false))
foreach ($vendor in $vendors) {
  $registryPath = "HKCU:\Software\$vendor\NativeMessagingHosts\$hostName"
  New-Item -Path $registryPath -Force | Out-Null
  Set-Item -LiteralPath $registryPath -Value $manifestPath
}
Write-Output "Registered $hostName for $ExtensionId in $($vendors -join ', '). Reload VoiceQA at chrome://extensions, then choose Retry connection."
