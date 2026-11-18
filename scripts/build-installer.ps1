[CmdletBinding()]
param(
    [ValidatePattern('^\d+\.\d+\.\d+$')][string] $Version,
    [string] $IsccPath
)
$ErrorActionPreference = 'Stop'
$rootDir = Split-Path -Parent $PSScriptRoot
if (!$Version) {
    $Version = (Get-Content -Raw -LiteralPath (Join-Path $rootDir 'package.json') | ConvertFrom-Json).version
}
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid stable release version: $Version" }
$stage = Join-Path $rootDir 'dist\win-unpacked'
if (!(Test-Path -LiteralPath (Join-Path $stage 'Cutting edge.exe') -PathType Leaf)) {
    throw 'Missing dist\win-unpacked\Cutting edge.exe. Run npm run pack first.'
}
if (!$IsccPath) {
    $iscc = Get-Command ISCC.exe -CommandType Application -ErrorAction SilentlyContinue
    $candidates = @(
        $env:ISCC_PATH
        $(if ($iscc) { $iscc.Source })
        (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
        (Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Inno Setup 6\ISCC.exe')
        (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
    )
    $IsccPath = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
}
if (!$IsccPath) { throw 'Inno Setup 6 missing. Install JRSoftware.InnoSetup or pass -IsccPath.' }
$outputDir = Join-Path $rootDir 'dist'
& $IsccPath '/Qp' "/DAppVersion=$Version" "/DStagedApp=$stage" "/O$outputDir" (Join-Path $rootDir 'installer\Cutting-edge.iss')
if ($LASTEXITCODE -ne 0) { throw "Inno Setup exited with code $LASTEXITCODE" }
$output = Join-Path $outputDir 'Cutting-edge-Setup-x64.exe'
$algorithm = [Security.Cryptography.SHA256]::Create()
$stream = [IO.File]::OpenRead($output)
try {
    $sha = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
} finally {
    $stream.Dispose()
    $algorithm.Dispose()
}
[IO.File]::WriteAllText((Join-Path $outputDir 'SHA256SUMS.txt'), "$sha  Cutting-edge-Setup-x64.exe" + [Environment]::NewLine, [Text.Encoding]::ASCII)
Write-Output "$output ($sha)"
