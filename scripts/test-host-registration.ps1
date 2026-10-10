param([ValidateSet('install','restore')][string]$Mode,[string]$ManifestPath,[string]$BackupPath)
$ErrorActionPreference = 'Stop'
$registryPath = 'HKCU:\Software\Chromium\NativeMessagingHosts\com.voiceqa.companion'
if ($Mode -eq 'install') {
  $present = Test-Path -LiteralPath $registryPath
  $previous = if ($present) { (Get-Item -LiteralPath $registryPath).GetValue('') } else { $null }
  @{present=$present;previous=$previous} | ConvertTo-Json | Set-Content -LiteralPath $BackupPath -Encoding utf8
  New-Item -Path $registryPath -Force | Out-Null
  Set-Item -LiteralPath $registryPath -Value $ManifestPath
} elseif (Test-Path -LiteralPath $BackupPath) {
  $backup = Get-Content -LiteralPath $BackupPath -Raw | ConvertFrom-Json
  if ($backup.present) { Set-Item -LiteralPath $registryPath -Value $backup.previous }
  elseif (Test-Path -LiteralPath $registryPath) { Remove-Item -LiteralPath $registryPath }
}
