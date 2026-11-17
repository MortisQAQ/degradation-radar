# Generate a local CA + MITM leaf certificate for the capture proxy.
#
# No openssl needed: PowerShell's New-SelfSignedCertificate builds both certs
# and exports them as PFX, which node:tls accepts directly (pfx + passphrase).
#
#   radar-ca    -> CurrentUser\Root   (what makes Go/Node/Python CLIs trust us)
#   radar-mitm  -> CurrentUser\My     (server cert, SANs cover the CLI upstreams)
#
# Re-running is idempotent: existing certs by subject are replaced.
param(
  [string]$OutDir = (Join-Path $PSScriptRoot '..\certs'),
  [string]$Pass = 'radar-local'
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path

# Wildcards cover one label, so *.googleapis.com matches
# daily-cloudcode-pa.googleapis.com without listing every host.
$dns = @(
  'googleapis.com', '*.googleapis.com',
  'google.com', '*.google.com',
  'anthropic.com', '*.anthropic.com',
  'openai.com', '*.openai.com',
  'chatgpt.com', '*.chatgpt.com',
  'oaistatic.com', '*.oaistatic.com',
  'statsig.com', '*.statsig.com'
)

Write-Host "==> CA" -ForegroundColor Cyan
# Reuse an existing radar CA when one is already installed. Regenerating it on
# every run would leave the old one trusted, and a leaf signed by the new CA
# would then fail to chain against the stale root of the same name.
$caSubject = 'CN=Degradation Radar Local CA'
$ca = Get-ChildItem 'Cert:\CurrentUser\My' |
  Where-Object { $_.Subject -eq $caSubject -and $_.HasPrivateKey } |
  Sort-Object NotAfter -Descending |
  Select-Object -First 1
if ($ca) {
  Write-Host "    reusing existing CA (expires $($ca.NotAfter.ToString('yyyy-MM-dd')))" -ForegroundColor DarkGray
} else {
  $ca = New-SelfSignedCertificate `
    -Subject $caSubject `
    -KeyExportPolicy Exportable `
    -KeyUsage CertSign, CRLSign, DigitalSignature `
    -KeyUsageProperty Sign `
    -KeyLength 2048 `
    -HashAlgorithm sha256 `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -NotAfter (Get-Date).AddYears(5) `
    -TextExtension @('2.5.29.19={critical}{text}ca=1&pathlength=1')
}

Write-Host "==> leaf: $($dns -join ', ')" -ForegroundColor Cyan
$leaf = New-SelfSignedCertificate `
  -Subject 'CN=daily-cloudcode-pa.googleapis.com' `
  -KeyExportPolicy Exportable `
  -KeyUsage DigitalSignature, KeyEncipherment `
  -KeyLength 2048 `
  -HashAlgorithm sha256 `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -NotAfter (Get-Date).AddYears(2) `
  -Signer $ca `
  -TextExtension @(
    '2.5.29.17={text}DNS=' + ($dns -join '&DNS='),
    '2.5.29.19={critical}{text}ca=0'
  )

$secure = ConvertTo-SecureString -String $Pass -Force -AsPlainText
foreach ($pair in @(@{ c = $leaf; n = 'leaf.pfx' }, @{ c = $ca; n = 'ca.pfx' })) {
  $path = Join-Path $OutDir $pair.n
  Export-PfxCertificate -Cert $pair.c -FilePath $path -Password $secure | Out-Null
  Write-Host "    wrote $path"
}

# Trust the CA for the current user (no elevation required). Go on Windows
# verifies against this store, which is why agy accepts the intercepted TLS.
$already = Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Subject -eq $ca.Subject }
if (-not $already) {
  $caPath = Join-Path $OutDir 'ca.cer'
  Export-Certificate -Cert $ca -FilePath $caPath | Out-Null
  certutil -user -addstore Root $caPath | Out-Null
  Write-Host '==> CA installed into CurrentUser\Root' -ForegroundColor Green
} else {
  Write-Host '==> CA already trusted' -ForegroundColor DarkGray
}

Set-Content -Path (Join-Path $OutDir 'pass.txt') -Value $Pass -NoNewline

# PEM copy of the CA. Node (NODE_EXTRA_CA_CERTS) and Rust (CODEX_CA_CERTIFICATE,
# SSL_CERT_FILE) will not read the Windows store or a PFX, so every CLI family
# gets a bundle it can actually parse.
$b64 = [Convert]::ToBase64String($ca.RawData, 'InsertLineBreaks')
$pem = "-----BEGIN CERTIFICATE-----`n$b64`n-----END CERTIFICATE-----`n"
[IO.File]::WriteAllText((Join-Path $OutDir 'ca.pem'), $pem, [Text.UTF8Encoding]::new($false))
Write-Host "    wrote $(Join-Path $OutDir 'ca.pem')"

Write-Host "done: $OutDir" -ForegroundColor Green
