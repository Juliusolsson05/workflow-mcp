param(
  [Parameter(Position = 0)] [string] $Command = "help",
  [Parameter(Position = 1)] [string] $Project = ".",
  [Parameter(ValueFromRemainingArguments = $true)] [string[]] $Rest
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Fail([string] $Message) { throw "workflow-mcp-docker: $Message" }
function Assert-TerminalSafePath([string] $Path) {
  # WHY: these host paths later appear in errors and success messages. Quoting a path is not a
  # terminal-safety boundary: ESC/C1 and Unicode format/bidi code points still execute or reorder
  # output. Reject them before any path-derived string is printed or persisted.
  if ($Path -match '[\p{Cc}\p{Cf}]') {
    Fail "path contains terminal control, bidi, or format characters"
  }
}
function Canonical-Directory([string] $Path) {
  Assert-TerminalSafePath $Path
  $Full = [IO.Path]::GetFullPath($Path)
  Assert-TerminalSafePath $Full
  # WHY: Docker Desktop bind-source parsing and PowerShell filesystem resolution do not share a
  # safe identity model for UNC/device paths or redirected ancestors. A leaf-only reparse check can
  # therefore attest one spelling while Docker mounts another target. V1 deliberately accepts only
  # an ordinary local drive path and walks every existing component before any project mutation.
  if ($Full -notmatch '^[A-Za-z]:[\\/]' -or $Full -match '^\\\\[?.]\\') {
    Fail "only local drive-qualified paths are supported: $Path"
  }
  if (-not (Test-Path -LiteralPath $Full -PathType Container)) { Fail "directory does not exist: $Path" }
  $Root = [IO.Path]::GetPathRoot($Full)
  $Current = Get-Item -Force -LiteralPath $Root
  if ($Current.Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail "refusing redirected path: $Path" }
  foreach ($Part in $Full.Substring($Root.Length).Split(@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar), [StringSplitOptions]::RemoveEmptyEntries)) {
    $Current = Get-Item -Force -LiteralPath (Join-Path $Current.FullName $Part)
    if ($Current.Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail "refusing redirected path: $Path" }
  }
  if (-not $Current.PSIsContainer) { Fail "directory does not exist: $Path" }
  return $Current.FullName
}

function Canonical-File([string] $Path, [string] $Kind) {
  Assert-TerminalSafePath $Path
  $Full = [IO.Path]::GetFullPath($Path)
  Assert-TerminalSafePath $Full
  $Parent = Canonical-Directory ([IO.Path]::GetDirectoryName($Full))
  $Expected = Join-Path $Parent ([IO.Path]::GetFileName($Full))
  if (-not (Test-Path -LiteralPath $Expected -PathType Leaf)) { Fail "$Kind file does not exist" }
  $Item = Get-Item -Force -LiteralPath $Expected
  if ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail "$Kind file may not be redirected" }
  return $Item.FullName
}

$ScriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
if (Test-Path -LiteralPath (Join-Path $ScriptDirectory "compose.yaml")) {
  $BundleRoot = $ScriptDirectory
} else {
  $BundleRoot = Split-Path -Parent $ScriptDirectory
}
$UpgradeNames = @("LICENSE", "compose.yaml", "compose.web.yaml", "compose.authoring.yaml", "compose.auth-api-key.yaml", "compose.project-codex-mask.yaml", "workflow-mcp-docker", "workflow-mcp-docker.ps1", "version.env", "SHA256SUMS", ".gitignore", "instance.json")

function Write-InstalledChecksumManifest([string] $TargetDirectory) {
  $Source = Join-Path $BundleRoot "SHA256SUMS"
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { return }
  # The release-only launcher smoke is not copied into a project. Every other archive digest remains
  # applicable byte-for-byte and protects installed Compose/launcher/version authority on each run.
  $Lines = [IO.File]::ReadAllLines($Source) | Where-Object { $_ -notmatch '  launcher-smoke\.sh$' }
  [IO.File]::WriteAllLines((Join-Path $TargetDirectory "SHA256SUMS"), $Lines, [Text.UTF8Encoding]::new($false))
}

function Remove-UpgradeDirectories([string] $Installation) {
  $PreparingMarker = Join-Path $Installation ".upgrade-transaction.tmp"
  if (Test-Path -LiteralPath $PreparingMarker -PathType Leaf) { Remove-Item -Force -LiteralPath $PreparingMarker }
  foreach ($Leaf in @(".upgrade-stage", ".upgrade-rollback")) {
    $Directory = Join-Path $Installation $Leaf
    if (Test-Path -LiteralPath $Directory -PathType Container) {
      foreach ($Name in $UpgradeNames) {
        $Target = Join-Path $Directory $Name
        if (Test-Path -LiteralPath $Target) { Remove-Item -Force -LiteralPath $Target }
      }
      Remove-Item -Force -LiteralPath $Directory
    }
  }
}

function Restore-InterruptedUpgrade([string] $Installation) {
  $Marker = Join-Path $Installation ".upgrade-transaction"
  if (-not (Test-Path -LiteralPath $Marker -PathType Leaf)) {
    Remove-UpgradeDirectories $Installation
    return
  }
  $Rollback = Join-Path $Installation ".upgrade-rollback"
  foreach ($Name in $UpgradeNames) {
    if (-not (Test-Path -LiteralPath (Join-Path $Rollback $Name) -PathType Leaf)) {
      Fail "upgrade rollback is incomplete: $Name"
    }
  }
  # Rollback bytes are copied and atomically moved one at a time while the marker remains. If the
  # host stops during recovery, the next invocation safely repeats the whole restoration before it
  # reads version/image authority from what might otherwise be a mixed public bundle.
  foreach ($Name in $UpgradeNames) {
    $Temporary = Join-Path $Installation ".recover-$Name-$([Guid]::NewGuid().ToString('N'))"
    Copy-Item -LiteralPath (Join-Path $Rollback $Name) -Destination $Temporary
    Move-Item -Force -LiteralPath $Temporary -Destination (Join-Path $Installation $Name)
  }
  Remove-Item -Force -LiteralPath $Marker
  Remove-UpgradeDirectories $Installation
  Write-Warning "Recovered the complete previous Workflow MCP bundle after an interrupted upgrade."
}

if (Test-Path -LiteralPath (Join-Path $ScriptDirectory "instance.json") -PathType Leaf) {
  Restore-InterruptedUpgrade $ScriptDirectory
}
$VersionPath = Join-Path $BundleRoot "version.env"
if (-not (Test-Path -LiteralPath $VersionPath)) { $VersionPath = Join-Path $BundleRoot "install/version.env" }
if (-not (Test-Path -LiteralPath $VersionPath)) { Fail "version.env is missing" }
$VersionValues = @{}
Get-Content -LiteralPath $VersionPath | ForEach-Object {
  if ($_ -match '^([A-Z0-9_]+)=(.+)$') { $VersionValues[$Matches[1]] = $Matches[2] }
}
$Image = $VersionValues["WORKFLOW_MCP_IMAGE"]
if ([string]::IsNullOrWhiteSpace($Image)) { Fail "version.env has no image" }
$script:AllowImageMismatch = $false
$script:AllowExternalPolicyMismatch = $false

$ChecksumPath = Join-Path $BundleRoot "SHA256SUMS"
if (Test-Path -LiteralPath $ChecksumPath -PathType Leaf) {
  # GitHub release attestation establishes publisher identity; these hashes then
  # catch extraction or storage corruption before any bundle file reaches Docker.
  foreach ($Line in [IO.File]::ReadAllLines($ChecksumPath)) {
    if ($Line -notmatch '^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$') { Fail "malformed SHA256SUMS entry" }
    $Target = Join-Path $BundleRoot $Matches[2]
    if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) { Fail "bundle file is missing: $($Matches[2])" }
    $Actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Target).Hash.ToLowerInvariant()
    if ($Actual -ne $Matches[1]) { Fail "bundle checksum verification failed: $($Matches[2])" }
  }
}

if ($Command -eq "install" -and $Project.StartsWith("--")) {
  $Rest = @($Project) + @($Rest)
  $Project = "."
}
if ($Command -ne "install") {
  # Installed launchers are deliberately self-locating: the command printed by
  # installation must keep working from every shell directory. A leading option
  # is command input rather than a strangely named project directory.
  $DefaultProject = "."
  if (Test-Path -LiteralPath (Join-Path $ScriptDirectory "instance.json")) {
    $DefaultProject = Split-Path -Parent $ScriptDirectory
  }
  if ($Project.StartsWith("--")) {
    $Rest = @($Project) + @($Rest)
    $Project = $DefaultProject
  } elseif ($Project -eq ".") {
    $Project = $DefaultProject
  }
  if ($Command -eq "backup" -and ($Project -eq "create" -or $Project -eq "verify")) {
    $Rest = @($Project) + @($Rest)
    $Project = $DefaultProject
  }
  if ($Command -eq "restore" -and $Project -eq "reset-target") {
    $Rest = @($Project) + @($Rest)
    $Project = $DefaultProject
  }
  if (($Command -eq "auth" -and $Project -in @("login", "status", "logout")) -or
      ($Command -eq "source" -and $Project -in @("approvals", "approve")) -or
      ($Command -eq "migrate" -and $Project -eq "inspect")) {
    $Rest = @($Project) + @($Rest)
    $Project = $DefaultProject
  }
}

function Host-Doctor([bool] $NeedWeb) {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail "Docker CLI is not installed" }
  docker info | Out-Null
  $script:ComposeVersion = ((docker compose version --short) -replace '[^0-9.].*$', '')
  $script:DockerClientVersion = ((docker version --format '{{.Client.Version}}') -replace '[^0-9.].*$', '')
  $script:DockerServerVersion = ((docker version --format '{{.Server.Version}}') -replace '[^0-9.].*$', '')
  $script:HostDescription = "Windows-$env:PROCESSOR_ARCHITECTURE-PowerShell-$($PSVersionTable.PSVersion)"
  if ([Version]$script:ComposeVersion -lt [Version]"2.32.0") { Fail "Docker Compose 2.32.0+ is required" }
  $script:DockerContext = (docker context show).Trim()
  $script:DockerEndpoint = (docker context inspect $script:DockerContext --format '{{.Endpoints.docker.Host}}').Trim()
  $script:DockerDaemonId = (docker info --format '{{.ID}}').Trim()
  if ([string]::IsNullOrWhiteSpace($script:DockerDaemonId)) { Fail "Docker daemon did not report a stable engine ID" }
  if ($script:DockerEndpoint -notmatch '^(npipe|unix)://') { Fail "remote Docker contexts are unsupported" }
  if ($NeedWeb) {
    $Engine = [Version]$script:DockerServerVersion
    if ($Engine -lt [Version]"28.3.3") { Fail "loopback web publication requires Docker Engine 28.3.3+" }
  }
}

function Set-DockerDaemonFingerprint() {
  $script:DockerDaemonFingerprint = (& docker run --rm --network none --read-only --user 0:0 `
    $Image instance daemon-fingerprint "--daemon-id=$script:DockerDaemonId").Trim()
  if ($LASTEXITCODE -ne 0 -or $script:DockerDaemonFingerprint -notmatch '^[a-f0-9]{64}$') {
    Fail "could not derive Docker daemon identity"
  }
}

function Load-Instance([string] $ProjectPath) {
  $script:ProjectDirectory = Canonical-Directory $ProjectPath
  $script:Installation = Join-Path $script:ProjectDirectory ".workflow-mcp"
  $script:InstancePath = Join-Path $script:Installation "instance.json"
  if (-not (Test-Path -LiteralPath $script:InstancePath)) { Fail "not installed; run install first" }
  Host-Doctor $false
  docker image inspect $Image 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { docker pull $Image | Out-Null }
  Set-DockerDaemonFingerprint
  # WHY: ConvertFrom-Json proves syntax only. Compose project name is command authority, so the
  # PowerShell launcher must not consume any member until the same pinned image parser used by the
  # POSIX launcher has checked size, schema, UUID-derived name, canonical path/hash, and field types.
  # WHY: PowerShell 7 can promote a native child's stderr into a terminating ErrorRecord under
  # `$ErrorActionPreference = "Stop"`. Invalid untrusted JSON is an expected parser outcome here,
  # not a PowerShell transport failure; discard the image parser's detail so the exit code below
  # always becomes the launcher's stable public error and never skips the command-authority fence.
  $ValidatedRecord = & docker run --rm --network none --read-only --user 0:0 `
    -v "${script:Installation}:/bundle:ro" $Image instance inspect --file=/bundle/instance.json 2>$null
  if ($LASTEXITCODE -ne 0) { Fail "instance.json is invalid or unsupported" }
  try {
    $script:Instance = (@($ValidatedRecord) -join [Environment]::NewLine) | ConvertFrom-Json
  } catch {
    Fail "validated instance parser returned malformed JSON"
  }
  # WHY: webPort is intentionally absent from the default non-web instance schema. StrictMode turns
  # direct access to an absent JSON member into a terminating error, so normalize the optional field
  # once and make every later overlay decision consume the same value.
  $WebPortProperty = $script:Instance.PSObject.Properties["webPort"]
  $script:InstanceWebPort = if ($null -eq $WebPortProperty) { $null } else { $WebPortProperty.Value }
  if ($null -ne $script:InstanceWebPort) { Host-Doctor $true }
  if ($script:Instance.image -ne $Image -and -not $script:AllowImageMismatch) { Fail "bundle and instance images differ; use upgrade" }
  if ($BundleRoot -ne $script:Installation -and -not $script:AllowExternalPolicyMismatch) {
    & docker run --rm --network none --read-only --user 0:0 `
      -v "${script:Installation}:/bundle:ro" $Image instance verify-policy --directory=/bundle | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "installed Compose policy differs from the verified recovery bundle" }
  }
  if ($script:Instance.dockerContext -ne $script:DockerContext -or $script:Instance.dockerEndpoint -ne $script:DockerEndpoint) {
    Fail "Docker context changed since install; switch back to the recorded context (cross-context identity import is not supported in v1)"
  }
  if ($script:Instance.dockerDaemonFingerprint -ne $script:DockerDaemonFingerprint) {
    Fail "Docker daemon changed since install; cross-daemon identity import is not supported in v1"
  }
  $ActualHash = (docker run --rm $Image instance hash "--project=$script:ProjectDirectory").Trim()
  if ($ActualHash -ne $script:Instance.projectHash) { Fail "instance belongs to another canonical project" }
  $env:WORKFLOW_MCP_IMAGE = $Image
  $env:WORKFLOW_MCP_INSTANCE_ID = $script:Instance.instanceId
  $env:WORKFLOW_MCP_PROJECT_HASH = $script:Instance.projectHash
  $env:WORKFLOW_MCP_PROJECT_DIR = $script:ProjectDirectory
  $env:WORKFLOW_MCP_DOCKER_DAEMON_FINGERPRINT = $script:DockerDaemonFingerprint
  # The instance record, not inherited process state or an earlier rollback load, decides which
  # optional Compose overlays exist for this exact identity.
  Remove-Item Env:WORKFLOW_MCP_PORT, Env:WORKFLOW_MCP_WORKFLOW_DIR, Env:WORKFLOW_MCP_OPENAI_API_KEY_FILE -ErrorAction SilentlyContinue
  $script:ApiKeyUnavailable = $false
  if ($null -ne $script:InstanceWebPort) { $env:WORKFLOW_MCP_PORT = [string]$script:InstanceWebPort }
  if ($script:Instance.authoring) {
    Test-AuthoringPath $false
    $env:WORKFLOW_MCP_WORKFLOW_DIR = Join-Path $script:ProjectDirectory ".claude/workflows"
  }
  $ApiKeyProperty = $script:Instance.PSObject.Properties["apiKeyFile"]
  if ($null -ne $ApiKeyProperty) {
    if ((Test-Path -LiteralPath $ApiKeyProperty.Value -PathType Leaf) -and
      -not ((Get-Item -Force -LiteralPath $ApiKeyProperty.Value).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      $env:WORKFLOW_MCP_OPENAI_API_KEY_FILE = [string]$ApiKeyProperty.Value
    } else {
      $script:ApiKeyUnavailable = $true
    }
  }
}

function Require-RuntimeApiKey() {
  if ($script:ApiKeyUnavailable) { Fail "recorded API key file is missing or redirected" }
  $ApiKeyProperty = $script:Instance.PSObject.Properties["apiKeyFile"]
  if ($null -ne $ApiKeyProperty) {
    # Rotating the external file is supported, so the install-time probe cannot authorize a later
    # container start. Rewalk every ancestor and exercise the exact runtime UID before `up` or
    # `upgrade` gets permission to create containers or quiesce the healthy old daemon.
    $ValidatedApiKey = Canonical-File ([string]$ApiKeyProperty.Value) "API key"
    if ($ValidatedApiKey -ne [string]$ApiKeyProperty.Value) {
      Fail "recorded API key file path is redirected"
    }
    $env:WORKFLOW_MCP_OPENAI_API_KEY_FILE = $ValidatedApiKey
    Test-ApiKeyForRuntime $ValidatedApiKey
  }
}

function Compose-Arguments() {
  $Arguments = @("compose", "-p", $script:Instance.composeProjectName, "--project-directory", $script:Installation, "-f", (Join-Path $script:Installation "compose.yaml"))
  $CodexDirectory = Join-Path $script:ProjectDirectory ".codex"
  if (Test-Path -LiteralPath $CodexDirectory -PathType Container) { $Arguments += @("-f", (Join-Path $script:Installation "compose.project-codex-mask.yaml")) }
  if ($null -ne $script:InstanceWebPort) { $Arguments += @("-f", (Join-Path $script:Installation "compose.web.yaml")) }
  if ($script:Instance.authoring) { $Arguments += @("-f", (Join-Path $script:Installation "compose.authoring.yaml")) }
  if ($env:WORKFLOW_MCP_OPENAI_API_KEY_FILE) {
    if (-not [IO.Path]::IsPathRooted($env:WORKFLOW_MCP_OPENAI_API_KEY_FILE)) { Fail "API key path must be absolute" }
    $Arguments += @("-f", (Join-Path $script:Installation "compose.auth-api-key.yaml"))
  }
  return $Arguments
}

function Invoke-Compose([string[]] $Arguments) {
  & docker @((Compose-Arguments) + $Arguments)
  if ($LASTEXITCODE -ne 0) { Fail "Docker Compose command failed" }
}

function Attest-Volume() {
  $script:Volume = "$($script:Instance.composeProjectName)_workflow-mcp-data"
  $script:VolumeDriver = (docker volume inspect $script:Volume --format '{{.Driver}}').Trim()
  $script:VolumeOptions = (docker volume inspect $script:Volume --format '{{json .Options}}').Trim()
  $script:VolumeInstanceLabel = (docker volume inspect $script:Volume --format '{{index .Labels "io.workflow-mcp.instance-id"}}').Trim()
  $script:VolumeProjectLabel = (docker volume inspect $script:Volume --format '{{index .Labels "io.workflow-mcp.project-hash"}}').Trim()
  $script:VolumeDaemonLabel = (docker volume inspect $script:Volume --format '{{index .Labels "io.workflow-mcp.docker-daemon-fingerprint"}}').Trim()
  if ($script:VolumeDriver -ne "local" -or ($script:VolumeOptions -ne "null" -and $script:VolumeOptions -ne "{}")) { Fail "unsupported volume driver/options" }
  if ($script:VolumeInstanceLabel -ne $script:Instance.instanceId -or
      $script:VolumeProjectLabel -ne $script:Instance.projectHash -or
      $script:VolumeDaemonLabel -ne $script:DockerDaemonFingerprint) { Fail "volume labels do not match" }
}

function Write-DoctorEnvelope() {
  $ReportName = ".doctor-container-$([Guid]::NewGuid().ToString('N')).json"
  $ReportPath = Join-Path $script:Installation $ReportName
  try {
    $ContainerReport = & docker @((Compose-Arguments) + @("exec", "-T", "workflow-mcp", "workflow-mcp", "doctor", "--json"))
    $ContainerDoctorExit = $LASTEXITCODE
    if ($ContainerDoctorExit -ne 0 -and $ContainerDoctorExit -ne 3) {
      # WHY: preserve the host half of the diagnosis when the very container being diagnosed is
      # stopped. Exit 3 means the doctor itself completed with a valid `ok:false` report; retaining
      # those bytes preserves the failed-check details while the image still validates their schema.
      $ContainerReport = '{"schemaVersion":1,"ok":false,"version":"unavailable","revision":"unavailable","dependencies":{},"checks":[{"id":"container-availability","status":"fail","message":"daemon unavailable; container phase was not executed"}]}'
    }
    [IO.File]::WriteAllLines($ReportPath, [string[]]@($ContainerReport), [Text.UTF8Encoding]::new($false))
    & docker run --rm --network none --read-only --user 0:0 `
      -v "${script:Installation}:/bundle:ro" $Image instance doctor-envelope `
      --file=/bundle/instance.json "--container-report=/bundle/$ReportName" `
      --platform=windows "--host-description=$script:HostDescription" `
      "--docker-client-version=$script:DockerClientVersion" "--docker-server-version=$script:DockerServerVersion" `
      "--compose-version=$script:ComposeVersion" "--docker-context=$script:DockerContext" `
      "--docker-endpoint=$script:DockerEndpoint" "--docker-daemon-fingerprint=$script:DockerDaemonFingerprint" `
      "--volume-driver=$script:VolumeDriver" `
      "--volume-options=$script:VolumeOptions" "--volume-instance-label=$script:VolumeInstanceLabel" `
      "--volume-project-label=$script:VolumeProjectLabel" "--volume-daemon-label=$script:VolumeDaemonLabel"
    $DoctorExit = $LASTEXITCODE
    if ($DoctorExit -eq 3) { exit 3 }
    if ($DoctorExit -ne 0) { Fail "host/container doctor envelope validation failed" }
  } finally {
    Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $ReportPath
  }
}

function Test-ApiKeyForRuntime([string] $Path) {
  if ($Path.Contains(',')) { Fail "API key file paths containing ',' are unsupported by Docker --mount" }
  $Probe = @'
const fs = require("node:fs");
try {
  const value = fs.readFileSync("/credential");
  const valid = value.length > 0 && value.length <= 16 * 1024 &&
    !value.includes(0) && /^\S+\n?$/.test(value.toString("utf8"));
  value.fill(0);
  if (!valid) process.exit(2);
} catch { process.exit(3); }
'@
  # Local Compose secrets retain bind-mount permissions. This exact-UID probe detects native Linux
  # 0600 ownership failures during install without ever copying the secret into PowerShell memory.
  & docker run --rm --network none --read-only --user 10001:10001 `
    --entrypoint /usr/local/bin/node --mount "type=bind,src=$Path,dst=/credential,readonly" `
    $Image -e $Probe 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Fail "UID 10001 cannot read one non-empty API-key line; grant that UID a narrow read ACL or use interactive login"
  }
}

function Test-CodexStanzaPreflight() {
  $ConfigDirectory = Join-Path $script:ProjectDirectory ".codex"
  if ((Test-Path -LiteralPath $ConfigDirectory) -and
    ((Get-Item -Force -LiteralPath $ConfigDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    Fail "refusing redirected Codex config directory"
  }
  $ConfigPath = Join-Path $ConfigDirectory "config.toml"
  if ((Test-Path -LiteralPath $ConfigPath) -and
    ((Get-Item -Force -LiteralPath $ConfigPath).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    Fail "refusing redirected Codex config file"
  }
  if ((Test-Path -LiteralPath $ConfigPath -PathType Leaf) -and
    (Select-String -Quiet '^\[mcp_servers\.workflow_mcp\]$' $ConfigPath)) {
    Fail "Codex MCP name already exists"
  }
}

function Test-AuthoringPath([bool] $ProbeWrites) {
  $ClaudeDirectory = Join-Path $script:ProjectDirectory ".claude"
  $WorkflowDirectory = Join-Path $ClaudeDirectory "workflows"
  foreach ($Candidate in @($ClaudeDirectory, $WorkflowDirectory)) {
    if (-not (Test-Path -LiteralPath $Candidate -PathType Container)) {
      Fail "workflow authoring directory is missing: $Candidate"
    }
    if ((Get-Item -Force -LiteralPath $Candidate).Attributes -band [IO.FileAttributes]::ReparsePoint) {
      Fail "refusing redirected authoring path: $Candidate"
    }
  }
  if ($WorkflowDirectory.Contains(',')) { Fail "authoring paths containing ',' are unsupported by Docker --mount" }
  $ExpectedWorkflowDirectory = [IO.Path]::GetFullPath($WorkflowDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $ActualWorkflowDirectory = (Get-Item -Force -LiteralPath $WorkflowDirectory).FullName.TrimEnd([IO.Path]::DirectorySeparatorChar)
  if ($ActualWorkflowDirectory -ne $ExpectedWorkflowDirectory) { Fail "workflow authoring path redirects outside the canonical project" }
  if (-not $ProbeWrites) { return }
  $Probe = @'
const fs = require("node:fs");
const first = `/probe/.workflow-mcp-write-probe-${process.pid}`;
const second = `${first}.renamed`;
let fd;
try {
  fd = fs.openSync(first, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  fs.writeSync(fd, "probe\n"); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
  fs.renameSync(first, second);
  const directory = fs.openSync("/probe", fs.constants.O_RDONLY); fs.fsyncSync(directory); fs.closeSync(directory);
  fs.unlinkSync(second);
} finally {
  if (fd !== undefined) fs.closeSync(fd);
  for (const path of [first, second]) { try { fs.unlinkSync(path); } catch {} }
}
'@
  # A path can be replaced after installation. Repeat both reparse checks and the exact fixed-UID
  # durability primitive immediately before Compose is allowed to create/recreate the RW bind.
  & docker run --rm --network none --read-only --user 10001:10001 --entrypoint /usr/local/bin/node `
    --mount "type=bind,src=$WorkflowDirectory,dst=/probe" $Image -e $Probe
  if ($LASTEXITCODE -ne 0) { Fail "UID 10001 cannot durably author $WorkflowDirectory; grant a narrow ACL/ownership or use read-only mode" }
}

function Test-AdoptionPreflight([string] $InstanceId) {
  if ($InstanceId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') {
    Fail "--adopt-instance must be the lowercase UUIDv4 printed by uninstall"
  }
  $ComposeProject = "workflow-mcp-" + (($InstanceId -replace '-', '').Substring(0, 16))
  $Volume = "${ComposeProject}_workflow-mcp-data"
  $ProjectHash = (docker run --rm $Image instance hash "--project=$script:ProjectDirectory").Trim()
  if ($LASTEXITCODE -ne 0) { Fail "could not derive canonical project identity" }
  $Driver = ((& docker volume inspect $Volume --format '{{.Driver}}' 2>$null) -join "").Trim()
  if ($LASTEXITCODE -ne 0) { Fail "preserved instance volume is missing: $Volume" }
  $Options = (docker volume inspect $Volume --format '{{json .Options}}').Trim()
  $InstanceLabel = (docker volume inspect $Volume --format '{{index .Labels "io.workflow-mcp.instance-id"}}').Trim()
  $ProjectLabel = (docker volume inspect $Volume --format '{{index .Labels "io.workflow-mcp.project-hash"}}').Trim()
  $DaemonLabel = (docker volume inspect $Volume --format '{{index .Labels "io.workflow-mcp.docker-daemon-fingerprint"}}').Trim()
  if ($Driver -ne "local" -or ($Options -ne "null" -and $Options -ne "{}")) { Fail "preserved volume uses unsupported driver/options" }
  if ($InstanceLabel -ne $InstanceId -or $ProjectLabel -ne $ProjectHash -or
      $DaemonLabel -ne $script:DockerDaemonFingerprint) {
    Fail "preserved volume labels do not match this instance, project, and Docker daemon"
  }
}

function Install-Command() {
  $WebPort = $null; $ApiKeyFile = $null; $AdoptInstance = $null; $Authoring = $false; $NoCodex = $false
  foreach ($Argument in $Rest) {
    if ($Argument -match '^--web-port=(\d+)$') { $WebPort = [int]$Matches[1] }
    elseif ($Argument -eq "--authoring") { $Authoring = $true }
    elseif ($Argument -match '^--api-key-file=(.+)$') { $ApiKeyFile = $Matches[1] }
    elseif ($Argument -match '^--adopt-instance=(.+)$') { $AdoptInstance = $Matches[1] }
    elseif ($Argument -eq "--no-codex") { $NoCodex = $true }
    else { Fail "unknown install option: $Argument" }
  }
  $script:ProjectDirectory = Canonical-Directory $Project
  $script:Installation = Join-Path $script:ProjectDirectory ".workflow-mcp"
  # A repository may contain reparse points. Never populate an existing ownership root: Copy-Item
  # can otherwise follow a pre-created leaf and overwrite an arbitrary host file. Get-Item detects
  # dangling links that Test-Path may treat as absent, while New-Item without -Force is the atomic
  # concurrent-creator check immediately before bundle population.
  $ExistingInstallation = Get-Item -Force -LiteralPath $script:Installation -ErrorAction SilentlyContinue
  if ($null -ne $ExistingInstallation) {
    Fail "installation path already exists; inspect and remove it explicitly before install: $script:Installation"
  }
  Host-Doctor ($null -ne $WebPort)
  docker image inspect $Image 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { docker pull $Image | Out-Null }
  Set-DockerDaemonFingerprint
  # Fail every ownership conflict before creating authoring/config/installation directories. A
  # rejected adoption must leave the project byte-for-byte outside Workflow MCP's authority.
  if (-not $NoCodex) { Test-CodexStanzaPreflight }
  if ($null -ne $AdoptInstance) { Test-AdoptionPreflight $AdoptInstance }
  if ($null -ne $ApiKeyFile) {
    # Credential identity is an install precondition. Validate it before authoring creates a
    # directory so a rejected device/UNC/reparse path leaves no partial Workflow MCP mutation.
    $ApiKeyFile = Canonical-File $ApiKeyFile "API key"
    Test-ApiKeyForRuntime $ApiKeyFile
  }
  if ($Authoring) {
    $ClaudeDirectory = Join-Path $script:ProjectDirectory ".claude"
    $WorkflowDirectory = Join-Path $ClaudeDirectory "workflows"
    if ((Test-Path -LiteralPath $ClaudeDirectory) -and
        ((Get-Item -Force -LiteralPath $ClaudeDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      Fail "refusing redirected authoring path: $ClaudeDirectory"
    }
    New-Item -ItemType Directory -Force -Path $WorkflowDirectory | Out-Null
    Test-AuthoringPath $true
  }
  $CreatedInstallation = New-Item -ItemType Directory -Path $script:Installation
  if (-not $CreatedInstallation.PSIsContainer -or
      ($CreatedInstallation.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    Fail "installation root was not created as an ordinary directory"
  }
  foreach ($Name in @("compose.yaml", "compose.web.yaml", "compose.authoring.yaml", "compose.auth-api-key.yaml", "compose.project-codex-mask.yaml")) {
    Copy-Item -LiteralPath (Join-Path $BundleRoot $Name) -Destination (Join-Path $script:Installation $Name)
  }
  Copy-Item -LiteralPath (Join-Path $BundleRoot "LICENSE") -Destination (Join-Path $script:Installation "LICENSE")
  $InstallSource = Join-Path $BundleRoot "install"
  if (-not (Test-Path $InstallSource)) { $InstallSource = $BundleRoot }
  Copy-Item (Join-Path $InstallSource "workflow-mcp-docker") (Join-Path $script:Installation "workflow-mcp-docker")
  Copy-Item (Join-Path $InstallSource "workflow-mcp-docker.ps1") (Join-Path $script:Installation "workflow-mcp-docker.ps1")
  Copy-Item $VersionPath (Join-Path $script:Installation "version.env")
  $GitIgnoreSource = Join-Path $InstallSource "bundle.gitignore"
  if (-not (Test-Path -LiteralPath $GitIgnoreSource)) { $GitIgnoreSource = Join-Path $BundleRoot ".gitignore" }
  Copy-Item $GitIgnoreSource (Join-Path $script:Installation ".gitignore")
  Write-InstalledChecksumManifest $script:Installation
  $InstanceAction = if ($null -eq $AdoptInstance) { "create" } else { "adopt" }
  $Create = @("run", "--rm", $Image, "instance", $InstanceAction, "--project=$script:ProjectDirectory", "--docker-context=$script:DockerContext", "--docker-endpoint=$script:DockerEndpoint", "--docker-daemon-fingerprint=$script:DockerDaemonFingerprint", "--image=$Image")
  if ($null -ne $AdoptInstance) { $Create += "--instance-id=$AdoptInstance" }
  if ($null -ne $WebPort) { $Create += "--web-port=$WebPort" }
  if ($Authoring) { $Create += "--authoring" }
  if ($null -ne $ApiKeyFile) { $Create += "--api-key-file=$ApiKeyFile" }
  $Record = & docker @Create
  if ($LASTEXITCODE -ne 0) { Fail "instance creation failed" }
  $Utf8NoBom = [Text.UTF8Encoding]::new($false)
  [IO.File]::WriteAllText(
    (Join-Path $script:Installation "instance.json"),
    (($Record -join [Environment]::NewLine) + [Environment]::NewLine),
    $Utf8NoBom
  )
  Load-Instance $script:ProjectDirectory
  if ($null -ne $AdoptInstance) { Attest-Volume }
  if (-not $NoCodex) {
    $ConfigDirectory = Join-Path $script:ProjectDirectory ".codex"
    if ((Test-Path -LiteralPath $ConfigDirectory) -and
      ((Get-Item -Force -LiteralPath $ConfigDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      Fail "refusing redirected Codex config directory"
    }
    New-Item -ItemType Directory -Force -Path $ConfigDirectory | Out-Null
    $ConfigPath = Join-Path $ConfigDirectory "config.toml"
    if ((Test-Path -LiteralPath $ConfigPath) -and
      ((Get-Item -Force -LiteralPath $ConfigPath).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      Fail "refusing redirected Codex config file"
    }
    if ((Test-Path $ConfigPath) -and (Select-String -Quiet '^\[mcp_servers\.workflow_mcp\]$' $ConfigPath)) { Fail "Codex MCP name already exists" }
    $SnippetLines = & docker run --rm --user 0:0 -v "${script:Installation}:/bundle:ro" $Image instance codex-config --file=/bundle/instance.json "--compose-file=$(Join-Path $script:Installation 'compose.yaml')"
    if ($LASTEXITCODE -ne 0) { Fail "Codex MCP configuration rendering failed" }
    $Snippet = @($SnippetLines) -join "`n"
    if ($Snippet -notmatch '(?m)^# BEGIN WORKFLOW MCP ' -or $Snippet -notmatch '(?m)^# END WORKFLOW MCP ') {
      Fail "Codex MCP configuration renderer returned an incomplete stanza"
    }
    $Existing = if (Test-Path -LiteralPath $ConfigPath) { [IO.File]::ReadAllText($ConfigPath) } else { "" }
    $TemporaryConfig = Join-Path $ConfigDirectory ("config.toml.workflow-mcp." + [Guid]::NewGuid().ToString("N"))
    [IO.File]::WriteAllText($TemporaryConfig, ($Existing + "`n" + $Snippet + "`n"), $Utf8NoBom)
    Move-Item -Force -LiteralPath $TemporaryConfig -Destination $ConfigPath
  }
  Write-Host "Installed Workflow MCP $($script:Instance.instanceId) at $script:Installation"
  if ($null -ne $AdoptInstance) { Write-Host "Adopted preserved durable volume $($script:Instance.composeProjectName)_workflow-mcp-data." }
}

function Test-CodexRemovalPath() {
  $ConfigDirectory = Join-Path $script:ProjectDirectory ".codex"
  if ((Test-Path -LiteralPath $ConfigDirectory) -and
      ((Get-Item -Force -LiteralPath $ConfigDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    Fail "refusing redirected Codex config directory during uninstall"
  }
  $ConfigPath = Join-Path $ConfigDirectory "config.toml"
  if ((Test-Path -LiteralPath $ConfigPath) -and
      ((Get-Item -Force -LiteralPath $ConfigPath).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    Fail "refusing redirected Codex config file during uninstall"
  }
}

function Remove-CodexStanza() {
  # Keep the second path check adjacent to the edit. Uninstall's earlier check preserves service
  # liveness on refusal; this one narrows the checkout-controlled retarget window on Windows.
  Test-CodexRemovalPath
  $ConfigDirectory = Join-Path $script:ProjectDirectory ".codex"
  $ConfigPath = Join-Path $ConfigDirectory "config.toml"
  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { return }
  $Begin = "# BEGIN WORKFLOW MCP $($script:Instance.instanceId)"
  $End = "# END WORKFLOW MCP $($script:Instance.instanceId)"
  $Lines = [IO.File]::ReadAllLines($ConfigPath)
  if ($Lines -notcontains $Begin) { return }
  $Skipping = $false
  $Filtered = [Collections.Generic.List[string]]::new()
  foreach ($Line in $Lines) {
    if ($Line -eq $Begin) { $Skipping = $true; continue }
    if ($Line -eq $End) { $Skipping = $false; continue }
    if (-not $Skipping) { $Filtered.Add($Line) }
  }
  if ($Skipping) { Fail "Codex stanza has no closing marker; refusing a partial edit" }
  $Utf8NoBom = [Text.UTF8Encoding]::new($false)
  $TemporaryConfig = "$ConfigPath.workflow-mcp.$([Guid]::NewGuid().ToString('N'))"
  [IO.File]::WriteAllLines($TemporaryConfig, $Filtered, $Utf8NoBom)
  Move-Item -Force -LiteralPath $TemporaryConfig -Destination $ConfigPath
}

function Uninstall-Command() {
  $DeleteData = $false
  $Confirmation = $null
  foreach ($Argument in $Rest) {
    if ($Argument -eq "--delete-data") { $DeleteData = $true }
    elseif ($Argument -match '^--confirm=(.+)$') { $Confirmation = $Matches[1] }
    else { Fail "unknown uninstall option: $Argument" }
  }
  Load-Instance $Project
  if ($DeleteData) {
    # WHY: reject a mistyped confirmation before stopping the service or editing the user's Codex
    # file. The label attestation also freezes the exact destructive target before mutation begins.
    if ($Confirmation -ne $script:Instance.instanceId) {
      Fail "data deletion requires --confirm=$($script:Instance.instanceId)"
    }
  }
  # A preservation receipt is ownership authority too. Refuse to delete the only record or edit
  # Codex unless the promised durable volume is presently attestable and adoptable.
  Attest-Volume
  # Refuse a reparse-point retarget before stopping a healthy instance. A failed uninstall must not
  # strand the daemon offline merely because its later config edit was unsafe.
  Test-CodexRemovalPath
  Invoke-Compose @("down", "--remove-orphans")
  Remove-CodexStanza
  if ($DeleteData) {
    docker volume rm "$($script:Instance.composeProjectName)_workflow-mcp-data" | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "volume deletion failed" }
  }
  # The running PowerShell file cannot be removed reliably on every supported
  # Windows filesystem. All other exact, attested instance files are removed and
  # the operator receives an explicit final path for this one harmless remnant.
  foreach ($Name in @("LICENSE", "compose.yaml", "compose.web.yaml", "compose.authoring.yaml", "compose.auth-api-key.yaml", "compose.project-codex-mask.yaml", "version.env", "SHA256SUMS", "instance.json", ".gitignore", "workflow-mcp-docker")) {
    $Target = Join-Path $script:Installation $Name
    if (Test-Path -LiteralPath $Target) { Remove-Item -Force -LiteralPath $Target }
  }
  Write-Host "Uninstalled Workflow MCP; durable data was $(if ($DeleteData) { 'deleted' } else { 'preserved' })."
  if (-not $DeleteData) {
    Write-Host "Preserved instance ID: $($script:Instance.instanceId)"
    Write-Host "Reattach only from this canonical project with: workflow-mcp-docker.ps1 install $script:ProjectDirectory --adopt-instance=$($script:Instance.instanceId)"
  }
  Write-Host "Remove the remaining launcher and its empty $script:Installation directory after this command returns."
}

function Upgrade-Command() {
  if (@($Rest).Count -gt 0) { Fail "upgrade accepts a project path only; create an offline backup first if required" }
  $NewImage = $Image
  $NewVersion = $VersionValues["WORKFLOW_MCP_BUNDLE_VERSION"]
  $ParsedNewVersion = $null
  if (-not [Version]::TryParse($NewVersion, [ref]$ParsedNewVersion) -or $ParsedNewVersion.ToString() -ne $NewVersion) { Fail "new bundle version is not stable SemVer" }
  $script:AllowImageMismatch = $true
  $script:AllowExternalPolicyMismatch = $true
  Load-Instance $Project
  $script:AllowExternalPolicyMismatch = $false
  $script:AllowImageMismatch = $false
  Require-RuntimeApiKey
  # Host credential bytes and authoring ACLs can change independently of instance.json. Prove both
  # while the old daemon remains live; neither rollback nor a new image can repair a host-side loss
  # after Compose has already quiesced it.
  if ($script:Instance.authoring) { Test-AuthoringPath $true }
  $OldImage = [string]$script:Instance.image
  $OldVersionValues = @{}
  Get-Content -LiteralPath (Join-Path $script:Installation "version.env") | ForEach-Object {
    if ($_ -match '^([A-Z0-9_]+)=(.+)$') { $OldVersionValues[$Matches[1]] = $Matches[2] }
  }
  $OldVersion = $OldVersionValues["WORKFLOW_MCP_BUNDLE_VERSION"]
  $ParsedOldVersion = $null
  if (-not [Version]::TryParse($OldVersion, [ref]$ParsedOldVersion)) { Fail "installed bundle version is invalid" }
  if ($ParsedNewVersion -lt $ParsedOldVersion) { Fail "refusing downgrade from $OldVersion to $NewVersion" }
  if ($OldImage -eq $NewImage) { Fail "instance already uses $NewImage" }
  docker image inspect $NewImage 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { docker pull $NewImage | Out-Null }
  docker image inspect $OldImage 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { docker pull $OldImage | Out-Null }
  & docker run --rm --network none --read-only --user 0:0 `
    -v "${script:Installation}:/bundle:ro" $OldImage instance verify-policy --directory=/bundle | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "installed pre-upgrade Compose policy differs from its recorded image" }

  $UpgradeStage = Join-Path $script:Installation ".upgrade-stage"
  $RollbackStage = Join-Path $script:Installation ".upgrade-rollback"
  $UpgradeMarker = Join-Path $script:Installation ".upgrade-transaction"
  if (Test-Path -LiteralPath $UpgradeMarker) { Fail "an interrupted upgrade must be recovered by the installed launcher first" }
  Remove-UpgradeDirectories $script:Installation
  New-Item -ItemType Directory -Path $UpgradeStage, $RollbackStage | Out-Null
  try {
    foreach ($Name in $UpgradeNames) {
      $Existing = Join-Path $script:Installation $Name
      if (-not (Test-Path -LiteralPath $Existing -PathType Leaf)) { Fail "installed bundle is incomplete: $Name" }
      Copy-Item -LiteralPath $Existing -Destination (Join-Path $RollbackStage $Name)
    }
    foreach ($Name in @("compose.yaml", "compose.web.yaml", "compose.authoring.yaml", "compose.auth-api-key.yaml", "compose.project-codex-mask.yaml")) {
      Copy-Item -LiteralPath (Join-Path $BundleRoot $Name) -Destination (Join-Path $UpgradeStage $Name)
    }
    Copy-Item -LiteralPath (Join-Path $BundleRoot "LICENSE") -Destination (Join-Path $UpgradeStage "LICENSE")
    $InstallSource = Join-Path $BundleRoot "install"
    if (-not (Test-Path -LiteralPath $InstallSource -PathType Container)) { $InstallSource = $BundleRoot }
    Copy-Item (Join-Path $InstallSource "workflow-mcp-docker") (Join-Path $UpgradeStage "workflow-mcp-docker")
    Copy-Item (Join-Path $InstallSource "workflow-mcp-docker.ps1") (Join-Path $UpgradeStage "workflow-mcp-docker.ps1")
    Copy-Item $VersionPath (Join-Path $UpgradeStage "version.env")
    $IgnoreSource = Join-Path $InstallSource "bundle.gitignore"
    if (-not (Test-Path -LiteralPath $IgnoreSource)) { $IgnoreSource = Join-Path $BundleRoot ".gitignore" }
    Copy-Item $IgnoreSource (Join-Path $UpgradeStage ".gitignore")
    Write-InstalledChecksumManifest $UpgradeStage
    $Record = docker run --rm --user 0:0 -v "${script:Installation}:/bundle:ro" $NewImage instance replace-image --file=/bundle/instance.json "--image=$NewImage"
    if ($LASTEXITCODE -ne 0) { Fail "new image could not validate the instance record" }
    [IO.File]::WriteAllText((Join-Path $UpgradeStage "instance.json"), (($Record -join [Environment]::NewLine) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))

    Invoke-Compose @("down", "--remove-orphans")
    Attest-Volume
    [IO.File]::WriteAllText("$UpgradeMarker.tmp", "workflow-mcp-upgrade-v1`n", [Text.UTF8Encoding]::new($false))
    Move-Item -Force -LiteralPath "$UpgradeMarker.tmp" -Destination $UpgradeMarker
    foreach ($Name in $UpgradeNames) { Move-Item -Force -LiteralPath (Join-Path $UpgradeStage $Name) -Destination (Join-Path $script:Installation $Name) }
    try {
      Invoke-Compose @("up", "--detach", "--wait")
    } catch {
      Write-Warning "New image did not become ready; restoring the previous layout-compatible bundle."
      Restore-InterruptedUpgrade $script:Installation
      $script:Image = $OldImage
      Load-Instance $script:ProjectDirectory
      if ($script:Instance.authoring) { Test-AuthoringPath $true }
      Invoke-Compose @("up", "--detach", "--wait")
      Fail "upgrade failed and was rolled back to $OldVersion"
    }
    # Marker removal is the only commit point. Before it, any interruption restores the complete
    # old bundle; after it, only private staging bytes remain and the healthy new bundle is final.
    Remove-Item -Force -LiteralPath $UpgradeMarker
    Remove-UpgradeDirectories $script:Installation
    Write-Host "Upgraded Workflow MCP from $OldVersion to $NewVersion at the same instance and volume identity."
  } finally {
    if (-not (Test-Path -LiteralPath $UpgradeMarker)) {
      Remove-UpgradeDirectories $script:Installation
    }
  }
}

function Resolve-MaintenancePath([string] $Requested, [string] $Kind) {
  if (-not [IO.Path]::IsPathRooted($Requested)) { Fail "$Kind path must be absolute" }
  $script:MaintenanceName = [IO.Path]::GetFileName($Requested)
  if ([string]::IsNullOrWhiteSpace($script:MaintenanceName)) { Fail "invalid $Kind filename" }
  Assert-TerminalSafePath $script:MaintenanceName
  # The checksum staging leaf is archive + `.sha256.workflow-mcp-copy-` + a 32-hex GUID. Restrict
  # output to 197 bytes so that exact 58-byte suffix still fits NAME_MAX=255; imported archives need
  # only their seven-byte `.sha256` sidecar and can therefore use at most 248 bytes.
  $SafeLeaf = if ($Kind -eq "output") {
    $script:MaintenanceName -cmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,196}$'
  } else {
    $script:MaintenanceName -cmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,247}$'
  }
  if (-not $SafeLeaf) {
    Fail "$Kind filename must be a safe leaf of at most $(if ($Kind -eq 'output') { 197 } else { 248 }) bytes"
  }
  $script:MaintenanceDirectory = Canonical-Directory ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Requested)))
  if ($script:MaintenanceDirectory.Contains(',')) { Fail "$Kind directories containing ',' are unsupported by Docker --mount" }
  $script:MaintenanceHostPath = Join-Path $script:MaintenanceDirectory $script:MaintenanceName
}

function New-ArchiveSnapshot([string] $InputPath) {
  Resolve-MaintenancePath $InputPath "input"
  if (-not (Test-Path -LiteralPath $script:MaintenanceHostPath -PathType Leaf) -or -not (Test-Path -LiteralPath "$($script:MaintenanceHostPath).sha256" -PathType Leaf)) {
    Fail "backup archive or checksum sidecar is missing"
  }
  $Suffix = [Guid]::NewGuid().ToString("N")
  $Volume = "$($script:Instance.composeProjectName)_backup_input_$Suffix"
  $Container = "$($script:Instance.composeProjectName)-backup-input-$Suffix"
  & docker volume create --label "io.workflow-mcp.instance-id=$($script:Instance.instanceId)" `
    --label io.workflow-mcp.temporary-purpose=backup-input $Volume | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "could not create private backup input volume" }
  try {
    & docker create --name $Container --network none --read-only --entrypoint /bin/true `
      --mount "type=volume,src=$Volume,dst=/backup-input" $Image | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "could not create private backup input container" }
    # Copying into Docker-managed storage makes a private Windows/macOS/Linux host file readable by
    # the fixed container UID without weakening its host ACL. The same snapshot is retained through
    # restore, so replacing the host path after verification cannot change extracted bytes.
    & docker cp $script:MaintenanceHostPath "${Container}:/backup-input/$script:MaintenanceName"
    if ($LASTEXITCODE -ne 0) { Fail "could not snapshot the backup archive" }
    & docker cp "$($script:MaintenanceHostPath).sha256" "${Container}:/backup-input/$($script:MaintenanceName).sha256"
    if ($LASTEXITCODE -ne 0) { Fail "could not snapshot the backup checksum" }
    & docker run --rm --network none --read-only --user 0:0 --entrypoint /bin/chown `
      --mount "type=volume,src=$Volume,dst=/backup-input,volume-nocopy" `
      $Image 10001:10001 "/backup-input/$script:MaintenanceName" "/backup-input/$($script:MaintenanceName).sha256" | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "could not narrow backup snapshot ownership" }
    & docker run --rm --network none --read-only --user 0:0 --entrypoint /bin/chmod `
      --mount "type=volume,src=$Volume,dst=/backup-input,volume-nocopy" `
      $Image 0400 "/backup-input/$script:MaintenanceName" "/backup-input/$($script:MaintenanceName).sha256" | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "could not narrow backup snapshot modes" }
    return [PSCustomObject]@{ Volume = $Volume; Container = $Container; Name = $script:MaintenanceName }
  } catch {
    & docker rm -f $Container 2>$null | Out-Null
    & docker volume rm $Volume 2>$null | Out-Null
    throw
  }
}

function Remove-ArchiveSnapshot($Snapshot) {
  & docker rm -f $Snapshot.Container 2>$null | Out-Null
  & docker volume rm $Snapshot.Volume 2>$null | Out-Null
}

function Invoke-ArchiveVerification($Snapshot) {
  & docker run --rm --network none --read-only --user 10001:10001 `
    -e "WORKFLOW_MCP_INSTANCE_ID=$($script:Instance.instanceId)" -e "WORKFLOW_MCP_PROJECT_HASH=$($script:Instance.projectHash)" `
    --mount "type=volume,src=$($Snapshot.Volume),dst=/backup-input,readonly,volume-nocopy" `
    $Image maintenance backup-verify "--input=/backup-input/$($Snapshot.Name)"
  if ($LASTEXITCODE -ne 0) { Fail "backup verification failed" }
}

function Backup-Command() {
  Load-Instance $Project
  if ($Rest.Count -lt 1) { Fail "backup requires create or verify" }
  $Action = $Rest[0]
  $Options = @($Rest | Select-Object -Skip 1)
  if ($Action -eq "create") {
    $Output = $null
    foreach ($Argument in $Options) {
      if ($Argument -match '^--output=(.+)$') { $Output = $Matches[1] } else { Fail "unknown backup create option: $Argument" }
    }
    if ([string]::IsNullOrWhiteSpace($Output)) { Fail "backup create requires --output=C:\absolute\file" }
    Resolve-MaintenancePath $Output "output"
    if ((Test-Path -LiteralPath $script:MaintenanceHostPath) -or (Test-Path -LiteralPath "$($script:MaintenanceHostPath).sha256")) { Fail "backup output already exists" }
    Invoke-Compose @("down", "--remove-orphans")
    Attest-Volume
    $Volume = "$($script:Instance.composeProjectName)_workflow-mcp-data"
    $ExportSuffix = [Guid]::NewGuid().ToString("N")
    $ExportVolume = "$($script:Instance.composeProjectName)_backup_export_$ExportSuffix"
    $ExportContainer = "$($script:Instance.composeProjectName)-backup-export-$ExportSuffix"
    $TemporaryArchive = "$($script:MaintenanceHostPath).workflow-mcp-copy-$ExportSuffix"
    $TemporaryChecksum = "$($script:MaintenanceHostPath).sha256.workflow-mcp-copy-$ExportSuffix"
    $ContainerCreated = $false
    $VolumeCreated = $false
    try {
      & docker volume create --label "io.workflow-mcp.instance-id=$($script:Instance.instanceId)" `
        --label io.workflow-mcp.temporary-purpose=backup-export $ExportVolume | Out-Null
      if ($LASTEXITCODE -ne 0) { Fail "could not create private backup export volume" }
      $VolumeCreated = $true
      # The unprivileged maintenance process writes only to Docker-managed storage. `docker cp`
      # then creates the host files as this invoking user, so a normal private backup directory
      # works on native Linux/Windows without granting UID 10001 arbitrary host write access.
      & docker create --name $ExportContainer --network none --read-only --user 10001:10001 `
        -e "WORKFLOW_MCP_INSTANCE_ID=$($script:Instance.instanceId)" -e "WORKFLOW_MCP_PROJECT_HASH=$($script:Instance.projectHash)" `
        --mount "type=volume,src=$Volume,dst=/data,volume-nocopy" `
        --mount "type=volume,src=$ExportVolume,dst=/backup-output" `
        $Image maintenance backup-create "--output=/backup-output/$script:MaintenanceName" | Out-Null
      if ($LASTEXITCODE -ne 0) { Fail "could not create backup export container" }
      $ContainerCreated = $true
      & docker start --attach $ExportContainer | Out-Null
      if ($LASTEXITCODE -ne 0) { Fail "offline backup failed; the daemon remains stopped" }
      & docker cp "${ExportContainer}:/backup-output/$script:MaintenanceName" $TemporaryArchive
      if ($LASTEXITCODE -ne 0) { Fail "could not copy backup archive to the host" }
      & docker cp "${ExportContainer}:/backup-output/$($script:MaintenanceName).sha256" $TemporaryChecksum
      if ($LASTEXITCODE -ne 0) { Fail "could not copy backup checksum to the host" }
      & docker run --rm --network none --read-only --user 0:0 `
        --mount "type=bind,src=$script:MaintenanceDirectory,dst=/host-output" `
        $Image maintenance host-backup-commit --directory=/host-output `
        "--archive-temporary=$([IO.Path]::GetFileName($TemporaryArchive))" `
        "--checksum-temporary=$([IO.Path]::GetFileName($TemporaryChecksum))" `
        "--archive=$script:MaintenanceName" "--checksum=$($script:MaintenanceName).sha256" | Out-Null
      if ($LASTEXITCODE -ne 0) { Fail "could not durably commit backup files on the host" }
    } finally {
      Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $TemporaryArchive, $TemporaryChecksum
      if ($ContainerCreated) { & docker rm -f $ExportContainer 2>$null | Out-Null }
      if ($VolumeCreated) { & docker volume rm $ExportVolume 2>$null | Out-Null }
    }
    Write-Host "Backup committed at $script:MaintenanceHostPath (checksum: $($script:MaintenanceHostPath).sha256)."
    Write-Host "Workflow MCP remains offline after backup; run $script:Installation\workflow-mcp-docker.ps1 up to resume it."
  } elseif ($Action -eq "verify") {
    $Input = $null
    foreach ($Argument in $Options) {
      if ($Argument -match '^--input=(.+)$') { $Input = $Matches[1] } else { Fail "unknown backup verify option: $Argument" }
    }
    if ([string]::IsNullOrWhiteSpace($Input)) { Fail "backup verify requires --input=C:\absolute\file" }
    $Snapshot = New-ArchiveSnapshot $Input
    try { Invoke-ArchiveVerification $Snapshot } finally { Remove-ArchiveSnapshot $Snapshot }
  } else { Fail "backup requires create or verify" }
}

function Restore-Command() {
  Load-Instance $Project
  if ($Rest.Count -gt 0 -and $Rest[0] -eq "reset-target") {
    $Confirmation = $null
    foreach ($Argument in @($Rest | Select-Object -Skip 1)) {
      if ($Argument -match '^--confirm=(.+)$') { $Confirmation = $Matches[1] }
      else { Fail "unknown restore reset-target option: $Argument" }
    }
    if ($Confirmation -ne $script:Instance.instanceId) {
      Fail "restore target reset requires --confirm=$($script:Instance.instanceId)"
    }
    # A partial restore is intentionally non-retryable without this explicit operation. Delete
    # only the label-attested target while preserving the exact instance/project identity record.
    Attest-Volume
    $Volume = "$($script:Instance.composeProjectName)_workflow-mcp-data"
    & docker run --rm --network none --read-only --user 10001:10001 `
      -e "WORKFLOW_MCP_INSTANCE_ID=$($script:Instance.instanceId)" -e "WORKFLOW_MCP_PROJECT_HASH=$($script:Instance.projectHash)" `
      --mount "type=volume,src=$Volume,dst=/data,volume-nocopy" `
      $Image maintenance restore-reset-check | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "restore target is busy or is not an identity-matched interrupted restore; refusing volume deletion" }
    Invoke-Compose @("down", "--remove-orphans")
    docker volume rm $Volume | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "restore target volume deletion failed" }
    Write-Host "Removed the attested restore target volume; instance metadata was preserved. Retry restore with the same project and archive."
    return
  }
  $Input = $null
  foreach ($Argument in $Rest) {
    if ($Argument -match '^--input=(.+)$') { $Input = $Matches[1] } else { Fail "unknown restore option: $Argument" }
  }
  if ([string]::IsNullOrWhiteSpace($Input)) { Fail "restore requires --input=C:\absolute\file" }
  $Snapshot = New-ArchiveSnapshot $Input
  try {
    Invoke-ArchiveVerification $Snapshot
    Invoke-Compose @("down", "--remove-orphans")
    Invoke-Compose @("create")
    Attest-Volume
    Invoke-Compose @("down", "--remove-orphans")
    $Volume = "$($script:Instance.composeProjectName)_workflow-mcp-data"
    & docker run --rm --network none --read-only -v "${Volume}:/data" $Image help | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "could not initialize the rootless restore volume skeleton" }
    & docker run --rm --network none --read-only --user 10001:10001 `
      -e "WORKFLOW_MCP_INSTANCE_ID=$($script:Instance.instanceId)" -e "WORKFLOW_MCP_PROJECT_HASH=$($script:Instance.projectHash)" `
      --mount "type=volume,src=$Volume,dst=/data,volume-nocopy" `
      --mount "type=volume,src=$($Snapshot.Volume),dst=/backup-input,readonly,volume-nocopy" `
      $Image maintenance restore "--input=/backup-input/$($Snapshot.Name)"
    if ($LASTEXITCODE -ne 0) { Fail "offline restore failed; the target volume was not overwritten if it was non-empty" }
  } finally { Remove-ArchiveSnapshot $Snapshot }
  Write-Host "Restore committed offline. Run the up command when ready; Codex login and local tokens must be recreated."
}

switch ($Command) {
  "install" { Install-Command }
  "upgrade" { Upgrade-Command }
  "up" { if ($Rest.Count -ne 0) { Fail "up accepts a project path only" }; Load-Instance $Project; Require-RuntimeApiKey; if ($script:Instance.authoring) { Test-AuthoringPath $true }; Invoke-Compose @("create"); Attest-Volume; Invoke-Compose @("up", "--detach", "--wait") }
  "down" { if ($Rest.Count -ne 0) { Fail "down accepts a project path only" }; Load-Instance $Project; Invoke-Compose @("down", "--remove-orphans") }
  "status" {
    if ($Rest.Count -gt 1 -or ($Rest.Count -eq 1 -and $Rest[0] -ne "--json")) { Fail "status accepts only --json" }
    Load-Instance $Project
    if ($Rest.Count -eq 0 -or $Rest[0] -ne "--json") { Invoke-Compose @("ps") }
    Invoke-Compose (@("exec", "-T", "workflow-mcp", "workflow-mcp", "status") + $Rest)
  }
  "logs" { Load-Instance $Project; Invoke-Compose (@("logs", "--follow", "workflow-mcp") + $Rest) }
  "doctor" { if ($Rest.Count -ne 0) { Fail "doctor accepts a project path only" }; Load-Instance $Project; Attest-Volume; Invoke-Compose @("config", "--quiet"); Write-DoctorEnvelope }
  "ui" {
    if ($Rest.Count -gt 1 -or ($Rest.Count -eq 1 -and $Rest[0] -ne "--snapshot")) { Fail "ui accepts only --snapshot" }
    Load-Instance $Project
    # WHY: snapshot output is a pipe-safe API client and must not inherit Compose's pseudo-TTY;
    # the interactive form needs that terminal for raw-mode navigation and signal restoration.
    if ($Rest.Count -eq 1) {
      Invoke-Compose @("exec", "-T", "workflow-mcp", "workflow-mcp", "ui", "--snapshot")
    } else {
      Invoke-Compose @("exec", "workflow-mcp", "workflow-mcp", "ui")
    }
  }
  "mcp-proxy" { if ($Rest.Count -ne 0) { Fail "mcp-proxy accepts a project path only" }; Load-Instance $Project; Invoke-Compose @("exec", "-T", "workflow-mcp", "workflow-mcp", "mcp-proxy") }
  "token" {
    Load-Instance $Project
    # Mirror the host stream, not Compose's default pseudo-terminal, so redirected callers retain
    # the inner CLI's refusal unless they deliberately supplied --force.
    $Exec = if ([Console]::IsOutputRedirected) { @("exec", "-T") } else { @("exec") }
    Invoke-Compose ($Exec + @("workflow-mcp", "workflow-mcp", "token", "show") + $Rest)
  }
  "source" { Load-Instance $Project; Invoke-Compose (@("exec", "-T", "workflow-mcp", "workflow-mcp", "source") + $Rest) }
  "auth" { Load-Instance $Project; Invoke-Compose (@("exec", "workflow-mcp", "workflow-mcp", "auth") + $Rest) }
  "migrate" { Load-Instance $Project; Invoke-Compose (@("exec", "-T", "workflow-mcp", "workflow-mcp", "migrate") + $Rest) }
  "backup" { Backup-Command }
  "restore" { Restore-Command }
  "uninstall" { Uninstall-Command }
  "help" { Write-Host "workflow-mcp-docker install|upgrade|up|down|status|logs|doctor|ui|mcp-proxy|token|source|auth|backup|restore|migrate PROJECT" }
  default { Fail "unknown command: $Command" }
}
