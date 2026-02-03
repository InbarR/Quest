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
    Write-Host "`n[1/4] Building server..." -ForegroundColor Yellow

    $serverDir = Join-Path $scriptDir "server"
    $serverOutput = Join-Path (Join-Path $scriptDir "extension") "server"

    # Clean previous build
    if (Test-Path $serverOutput) {
        Remove-Item -Recurse -Force $serverOutput
    }
    New-Item -ItemType Directory -Force -Path $serverOutput | Out-Null

    # Build self-contained single-file executable
    Push-Location $serverDir
    try {
        dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o $serverOutput

        if ($LASTEXITCODE -ne 0) {
            throw "Server build failed"
        }

        Write-Host "Server built successfully to: $serverOutput" -ForegroundColor Green
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
