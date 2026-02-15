# Build script for Query Studio VS Code extension
# This script builds the server and packages the extension

param(
    [switch]$SkipServer,
    [switch]$SkipExtension
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "=== Building Query Studio Extension ===" -ForegroundColor Cyan

# Build the server
if (-not $SkipServer) {
    Write-Host "`n[1/4] Building server for all platforms..." -ForegroundColor Yellow

    $serverDir = Join-Path $scriptDir "server"
    $serverBaseOutput = Join-Path (Join-Path $scriptDir "extension") "server"

    # Clean previous build
    if (Test-Path $serverBaseOutput) {
        Remove-Item -Recurse -Force $serverBaseOutput
    }

    # Build for each platform
    $platforms = @(
        @{ rid = "win-x64"; name = "Windows x64" },
        @{ rid = "osx-x64"; name = "macOS Intel" },
        @{ rid = "osx-arm64"; name = "macOS Apple Silicon" }
    )

    Push-Location $serverDir
    try {
        foreach ($platform in $platforms) {
            $rid = $platform.rid
            $name = $platform.name
            $serverOutput = Join-Path $serverBaseOutput $rid

            Write-Host "  Building for $name ($rid)..." -ForegroundColor Cyan
            New-Item -ItemType Directory -Force -Path $serverOutput | Out-Null

            dotnet publish -c Release -r $rid --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o $serverOutput

            if ($LASTEXITCODE -ne 0) {
                throw "Server build failed for $rid"
            }
        }

        # Ad-hoc sign macOS binaries to prevent Gatekeeper SIGKILL
        foreach ($platform in $platforms) {
            if ($platform.rid -like "osx-*") {
                $macBinary = Join-Path (Join-Path $serverBaseOutput $platform.rid) "QueryStudio.Server"
                if (Test-Path $macBinary) {
                    Write-Host "  Ad-hoc signing $($platform.name) binary..." -ForegroundColor Cyan
                    if (Get-Command codesign -ErrorAction SilentlyContinue) {
                        codesign --force --deep --sign - $macBinary
                        if ($LASTEXITCODE -ne 0) {
                            Write-Host "  Warning: codesign failed for $($platform.rid) - Mac users may need to run: xattr -dr com.apple.quarantine <path>" -ForegroundColor Yellow
                        }
                    } else {
                        Write-Host "  Warning: codesign not available (not on macOS). Mac users may need to run: xattr -dr com.apple.quarantine <path>" -ForegroundColor Yellow
                    }
                }
            }
        }

        Write-Host "Server built successfully for all platforms" -ForegroundColor Green
    }
    finally {
        Pop-Location
    }
}

# Build the extension
if (-not $SkipExtension) {
    Write-Host "`n[2/4] Compiling TypeScript..." -ForegroundColor Yellow

    $extensionDir = Join-Path $scriptDir "extension"
    Push-Location $extensionDir
    try {
        npm run compile

        if ($LASTEXITCODE -ne 0) {
            throw "TypeScript compilation failed"
        }

        Write-Host "TypeScript compiled successfully" -ForegroundColor Green
    }
    finally {
        Pop-Location
    }

    Write-Host "`n[3/4] Installing vsce if needed..." -ForegroundColor Yellow
    npm list -g @vscode/vsce >$null 2>&1
    if ($LASTEXITCODE -ne 0) {
        npm install -g @vscode/vsce
    }

    Write-Host "`n[4/4] Packaging extension..." -ForegroundColor Yellow
    Push-Location $extensionDir
    try {
        vsce package

        if ($LASTEXITCODE -ne 0) {
            throw "Extension packaging failed"
        }

        $vsix = Get-ChildItem -Path $extensionDir -Filter "*.vsix" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        Write-Host "`nExtension packaged successfully: $($vsix.FullName)" -ForegroundColor Green
    }
    finally {
        Pop-Location
    }
}

Write-Host "`n=== Build Complete ===" -ForegroundColor Cyan
Write-Host "To install locally: code --install-extension extension\query-studio-*.vsix"
Write-Host "To publish: vsce publish (requires PAT token)"
