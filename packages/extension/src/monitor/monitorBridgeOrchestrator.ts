import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export type TakeoverPolicy = 'version-mismatch' | 'stale-recovery'

export interface MonitorBridgeIdentitySnapshot {
  readonly version?: string
  readonly extensionPath?: string
  readonly mode?: string
  readonly commit?: string
}

export interface MonitorBridgeRuntimeSnapshot {
  readonly ownerPid: number
  readonly port: number
  readonly version?: string
  readonly extensionPath?: string
  readonly mode?: string
  readonly commit?: string
}

export interface BridgeOwnerLease {
  readonly pid: number
  readonly port: number
  readonly version?: string
  readonly extensionPath?: string
  readonly mode?: string
  readonly commit?: string
  readonly ownerClientId: string
  readonly updatedAt: string
  readonly lastHeartbeatAt?: string
  readonly lastTakeoverAt?: string
  readonly restartOwnerClientId?: string
  readonly restartExpectedVersion?: string
  readonly restartStartedAt?: string
}

export interface MonitorBridgeOrchestratorOptions {
  readonly identity: MonitorBridgeIdentitySnapshot
  readonly clientId: string
  readonly leaseFilePath?: string
  readonly takeoverCooldownMs?: number
  readonly demandWindowMs?: number
  readonly leaseFreshWindowMs?: number
  readonly retryBackoffMinMs?: number
  readonly retryBackoffMaxMs?: number
  readonly restartLockTtlMs?: number
  readonly now?: () => number
}

const DEFAULT_TAKEOVER_COOLDOWN_MS = 12_000
const DEFAULT_TAKEOVER_DEMAND_WINDOW_MS = 60_000
const DEFAULT_LEASE_FRESH_WINDOW_MS = 15_000
const DEFAULT_RETRY_BACKOFF_MIN_MS = 1_000
const DEFAULT_RETRY_BACKOFF_MAX_MS = 2_500
const DEFAULT_RESTART_LOCK_TTL_MS = 20_000

const DEFAULT_LEASE_FILE_PATH = path.join(
  os.tmpdir(),
  '.boardlab',
  'monitor-bridge',
  'owner-lease.json'
)

export class MonitorBridgeOrchestrator {
  private readonly identity: MonitorBridgeIdentitySnapshot
  private readonly clientId: string
  private readonly leaseFilePath: string
  private readonly takeoverCooldownMs: number
  private readonly demandWindowMs: number
  private readonly leaseFreshWindowMs: number
  private readonly retryBackoffMinMs: number
  private readonly retryBackoffMaxMs: number
  private readonly restartLockTtlMs: number
  private readonly now: () => number
  private lastTakeoverAt = 0
  private lastDemandAt = 0

  constructor(options: MonitorBridgeOrchestratorOptions) {
    this.identity = options.identity
    this.clientId = options.clientId
    this.leaseFilePath = options.leaseFilePath ?? DEFAULT_LEASE_FILE_PATH
    this.takeoverCooldownMs =
      options.takeoverCooldownMs ?? DEFAULT_TAKEOVER_COOLDOWN_MS
    this.demandWindowMs =
      options.demandWindowMs ?? DEFAULT_TAKEOVER_DEMAND_WINDOW_MS
    this.leaseFreshWindowMs =
      options.leaseFreshWindowMs ?? DEFAULT_LEASE_FRESH_WINDOW_MS
    this.retryBackoffMinMs =
      options.retryBackoffMinMs ?? DEFAULT_RETRY_BACKOFF_MIN_MS
    this.retryBackoffMaxMs =
      options.retryBackoffMaxMs ?? DEFAULT_RETRY_BACKOFF_MAX_MS
    this.restartLockTtlMs =
      options.restartLockTtlMs ?? DEFAULT_RESTART_LOCK_TTL_MS
    this.now = options.now ?? Date.now
  }

  noteDemand(): void {
    this.lastDemandAt = this.now()
  }

  noteTakeover(): void {
    this.lastTakeoverAt = this.now()
  }

  hasActiveDemand(): boolean {
    return this.now() - this.lastDemandAt < this.demandWindowMs
  }

  computeRetryBackoffMs(): number {
    const min = Math.min(this.retryBackoffMinMs, this.retryBackoffMaxMs)
    const max = Math.max(this.retryBackoffMinMs, this.retryBackoffMaxMs)
    const jitter = Math.floor(Math.random() * (max - min + 1))
    return min + jitter
  }

  isCompatibleBridge(info: MonitorBridgeRuntimeSnapshot): boolean {
    const expectedVersion = this.identity.version
    if (
      expectedVersion &&
      (!info.version || info.version !== expectedVersion)
    ) {
      return false
    }
    const expectedExtensionPath = this.identity.extensionPath
    if (
      expectedExtensionPath &&
      (!info.extensionPath || info.extensionPath !== expectedExtensionPath)
    ) {
      return false
    }
    const expectedCommit = this.identity.commit
    if (expectedCommit && (!info.commit || info.commit !== expectedCommit)) {
      return false
    }
    return true
  }

  async evaluateTakeoverPolicy(
    policy: TakeoverPolicy,
    port: number
  ): Promise<{ allowed: true } | { allowed: false; reason: string }> {
    if (!this.hasActiveDemand()) {
      return { allowed: false, reason: 'demand-inactive' }
    }

    const now = this.now()
    if (now - this.lastTakeoverAt < this.takeoverCooldownMs) {
      return { allowed: false, reason: 'cooldown-local' }
    }

    const lease = await this.readOwnerLease().catch(() => undefined)
    if (!lease || lease.port !== port) {
      return { allowed: true }
    }

    const updatedAt = Date.parse(lease.updatedAt)
    if (
      Number.isFinite(updatedAt) &&
      now - updatedAt < this.leaseFreshWindowMs &&
      !this.leaseMatchesIdentity(lease)
    ) {
      return { allowed: false, reason: 'lease-fresh-foreign-owner' }
    }

    if (
      lease.lastTakeoverAt &&
      Number.isFinite(Date.parse(lease.lastTakeoverAt)) &&
      now - Date.parse(lease.lastTakeoverAt) < this.takeoverCooldownMs
    ) {
      return { allowed: false, reason: 'cooldown-shared' }
    }

    return { allowed: true }
  }

  async readOwnerLease(): Promise<BridgeOwnerLease | undefined> {
    try {
      const text = await fs.readFile(this.leaseFilePath, 'utf8')
      const parsed = JSON.parse(text) as BridgeOwnerLease
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !Number.isInteger(parsed.pid) ||
        !Number.isInteger(parsed.port) ||
        typeof parsed.updatedAt !== 'string'
      ) {
        return undefined
      }
      return parsed
    } catch {
      return undefined
    }
  }

  async writeOwnerLease(
    info: MonitorBridgeRuntimeSnapshot,
    options: {
      heartbeat?: boolean
      takeover?: boolean
      restartLock?: { expectedVersion?: string } | null
    } = {}
  ): Promise<void> {
    if (!Number.isInteger(info.port) || info.port <= 0) {
      return
    }
    const nowIso = new Date(this.now()).toISOString()
    const current = await this.readOwnerLease().catch(() => undefined)
    const lease: BridgeOwnerLease = {
      pid: info.ownerPid || process.pid,
      port: info.port,
      version: info.version ?? this.identity.version,
      extensionPath: info.extensionPath ?? this.identity.extensionPath,
      mode: info.mode ?? this.identity.mode,
      commit: info.commit ?? this.identity.commit,
      ownerClientId: this.clientId,
      updatedAt: nowIso,
      lastHeartbeatAt: options.heartbeat ? nowIso : current?.lastHeartbeatAt,
      lastTakeoverAt: options.takeover ? nowIso : current?.lastTakeoverAt,
      restartOwnerClientId:
        options.restartLock === null
          ? undefined
          : options.restartLock
            ? this.clientId
            : current?.restartOwnerClientId,
      restartExpectedVersion:
        options.restartLock === null
          ? undefined
          : options.restartLock
            ? options.restartLock.expectedVersion
            : current?.restartExpectedVersion,
      restartStartedAt:
        options.restartLock === null
          ? undefined
          : options.restartLock
            ? nowIso
            : current?.restartStartedAt,
    }
    await fs.mkdir(path.dirname(this.leaseFilePath), { recursive: true })
    await fs.writeFile(
      this.leaseFilePath,
      JSON.stringify(lease, null, 2),
      'utf8'
    )
  }

  async tryAcquireRestartLock(
    port: number,
    expectedVersion?: string
  ): Promise<{ acquired: true } | { acquired: false; reason: string }> {
    if (!Number.isInteger(port) || port <= 0) {
      return { acquired: false, reason: 'restart-lock-invalid-port' }
    }
    const now = this.now()
    const lease = await this.readOwnerLease().catch(() => undefined)
    if (lease?.port === port && lease.restartOwnerClientId) {
      const startedAt = Date.parse(lease.restartStartedAt ?? '')
      const lockFresh =
        Number.isFinite(startedAt) && now - startedAt < this.restartLockTtlMs
      if (lockFresh && lease.restartOwnerClientId !== this.clientId) {
        return { acquired: false, reason: 'restart-lock-foreign' }
      }
    }
    await this.writeOwnerLease(
      {
        ownerPid: lease?.pid ?? process.pid,
        port,
        version: lease?.version ?? this.identity.version,
        extensionPath: lease?.extensionPath ?? this.identity.extensionPath,
        mode: lease?.mode ?? this.identity.mode,
        commit: lease?.commit ?? this.identity.commit,
      },
      { restartLock: { expectedVersion } }
    )
    return { acquired: true }
  }

  async clearRestartLock(port: number): Promise<void> {
    if (!Number.isInteger(port) || port <= 0) {
      return
    }
    const lease = await this.readOwnerLease().catch(() => undefined)
    if (!lease || lease.port !== port || !lease.restartOwnerClientId) {
      return
    }
    if (lease.restartOwnerClientId !== this.clientId) {
      const startedAt = Date.parse(lease.restartStartedAt ?? '')
      const lockFresh =
        Number.isFinite(startedAt) &&
        this.now() - startedAt < this.restartLockTtlMs
      if (lockFresh) {
        return
      }
    }
    await this.writeOwnerLease(
      {
        ownerPid: lease.pid,
        port: lease.port,
        version: lease.version,
        extensionPath: lease.extensionPath,
        mode: lease.mode,
        commit: lease.commit,
      },
      { restartLock: null }
    )
  }

  private leaseMatchesIdentity(lease: BridgeOwnerLease): boolean {
    const leasePath = this.normalizeForMatch(lease.extensionPath)
    const currentPath = this.normalizeForMatch(this.identity.extensionPath)
    if (leasePath && currentPath && leasePath === currentPath) {
      return true
    }
    const leaseVersion = lease.version ?? ''
    const currentVersion = this.identity.version ?? ''
    return Boolean(
      leaseVersion && currentVersion && leaseVersion === currentVersion
    )
  }

  private normalizeForMatch(value: string | undefined): string {
    if (!value) {
      return ''
    }
    return value.replace(/\//g, '\\').toLowerCase()
  }
}
