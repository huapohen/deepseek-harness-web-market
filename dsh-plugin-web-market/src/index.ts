import { createHash, randomBytes } from 'node:crypto'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import {
  existsSync,
  readFileSync,
} from 'node:fs'
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { type Readable } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'

const PROFILE_NAME = 'web'
const PREVIEW_TTL_MS = 5 * 60 * 1000
const PROFILE_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'] as const
const SAFE_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const IMMUTABLE_BUNDLES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@huapohen/dsh-web-market',
  'dsh-community-market',
])

export interface WebMarketConfig {
  readonly profile?: string
  readonly restartDelayMs?: number
}

interface ProfileManifest {
  dependencies?: Record<string, string>
  dsh?: {
    profile?: {
      bundles?: string[]
    }
  }
  [key: string]: unknown
}

interface WebProfile {
  readonly name: string
  readonly dir: string
}

interface PnpmOutcome {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
}

interface PnpmHandle {
  readonly stdout: Readable
  readonly stderr: Readable
  readonly done: Promise<PnpmOutcome>
  cancel(): void
}

interface RecoveryRequest {
  readonly packageName: string
  readonly packageVersion: string
  readonly receiptId: string
}

interface ProfileSnapshot {
  readonly receiptId: string
  readonly files: ReadonlyMap<string, Buffer | null>
}

interface PluginBundle {
  readonly bundleId: string
  readonly packageName: string
  readonly status: 'active' | 'disabled'
  readonly mutable: boolean
}

interface PluginPreview {
  readonly previewId: string
  readonly profileName: string
  readonly packageName: string
  readonly expiresAt: string
}

interface PreviewRecord {
  readonly action: 'disable' | 'enable'
  readonly packageName: string
  readonly expiresAt: number
}

interface PluginState {
  readonly version: 1
  readonly disabled: readonly string[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    desktopProfiles: WebProfilesService
    desktopPnpm: WebPnpmService
    desktopPlugins: WebPluginsService
    desktopActions: WebActionsService
  }
}

function resolveDshHome(): string {
  const configured = process.env.DSH_HOME
  return configured === undefined || configured.length === 0 ? join(homedir(), '.dsh') : configured
}

function assertProfileName(value: string): void {
  if (value.length === 0 || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
    throw new Error(`invalid DSH profile name: ${JSON.stringify(value)}`)
  }
}

function profileDirectory(home: string, name: string): string {
  assertProfileName(name)
  return join(home, 'profiles', name)
}

function readManifest(profileDir: string): ProfileManifest {
  const parsed = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('web profile manifest must be an object')
  }
  return parsed as ProfileManifest
}

function manifestBundles(manifest: ProfileManifest): string[] {
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!Array.isArray(bundles) || bundles.some(value => typeof value !== 'string' || !SAFE_PACKAGE.test(value))) {
    throw new Error('web profile bundle list is invalid')
  }
  return [...bundles]
}

async function atomicWrite(path: string, body: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.web-market-${process.pid}-${randomBytes(8).toString('hex')}`
  await writeFile(temporary, body, { mode: 0o600 })
  await rename(temporary, path)
}

async function takeProfileSnapshot(profileDir: string, receiptId: string): Promise<ProfileSnapshot> {
  const files = new Map<string, Buffer | null>()
  for (const filename of PROFILE_FILES) {
    const path = join(profileDir, filename)
    try {
      files.set(path, await readFile(path))
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
      files.set(path, null)
    }
  }
  return { receiptId, files }
}

async function restoreProfileSnapshot(snapshot: ProfileSnapshot): Promise<void> {
  for (const [path, body] of snapshot.files) {
    if (body === null) await rm(path, { force: true })
    else await atomicWrite(path, body)
  }
}

function processHandle(child: ChildProcessByStdio<null, Readable, Readable>, signal?: AbortSignal): PnpmHandle {
  let settled = false
  const done = new Promise<PnpmOutcome>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, childSignal) => {
      settled = true
      resolve({ exitCode: code, signal: childSignal })
    })
  })
  const cancel = (): void => {
    if (!settled) child.kill('SIGTERM')
  }
  if (signal !== undefined) {
    if (signal.aborted) cancel()
    else signal.addEventListener('abort', cancel, { once: true })
    void done.finally(() => signal.removeEventListener('abort', cancel))
  }
  return { stdout: child.stdout, stderr: child.stderr, done, cancel }
}

export class WebProfilesService extends Service {
  readonly current: WebProfile

  constructor(ctx: Context, profile: WebProfile) {
    super(ctx, 'desktopProfiles')
    this.current = Object.freeze(profile)
  }
}

export class WebPnpmService extends Service {
  private active: PnpmHandle | undefined
  private readonly snapshots = new Map<string, ProfileSnapshot>()
  private closed = false

  constructor(
    ctx: Context,
    private readonly profile: WebProfile,
    private readonly homeDir: string,
    private readonly cliEntry: string,
  ) {
    super(ctx, 'desktopPnpm')
    if (!isAbsolute(cliEntry)) throw new Error('DSH CLI entry must be an absolute path')
    ctx.effect(() => () => {
      this.closed = true
      this.active?.cancel()
    }, 'dsh-web-market: package operation lifetime')
  }

  runPlugin(args: readonly string[], invokingDir: string, signal?: AbortSignal): PnpmHandle {
    return this.start(args, invokingDir, signal)
  }

  async installPlugin(request: {
    readonly pnpmOptions?: readonly string[]
    readonly invokingDir: string
    readonly recovery: RecoveryRequest
    readonly signal?: AbortSignal
  }): Promise<PnpmHandle> {
    if (!SAFE_PACKAGE.test(request.recovery.packageName)) throw new Error('invalid package name')
    const snapshot = await takeProfileSnapshot(this.profile.dir, request.recovery.receiptId)
    this.snapshots.set(request.recovery.receiptId, snapshot)
    while (this.snapshots.size > 16) {
      const oldest = this.snapshots.keys().next().value as string | undefined
      if (oldest !== undefined) this.snapshots.delete(oldest)
    }
    const target = `${request.recovery.packageName}@${request.recovery.packageVersion}`
    const handle = this.start(['add', ...(request.pnpmOptions ?? []), target], request.invokingDir, request.signal)
    const guardedDone = handle.done.then(async outcome => {
      if (outcome.exitCode !== 0 || outcome.signal !== null) {
        await restoreProfileSnapshot(snapshot)
        this.snapshots.delete(request.recovery.receiptId)
      }
      return outcome
    })
    return { ...handle, done: guardedDone }
  }

  recoveredInstallReceiptIds(): Promise<readonly string[]> {
    return Promise.resolve([])
  }

  acknowledgeRecoveredInstall(receiptId: string): Promise<void> {
    this.snapshots.delete(receiptId)
    return Promise.resolve()
  }

  async rollbackPluginInstall(receiptId: string): Promise<boolean> {
    const snapshot = this.snapshots.get(receiptId)
    if (snapshot === undefined) return false
    await restoreProfileSnapshot(snapshot)
    this.snapshots.delete(receiptId)
    return true
  }

  private start(args: readonly string[], invokingDir: string, signal?: AbortSignal): PnpmHandle {
    if (this.closed) throw new Error('web market package service is closed')
    if (this.active !== undefined) throw new Error('another web market package operation is active')
    if (!isAbsolute(invokingDir) || args.length === 0 || args.some(value => value.includes('\0'))) {
      throw new Error('invalid package operation')
    }
    signal?.throwIfAborted()
    const child = spawn(process.execPath, [
      this.cliEntry,
      'plugin',
      '--profile',
      this.profile.name,
      ...args,
    ], {
      cwd: invokingDir,
      env: { ...process.env, DSH_HOME: this.homeDir, CI: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const handle = processHandle(child, signal)
    this.active = handle
    void handle.done.finally(() => {
      if (this.active === handle) this.active = undefined
    })
    return handle
  }
}

export class WebPluginsService extends Service {
  private readonly previews = new Map<string, PreviewRecord>()
  private operation: Promise<{ packageName: string }> | undefined
  private closed = false

  constructor(
    ctx: Context,
    private readonly profile: WebProfile,
    private readonly statePath: string,
  ) {
    super(ctx, 'desktopPlugins')
    ctx.effect(() => () => {
      this.closed = true
      this.previews.clear()
    }, 'dsh-web-market: plugin inventory lifetime')
  }

  list(): readonly PluginBundle[] {
    this.assertOpen()
    const manifest = readManifest(this.profile.dir)
    const active = manifestBundles(manifest)
    const dependencies = new Set(Object.keys(manifest.dependencies ?? {}))
    const disabled = this.readState().disabled.filter(name => dependencies.has(name) && !active.includes(name))
    return [...active.map(packageName => this.bundle(packageName, 'active')),
      ...disabled.map(packageName => this.bundle(packageName, 'disabled'))]
  }

  disabledPackageNames(): readonly string[] {
    return this.list().filter(bundle => bundle.status === 'disabled').map(bundle => bundle.packageName)
  }

  isDisabled(packageName: string): boolean {
    return this.disabledPackageNames().includes(packageName)
  }

  previewDisable(bundleId: string): PluginPreview {
    const bundle = this.list().find(value => value.bundleId === bundleId)
    if (bundle === undefined || bundle.status !== 'active' || !bundle.mutable) throw new Error('plugin cannot be disabled')
    return this.preview('disable', bundle.packageName)
  }

  executeDisable(previewId: string): Promise<{ packageName: string }> {
    return this.execute(previewId, 'disable')
  }

  previewEnable(bundleId: string): PluginPreview {
    const bundle = this.list().find(value => value.bundleId === bundleId)
    if (bundle === undefined || bundle.status !== 'disabled' || !bundle.mutable) throw new Error('plugin cannot be enabled')
    return this.preview('enable', bundle.packageName)
  }

  executeEnable(previewId: string): Promise<{ packageName: string }> {
    return this.execute(previewId, 'enable')
  }

  private bundle(packageName: string, status: PluginBundle['status']): PluginBundle {
    const id = createHash('sha256').update(`${this.profile.name}\0${packageName}`).digest('base64url').slice(0, 32)
    return { bundleId: `bundle_${id}`, packageName, status, mutable: !IMMUTABLE_BUNDLES.has(packageName) }
  }

  private preview(action: PreviewRecord['action'], packageName: string): PluginPreview {
    this.assertOpen()
    const previewId = `${action}_${randomBytes(32).toString('base64url')}`
    const expiresAt = Date.now() + PREVIEW_TTL_MS
    this.previews.set(previewId, { action, packageName, expiresAt })
    return { previewId, profileName: this.profile.name, packageName, expiresAt: new Date(expiresAt).toISOString() }
  }

  private execute(previewId: string, action: PreviewRecord['action']): Promise<{ packageName: string }> {
    this.assertOpen()
    if (this.operation !== undefined) return Promise.reject(new Error('another plugin state operation is active'))
    const preview = this.previews.get(previewId)
    this.previews.delete(previewId)
    if (preview === undefined || preview.action !== action || preview.expiresAt <= Date.now()) {
      return Promise.reject(new Error('plugin state preview expired'))
    }
    const operation = this.persist(action, preview.packageName)
    this.operation = operation
    void operation.finally(() => {
      if (this.operation === operation) this.operation = undefined
    })
    return operation
  }

  private async persist(action: PreviewRecord['action'], packageName: string): Promise<{ packageName: string }> {
    const manifestPath = join(this.profile.dir, 'package.json')
    const previousManifest = await readFile(manifestPath)
    const previousState = existsSync(this.statePath) ? await readFile(this.statePath) : null
    const manifest = readManifest(this.profile.dir)
    const dependencies = manifest.dependencies ?? {}
    const bundles = manifestBundles(manifest)
    const disabled = new Set(this.readState().disabled.filter(name => Object.hasOwn(dependencies, name)))
    if (!Object.hasOwn(dependencies, packageName) || IMMUTABLE_BUNDLES.has(packageName)) {
      throw new Error('plugin is not mutable')
    }
    if (action === 'disable') {
      if (!bundles.includes(packageName)) throw new Error('plugin is not active')
      manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: bundles.filter(name => name !== packageName) } }
      disabled.add(packageName)
    } else {
      if (!disabled.delete(packageName)) throw new Error('plugin is not disabled')
      manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundles, packageName] } }
    }
    try {
      await atomicWrite(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
      await atomicWrite(this.statePath, `${JSON.stringify({ version: 1, disabled: [...disabled].sort() }, undefined, 2)}\n`)
      return { packageName }
    } catch (cause) {
      await atomicWrite(manifestPath, previousManifest)
      if (previousState === null) await rm(this.statePath, { force: true })
      else await atomicWrite(this.statePath, previousState)
      throw cause
    }
  }

  private readState(): PluginState {
    if (!existsSync(this.statePath)) return { version: 1, disabled: [] }
    const value = JSON.parse(readFileSync(this.statePath, 'utf8')) as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid web market plugin state')
    const state = value as Record<string, unknown>
    if (state.version !== 1 || !Array.isArray(state.disabled)
      || state.disabled.some(name => typeof name !== 'string' || !SAFE_PACKAGE.test(name))) {
      throw new Error('invalid web market plugin state')
    }
    return { version: 1, disabled: [...new Set(state.disabled as string[])] }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('web market plugin service is closed')
  }
}

export class WebActionsService extends Service {
  private closed = false

  constructor(
    ctx: Context,
    private readonly profile: WebProfile,
    private readonly restartDelayMs: number,
  ) {
    super(ctx, 'desktopActions')
    ctx.effect(() => () => { this.closed = true }, 'dsh-web-market: actions lifetime')
  }

  openTerminal(): void {
    this.assertOpen()
    const child = spawn('/usr/bin/open', ['-a', 'Terminal', this.profile.dir], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
  }

  requestRestart(): Promise<void> {
    this.assertOpen()
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), this.restartDelayMs).unref()
    return Promise.resolve()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('web market actions service is closed')
  }
}

export const name = 'dsh-web-market-host'

export function apply(ctx: Context, config: WebMarketConfig = {}): void {
  const homeDir = resolveDshHome()
  const profileName = config.profile ?? PROFILE_NAME
  const profile = Object.freeze({ name: profileName, dir: profileDirectory(homeDir, profileName) })
  const cliEntry = process.env.DSH_WEB_MARKET_CLI_ENTRY ?? process.argv[1]
  if (cliEntry === undefined) throw new Error('unable to resolve the active DSH CLI entry')
  new WebProfilesService(ctx, profile)
  new WebPnpmService(ctx, profile, homeDir, cliEntry)
  new WebPluginsService(ctx, profile, join(homeDir, 'web-market', 'plugin-state.json'))
  new WebActionsService(ctx, profile, config.restartDelayMs ?? 300)
}
