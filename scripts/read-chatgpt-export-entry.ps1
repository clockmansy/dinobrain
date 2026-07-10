param(
  [Parameter(Mandatory = $true)]
  [string]$ZipPath,

  [string]$EntryName,

  [switch]$List
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.IO.Compression.FileSystem

$resolvedZip = [System.IO.Path]::GetFullPath($ZipPath)
if (-not [System.IO.File]::Exists($resolvedZip)) {
  throw "ChatGPT export ZIP does not exist: $resolvedZip"
}

$archive = [System.IO.Compression.ZipFile]::OpenRead($resolvedZip)
try {
  if ($List) {
    $entries = @(
      $archive.Entries | ForEach-Object {
        [ordered]@{
          name = $_.FullName
          length = $_.Length
          compressed_length = $_.CompressedLength
          last_write_time = $_.LastWriteTime.UtcDateTime.ToString("o")
        }
      }
    )
    $json = ConvertTo-Json -InputObject $entries -Depth 4 -Compress
    $encoding = New-Object System.Text.UTF8Encoding($false)
    $bytes = $encoding.GetBytes($json)
    $stdout = [Console]::OpenStandardOutput()
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
    exit 0
  }

  if ([string]::IsNullOrWhiteSpace($EntryName)) {
    throw "EntryName is required unless -List is used."
  }
  if ($EntryName.Contains("\") -or $EntryName.StartsWith("/") -or $EntryName.Split("/") -contains "..") {
    throw "Invalid ZIP entry name: $EntryName"
  }

  $entry = $archive.GetEntry($EntryName)
  if ($null -eq $entry) {
    throw "ZIP entry not found: $EntryName"
  }

  $inputStream = $entry.Open()
  try {
    $stdout = [Console]::OpenStandardOutput()
    $inputStream.CopyTo($stdout)
    $stdout.Flush()
  } finally {
    $inputStream.Dispose()
  }
} finally {
  $archive.Dispose()
}
