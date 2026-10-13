param([Parameter(Mandatory=$true)][string]$Directory, [switch]$Whisper, [switch]$Python, [switch]$PortablePython, [string[]]$Models = @())
$ErrorActionPreference = 'Stop'
$arguments = @((Join-Path $PSScriptRoot 'setup-engines.py'), '--directory', $Directory)
if ($Whisper) { $arguments += '--whisper' }
if ($Python) { $arguments += '--python' }
if ($PortablePython) { $arguments += '--portable-python' }
if ($Models.Count -gt 0) { $arguments += '--models'; $arguments += $Models }
& python @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
