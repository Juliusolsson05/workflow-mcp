param(
  [Parameter(Position = 0)] [string] $Command = "help",
  [Parameter(Position = 1)] [string] $Project = ".",
  [Parameter(ValueFromRemainingArguments = $true)] [string[]] $Rest
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Fail([string] $Message) { throw "workflow-mcp-docker: $Message" }
function Canonical-Directory([string] $Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { Fail "directory does not exist: $Path" }
  return (Get-Item -LiteralPath $Path).FullName
}

$ScriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
if (Test-Path -LiteralPath (Join-Path $ScriptDirectory "compose.yaml")) {
  $BundleRoot = $ScriptDirectory
} else {
  $BundleRoot = Split-Path -Parent $ScriptDirectory
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
}

function Host-Doctor([bool] $NeedWeb) {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail "Docker CLI is not installed" }
  docker info | Out-Null
  $ComposeVersion = [Version]((docker compose version --short) -replace '[^0-9.].*$', '')
  if ($ComposeVersion -lt [Version]"2.32.0") { Fail "Docker Compose 2.32.0+ is required" }
  $script:DockerContext = (docker context show).Trim()
  $script:DockerEndpoint = (docker context inspect $script:DockerContext --format '{{.Endpoints.docker.Host}}').Trim()
  if ($script:DockerEndpoint -notmatch '^(npipe|unix)://') { Fail "remote Docker contexts are unsupported" }
  if ($NeedWeb) {
    $Engine = [Version]((docker version --format '{{.Server.Version}}') -replace '[^0-9.].*$', '')
    if ($Engine -lt [Version]"28.3.3") { Fail "loopback web publication requires Docker Engine 28.3.3+" }
  }
}

function Load-Instance([string] $ProjectPath) {
  $script:ProjectDirectory = Canonical-Directory $ProjectPath
  $script:Installation = Join-Path $script:ProjectDirectory ".workflow-mcp"
  $script:InstancePath = Join-Path $script:Installation "instance.json"
  if (-not (Test-Path -LiteralPath $script:InstancePath)) { Fail "not installed; run install first" }
  $script:Instance = Get-Content -Raw -LiteralPath $script:InstancePath | ConvertFrom-Json
  Host-Doctor ($null -ne $script:Instance.webPort)
  if ($script:Instance.image -ne $Image) { Fail "bundle and instance images differ; use upgrade" }
  if ($script:Instance.dockerContext -ne $script:DockerContext -or $script:Instance.dockerEndpoint -ne $script:DockerEndpoint) {
    Fail "Docker context changed since install; use instance move/adopt"
  }
  $ActualHash = (docker run --rm $Image instance hash "--project=$script:ProjectDirectory").Trim()
  if ($ActualHash -ne $script:Instance.projectHash) { Fail "instance belongs to another canonical project" }
  $env:WORKFLOW_MCP_IMAGE = $Image
  $env:WORKFLOW_MCP_INSTANCE_ID = $script:Instance.instanceId
  $env:WORKFLOW_MCP_PROJECT_HASH = $script:Instance.projectHash
  $env:WORKFLOW_MCP_PROJECT_DIR = $script:ProjectDirectory
  if ($null -ne $script:Instance.webPort) { $env:WORKFLOW_MCP_PORT = [string]$script:Instance.webPort }
  if ($script:Instance.authoring) { $env:WORKFLOW_MCP_WORKFLOW_DIR = Join-Path $script:ProjectDirectory ".claude/workflows" }
}

function Compose-Arguments() {
  $Arguments = @("compose", "-p", $script:Instance.composeProjectName, "--project-directory", $script:Installation, "-f", (Join-Path $script:Installation "compose.yaml"))
  $CodexDirectory = Join-Path $script:ProjectDirectory ".codex"
  if (Test-Path -LiteralPath $CodexDirectory -PathType Container) { $Arguments += @("-f", (Join-Path $script:Installation "compose.project-codex-mask.yaml")) }
  if ($null -ne $script:Instance.webPort) { $Arguments += @("-f", (Join-Path $script:Installation "compose.web.yaml")) }
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
  $Volume = "$($script:Instance.composeProjectName)_workflow-mcp-data"
  $Driver = (docker volume inspect $Volume --format '{{.Driver}}').Trim()
  $Options = (docker volume inspect $Volume --format '{{json .Options}}').Trim()
  $InstanceLabel = (docker volume inspect $Volume --format '{{index .Labels "io.workflow-mcp.instance-id"}}').Trim()
  $ProjectLabel = (docker volume inspect $Volume --format '{{index .Labels "io.workflow-mcp.project-hash"}}').Trim()
  if ($Driver -ne "local" -or ($Options -ne "null" -and $Options -ne "{}")) { Fail "unsupported volume driver/options" }
  if ($InstanceLabel -ne $script:Instance.instanceId -or $ProjectLabel -ne $script:Instance.projectHash) { Fail "volume labels do not match" }
}

function Install-Command() {
  $WebPort = $null; $Authoring = $false; $NoCodex = $false
  foreach ($Argument in $Rest) {
    if ($Argument -match '^--web-port=(\d+)$') { $WebPort = [int]$Matches[1] }
    elseif ($Argument -eq "--authoring") { $Authoring = $true }
    elseif ($Argument -eq "--no-codex") { $NoCodex = $true }
    else { Fail "unknown install option: $Argument" }
  }
  $script:ProjectDirectory = Canonical-Directory $Project
  $script:Installation = Join-Path $script:ProjectDirectory ".workflow-mcp"
  if (Test-Path -LiteralPath (Join-Path $script:Installation "instance.json")) { Fail "already installed" }
  Host-Doctor ($null -ne $WebPort)
  docker image inspect $Image 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { docker pull $Image | Out-Null }
  if ($Authoring) {
    $ClaudeDirectory = Join-Path $script:ProjectDirectory ".claude"
    $WorkflowDirectory = Join-Path $ClaudeDirectory "workflows"
    foreach ($Candidate in @($ClaudeDirectory, $WorkflowDirectory)) {
      if ((Test-Path -LiteralPath $Candidate) -and ((Get-Item -Force -LiteralPath $Candidate).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        Fail "refusing redirected authoring path: $Candidate"
      }
    }
    New-Item -ItemType Directory -Force -Path $WorkflowDirectory | Out-Null
    $ExpectedWorkflowDirectory = [IO.Path]::GetFullPath($WorkflowDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $ActualWorkflowDirectory = (Get-Item -Force -LiteralPath $WorkflowDirectory).FullName.TrimEnd([IO.Path]::DirectorySeparatorChar)
    if ($ActualWorkflowDirectory -ne $ExpectedWorkflowDirectory) { Fail "workflow authoring path redirects outside the canonical project" }
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
    & docker run --rm --network none --read-only --user 10001:10001 --entrypoint /usr/local/bin/node --mount "type=bind,src=$WorkflowDirectory,dst=/probe" $Image -e $Probe
    if ($LASTEXITCODE -ne 0) { Fail "UID 10001 cannot durably author $WorkflowDirectory; grant a narrow ACL/ownership or use read-only mode" }
  }
  New-Item -ItemType Directory -Force -Path $script:Installation | Out-Null
  foreach ($Name in @("compose.yaml", "compose.web.yaml", "compose.authoring.yaml", "compose.auth-api-key.yaml", "compose.project-codex-mask.yaml")) {
    Copy-Item -LiteralPath (Join-Path $BundleRoot $Name) -Destination (Join-Path $script:Installation $Name)
  }
  $InstallSource = Join-Path $BundleRoot "install"
  if (-not (Test-Path $InstallSource)) { $InstallSource = $BundleRoot }
  Copy-Item (Join-Path $InstallSource "workflow-mcp-docker") (Join-Path $script:Installation "workflow-mcp-docker")
  Copy-Item (Join-Path $InstallSource "workflow-mcp-docker.ps1") (Join-Path $script:Installation "workflow-mcp-docker.ps1")
  Copy-Item $VersionPath (Join-Path $script:Installation "version.env")
  $GitIgnoreSource = Join-Path $InstallSource "bundle.gitignore"
  if (-not (Test-Path -LiteralPath $GitIgnoreSource)) { $GitIgnoreSource = Join-Path $BundleRoot ".gitignore" }
  Copy-Item $GitIgnoreSource (Join-Path $script:Installation ".gitignore")
  $Create = @("run", "--rm", $Image, "instance", "create", "--project=$script:ProjectDirectory", "--docker-context=$script:DockerContext", "--docker-endpoint=$script:DockerEndpoint", "--image=$Image")
  if ($null -ne $WebPort) { $Create += "--web-port=$WebPort" }
  if ($Authoring) { $Create += "--authoring" }
  $Record = & docker @Create
  if ($LASTEXITCODE -ne 0) { Fail "instance creation failed" }
  $Utf8NoBom = [Text.UTF8Encoding]::new($false)
  [IO.File]::WriteAllText(
    (Join-Path $script:Installation "instance.json"),
    (($Record -join [Environment]::NewLine) + [Environment]::NewLine),
    $Utf8NoBom
  )
  Load-Instance $script:ProjectDirectory
  if (-not $NoCodex) {
    $ConfigDirectory = Join-Path $script:ProjectDirectory ".codex"
    New-Item -ItemType Directory -Force -Path $ConfigDirectory | Out-Null
    $ConfigPath = Join-Path $ConfigDirectory "config.toml"
    if ((Test-Path $ConfigPath) -and (Select-String -Quiet '^\[mcp_servers\.workflow_mcp\]$' $ConfigPath)) { Fail "Codex MCP name already exists" }
    $Snippet = docker run --rm --user 0:0 -v "${script:Installation}:/bundle:ro" $Image instance codex-config --file=/bundle/instance.json "--compose-file=$(Join-Path $script:Installation 'compose.yaml')"
    $Existing = if (Test-Path -LiteralPath $ConfigPath) { [IO.File]::ReadAllText($ConfigPath) } else { "" }
    $TemporaryConfig = Join-Path $ConfigDirectory ("config.toml.workflow-mcp." + [Guid]::NewGuid().ToString("N"))
    [IO.File]::WriteAllText($TemporaryConfig, ($Existing + "`n" + $Snippet + "`n"), $Utf8NoBom)
    Move-Item -Force -LiteralPath $TemporaryConfig -Destination $ConfigPath
  }
  Write-Host "Installed Workflow MCP $($script:Instance.instanceId) at $script:Installation"
}

function Remove-CodexStanza() {
  $ConfigPath = Join-Path $script:ProjectDirectory ".codex/config.toml"
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
  Invoke-Compose @("down", "--remove-orphans")
  Remove-CodexStanza
  if ($DeleteData) {
    if ($Confirmation -ne $script:Instance.instanceId) {
      Fail "data deletion requires --confirm=$($script:Instance.instanceId)"
    }
    Attest-Volume
    docker volume rm "$($script:Instance.composeProjectName)_workflow-mcp-data" | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "volume deletion failed" }
  }
  # The running PowerShell file cannot be removed reliably on every supported
  # Windows filesystem. All other exact, attested instance files are removed and
  # the operator receives an explicit final path for this one harmless remnant.
  foreach ($Name in @("compose.yaml", "compose.web.yaml", "compose.authoring.yaml", "compose.auth-api-key.yaml", "compose.project-codex-mask.yaml", "version.env", "instance.json", ".gitignore", "workflow-mcp-docker")) {
    $Target = Join-Path $script:Installation $Name
    if (Test-Path -LiteralPath $Target) { Remove-Item -Force -LiteralPath $Target }
  }
  Write-Host "Uninstalled Workflow MCP; durable data was $(if ($DeleteData) { 'deleted' } else { 'preserved' })."
  Write-Host "Remove $($MyInvocation.MyCommand.Path) after this command returns."
}

function Resolve-MaintenancePath([string] $Requested, [string] $Kind) {
  if (-not [IO.Path]::IsPathRooted($Requested)) { Fail "$Kind path must be absolute" }
  $script:MaintenanceName = [IO.Path]::GetFileName($Requested)
  if ([string]::IsNullOrWhiteSpace($script:MaintenanceName)) { Fail "invalid $Kind filename" }
  $script:MaintenanceDirectory = Canonical-Directory ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Requested)))
  $script:MaintenanceHostPath = Join-Path $script:MaintenanceDirectory $script:MaintenanceName
}

function Invoke-ArchiveVerification([string] $InputPath) {
  Resolve-MaintenancePath $InputPath "input"
  if (-not (Test-Path -LiteralPath $script:MaintenanceHostPath -PathType Leaf) -or -not (Test-Path -LiteralPath "$($script:MaintenanceHostPath).sha256" -PathType Leaf)) {
    Fail "backup archive or checksum sidecar is missing"
  }
  & docker run --rm --network none --read-only --user 10001:10001 `
    -e "WORKFLOW_MCP_INSTANCE_ID=$($script:Instance.instanceId)" -e "WORKFLOW_MCP_PROJECT_HASH=$($script:Instance.projectHash)" `
    --mount "type=bind,src=$script:MaintenanceDirectory,dst=/backup-input,readonly" `
    $Image maintenance backup-verify "--input=/backup-input/$script:MaintenanceName"
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
    & docker run --rm --network none --read-only --user 10001:10001 `
      -e "WORKFLOW_MCP_INSTANCE_ID=$($script:Instance.instanceId)" -e "WORKFLOW_MCP_PROJECT_HASH=$($script:Instance.projectHash)" `
      --mount "type=volume,src=$Volume,dst=/data,volume-nocopy" `
      --mount "type=bind,src=$script:MaintenanceDirectory,dst=/backup-output" `
      $Image maintenance backup-create "--output=/backup-output/$script:MaintenanceName"
    if ($LASTEXITCODE -ne 0) { Fail "offline backup failed; the daemon remains stopped" }
    Write-Host "Backup committed at $script:MaintenanceHostPath (checksum: $($script:MaintenanceHostPath).sha256)."
  } elseif ($Action -eq "verify") {
    $Input = $null
    foreach ($Argument in $Options) {
      if ($Argument -match '^--input=(.+)$') { $Input = $Matches[1] } else { Fail "unknown backup verify option: $Argument" }
    }
    if ([string]::IsNullOrWhiteSpace($Input)) { Fail "backup verify requires --input=C:\absolute\file" }
    Invoke-ArchiveVerification $Input
  } else { Fail "backup requires create or verify" }
}

function Restore-Command() {
  Load-Instance $Project
  $Input = $null
  foreach ($Argument in $Rest) {
    if ($Argument -match '^--input=(.+)$') { $Input = $Matches[1] } else { Fail "unknown restore option: $Argument" }
  }
  if ([string]::IsNullOrWhiteSpace($Input)) { Fail "restore requires --input=C:\absolute\file" }
  Invoke-ArchiveVerification $Input
  Invoke-Compose @("down", "--remove-orphans")
  Invoke-Compose @("create")
  Attest-Volume
  Invoke-Compose @("down", "--remove-orphans")
  $Volume = "$($script:Instance.composeProjectName)_workflow-mcp-data"
  & docker run --rm --network none --read-only --user 10001:10001 `
    -e "WORKFLOW_MCP_INSTANCE_ID=$($script:Instance.instanceId)" -e "WORKFLOW_MCP_PROJECT_HASH=$($script:Instance.projectHash)" `
    --mount "type=volume,src=$Volume,dst=/data,volume-nocopy" `
    --mount "type=bind,src=$script:MaintenanceDirectory,dst=/backup-input,readonly" `
    $Image maintenance restore "--input=/backup-input/$script:MaintenanceName"
  if ($LASTEXITCODE -ne 0) { Fail "offline restore failed; the target volume was not overwritten if it was non-empty" }
  Write-Host "Restore committed offline. Run the up command when ready; Codex login and local tokens must be recreated."
}

switch ($Command) {
  "install" { Install-Command }
  "up" { Load-Instance $Project; Invoke-Compose @("create"); Attest-Volume; Invoke-Compose @("up", "--detach", "--wait") }
  "down" { Load-Instance $Project; Invoke-Compose @("down", "--remove-orphans") }
  "status" { Load-Instance $Project; Invoke-Compose @("ps"); Invoke-Compose (@("exec", "-T", "workflow-mcp", "workflow-mcp", "status") + $Rest) }
  "logs" { Load-Instance $Project; Invoke-Compose (@("logs", "--follow", "workflow-mcp") + $Rest) }
  "doctor" { Load-Instance $Project; Attest-Volume; Invoke-Compose @("config", "--quiet"); Invoke-Compose @("exec", "-T", "workflow-mcp", "workflow-mcp", "doctor", "--json") }
  "ui" { Load-Instance $Project; Invoke-Compose @("exec", "workflow-mcp", "workflow-mcp", "ui") }
  "mcp-proxy" { Load-Instance $Project; Invoke-Compose @("exec", "-T", "workflow-mcp", "workflow-mcp", "mcp-proxy") }
  "token" { Load-Instance $Project; Invoke-Compose (@("exec", "workflow-mcp", "workflow-mcp", "token", "show") + $Rest) }
  "source" { Load-Instance $Project; Invoke-Compose (@("exec", "-T", "workflow-mcp", "workflow-mcp", "source") + $Rest) }
  "auth" { Load-Instance $Project; Invoke-Compose (@("exec", "workflow-mcp", "workflow-mcp", "auth") + $Rest) }
  "backup" { Backup-Command }
  "restore" { Restore-Command }
  "uninstall" { Uninstall-Command }
  "help" { Write-Host "workflow-mcp-docker install|up|down|status|logs|doctor|ui|mcp-proxy|token|source|auth|backup|restore PROJECT" }
  default { Fail "unknown command: $Command" }
}
