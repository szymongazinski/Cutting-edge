<#
.SYNOPSIS
Installs or upgrades Cutting edge for the current Windows user.
.DESCRIPTION
Downloads a stable GitHub release and its SHA256SUMS.txt, verifies the installer, and waits for installation. Existing storage directories carry forward unless explicitly supplied.
.EXAMPLE
& ([scriptblock]::Create((Invoke-RestMethod 'https://raw.githubusercontent.com/szymongazinski/Cutting-edge/v1.0.0/scripts/install.ps1')))
.EXAMPLE
.\scripts\install.ps1 -ProjectDir 'D:\Video projects' -OutputDir 'D:\Finished videos' -Language pl
.EXAMPLE
.\scripts\install.ps1 -Version 1.0.0 -Interactive
#>
[CmdletBinding()]
param(
    [ValidatePattern('^(latest|v?\d+\.\d+\.\d+)$')][string] $Version = 'latest',
    [string] $InstallDir,
    [string] $ProjectDir,
    [string] $OutputDir,
    [ValidateSet('pl','en')][string] $Language,
    [switch] $AssociateFiles,
    [switch] $Interactive
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Cutting edge requires Windows.' }
if (![Environment]::Is64BitOperatingSystem) { throw 'Cutting edge requires 64-bit Windows.' }
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$repoName = 'szymongazinski/Cutting-edge'
$installerName = 'Cutting-edge-Setup-x64.exe'
$manifestName = 'SHA256SUMS.txt'
$selector = if ($Version -eq 'latest') { 'latest' } else { 'tags/v' + $Version.TrimStart('v') }
$httpHeaders = @{ 'User-Agent' = 'Cutting-edge-installer'; Accept = 'application/vnd.github+json' }
$release = Invoke-RestMethod -UseBasicParsing -Headers $httpHeaders -Uri "https://api.github.com/repos/$repoName/releases/$selector"
if ($release.draft -or $release.prerelease -or $release.tag_name -notmatch '^v\d+\.\d+\.\d+$') {
    throw 'Invalid stable release.'
}
function Get-ReleaseAsset([string] $FileName) {
    $matching = @($release.assets | Where-Object { $_.name -ceq $FileName -and $_.state -eq 'uploaded' })
    $expected = "https://github.com/$repoName/releases/download/$($release.tag_name)/$FileName"
    if ($matching.Count -ne 1 -or $matching[0].browser_download_url -cne $expected) { throw "Missing or invalid release asset: $FileName" }
    return $matching[0]
}
function Get-DirectoryArgument([string] $Key, [string] $Value) {
    if ($Value.Contains('"')) { throw "Invalid directory for $Key" }
    $absolute = [IO.Path]::GetFullPath($Value)
    if ($absolute.EndsWith('\')) { $absolute += '.' }
    return "/$Key=" + '"' + $absolute + '"'
}
$installerAsset = Get-ReleaseAsset $installerName
$manifestAsset = Get-ReleaseAsset $manifestName
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$stagePath = Join-Path $tempRoot ('Cutting-edge-install-' + [Guid]::NewGuid().ToString('N'))
$validatedPath = [IO.Path]::GetFullPath($stagePath)
if ((Split-Path -Parent $validatedPath) -ine $tempRoot -or (Split-Path -Leaf $validatedPath) -notmatch '^Cutting-edge-install-[0-9a-f]{32}$') {
    throw 'Invalid temporary directory.'
}
New-Item -ItemType Directory -Path $validatedPath | Out-Null
try {
    $manifest = Join-Path $validatedPath $manifestName
    $setupExe = Join-Path $validatedPath $installerName
    Write-Host "Downloading Cutting edge $($release.tag_name)..."
    # Windows PowerShell's progress UI can greatly slow large binary downloads.
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -UseBasicParsing -Uri $manifestAsset.browser_download_url -OutFile $manifest
    $pattern = '^([A-Fa-f0-9]{64})\s+\*?' + [regex]::Escape($installerName) + '\s*$'
    $checksums = @([IO.File]::ReadAllLines($manifest) | ForEach-Object { if ($_ -cmatch $pattern) { $Matches[1].ToLowerInvariant() } })
    if ($checksums.Count -ne 1) { throw 'Missing or ambiguous installer SHA-256.' }
    $expectedHash = $checksums[0]
    if ($installerAsset.digest -and $installerAsset.digest -ine "sha256:$expectedHash") { throw 'Conflicting release SHA-256.' }
    Invoke-WebRequest -UseBasicParsing -Uri $installerAsset.browser_download_url -OutFile $setupExe
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($setupExe)
    try {
        $actualHash = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '')
    } finally {
        $stream.Dispose()
        $algorithm.Dispose()
    }
    if ($actualHash -ine $expectedHash) { throw 'Installer SHA-256 mismatch.' }
    $setupArgs = @('/SP-', '/NORESTART')
    if (!$Interactive) { $setupArgs += @('/VERYSILENT','/SUPPRESSMSGBOXES','/CLOSEAPPLICATIONS') }
    if ($InstallDir) { $setupArgs += Get-DirectoryArgument 'DIR' $InstallDir }
    if ($ProjectDir) { $setupArgs += Get-DirectoryArgument 'PROJECTDIR' $ProjectDir }
    if ($OutputDir) { $setupArgs += Get-DirectoryArgument 'OUTPUTDIR' $OutputDir }
    if ($AssociateFiles) { $setupArgs += '/MERGETASKS=fileassoc' }
    if ($Language) { $setupArgs += if ($Language -eq 'pl') { '/LANG=polish' } else { '/LANG=english' } }
    $processOptions = @{FilePath=$setupExe; ArgumentList=$setupArgs; Wait=$true; PassThru=$true}
    if (!$Interactive) { $processOptions.WindowStyle = 'Hidden' }
    $installProcess = Start-Process @processOptions
    if ($installProcess.ExitCode -ne 0) { throw "Setup exited with code $($installProcess.ExitCode)." }
    Write-Host "Installed Cutting edge $($release.tag_name). Open Cutting edge from Windows Start."
} finally {
    Remove-Item -LiteralPath $validatedPath -Recurse -Force
}
