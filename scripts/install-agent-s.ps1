param([string]$PythonPath)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$distribution = Join-Path $projectRoot 'dist'
$workerRoot = Join-Path $distribution 'agent-s'
$runtimeRoot = Join-Path $distribution 'agent-s-runtime'
if (!(Test-Path -LiteralPath (Join-Path $workerRoot 'worker.py'))) { throw 'Build first: npm run build:all' }
$uv = Get-Command uv -ErrorAction SilentlyContinue
if (!$PythonPath) {
  if ($uv) {
    $PythonPath = (& $uv.Source python find 3.11 | Select-Object -Last 1)
    if ($LASTEXITCODE -ne 0) { throw 'Install Python 3.11 or 3.12 and supply -PythonPath.' }
  } else {
    $PythonPath = (& py -3.11 -c 'import sys;print(sys.executable)' | Select-Object -Last 1)
    if ($LASTEXITCODE -ne 0) { throw 'Install Python 3.11 or 3.12 and supply -PythonPath.' }
  }
}
$version = & $PythonPath -c 'import sys;print(sys.version_info.major*100+sys.version_info.minor)'
if ($version -notin @('311','312')) { throw 'The pinned Agent S adapter requires Python 3.11 or 3.12.' }
$runtimePython = Join-Path $runtimeRoot 'Scripts\python.exe'
if ($uv) {
  if (!(Test-Path -LiteralPath $runtimePython)) { & $uv.Source venv --python $PythonPath $runtimeRoot }
  if ($LASTEXITCODE -ne 0) { throw 'Could not create isolated Agent S environment.' }
  & $uv.Source pip install --python $runtimePython -r (Join-Path $workerRoot 'requirements.txt')
} else {
  if (!(Test-Path -LiteralPath $runtimePython)) { & $PythonPath -m venv $runtimeRoot }
  if ($LASTEXITCODE -ne 0) { throw 'Could not create isolated Agent S environment.' }
  & $runtimePython -m pip install -r (Join-Path $workerRoot 'requirements.txt')
}
if ($LASTEXITCODE -ne 0) { throw 'Agent S dependency installation failed.' }
& $runtimePython -I (Join-Path $workerRoot 'worker.py') --check
if ($LASTEXITCODE -ne 0) { throw 'Agent S import check failed.' }
Write-Output 'Agent S visual recovery is ready. Reload the extension to reconnect the companion.'
