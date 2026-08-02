Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Security -ErrorAction Stop

$script:ArforgeBackupKeyBytes = 64
$script:ArforgeBackupEntropy = [Text.Encoding]::UTF8.GetBytes("Arforge PostgreSQL backup key v1")

function Get-ArforgeBackupKeyPath([string]$KeyFile) {
  if (![string]::IsNullOrWhiteSpace($KeyFile)) {
    return [IO.Path]::GetFullPath($KeyFile)
  }
  return Join-Path $env:LOCALAPPDATA "Arforge\secrets\postgres-backup.key.dpapi"
}

function New-CryptographicBytes([int]$Length) {
  $bytes = New-Object byte[] $Length
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  return $bytes
}

function Get-ArforgeBackupMasterKey(
  [string]$KeyFile,
  [switch]$Create
) {
  $path = Get-ArforgeBackupKeyPath $KeyFile
  if (!(Test-Path -LiteralPath $path -PathType Leaf)) {
    if (!$Create) {
      throw "The encrypted backup key is missing: $path"
    }

    $parent = Split-Path -Parent $path
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $masterKey = New-CryptographicBytes $script:ArforgeBackupKeyBytes
    try {
      $protected = [Security.Cryptography.ProtectedData]::Protect(
        $masterKey,
        $script:ArforgeBackupEntropy,
        [Security.Cryptography.DataProtectionScope]::CurrentUser
      )
      $partial = "$path.partial"
      [IO.File]::WriteAllBytes($partial, $protected)
      Move-Item -LiteralPath $partial -Destination $path -Force
    } finally {
      if ($null -ne $masterKey) {
        [Array]::Clear($masterKey, 0, $masterKey.Length)
      }
    }
  }

  $protectedKey = [IO.File]::ReadAllBytes($path)
  $key = [Security.Cryptography.ProtectedData]::Unprotect(
    $protectedKey,
    $script:ArforgeBackupEntropy,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  if ($key.Length -ne $script:ArforgeBackupKeyBytes) {
    [Array]::Clear($key, 0, $key.Length)
    throw "The encrypted backup key has an unexpected length."
  }
  return $key
}

function Get-KeySlice([byte[]]$MasterKey, [int]$Offset, [int]$Length) {
  $slice = New-Object byte[] $Length
  [Array]::Copy($MasterKey, $Offset, $slice, 0, $Length)
  return $slice
}

function Get-HmacForEncryptedBackup(
  [string]$EncryptedFile,
  [byte[]]$Iv,
  [byte[]]$HmacKey
) {
  $hmac = New-Object Security.Cryptography.HMACSHA256 -ArgumentList (, $HmacKey)
  $stream = [IO.File]::OpenRead($EncryptedFile)
  $buffer = New-Object byte[] (1024 * 1024)
  try {
    $null = $hmac.TransformBlock($Iv, 0, $Iv.Length, $null, 0)
    while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $null = $hmac.TransformBlock($buffer, 0, $read, $null, 0)
    }
    $null = $hmac.TransformFinalBlock((New-Object byte[] 0), 0, 0)
    return $hmac.Hash
  } finally {
    $stream.Dispose()
    $hmac.Dispose()
    [Array]::Clear($buffer, 0, $buffer.Length)
  }
}

function Test-ConstantTimeBytes([byte[]]$Left, [byte[]]$Right) {
  if ($null -eq $Left -or $null -eq $Right -or $Left.Length -ne $Right.Length) {
    return $false
  }
  $difference = 0
  for ($index = 0; $index -lt $Left.Length; $index++) {
    $difference = $difference -bor ($Left[$index] -bxor $Right[$index])
  }
  return $difference -eq 0
}

function Protect-ArforgeBackup(
  [string]$InputFile,
  [string]$OutputFile,
  [string]$KeyFile
) {
  $masterKey = Get-ArforgeBackupMasterKey $KeyFile -Create
  $aesKey = Get-KeySlice $masterKey 0 32
  $hmacKey = Get-KeySlice $masterKey 32 32
  $iv = New-CryptographicBytes 16
  $aes = [Security.Cryptography.Aes]::Create()
  $input = $null
  $output = $null
  $crypto = $null
  try {
    $aes.Mode = [Security.Cryptography.CipherMode]::CBC
    $aes.Padding = [Security.Cryptography.PaddingMode]::PKCS7
    $aes.KeySize = 256
    $aes.Key = $aesKey
    $aes.IV = $iv
    $input = [IO.File]::OpenRead($InputFile)
    $output = [IO.File]::Open($OutputFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $crypto = New-Object Security.Cryptography.CryptoStream(
      $output,
      $aes.CreateEncryptor(),
      [Security.Cryptography.CryptoStreamMode]::Write
    )
    $input.CopyTo($crypto)
    $crypto.FlushFinalBlock()
    $crypto.Dispose()
    $crypto = $null
    $output.Dispose()
    $output = $null

    $hmac = Get-HmacForEncryptedBackup $OutputFile $iv $hmacKey
    return [pscustomobject]@{
      IvBase64 = [Convert]::ToBase64String($iv)
      HmacSha256 = ([BitConverter]::ToString($hmac)).Replace("-", "")
    }
  } finally {
    if ($null -ne $crypto) { $crypto.Dispose() }
    if ($null -ne $output) { $output.Dispose() }
    if ($null -ne $input) { $input.Dispose() }
    $aes.Dispose()
    [Array]::Clear($masterKey, 0, $masterKey.Length)
    [Array]::Clear($aesKey, 0, $aesKey.Length)
    [Array]::Clear($hmacKey, 0, $hmacKey.Length)
  }
}

function Unprotect-ArforgeBackup(
  [string]$InputFile,
  [string]$OutputFile,
  [string]$IvBase64,
  [string]$ExpectedHmacSha256,
  [string]$KeyFile
) {
  $masterKey = Get-ArforgeBackupMasterKey $KeyFile
  $aesKey = Get-KeySlice $masterKey 0 32
  $hmacKey = Get-KeySlice $masterKey 32 32
  $iv = [Convert]::FromBase64String($IvBase64)
  $expectedHmac = New-Object byte[] ($ExpectedHmacSha256.Length / 2)
  for ($index = 0; $index -lt $expectedHmac.Length; $index++) {
    $expectedHmac[$index] = [Convert]::ToByte($ExpectedHmacSha256.Substring($index * 2, 2), 16)
  }
  $actualHmac = Get-HmacForEncryptedBackup $InputFile $iv $hmacKey
  if (!(Test-ConstantTimeBytes $expectedHmac $actualHmac)) {
    throw "Encrypted backup authentication failed. The backup, manifest, or key is invalid."
  }

  $aes = [Security.Cryptography.Aes]::Create()
  $input = $null
  $output = $null
  $crypto = $null
  try {
    $aes.Mode = [Security.Cryptography.CipherMode]::CBC
    $aes.Padding = [Security.Cryptography.PaddingMode]::PKCS7
    $aes.KeySize = 256
    $aes.Key = $aesKey
    $aes.IV = $iv
    $input = [IO.File]::OpenRead($InputFile)
    $crypto = New-Object Security.Cryptography.CryptoStream(
      $input,
      $aes.CreateDecryptor(),
      [Security.Cryptography.CryptoStreamMode]::Read
    )
    $output = [IO.File]::Open($OutputFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $crypto.CopyTo($output)
  } finally {
    if ($null -ne $output) { $output.Dispose() }
    if ($null -ne $crypto) { $crypto.Dispose() }
    if ($null -ne $input) { $input.Dispose() }
    $aes.Dispose()
    [Array]::Clear($masterKey, 0, $masterKey.Length)
    [Array]::Clear($aesKey, 0, $aesKey.Length)
    [Array]::Clear($hmacKey, 0, $hmacKey.Length)
  }
}
