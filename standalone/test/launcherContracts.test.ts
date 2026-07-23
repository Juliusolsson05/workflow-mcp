import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

let posix = ''
let powershell = ''

beforeAll(async () => {
  ;[posix, powershell] = await Promise.all([
    readFile(resolve('install/workflow-mcp-docker'), 'utf8'),
    readFile(resolve('install/workflow-mcp-docker.ps1'), 'utf8'),
  ])
})

describe('host launcher orchestration contracts', () => {
  it('validates API-key identity and bytes before authoring can create its project tree', () => {
    const posixRequire = section(posix, 'require_runtime_api_key() {', 'compose() {')
    expectBefore(posixRequire, 'validate_api_key_path', 'api_key_preflight')
    const posixInstall = section(posix, 'install_command() {', 'validate_codex_removal_path() {')
    expectBefore(posixInstall, 'api_key_preflight "$api_key_arg"', 'mkdir -p "$project_directory/.claude/workflows"')

    const powershellRequire = section(powershell, 'function Require-RuntimeApiKey()', 'function Compose-Arguments()')
    expectBefore(powershellRequire, 'Canonical-File', 'Test-ApiKeyForRuntime')
    const powershellInstall = section(powershell, 'function Install-Command()', 'function Test-CodexRemovalPath()')
    expectBefore(powershellInstall, 'Test-ApiKeyForRuntime $ApiKeyFile', 'New-Item -ItemType Directory -Force -Path $WorkflowDirectory')
  })

  it('runs mutable credential and authoring probes before upgrade can quiesce the old daemon', () => {
    const posixUpgrade = section(posix, 'upgrade_command() {', 'maintenance_bind_path() {')
    expectBefore(posixUpgrade, 'require_runtime_api_key', 'compose down --remove-orphans')
    expectBefore(posixUpgrade, 'authoring_preflight', 'compose down --remove-orphans')

    const powershellUpgrade = section(powershell, 'function Upgrade-Command()', 'function Resolve-MaintenancePath')
    expectBefore(powershellUpgrade, 'Require-RuntimeApiKey', 'Invoke-Compose @("down", "--remove-orphans")')
    expectBefore(powershellUpgrade, 'Test-AuthoringPath $true', 'Invoke-Compose @("down", "--remove-orphans")')
    // Presence in the upgrade function is not sufficient: the old bug also repeated this probe only
    // after public bundle replacement. Exactly one pre-mutation probe keeps that ordering obvious.
    expect(posixUpgrade.match(/authoring_preflight/g)).toHaveLength(2) // preflight + rollback race recheck
    expect(powershellUpgrade.match(/Test-AuthoringPath \$true/g)).toHaveLength(2)
  })

  it('distinguishes a completed doctor exit 3 from Compose execution failure in both launchers', () => {
    expect(posix).toContain('[ "$container_doctor_status" -ne 0 ] && [ "$container_doctor_status" -ne 3 ]')
    expect(powershell).toContain('if ($ContainerDoctorExit -ne 0 -and $ContainerDoctorExit -ne 3)')
  })

  it('rejects backup names and bind directories before Compose down on both hosts', () => {
    const posixPath = section(posix, 'maintenance_bind_path() {', 'run_offline_maintenance() {')
    expect(posixPath).toContain('{0,196}$')
    expect(posixPath).toContain('{0,247}$')
    expect(posixPath).toContain("backup output directories containing ','")
    const posixBackup = section(posix, 'backup_command() {', 'restore_command() {')
    expectBefore(posixBackup, 'maintenance_bind_path "$output" output', 'compose down --remove-orphans')

    const powershellPath = section(powershell, 'function Resolve-MaintenancePath', 'function New-ArchiveSnapshot')
    expect(powershellPath).toContain('{0,196}$')
    expect(powershellPath).toContain('{0,247}$')
    expect(powershellPath).toContain("directories containing ','")
    const powershellBackup = section(powershell, 'function Backup-Command()', 'function Restore-Command()')
    expectBefore(powershellBackup, 'Resolve-MaintenancePath $Output "output"', 'Invoke-Compose @("down", "--remove-orphans")')
  })
})

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  expect(startIndex, `missing section start ${start}`).toBeGreaterThanOrEqual(0)
  expect(endIndex, `missing section end ${end}`).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

function expectBefore(source: string, earlier: string, later: string): void {
  const earlierIndex = source.indexOf(earlier)
  const laterIndex = source.indexOf(later)
  expect(earlierIndex, `missing earlier operation ${earlier}`).toBeGreaterThanOrEqual(0)
  expect(laterIndex, `missing later operation ${later}`).toBeGreaterThan(earlierIndex)
}
