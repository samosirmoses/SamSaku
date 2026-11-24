$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root '.env'
if (Test-Path -LiteralPath $target) {
    Write-Output 'Konfigurasi .env sudah tersedia.'
    exit 0
}
$generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
function New-LocalSecret {
    $bytes = New-Object byte[] 32
    $generator.GetBytes($bytes)
    return [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
}
try {
    $template = [IO.File]::ReadAllText((Join-Path $root '.env.example'))
    foreach ($name in @('LOCAL_DB_PASSWORD', 'SAMSAKU_DEV_TOKEN')) {
        $template = [regex]::Replace($template, "(?m)^$name=\r?$", "$name=$(New-LocalSecret)")
    }
    $content = [Text.Encoding]::UTF8.GetBytes($template)
    $file = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
    try { $file.Write($content, 0, $content.Length) } finally { $file.Dispose() }
    Write-Output 'Konfigurasi lokal dibuat. Gunakan SAMSAKU_DEV_TOKEN dari .env untuk masuk di localhost.'
} finally { $generator.Dispose() }
