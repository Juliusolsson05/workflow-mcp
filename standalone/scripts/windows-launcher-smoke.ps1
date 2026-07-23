param(
  [Parameter(Mandatory = $true)] [string] $Bundle
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Temporary = Join-Path ([IO.Path]::GetTempPath()) ("workflow-mcp-windows-launcher-" + [Guid]::NewGuid().ToString("N"))
$Project = Join-Path $Temporary "project"
$Stub = Join-Path $Temporary "bin"

try {
  New-Item -ItemType Directory -Path $Project, $Stub | Out-Null
  $env:WORKFLOW_MCP_FAKE_PROJECT = $Project
  $FakeDocker = @'
param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $DockerArguments)
$ErrorActionPreference = "Stop"
function ProjectHash() {
  $Identity = $env:WORKFLOW_MCP_FAKE_PROJECT.TrimEnd('\').ToLowerInvariant()
  $Bytes = [Text.Encoding]::UTF8.GetBytes("workflow-mcp-project-v1`0$Identity")
  return ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes))).ToLowerInvariant()
}
function DaemonFingerprint() {
  $Bytes = [Text.Encoding]::UTF8.GetBytes("workflow-mcp-docker-daemon-v1`0fake-engine-id")
  return ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes))).ToLowerInvariant()
}
function ValidRecord() {
  return [ordered]@{
    schemaVersion = 1
    instanceId = "11111111-2222-4333-8444-555555555555"
    composeProjectName = "workflow-mcp-1111111122224333"
    projectDirectory = $env:WORKFLOW_MCP_FAKE_PROJECT
    projectHash = ProjectHash
    dockerContext = "default"
    dockerEndpoint = "npipe:////./pipe/docker_engine"
    dockerDaemonFingerprint = DaemonFingerprint
    image = "workflow-mcp:windows-smoke"
    createdAt = "2026-01-01T00:00:00.000Z"
    authoring = $false
  }
}
if ($DockerArguments[0] -eq "info") {
  if ($DockerArguments -contains "--format") { Write-Output "fake-engine-id" }
  exit 0
}
if ($DockerArguments[0] -eq "compose" -and $DockerArguments[1] -eq "version") { Write-Output "2.32.0"; exit 0 }
if ($DockerArguments[0] -eq "version") { Write-Output "28.3.3"; exit 0 }
if ($DockerArguments[0] -eq "context" -and $DockerArguments[1] -eq "show") { Write-Output "default"; exit 0 }
if ($DockerArguments[0] -eq "context" -and $DockerArguments[1] -eq "inspect") { Write-Output "npipe:////./pipe/docker_engine"; exit 0 }
if ($DockerArguments[0] -eq "image" -and $DockerArguments[1] -eq "inspect") { Write-Output "{}"; exit 0 }
if ($DockerArguments -contains "daemon-fingerprint") { Write-Output (DaemonFingerprint); exit 0 }
if ($DockerArguments -contains "verify-policy") { exit 0 }
if ($DockerArguments -contains "create") {
  Write-Output ((ValidRecord) | ConvertTo-Json -Compress)
  exit 0
}
if ($DockerArguments -contains "inspect") {
  $Path = Join-Path $env:WORKFLOW_MCP_FAKE_PROJECT ".workflow-mcp/instance.json"
  $Record = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
  $Expected = ValidRecord
  if ($Record.schemaVersion -ne 1 -or $Record.instanceId -ne $Expected.instanceId -or
      $Record.composeProjectName -ne $Expected.composeProjectName -or
      $Record.projectDirectory -ne $Expected.projectDirectory -or
      $Record.projectHash -ne $Expected.projectHash -or
      $Record.dockerDaemonFingerprint -ne $Expected.dockerDaemonFingerprint -or
      $Record.createdAt -ne $Expected.createdAt) {
    Write-Error "instance record failed the fake strict parser"
    exit 65
  }
  Write-Output ($Record | ConvertTo-Json -Compress)
  exit 0
}
if ($DockerArguments -contains "hash") { Write-Output (ProjectHash); exit 0 }
Write-Error "unexpected fake Docker invocation: $($DockerArguments -join ' ')"
exit 64
'@
  [IO.File]::WriteAllText((Join-Path $Stub "fake-docker.ps1"), $FakeDocker, [Text.UTF8Encoding]::new($false))
  $Wrapper = @'
@echo off
pwsh.exe -NoLogo -NoProfile -NonInteractive -File "%~dp0fake-docker.ps1" %*
exit /b %ERRORLEVEL%
'@
  [IO.File]::WriteAllText((Join-Path $Stub "docker.cmd"), $Wrapper, [Text.ASCIIEncoding]::new())
  $env:PATH = "$Stub;$env:PATH"

  # WHY: installation immediately reloads its JSON record under StrictMode. A non-web record omits
  # webPort by design, so this clean default path is the smallest executable regression for optional
  # JSON-member handling without pretending a fake Docker daemon qualifies Docker Desktop itself.
  & (Join-Path $Bundle "workflow-mcp-docker.ps1") install $Project --no-codex
  $RecordPath = Join-Path $Project ".workflow-mcp/instance.json"
  if (-not (Test-Path -LiteralPath $RecordPath -PathType Leaf)) { throw "default installation did not commit instance.json" }
  $Record = Get-Content -Raw -LiteralPath $RecordPath | ConvertFrom-Json
  if ($null -ne $Record.PSObject.Properties["webPort"]) { throw "default installation unexpectedly persisted webPort" }

  # The fake image parser models the production inspect boundary. Mutating command authority must
  # be rejected before the launcher can reach any Compose invocation.
  $Record.composeProjectName = "workflow-mcp-ffffffffffffffff"
  [IO.File]::WriteAllText($RecordPath, (($Record | ConvertTo-Json -Compress) + "`n"), [Text.UTF8Encoding]::new($false))
  $Rejected = $false
  try {
    & (Join-Path $Project ".workflow-mcp/workflow-mcp-docker.ps1") mcp-proxy $Project
  } catch {
    $Rejected = $_.Exception.Message -match 'instance.json is invalid or unsupported'
  }
  if (-not $Rejected) { throw "tampered Compose authority reached the installed launcher" }
  Write-Host "Windows default non-web launcher installation passed."
} finally {
  # This exact GUID-named temporary leaf is the only cleanup target.
  if (Test-Path -LiteralPath $Temporary) { Remove-Item -Recurse -Force -LiteralPath $Temporary }
}
