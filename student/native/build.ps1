$ErrorActionPreference = 'Stop'

$nativeRoot = $PSScriptRoot
$vendorRoot = Join-Path $nativeRoot 'vendor'
$binRoot = Join-Path $nativeRoot 'bin'
$naudioVersion = '1.10.0'
$expectedPackageHash = 'E4A80EED41DAD794695F9C114432DE4667D20BDFA80825AA94D159708CF29217'
$expectedDllHash = 'BC4BACC3B8B28D898F1671B79F216CCA439F95EB60CD32D3E3ECAFBECAC42780'
$naudioDll = Join-Path $vendorRoot 'NAudio.dll'
$compilerCandidates = @(
  'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe',
  'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe'
)
$compiler = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $compiler) { throw 'The Windows .NET Framework C# compiler was not found.' }

New-Item -ItemType Directory -Path $vendorRoot, $binRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $naudioDll)) {
  $packagePath = Join-Path $vendorRoot "naudio.$naudioVersion.zip"
  $expandedPath = Join-Path $vendorRoot "naudio.$naudioVersion"
  Invoke-WebRequest -UseBasicParsing -Uri "https://api.nuget.org/v3-flatcontainer/naudio/$naudioVersion/naudio.$naudioVersion.nupkg" -OutFile $packagePath
  if ((Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash -ne $expectedPackageHash) {
    throw 'The downloaded NAudio package failed SHA-256 verification.'
  }
  Expand-Archive -LiteralPath $packagePath -DestinationPath $expandedPath -Force
  Copy-Item -LiteralPath (Join-Path $expandedPath 'lib\net35\NAudio.dll') -Destination $naudioDll -Force
}
if ((Get-FileHash -LiteralPath $naudioDll -Algorithm SHA256).Hash -ne $expectedDllHash) {
  throw 'NAudio.dll failed SHA-256 verification.'
}

$outputExe = Join-Path $binRoot 'InterviewAudioCapture.exe'
& $compiler /nologo /optimize+ /platform:anycpu /target:exe "/out:$outputExe" "/reference:$naudioDll" (Join-Path $nativeRoot 'AudioCapture.cs')
if ($LASTEXITCODE -ne 0) { throw "Native audio helper compilation failed with exit code $LASTEXITCODE." }
Copy-Item -LiteralPath $naudioDll -Destination (Join-Path $binRoot 'NAudio.dll') -Force
Copy-Item -LiteralPath (Join-Path $nativeRoot 'THIRD_PARTY_NOTICES.txt') -Destination (Join-Path $binRoot 'THIRD_PARTY_NOTICES.txt') -Force
Write-Output "Built $outputExe"
