# RelayDesk demo: no third-party Node dependencies are required.
param([ValidateRange(1024,65535)][int]$Port=4173)
$ErrorActionPreference='Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$previousDemoPort = $env:PORT
try { $env:PORT=[string]$Port; & node (Join-Path $projectRoot 'demo\server.mjs') }
finally { $env:PORT=$previousDemoPort }
