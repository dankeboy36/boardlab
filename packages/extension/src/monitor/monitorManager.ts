import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { createPortKey, PortIdentifier, type DetectedPorts } from 'boards-list'
import deepEqual from 'fast-deep-equal'
import * as vscode from 'vscode'
import type { Messenger } from 'vscode-messenger'
import type {
  MessageParticipant,
  NotificationType,
} from 'vscode-messenger-common'
import {
  equalParticipants,
  isWebviewIdMessageParticipant,
  isWebviewTypeMessageParticipant,
} from 'vscode-messenger-common'

import {
  connectMonitorClient,
  disconnectMonitorClient,
  getMonitorBridgeInfo,
  notifyMonitorBridgeError,
  notifyMonitorClientAttached,
  notifyMonitorClientDetached,
  notifyMonitorIntentResume,
  notifyMonitorIntentStart,
  notifyMonitorIntentStop,
  notifyMonitorOpenError,
  notifyMonitorPhysicalStateChanged,
  notifyMonitorSessionState,
  notifyMonitorViewDidChangeBaudrate,
  notifyMonitorViewDidChangeDetectedPorts,
  notifyMonitorViewDidChangeMonitorSettings,
  notifyMonitorViewDidPause,
  notifyMonitorViewDidResume,
  notifyTraceEvent,
  requestMonitorDetectedPorts,
  requestMonitorPause,
  requestMonitorPhysicalStateSnapshot,
  requestMonitorResume,
  requestMonitorSendMessage,
  requestMonitorSessionSnapshot,
  requestMonitorUpdateBaudrate,
  type ConnectClientParams,
  type DisconnectMonitorClientParams,
  type HostConnectClientResult,
  type MonitorBridgeInfo,
  type MonitorBridgeLogEntry,
  type MonitorClientAttachParams,
  type MonitorClientDetachParams,
  type MonitorIntentParams,
  type MonitorOpenErrorNotification,
  type MonitorSelectionNotification,
  type MonitorSessionState,
  type MonitorSettingsByProtocol,
  type RequestPauseResumeMonitorParams,
  type RequestSendMonitorMessageParams,
  type RequestUpdateBaudrateParams,
  type TraceEventNotification,
} from '@boardlab/protocol'

import type { CliContext } from '../cli/context'
import { kill } from './kill'
import {
  MonitorBridgeClient,
  type MonitorBridgeClientOptions,
} from './monitorBridgeClient'
import {
  MonitorBridgeOrchestrator,
  type MonitorBridgeRuntimeSnapshot,
} from './monitorBridgeOrchestrator'
import {
  MonitorLogicalTracker,
  type MonitorPhysicalState,
} from './monitorLogicalTracker'
import { MonitorPhysicalStateRegistry } from './monitorPhysicalStateRegistry'
import { MonitorPortSession } from './monitorPortSession'
import { portToPid } from './pidPort'

const DEFAULT_BRIDGE_HOST = '127.0.0.1'
const DEFAULT_BRIDGE_PORT = 55888
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 20_000
const WAIT_ATTEMPTS = 50
const WAIT_DELAY_MS = 200
const PROBE_TIMEOUT_MS = 1_000_000
const HEARTBEAT_REQUEST_TIMEOUT_MS = 5_000
const EXTERNAL_HTTP_RETRY_DELAY_MS = 200
const TAKEOVER_DECISION_DEDUPE_MS = 2_000
const TAKEOVER_DECISION_DEDUPE_RETENTION_MS = 30_000
const STALE_HOST_WAIT_ATTEMPTS = 40
const STALE_HOST_WAIT_DELAY_MS = 250

interface ServiceReadyInfo extends MonitorBridgeInfo {
  readonly ownerPid: number
  readonly port: number
  readonly startedAt?: string
  readonly version?: string
  readonly mode?: string
  readonly extensionPath?: string
  readonly commit?: string
  readonly nodeVersion?: string
  readonly platform?: string
}

interface AttachResponse {
  readonly token: string
  readonly httpBaseUrl: string
  readonly wsUrl: string
}

interface WindowsPortOwnerInfo {
  readonly pid: number
  readonly name?: string
  readonly commandLine?: string
  readonly executablePath?: string
}

export type MonitorRuntimeState =
  | 'disconnected'
  | 'connected'
  | 'running'
  | 'suspended'

export interface MonitorStateChangeEvent {
  readonly port: PortIdentifier
  readonly state: MonitorRuntimeState
  readonly reason?: string
}

type BridgeOwnerReuseContext =
  | 'retry-recheck'
  | 'preferred-port'
  | 'wait-for-bridge'

interface BridgeOwnerReuseDecision {
  readonly reuse: boolean
  readonly reason?: string
}

export function decideBridgeOwnerReuse(
  handled: 'none' | 'killed',
  compatible: boolean,
  context: BridgeOwnerReuseContext
): BridgeOwnerReuseDecision {
  if (handled === 'killed') {
    return { reuse: false }
  }
  if (compatible) {
    return { reuse: true }
  }
  if (context === 'retry-recheck') {
    return { reuse: false, reason: 'retry-recheck-owner-incompatible' }
  }
  if (context === 'preferred-port') {
    return { reuse: false, reason: 'preferred-port-owner-incompatible' }
  }
  return { reuse: false, reason: 'wait-owner-incompatible' }
}

export function shouldBypassTakeoverPolicyForStartupWait(
  reason: string | undefined
): boolean {
  return (
    reason === 'cooldown-local' ||
    reason === 'cooldown-shared' ||
    reason === 'lease-fresh-foreign-owner'
  )
}

export class BridgeInUseError extends Error {
  constructor(
    readonly port: number,
    readonly reason: string,
    cause?: unknown
  ) {
    super(
      `BoardLab monitor bridge port ${port} is already in use (${reason}). Stop the other process or choose a different port.`
    )
    this.name = 'BridgeInUseError'
    if (cause !== undefined) {
      ;(this as any).cause = cause
    }
  }
}

// TODO: portino server must define and export the types
export interface MonitorBridgeServiceClientOptions {
  readonly preferredPort?: number
  readonly heartbeatIntervalMs?: number
  readonly heartbeatTimeoutMs?: number
  readonly identity?: MonitorBridgeIdentity
  readonly logging?: MonitorBridgeLoggingOptions
}

// TODO: portino server must define and export the types
interface MonitorBridgeIdentity {
  readonly version?: string
  readonly mode?: string
  readonly extensionPath?: string
  readonly commit?: string
}

// TODO: portino server must define and export the types
interface MonitorBridgeLoggingOptions {
  readonly heartbeat?: boolean
}

const DEFAULT_BRIDGE_MODE = 'external-process' as const

function formatLog(message: string, data?: unknown): string {
  if (data === undefined) {
    return message
  }
  try {
    return `${message} ${JSON.stringify(data)}`
  } catch {
    return `${message} ${String(data)}`
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message
  }
  return String(error)
}

function getErrnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined
  }
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function resolveBridgeIdentity(
  context: vscode.ExtensionContext
): MonitorBridgeIdentity {
  const extension = context.extension
  const pkg = extension?.packageJSON as { version?: unknown; commit?: unknown }
  const version = typeof pkg?.version === 'string' ? pkg.version : undefined
  const commit = typeof pkg?.commit === 'string' ? pkg.commit : undefined
  const extensionPath = extension?.extensionPath ?? context.extensionPath
  return {
    version,
    mode: DEFAULT_BRIDGE_MODE,
    extensionPath,
    commit,
  }
}

function toComparableExtensionPath(
  value: string | undefined
): string | undefined {
  if (!value) {
    return undefined
  }
  try {
    const uri = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(value)
      ? vscode.Uri.parse(value)
      : vscode.Uri.file(value)
    const fsPath = uri.fsPath || value
    return process.platform === 'win32' ? fsPath.toLowerCase() : fsPath
  } catch {
    return process.platform === 'win32' ? value.toLowerCase() : value
  }
}

class MonitorBridgeServiceClient implements vscode.Disposable {
  private readonly clientId = randomUUID()
  private preferredPort: number
  private readyInfo: ServiceReadyInfo | undefined
  private ensuring: Promise<ServiceReadyInfo> | undefined
  private attachPromise: Promise<void> | undefined
  private attachToken: string | undefined
  private disposed = false
  private heartbeatTimer: NodeJS.Timeout | undefined
  private heartbeatInFlight = false
  private readonly heartbeatIntervalMs: number
  private readonly heartbeatTimeoutMs: number
  private readonly identity: MonitorBridgeIdentity
  private readonly extensionId: string
  private extensionsChangedDisposable: vscode.Disposable | undefined
  private logging: MonitorBridgeLoggingOptions
  private startupError: Error | undefined
  private readonly orchestrator: MonitorBridgeOrchestrator
  private readonly takeoverDecisionTimestamps = new Map<string, number>()
  private installedIdentity:
    | { version?: string; extensionPath?: string }
    | undefined

  private staleHostReloadPromptShown = false

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly resolveCliPath: () => Promise<string>,
    private readonly outputChannel: vscode.OutputChannel,
    options: MonitorBridgeServiceClientOptions = {}
  ) {
    const resolvedPort =
      typeof options.preferredPort === 'number'
        ? options.preferredPort
        : DEFAULT_BRIDGE_PORT
    if (
      Number.isInteger(resolvedPort) &&
      resolvedPort >= 0 &&
      resolvedPort <= 65_535
    ) {
      this.preferredPort = resolvedPort
    } else {
      this.preferredPort = DEFAULT_BRIDGE_PORT
    }
    this.heartbeatIntervalMs =
      typeof options.heartbeatIntervalMs === 'number' &&
      options.heartbeatIntervalMs > 0
        ? options.heartbeatIntervalMs
        : 0
    this.heartbeatTimeoutMs =
      typeof options.heartbeatTimeoutMs === 'number' &&
      options.heartbeatTimeoutMs > 0
        ? options.heartbeatTimeoutMs
        : 0
    this.identity = options.identity ?? {}
    this.extensionId = this.context.extension.id
    this.logging = options.logging ?? {}
    this.orchestrator = new MonitorBridgeOrchestrator({
      identity: this.identity,
      clientId: this.clientId,
    })
    this.refreshInstalledIdentity('startup')
    this.extensionsChangedDisposable = vscode.extensions.onDidChange(() => {
      this.refreshInstalledIdentity('extensions.onDidChange')
    })
  }

  async getBridgeInfo(): Promise<ServiceReadyInfo> {
    this.orchestrator.noteDemand()
    const ready = await this.ensureService()
    await this.ensureAttached(ready)
    await this.orchestrator.clearRestartLock(ready.port).catch(() => undefined)
    return ready
  }

  async updateLoggingOptions(
    options: MonitorBridgeLoggingOptions
  ): Promise<void> {
    this.logging = options
    const ready = this.readyInfo
    if (!ready) {
      return
    }
    const reachable = await this.isBridgeReachable(ready).catch(() => false)
    if (!reachable || !this.readyInfo) {
      return
    }
    try {
      await fetch(`${this.readyInfo.httpBaseUrl}/control/logging`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          heartbeat: options.heartbeat,
        }),
      })
    } catch (error) {
      this.logError('Failed to update monitor bridge logging', error)
    }
  }

  dispose(): void {
    this.disposed = true
    this.extensionsChangedDisposable?.dispose()
    this.extensionsChangedDisposable = undefined
    this.stopHeartbeat()
    this.detach().catch((error) => {
      this.logError('Failed to detach from monitor bridge service', error)
    })
  }

  private async ensureService(): Promise<ServiceReadyInfo> {
    this.refreshInstalledIdentity('ensure-service')
    if (!this.isInstalledVersionOwner()) {
      this.log('Skipping monitor bridge resolution: extension host is stale', {
        extensionId: this.extensionId,
        hostVersion: this.identity.version ?? 'unknown',
        hostExtensionPath: this.identity.extensionPath ?? 'unknown',
        installedVersion: this.installedIdentity?.version ?? 'unknown',
        installedExtensionPath:
          this.installedIdentity?.extensionPath ?? 'unknown',
      })
      const ready = await this.waitForInstalledOwnerBridge()
      if (ready) {
        this.log(
          'Stale extension host found active bridge from installed owner',
          {
            ownerPid: ready.ownerPid,
            port: ready.port,
            version: ready.version ?? 'unknown',
            extensionPath: ready.extensionPath ?? 'unknown',
          }
        )
        this.readyInfo = ready
        this.attachToken = undefined
        return ready
      }
      throw new Error(
        'Monitor bridge startup blocked: running extension host is stale and installed owner bridge did not become available in time'
      )
    }
    if (
      this.readyInfo &&
      (await this.isBridgeReachable(this.readyInfo).catch(() => false))
    ) {
      return this.readyInfo
    }
    if (this.ensuring) {
      return this.ensuring
    }
    this.ensuring = this.resolveService().finally(() => {
      this.ensuring = undefined
    })
    return this.ensuring
  }

  private async resolveService(): Promise<ServiceReadyInfo> {
    const reused = await this.tryPreferredPort()
    if (reused) {
      this.readyInfo = reused
      this.attachToken = undefined
      return reused
    }

    this.readyInfo = undefined
    const actualPort = await this.launchService(this.preferredPort)
    const portToProbe = actualPort > 0 ? actualPort : this.preferredPort
    let ready: ServiceReadyInfo
    try {
      ready = await this.waitForBridge(portToProbe)
    } catch (error) {
      this.log('Bridge startup failed after launch; evaluating recovery', {
        port: portToProbe,
        error: formatError(error),
      })
      const recovered = await this.tryRecoverStaleWindowsBridgeProcess(
        portToProbe,
        error
      )
      if (!recovered) {
        if (
          error instanceof Error &&
          /exited before startup/i.test(error.message)
        ) {
          this.logTakeoverDecision('retry', 'early-startup-exit', {
            port: this.preferredPort,
          })
          await delay(this.orchestrator.computeRetryBackoffMs())
          const owner = await this.fetchHealth(this.preferredPort).catch(
            () => undefined
          )
          if (owner) {
            this.logTakeoverDecision('retry-recheck', 'owner-observed', {
              ownerPid: owner.ownerPid,
              ownerVersion: owner.version,
              ownerExtensionPath: owner.extensionPath,
            })
            const handled = await this.handleVersionMismatch(owner)
            const reuseDecision = decideBridgeOwnerReuse(
              handled,
              this.isCompatibleBridge(owner),
              'retry-recheck'
            )
            if (reuseDecision.reuse) {
              this.readyInfo = owner
              this.attachToken = undefined
              await this.orchestrator
                .writeOwnerLease(owner, { takeover: false })
                .catch(() => undefined)
              return owner
            }
            if (
              reuseDecision.reason &&
              !reuseDecision.reason.endsWith('owner-incompatible')
            ) {
              this.logTakeoverDecision('skip', reuseDecision.reason, {
                policy: 'version-mismatch',
                runningPid: owner.ownerPid,
                runningVersion: owner.version,
                expectedVersion: this.identity.version,
                port: owner.port,
              })
            }
          }
          const retryPort = await this.launchService(this.preferredPort)
          const retryPortToProbe =
            retryPort > 0 ? retryPort : this.preferredPort
          ready = await this.waitForBridge(retryPortToProbe)
          if (ready.port > 0) {
            this.preferredPort = ready.port
          }
          this.readyInfo = ready
          this.attachToken = undefined
          return ready
        }
        this.log('Bridge recovery was not applied; rethrowing startup error', {
          port: portToProbe,
        })
        throw error
      }
      this.log('Bridge recovery applied; relaunching monitor bridge', {
        port: this.preferredPort,
      })
      const retryPort = await this.launchService(this.preferredPort)
      const retryPortToProbe = retryPort > 0 ? retryPort : this.preferredPort
      ready = await this.waitForBridge(retryPortToProbe)
    }
    if (ready.port > 0) {
      this.preferredPort = ready.port
    }
    this.readyInfo = ready
    this.attachToken = undefined
    return ready
  }

  private async tryRecoverStaleWindowsBridgeProcess(
    port: number,
    error: unknown
  ): Promise<boolean> {
    if (process.platform !== 'win32') {
      this.log('Skipping stale bridge recovery: platform is not win32', {
        platform: process.platform,
      })
      return false
    }
    if (port <= 0) {
      this.log('Skipping stale bridge recovery: invalid port', { port })
      return false
    }
    if (
      !(
        error instanceof BridgeInUseError ||
        (error instanceof Error &&
          /EADDRINUSE|address already in use|Timed out waiting for BoardLab monitor bridge startup|exited before startup/i.test(
            error.message
          ))
      )
    ) {
      this.log(
        'Skipping stale bridge recovery: startup error is not recoverable',
        {
          port,
          error: formatError(error),
        }
      )
      return false
    }

    this.log(
      'Windows bridge startup failed; checking port owner for recovery',
      {
        port,
        startupError: formatError(error),
      }
    )

    const takeoverDecision = await this.orchestrator.evaluateTakeoverPolicy(
      'stale-recovery',
      port
    )
    if (!takeoverDecision.allowed) {
      this.logTakeoverDecision('skip', takeoverDecision.reason, {
        policy: 'stale-recovery',
        port,
      })
      return false
    }

    const pid = await this.getWindowsPidForPort(port)
    if (!pid) {
      this.log('No Windows port owner PID found for recovery', { port })
      return false
    }
    const owner = await this.inspectWindowsProcess(pid)
    const ownerInfo: WindowsPortOwnerInfo = owner ? { pid, ...owner } : { pid }

    this.log('Resolved Windows port owner', {
      port,
      pid: ownerInfo.pid,
      name: ownerInfo.name,
      executablePath: ownerInfo.executablePath,
      commandLine: ownerInfo.commandLine,
    })

    if (!this.shouldTerminateStaleWindowsBridgeOwner(ownerInfo, port)) {
      this.log('Windows bridge port owner does not look stale, skipping stop', {
        port,
        pid: ownerInfo.pid,
        name: ownerInfo.name,
      })
      this.logTakeoverDecision('skip', 'owner-not-stale', {
        policy: 'stale-recovery',
        port,
        pid: ownerInfo.pid,
      })
      return false
    }

    this.logTakeoverDecision('kill', 'stale-owner-confirmed', {
      policy: 'stale-recovery',
      port,
      pid: ownerInfo.pid,
    })
    this.log('Stopping stale Windows monitor bridge process detected by port', {
      port,
      pid: ownerInfo.pid,
      name: ownerInfo.name,
    })

    const stopped = await this.stopBridgeProcess({
      ownerPid: ownerInfo.pid,
      port,
      wsUrl: '',
      httpBaseUrl: `http://${DEFAULT_BRIDGE_HOST}:${port}`,
      version: undefined,
      mode: undefined,
      extensionPath: ownerInfo.executablePath,
      commit: undefined,
      nodeVersion: undefined,
      platform: undefined,
      startedAt: undefined,
    })

    if (!stopped) {
      this.log('Failed to stop stale Windows monitor bridge process', {
        port,
        pid: ownerInfo.pid,
      })
      return false
    }

    this.log('Stopped stale Windows monitor bridge process; retrying startup', {
      port,
      pid: ownerInfo.pid,
    })
    this.orchestrator.noteTakeover()
    await this.orchestrator
      .writeOwnerLease(
        {
          ownerPid: ownerInfo.pid,
          port,
          wsUrl: '',
          httpBaseUrl: `http://${DEFAULT_BRIDGE_HOST}:${port}`,
        } as ServiceReadyInfo,
        { takeover: true }
      )
      .catch(() => undefined)
    this.startupError = undefined
    return true
  }

  private async tryPreferredPort(): Promise<ServiceReadyInfo | undefined> {
    const reused = await this.fetchHealth(this.preferredPort).catch((error) => {
      if (error instanceof BridgeInUseError) {
        throw error
      }
      return undefined
    })
    if (!reused) {
      return undefined
    }
    const handled = await this.handleVersionMismatch(reused)
    const reuseDecision = decideBridgeOwnerReuse(
      handled,
      this.isCompatibleBridge(reused),
      'preferred-port'
    )
    if (!reuseDecision.reuse) {
      if (
        reuseDecision.reason &&
        !reuseDecision.reason.endsWith('owner-incompatible')
      ) {
        this.logTakeoverDecision('skip', reuseDecision.reason, {
          policy: 'version-mismatch',
          runningPid: reused.ownerPid,
          runningVersion: reused.version,
          expectedVersion: this.identity.version,
          port: reused.port,
        })
      }
      return undefined
    }
    return reused
  }

  private async waitForBridge(port: number): Promise<ServiceReadyInfo> {
    if (port <= 0) {
      throw new Error('Invalid BoardLab monitor bridge port')
    }
    for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt++) {
      if (this.startupError) {
        this.log('Bridge startup error detected while waiting for health', {
          port,
          attempt: attempt + 1,
          startupError: formatError(this.startupError),
        })
        throw this.startupError
      }
      try {
        const ready = await this.fetchHealth(port)
        if (ready) {
          const handled = await this.handleVersionMismatch(ready, {
            startupWait: true,
          })
          const reuseDecision = decideBridgeOwnerReuse(
            handled,
            this.isCompatibleBridge(ready),
            'wait-for-bridge'
          )
          if (reuseDecision.reuse) {
            return ready
          }
          if (
            reuseDecision.reason &&
            !reuseDecision.reason.endsWith('owner-incompatible')
          ) {
            this.logTakeoverDecision('skip', reuseDecision.reason, {
              policy: 'version-mismatch',
              runningPid: ready.ownerPid,
              runningVersion: ready.version,
              expectedVersion: this.identity.version,
              port: ready.port,
            })
          }
        }
      } catch (error) {
        if (error instanceof BridgeInUseError) {
          throw error
        }
      }
      if (this.startupError) {
        this.log('Bridge startup error detected after health probe', {
          port,
          attempt: attempt + 1,
          startupError: formatError(this.startupError),
        })
        throw this.startupError
      }
      await delay(WAIT_DELAY_MS)
    }
    if (this.startupError) {
      throw this.startupError
    }
    const finalReady = await this.fetchHealth(port).catch(() => undefined)
    if (finalReady) {
      const finalHandled = await this.handleVersionMismatch(finalReady, {
        startupWait: true,
      })
      const finalReuseDecision = decideBridgeOwnerReuse(
        finalHandled,
        this.isCompatibleBridge(finalReady),
        'wait-for-bridge'
      )
      if (finalReuseDecision.reuse) {
        return finalReady
      }
    }
    throw new Error('Timed out waiting for BoardLab monitor bridge startup')
  }

  private async fetchHealth(
    port: number
  ): Promise<ServiceReadyInfo | undefined> {
    if (port <= 0) {
      return undefined
    }
    const httpBaseUrl = `http://${DEFAULT_BRIDGE_HOST}:${port}`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    try {
      const res = await fetch(`${httpBaseUrl}/control/health`, {
        method: 'POST',
        signal: controller.signal,
        headers: { accept: 'application/json' },
      })

      if (!res.ok) {
        if (res.status === 404 || res.status === 501) {
          throw new BridgeInUseError(port, `unexpected-status-${res.status}`)
        }
        return undefined
      }

      const payload: any = await res.json().catch(() => undefined)
      if (
        !payload ||
        typeof payload !== 'object' ||
        payload.status !== 'ok' ||
        typeof payload.attachments !== 'number'
      ) {
        throw new BridgeInUseError(port, 'unexpected-response')
      }

      const wsUrl = `ws://${DEFAULT_BRIDGE_HOST}:${port}/serial`
      const payloadPort =
        typeof payload.port === 'number' && Number.isFinite(payload.port)
          ? payload.port
          : port
      const pid =
        typeof payload.pid === 'number' && Number.isFinite(payload.pid)
          ? payload.pid
          : 0
      const startedAt =
        typeof payload.startedAt === 'string' ? payload.startedAt : undefined
      const version =
        typeof payload.version === 'string' ? payload.version : undefined
      const mode = typeof payload.mode === 'string' ? payload.mode : undefined
      const extensionPath =
        typeof payload.extensionPath === 'string'
          ? payload.extensionPath
          : undefined
      const commit =
        typeof payload.commit === 'string' ? payload.commit : undefined
      const nodeVersion =
        typeof payload.nodeVersion === 'string'
          ? payload.nodeVersion
          : undefined
      const platform =
        typeof payload.platform === 'string' ? payload.platform : undefined

      return {
        ownerPid: pid,
        port: payloadPort,
        wsUrl,
        httpBaseUrl,
        startedAt,
        version,
        mode,
        extensionPath,
        commit,
        nodeVersion,
        platform,
      }
    } catch (error) {
      // Used by a 3rd party process
      if (error instanceof BridgeInUseError) {
        throw error
      }

      // Timeout or aborted
      if (
        error instanceof Error &&
        'name' in error &&
        (error as any).name === 'AbortError'
      ) {
        return undefined
      }

      // Connection error
      if (typeof error === 'object' && error && 'code' in error) {
        const code = (error as any).code
        if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH') {
          return undefined
        }
      }
      if (error instanceof TypeError && error.message === 'fetch failed') {
        return undefined
      }

      // Unknown error
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  private async waitForInstalledOwnerBridge(): Promise<
    ServiceReadyInfo | undefined
  > {
    for (let attempt = 0; attempt < STALE_HOST_WAIT_ATTEMPTS; attempt++) {
      if (this.disposed) {
        return undefined
      }
      const ready = await this.fetchHealth(this.preferredPort).catch(
        () => undefined
      )
      if (ready) {
        return ready
      }
      if (attempt === 0 || (attempt + 1) % 8 === 0) {
        this.log('Waiting for installed owner bridge to become available', {
          attempt: attempt + 1,
          maxAttempts: STALE_HOST_WAIT_ATTEMPTS,
          port: this.preferredPort,
        })
      }
      await delay(STALE_HOST_WAIT_DELAY_MS)
    }
    this.log('Timed out waiting for installed owner bridge', {
      maxAttempts: STALE_HOST_WAIT_ATTEMPTS,
      delayMs: STALE_HOST_WAIT_DELAY_MS,
      port: this.preferredPort,
    })
    return undefined
  }

  private isCompatibleBridge(info: ServiceReadyInfo): boolean {
    return this.orchestrator.isCompatibleBridge(info)
  }

  private async handleVersionMismatch(
    info: ServiceReadyInfo,
    options: { startupWait?: boolean } = {}
  ): Promise<'none' | 'killed'> {
    if (!this.isInstalledVersionOwner()) {
      this.logTakeoverDecision('skip', 'host-version-not-installed', {
        policy: 'version-mismatch',
        runningPid: info.ownerPid,
        runningVersion: info.version,
        expectedVersion: this.identity.version,
        port: info.port,
        installedVersion: this.installedIdentity?.version,
      })
      return 'none'
    }
    if (this.isCompatibleBridge(info)) {
      await this.orchestrator
        .writeOwnerLease(info, { takeover: false })
        .catch(() => undefined)
      return 'none'
    }

    const takeoverDecision = await this.orchestrator.evaluateTakeoverPolicy(
      'version-mismatch',
      info.port
    )
    if (
      !takeoverDecision.allowed &&
      options.startupWait &&
      shouldBypassTakeoverPolicyForStartupWait(takeoverDecision.reason)
    ) {
      this.logTakeoverDecision('retry', 'startup-wait-policy-override', {
        policy: 'version-mismatch',
        blockedReason: takeoverDecision.reason,
        runningPid: info.ownerPid,
        runningVersion: info.version,
        expectedVersion: this.identity.version,
        port: info.port,
      })
    } else if (!takeoverDecision.allowed) {
      this.logTakeoverDecision('skip', takeoverDecision.reason, {
        policy: 'version-mismatch',
        runningPid: info.ownerPid,
        runningVersion: info.version,
        expectedVersion: this.identity.version,
        port: info.port,
      })
      return 'none'
    }

    const restartLock = await this.orchestrator.tryAcquireRestartLock(
      info.port,
      this.identity.version
    )
    if (!restartLock.acquired) {
      this.logTakeoverDecision('skip', restartLock.reason, {
        policy: 'version-mismatch',
        runningPid: info.ownerPid,
        runningVersion: info.version,
        expectedVersion: this.identity.version,
        port: info.port,
      })
      this.promptReloadForStaleHost()
      return 'none'
    }

    this.log('Found monitor bridge version mismatch, restarting bridge', {
      pid: info.ownerPid,
      port: info.port,
      runningVersion: info.version ?? 'unknown',
      expectedVersion: this.identity.version ?? 'unknown',
      runningExtensionPath: info.extensionPath ?? 'unknown',
      expectedExtensionPath: this.identity.extensionPath ?? 'unknown',
      runningCommit: info.commit ?? 'unknown',
      expectedCommit: this.identity.commit ?? 'unknown',
    })
    this.logTakeoverDecision('kill', 'version-mismatch', {
      policy: 'version-mismatch',
      runningPid: info.ownerPid,
      runningVersion: info.version,
      expectedVersion: this.identity.version,
      port: info.port,
    })
    const stopped = await this.stopBridgeProcess(info)
    if (!stopped) {
      await this.orchestrator.clearRestartLock(info.port).catch(() => undefined)
      throw new BridgeInUseError(
        info.port,
        `failed-to-stop-existing-bridge-pid-${info.ownerPid || 'unknown'}`
      )
    }
    this.orchestrator.noteTakeover()
    await this.orchestrator
      .writeOwnerLease(info, { takeover: true })
      .catch(() => undefined)
    return 'killed'
  }

  private async stopBridgeProcess(info: ServiceReadyInfo): Promise<boolean> {
    if (!info.ownerPid || info.ownerPid === process.pid) {
      this.log('Refusing to stop monitor bridge process', {
        pid: info.ownerPid,
      })
      return false
    }
    const pid = info.ownerPid
    this.log('Stopping monitor bridge process', {
      pid,
      port: info.port,
      version: info.version,
    })
    if (process.platform === 'win32') {
      this.log('Attempting to stop monitor bridge with fkill', {
        pid,
        force: false,
      })
      const terminatedWithFkill = await this.killProcessWithFkill(pid, false)
      if (terminatedWithFkill) {
        this.log('Stopped monitor bridge with fkill', { pid, force: false })
        return true
      }
      this.log('fkill graceful stop did not terminate process; escalating', {
        pid,
      })
      this.log('Attempting to stop monitor bridge with fkill', {
        pid,
        force: true,
      })
      const forceTerminatedWithFkill = await this.killProcessWithFkill(
        pid,
        true
      )
      if (forceTerminatedWithFkill) {
        this.log('Stopped monitor bridge with fkill', { pid, force: true })
        return true
      }
      this.log('fkill forced stop did not terminate process; using signals', {
        pid,
      })
    }
    try {
      process.kill(pid, 'SIGTERM')
      this.log('Sent SIGTERM to monitor bridge process', { pid })
    } catch (error) {
      const code = getErrnoCode(error)
      if (code === 'ESRCH') {
        return true
      }
      this.logError('Failed to stop monitor bridge process', error)
      return false
    }

    if (await this.waitForProcessExit(pid)) {
      return true
    }

    this.log('Monitor bridge did not exit after SIGTERM; sending SIGKILL', {
      pid,
    })
    try {
      process.kill(pid, 'SIGKILL')
      this.log('Sent SIGKILL to monitor bridge process', { pid })
    } catch (error) {
      const code = getErrnoCode(error)
      if (code === 'ESRCH') {
        return true
      }
      this.logError('Failed to SIGKILL monitor bridge process', error)
      return false
    }
    const terminated = await this.waitForProcessExit(pid)
    if (!terminated) {
      if (process.platform === 'win32') {
        this.log('Monitor bridge still alive after SIGKILL; retrying fkill', {
          pid,
        })
        this.log('Attempting to stop monitor bridge with fkill', {
          pid,
          force: true,
        })
        const forceTerminatedWithFkill = await this.killProcessWithFkill(
          pid,
          true
        )
        if (forceTerminatedWithFkill) {
          this.log('Stopped monitor bridge with fkill', { pid, force: true })
          return true
        }
      }
      this.log('Monitor bridge process is still alive after SIGKILL', { pid })
    }
    return terminated
  }

  private async waitForProcessExit(
    pid: number,
    timeoutMs = 3_000
  ): Promise<boolean> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const running = this.isProcessRunning(pid)
      if (!running) {
        return true
      }
      await delay(100)
    }
    return !this.isProcessRunning(pid)
  }

  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      const code = getErrnoCode(error)
      if (code === 'ESRCH') {
        return false
      }
      if (code === 'EPERM') {
        return true
      }
      throw error
    }
  }

  private async launchService(port: number): Promise<number> {
    this.startupError = undefined
    const cliPath = await this.resolveCliPath()
    const entry = this.serviceEntryPoint
    const args = [
      entry,
      '--cli-path',
      cliPath,
      '--port',
      String(port),
      '--heartbeat-timeout-ms',
      String(this.heartbeatTimeoutMs),
    ]
    if (this.identity.version) {
      args.push('--boardlab-version', this.identity.version)
    }
    if (this.identity.extensionPath) {
      args.push('--extension-path', this.identity.extensionPath)
    }
    if (this.identity.mode) {
      args.push('--bridge-mode', this.identity.mode)
    } else {
      args.push('--bridge-mode', DEFAULT_BRIDGE_MODE)
    }
    if (this.identity.commit) {
      args.push('--boardlab-commit', this.identity.commit)
    }
    if (this.logging.heartbeat) {
      args.push('--log-heartbeat')
    }

    this.log('Launching monitor bridge service', {
      entry,
      cliPath,
      port,
    })

    try {
      const child = spawn(process.execPath, args, {
        detached: false, // TODO: change to true when ready
        stdio: 'pipe', // // TODO: change to ignore when ready
      })
      this.log('Launched monitor bridge service', { pid: child.pid })
      child.stdout?.on('data', (chunk) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        this.log('monitor bridge service stdout', {
          pid: child.pid,
          port,
          message: text.trim(),
        })
      })
      child.stderr?.on('data', (chunk) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        this.log('monitor bridge service stderr', {
          pid: child.pid,
          port,
          message: text.trim(),
        })
        if (
          !this.startupError &&
          /EADDRINUSE|address already in use/i.test(text)
        ) {
          this.startupError = new BridgeInUseError(
            port,
            'address-already-in-use'
          )
        }
      })
      child.on('error', (error) => {
        if (!this.startupError) {
          this.startupError =
            error instanceof Error ? error : new Error(String(error))
        }
        this.logError('monitor bridge service process error', error)
      })
      child.on('exit', (code, signal) => {
        if (!this.startupError && !this.readyInfo && code && code !== 0) {
          const reason = signal ? `signal-${signal}` : `exit-code-${code}`
          this.startupError = new Error(
            `Monitor bridge service exited before startup (${reason})`
          )
        }
        this.log('monitor bridge service process exited', { code, signal })
      })
      // child.unref() // TODO: uncomment when ready
    } catch (error) {
      throw new Error(
        `Failed to launch monitor bridge service: ${String(error)}`
      )
    }
    return port
  }

  private get serviceEntryPoint(): string {
    const extensionRoot = this.context.extensionPath
    if (this.context.extensionMode !== vscode.ExtensionMode.Production) {
      return path.join(
        extensionRoot,
        'out',
        'portino-bridge',
        'out',
        'serviceMain.js'
      )
    }
    return path.join(extensionRoot, 'dist', 'portino-bridge', 'serviceMain.js')
  }

  private async ensureAttached(info: ServiceReadyInfo): Promise<void> {
    if (this.attachToken) {
      this.startHeartbeat(info)
      return
    }
    if (this.attachPromise) {
      await this.attachPromise
      return
    }
    this.attachPromise = this.performAttach(info).finally(() => {
      this.attachPromise = undefined
    })
    await this.attachPromise
  }

  private async performAttach(info: ServiceReadyInfo): Promise<void> {
    if (this.disposed) {
      return
    }
    try {
      const response = await fetch(`${info.httpBaseUrl}/control/attach`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ clientId: this.clientId }),
      })
      if (!response.ok) {
        throw new Error(`Unexpected status ${response.status}`)
      }
      const data = (await response.json()) as AttachResponse
      this.attachToken = data.token
      await this.orchestrator
        .writeOwnerLease(info, { takeover: false })
        .catch(() => undefined)
      this.startHeartbeat(info)
    } catch (error) {
      this.attachToken = undefined
      this.readyInfo = undefined
      throw new Error(
        `Failed to attach to monitor bridge service: ${String(error)}`
      )
    }
  }

  private async detach(): Promise<void> {
    if (!this.attachToken || !this.readyInfo) {
      return
    }
    const token = this.attachToken
    const { httpBaseUrl } = this.readyInfo
    this.attachToken = undefined
    this.stopHeartbeat()
    try {
      await fetch(`${httpBaseUrl}/control/detach`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ token }),
      })
    } catch (error) {
      this.logError('Failed to notify monitor bridge service detach', error)
    }
  }

  private startHeartbeat(info: ServiceReadyInfo): void {
    if (this.heartbeatIntervalMs <= 0 || this.heartbeatTimeoutMs <= 0) {
      return
    }
    if (this.heartbeatTimer) {
      return
    }
    const interval = this.heartbeatIntervalMs
    this.heartbeatTimer = setInterval(() => {
      if (this.disposed) {
        this.stopHeartbeat()
        return
      }
      const token = this.attachToken
      const ready = this.readyInfo ?? info
      if (!token || !ready) {
        this.stopHeartbeat()
        return
      }
      this.sendHeartbeat(ready.httpBaseUrl, token).catch((error) => {
        this.logError('Monitor bridge heartbeat failed', error)
      })
    }, interval)
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) {
      return
    }
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
    this.heartbeatInFlight = false
  }

  private async sendHeartbeat(
    httpBaseUrl: string,
    token: string
  ): Promise<void> {
    if (this.heartbeatInFlight) {
      return
    }
    this.heartbeatInFlight = true
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      HEARTBEAT_REQUEST_TIMEOUT_MS
    )
    try {
      const response = await fetch(`${httpBaseUrl}/control/heartbeat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ token }),
        signal: controller.signal,
      })
      if (response.status === 404) {
        this.attachToken = undefined
        this.stopHeartbeat()
        return
      }
      if (!response.ok) {
        this.log('Monitor bridge heartbeat rejected', {
          status: response.status,
        })
      } else {
        const runtimeInfo: MonitorBridgeRuntimeSnapshot = {
          ownerPid: this.readyInfo?.ownerPid ?? process.pid,
          port: this.readyInfo?.port ?? this.preferredPort,
          version: this.readyInfo?.version,
          extensionPath: this.readyInfo?.extensionPath,
          mode: this.readyInfo?.mode,
          commit: this.readyInfo?.commit,
        }
        await this.orchestrator
          .writeOwnerLease(runtimeInfo, { heartbeat: true, takeover: false })
          .catch(() => undefined)
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return
      }
      if (!this.disposed) {
        this.attachToken = undefined
        this.stopHeartbeat()
        throw error
      }
    } finally {
      clearTimeout(timeout)
      this.heartbeatInFlight = false
    }
  }

  private async isBridgeReachable(info: ServiceReadyInfo): Promise<boolean> {
    try {
      const result = await this.fetchHealth(info.port)
      if (!result) {
        return false
      }
      this.readyInfo = result
      return true
    } catch (error) {
      if (error instanceof BridgeInUseError) {
        throw error
      }
      return false
    }
  }

  private log(message: string, data?: unknown): void {
    this.outputChannel.appendLine(formatLog(message, data))
  }

  private logError(message: string, error: unknown): void {
    this.outputChannel.appendLine(`${message} ${formatError(error)}`)
  }

  private async getWindowsPidForPort(
    port: number
  ): Promise<number | undefined> {
    if (process.platform !== 'win32' || port <= 0) {
      return undefined
    }
    try {
      this.log('Looking up Windows PID by bridge port', { port })
      const pid = await portToPid({ port, host: '*' })
      const valid = Number.isInteger(pid) && (pid ?? 0) > 0
      this.log('Windows PID lookup result', {
        port,
        pid: valid ? pid : undefined,
      })
      return valid ? pid : undefined
    } catch (error) {
      this.logError('Failed resolving PID by port with pid-port', error)
      return undefined
    }
  }

  private async killProcessWithFkill(
    pid: number,
    force: boolean
  ): Promise<boolean> {
    if (pid <= 0 || pid === process.pid) {
      this.log('Skipping fkill: invalid target PID', {
        pid,
        currentPid: process.pid,
      })
      return false
    }
    try {
      this.log('Invoking fkill for monitor bridge process', { pid, force })
      await kill(pid, force)
    } catch (error) {
      if (
        !force &&
        error instanceof Error &&
        /Failed to kill processes/i.test(error.message)
      ) {
        this.log('fkill graceful attempt did not terminate target process', {
          pid,
        })
        return false
      }
      this.logError('Failed to stop monitor bridge process with fkill', error)
      return false
    }

    const timeoutMs = force ? 5_000 : 2_500
    const stopped = await this.waitForProcessExit(pid, timeoutMs)
    if (!stopped) {
      this.log('Process still running after fkill', { pid, force })
    }
    return stopped
  }

  private logTakeoverDecision(
    action: 'skip' | 'kill' | 'retry' | 'retry-recheck',
    reason: string,
    data?: Record<string, unknown>
  ): void {
    const payload = {
      action,
      reason,
      port: this.preferredPort,
      expectedVersion: this.identity.version ?? 'unknown',
      expectedExtensionPath: this.identity.extensionPath ?? 'unknown',
      ...data,
    }
    const signature = JSON.stringify(payload)
    const now = Date.now()
    const previous = this.takeoverDecisionTimestamps.get(signature)
    if (
      previous !== undefined &&
      now - previous < TAKEOVER_DECISION_DEDUPE_MS
    ) {
      return
    }
    this.takeoverDecisionTimestamps.set(signature, now)
    if (this.takeoverDecisionTimestamps.size > 128) {
      for (const [key, timestamp] of this.takeoverDecisionTimestamps) {
        if (now - timestamp > TAKEOVER_DECISION_DEDUPE_RETENTION_MS) {
          this.takeoverDecisionTimestamps.delete(key)
        }
      }
    }
    this.log('takeover_decision', payload)
  }

  private refreshInstalledIdentity(
    reason: 'startup' | 'extensions.onDidChange' | 'ensure-service'
  ): void {
    const extension = vscode.extensions.getExtension(this.extensionId)
    const apiVersion =
      typeof extension?.packageJSON?.version === 'string'
        ? extension.packageJSON.version
        : undefined
    const apiExtensionPath = extension?.extensionPath
    const fsDetected = this.detectInstalledIdentityFromFilesystem()
    const shouldUseFilesystem =
      !!fsDetected?.extensionPath &&
      toComparableExtensionPath(fsDetected.extensionPath) !==
        toComparableExtensionPath(apiExtensionPath)
    const installedVersion = shouldUseFilesystem
      ? fsDetected?.version
      : apiVersion
    const installedExtensionPath = shouldUseFilesystem
      ? fsDetected?.extensionPath
      : apiExtensionPath
    this.installedIdentity = {
      version: installedVersion,
      extensionPath: installedExtensionPath,
    }
    const owner = this.isInstalledVersionOwner()
    this.log('Resolved installed BoardLab extension identity', {
      reason,
      extensionId: this.extensionId,
      hostVersion: this.identity.version ?? 'unknown',
      hostExtensionPath: this.identity.extensionPath ?? 'unknown',
      installedVersion: installedVersion ?? 'unknown',
      installedExtensionPath: installedExtensionPath ?? 'unknown',
      installedSource: shouldUseFilesystem ? 'filesystem' : 'vscode.extensions',
      vscodeApiVersion: apiVersion ?? 'unknown',
      vscodeApiExtensionPath: apiExtensionPath ?? 'unknown',
      filesystemVersion: fsDetected?.version ?? 'unknown',
      filesystemExtensionPath: fsDetected?.extensionPath ?? 'unknown',
      owner,
    })
    if (!owner && reason !== 'startup') {
      this.promptReloadForStaleHost()
    }
  }

  private detectInstalledIdentityFromFilesystem():
    | { version?: string; extensionPath?: string }
    | undefined {
    const extensionRoot = path.dirname(this.context.extensionPath)
    if (!extensionRoot) {
      return undefined
    }
    const prefix = `${this.extensionId.toLowerCase()}-`
    try {
      const candidates = fs
        .readdirSync(extensionRoot, { withFileTypes: true })
        .filter((entry) => {
          return (
            entry.isDirectory() && entry.name.toLowerCase().startsWith(prefix)
          )
        })
        .map((entry) => {
          const extensionPath = path.join(extensionRoot, entry.name)
          const stats = fs.statSync(extensionPath)
          return {
            extensionPath,
            mtimeMs: stats.mtimeMs,
          }
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs)

      const selected = candidates[0]
      if (!selected) {
        return undefined
      }
      let version: string | undefined
      try {
        const packageJsonPath = path.join(
          selected.extensionPath,
          'package.json'
        )
        const packageJsonText = fs.readFileSync(packageJsonPath, 'utf8')
        const packageJson = JSON.parse(packageJsonText) as { version?: unknown }
        if (typeof packageJson.version === 'string') {
          version = packageJson.version
        }
      } catch {
        // ignore parse/IO errors and fallback to path-only identity
      }
      return {
        version,
        extensionPath: selected.extensionPath,
      }
    } catch {
      return undefined
    }
  }

  private isInstalledVersionOwner(): boolean {
    const installedVersion = this.installedIdentity?.version
    const hostVersion = this.identity.version
    if (installedVersion && hostVersion && installedVersion !== hostVersion) {
      return false
    }
    const installedPath = toComparableExtensionPath(
      this.installedIdentity?.extensionPath
    )
    const hostPath = toComparableExtensionPath(this.identity.extensionPath)
    if (installedPath && hostPath && installedPath !== hostPath) {
      return false
    }
    return true
  }

  private promptReloadForStaleHost(): void {
    if (this.staleHostReloadPromptShown || this.disposed) {
      return
    }
    this.staleHostReloadPromptShown = true
    vscode.window
      .showWarningMessage(
        'BoardLab update detected. This window is running an older extension host. Reload to finish switching monitor bridge ownership.',
        'Reload Window'
      )
      .then((selection) => {
        if (selection === 'Reload Window') {
          vscode.commands.executeCommand('workbench.action.reloadWindow')
        }
      })
  }

  private async inspectWindowsProcess(
    pid: number
  ): Promise<Omit<WindowsPortOwnerInfo, 'pid'> | undefined> {
    if (process.platform !== 'win32' || pid <= 0) {
      return undefined
    }
    const script = [
      `$pid = ${pid}`,
      '$p = Get-CimInstance Win32_Process -Filter "ProcessId=$pid"',
      'if (-not $p) { return }',
      '[pscustomobject]@{',
      '  name = $p.Name',
      '  commandLine = $p.CommandLine',
      '  executablePath = $p.ExecutablePath',
      '} | ConvertTo-Json -Compress',
    ].join('; ')

    const stdout = await this.execFileText('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ]).catch((execError) => {
      this.log('Failed to inspect Windows process details', {
        pid,
        error: formatError(execError),
      })
      return ''
    })

    const text = stdout.trim()
    if (!text) {
      return undefined
    }

    try {
      const row = JSON.parse(text) as {
        name?: unknown
        commandLine?: unknown
        executablePath?: unknown
      }
      return {
        name: typeof row.name === 'string' ? row.name : undefined,
        commandLine:
          typeof row.commandLine === 'string' ? row.commandLine : undefined,
        executablePath:
          typeof row.executablePath === 'string'
            ? row.executablePath
            : undefined,
      }
    } catch (parseError) {
      this.log('Failed to parse Windows process payload', {
        pid,
        payload: text,
        error: formatError(parseError),
      })
      return undefined
    }
  }

  private shouldTerminateStaleWindowsBridgeOwner(
    owner: WindowsPortOwnerInfo,
    port: number
  ): boolean {
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) {
      return false
    }
    if (owner.pid === process.pid) {
      return false
    }

    const commandLine = this.normalizeForMatch(owner.commandLine)
    if (!commandLine) {
      return false
    }
    if (
      !commandLine.includes('boardlab') ||
      !commandLine.includes('portino-bridge') ||
      !commandLine.includes('servicemain.js')
    ) {
      return false
    }
    if (!commandLine.includes(`--port ${port}`)) {
      return false
    }

    const expectedExtensionPath = this.normalizeForMatch(
      this.identity.extensionPath
    )
    if (!expectedExtensionPath) {
      return false
    }

    const ownerMatchesCurrentPath = commandLine.includes(expectedExtensionPath)
    if (!ownerMatchesCurrentPath) {
      return true
    }

    const expectedVersion = this.normalizeForMatch(this.identity.version)
    if (!expectedVersion) {
      return false
    }
    return !commandLine.includes(`--boardlab-version ${expectedVersion}`)
  }

  private normalizeForMatch(value: string | undefined): string {
    if (!value) {
      return ''
    }
    return value.replace(/\//g, '\\').toLowerCase()
  }

  private async execFileText(
    command: string,
    args: readonly string[],
    timeoutMs = 5_000
  ): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      execFile(
        command,
        [...args],
        {
          encoding: 'utf8',
          windowsHide: true,
          timeout: timeoutMs,
          maxBuffer: 1_000_000,
        },
        (error, stdout, stderr) => {
          if (error) {
            const output = String(stdout ?? '').trim()
            if (output) {
              resolve(output)
              return
            }
            const message = String(stderr ?? '').trim()
            reject(new Error(message || String(error)))
            return
          }
          resolve(String(stdout ?? ''))
        }
      )
    })
  }
}

export interface MonitorManagerOptions {
  readonly serviceClientOptions?: MonitorBridgeServiceClientOptions
  readonly serviceClientFactory?: (
    context: vscode.ExtensionContext,
    resolver: () => Promise<string>,
    outputChannel: vscode.OutputChannel,
    clientOptions: MonitorBridgeServiceClientOptions
  ) => MonitorBridgeServiceClient
  readonly bridgeClientFactory?: (
    clientOptions: MonitorBridgeClientOptions
  ) => MonitorBridgeClient
}

export class MonitorManager implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = []
  private readonly clientSessions = new Map<string, MessageParticipant>()
  private readonly clientPorts = new Map<string, string>()
  private readonly portSessions = new Map<string, MonitorPortSession>()
  private readonly sessionSnapshots = new Map<string, MonitorSessionState>()
  private readonly monitorSessionIds = new Map<string, string>()
  private readonly runningMonitors = new Map<
    string,
    { port: PortIdentifier; baudrate?: string }
  >()

  private readonly externalMonitorClientIds = new Set<string>()

  private readonly physicalStates = new MonitorPhysicalStateRegistry()
  private readonly logicalTracker = new MonitorLogicalTracker()
  private readonly monitorStates = new Map<string, MonitorRuntimeState>()
  private readonly selectedBaudrateCache = new Map<string, string>()
  private readonly onDidChangeMonitorStateEmitter =
    new vscode.EventEmitter<MonitorStateChangeEvent>()

  private readonly onDidReceiveMonitorDataEmitter = new vscode.EventEmitter<{
    port: PortIdentifier
    data: Uint8Array
  }>()

  private readonly onDidChangeRunningMonitorsEmitter = new vscode.EventEmitter<
    ReadonlyArray<{ port: PortIdentifier; baudrate?: string }>
  >()

  readonly onDidChangeMonitorState = this.onDidChangeMonitorStateEmitter.event
  readonly onDidReceiveMonitorData = this.onDidReceiveMonitorDataEmitter.event

  readonly onDidChangeRunningMonitors =
    this.onDidChangeRunningMonitorsEmitter.event

  private bridgeEventsRegistered = false
  private bridgeConflictNotified = false
  private monitorSettingsByProtocol: MonitorSettingsByProtocol = {
    protocols: {},
  }

  private selectionResolver:
    | ((
        sender?: MessageParticipant
      ) => MonitorSelectionNotification | Promise<MonitorSelectionNotification>)
    | undefined

  private readonly bridgeLogChannel: vscode.OutputChannel
  private serviceClient: MonitorBridgeServiceClient
  private bridgeClient: MonitorBridgeClient
  private readonly externalHttpStreams = new Map<
    string,
    {
      portKey: string
      abortController: AbortController
      task: Promise<void>
    }
  >()

  private readonly clientChannels = new Map<string, ReadonlyArray<string>>()
  private readonly outputChannel: vscode.OutputChannel

  private detectedPorts: DetectedPorts = {}

  constructor(
    context: vscode.ExtensionContext,
    private readonly cliContext: CliContext,
    private readonly messenger: Messenger,
    outputChannel: vscode.OutputChannel,
    options: MonitorManagerOptions = {}
  ) {
    this.outputChannel = outputChannel
    this.bridgeLogChannel = vscode.window.createOutputChannel(
      'BoardLab - Monitor Bridge',
      { log: true }
    )
    this.disposables.push(this.bridgeLogChannel)
    const configuration = vscode.workspace.getConfiguration('boardlab.monitor')
    const configuredPort = configuration.get<number>('bridgePort', 0)
    const preferredPort =
      configuredPort > 0 ? configuredPort : DEFAULT_BRIDGE_PORT
    const configuredHeartbeatInterval = configuration.get<number>(
      'bridgeHeartbeatIntervalMs',
      DEFAULT_HEARTBEAT_INTERVAL_MS
    )
    const configuredHeartbeatTimeout = configuration.get<number>(
      'bridgeHeartbeatTimeoutMs',
      DEFAULT_HEARTBEAT_TIMEOUT_MS
    )
    const configuredLogHeartbeat = configuration.get<boolean>(
      'bridgeLogHeartbeat',
      false
    )
    let heartbeatIntervalMs =
      typeof configuredHeartbeatInterval === 'number' &&
      Number.isFinite(configuredHeartbeatInterval)
        ? Math.max(0, configuredHeartbeatInterval)
        : DEFAULT_HEARTBEAT_INTERVAL_MS
    let heartbeatTimeoutMs =
      typeof configuredHeartbeatTimeout === 'number' &&
      Number.isFinite(configuredHeartbeatTimeout)
        ? Math.max(0, configuredHeartbeatTimeout)
        : DEFAULT_HEARTBEAT_TIMEOUT_MS
    if (heartbeatIntervalMs <= 0 || heartbeatTimeoutMs <= 0) {
      heartbeatIntervalMs = 0
      heartbeatTimeoutMs = 0
    }

    const overrides = options.serviceClientOptions ?? {}
    const resolvedHeartbeatInterval =
      typeof overrides.heartbeatIntervalMs === 'number' &&
      Number.isFinite(overrides.heartbeatIntervalMs)
        ? Math.max(0, overrides.heartbeatIntervalMs)
        : heartbeatIntervalMs
    const resolvedHeartbeatTimeout =
      typeof overrides.heartbeatTimeoutMs === 'number' &&
      Number.isFinite(overrides.heartbeatTimeoutMs)
        ? Math.max(0, overrides.heartbeatTimeoutMs)
        : heartbeatTimeoutMs
    const heartbeatDisabled =
      resolvedHeartbeatInterval <= 0 || resolvedHeartbeatTimeout <= 0
    const effectiveHeartbeatInterval = heartbeatDisabled
      ? 0
      : resolvedHeartbeatInterval
    const effectiveHeartbeatTimeout = heartbeatDisabled
      ? 0
      : resolvedHeartbeatTimeout
    const resolvedLogHeartbeat =
      typeof overrides.logging?.heartbeat === 'boolean'
        ? overrides.logging.heartbeat
        : typeof configuredLogHeartbeat === 'boolean'
          ? configuredLogHeartbeat
          : false
    const baseIdentity = resolveBridgeIdentity(context)
    const resolvedIdentity = {
      ...baseIdentity,
      ...(overrides.identity ?? {}),
      mode: overrides.identity?.mode ?? DEFAULT_BRIDGE_MODE,
    }

    const serviceClientOptions: MonitorBridgeServiceClientOptions = {
      preferredPort:
        overrides.preferredPort !== undefined
          ? overrides.preferredPort
          : preferredPort,
      heartbeatIntervalMs: effectiveHeartbeatInterval,
      heartbeatTimeoutMs: effectiveHeartbeatTimeout,
      identity: resolvedIdentity,
      logging: {
        heartbeat: resolvedLogHeartbeat,
      },
    }

    const serviceClientFactory =
      options.serviceClientFactory ??
      ((ctx, resolver, channel, clientOptions) =>
        new MonitorBridgeServiceClient(ctx, resolver, channel, clientOptions))

    this.serviceClient = serviceClientFactory(
      context,
      async () => this.cliContext.resolveExecutablePath(),
      outputChannel,
      serviceClientOptions
    )
    this.disposables.push(this.serviceClient)

    const bridgeClientFactory =
      options.bridgeClientFactory ??
      ((clientOptions: MonitorBridgeClientOptions) =>
        new MonitorBridgeClient(clientOptions))

    this.bridgeClient = bridgeClientFactory({
      resolveBridgeInfo: async () => this.serviceClient.getBridgeInfo(),
    })
    this.disposables.push(this.bridgeClient)
    this.disposables.push(
      this.bridgeClient.onBridgeLog((entry) => this.handleBridgeLog(entry))
    )
    this.disposables.push(this.physicalStates)
    this.disposables.push(this.onDidChangeMonitorStateEmitter)
    this.disposables.push(this.onDidChangeRunningMonitorsEmitter)
    this.disposables.push(this.onDidReceiveMonitorDataEmitter)
    this.disposables.push(
      messenger.onRequest(getMonitorBridgeInfo, async (_params, sender) =>
        this.handleGetBridgeInfo(sender)
      )
    )
    this.disposables.push(
      messenger.onRequest(connectMonitorClient, (params, sender) =>
        this.handleConnectMonitorClient(params, sender)
      )
    )
    this.disposables.push(
      messenger.onNotification(disconnectMonitorClient, (params, sender) => {
        this.handleDisconnectMonitorClient(params, sender)
      })
    )
    this.disposables.push(
      messenger.onNotification(notifyMonitorClientAttached, (params, sender) =>
        this.handleClientAttached(params, sender)
      )
    )
    this.disposables.push(
      messenger.onNotification(notifyMonitorClientDetached, (params, sender) =>
        this.handleClientDetached(params, sender)
      )
    )
    this.disposables.push(
      messenger.onNotification(notifyMonitorIntentStart, (params, sender) =>
        this.handleMonitorIntentStart(params, sender)
      )
    )
    this.disposables.push(
      messenger.onNotification(notifyMonitorIntentStop, (params, sender) =>
        this.handleMonitorIntentStop(params, sender)
      )
    )
    this.disposables.push(
      messenger.onNotification(notifyMonitorIntentResume, (params, sender) =>
        this.handleMonitorIntentResume(params, sender)
      )
    )
    this.disposables.push(
      messenger.onNotification(notifyMonitorOpenError, (params, sender) =>
        this.handleMonitorOpenError(params, sender)
      )
    )
    this.disposables.push(
      messenger.onNotification(notifyTraceEvent, (event, sender) =>
        this.handleTraceEvent(event, sender)
      )
    )
    this.disposables.push(
      messenger.onRequest(requestMonitorDetectedPorts, () =>
        this.bridgeClient.requestDetectedPorts()
      )
    )
    this.disposables.push(
      messenger.onRequest(requestMonitorUpdateBaudrate, (params) =>
        this.handleUpdateBaudrate(params)
      )
    )
    this.disposables.push(
      messenger.onRequest(requestMonitorSendMessage, (params) =>
        this.handleSendMonitorMessage(params)
      )
    )
    this.disposables.push(
      messenger.onRequest(requestMonitorPause, (params) =>
        this.bridgeClient.pauseMonitor(params)
      )
    )
    this.disposables.push(
      messenger.onRequest(requestMonitorResume, (params) =>
        this.bridgeClient.resumeMonitor(params)
      )
    )
    this.disposables.push(
      messenger.onRequest(requestMonitorPhysicalStateSnapshot, () =>
        this.physicalStates.snapshot()
      )
    )
    this.disposables.push(
      messenger.onRequest(requestMonitorSessionSnapshot, () =>
        this.snapshotSessions()
      )
    )

    this.disposables.push(
      this.physicalStates.onDidChange((state) => {
        this.forEachClient((clientId, participant) => {
          this.sendNotificationSafe(
            clientId,
            participant,
            notifyMonitorPhysicalStateChanged,
            state
          )
        })
        this.logicalTracker.applyPhysicalState(state as MonitorPhysicalState)
      })
    )

    const unlistenLogical = this.logicalTracker.onDidChange(
      ({ portKey, context }) => {
        this.emitHostTrace('extMonitorState', {
          portKey,
          logical: context.logical,
          desired: context.desired,
          currentAttemptId: context.currentAttemptId,
          lastCompletedAttemptId: context.lastCompletedAttemptId,
          selectedDetected: context.selectedDetected,
          lastError: context.lastError,
        })
      }
    )
    this.disposables.push({ dispose: () => unlistenLogical() })
    this.ensureBridgeEventForwarders()
  }

  dispose(): void {
    while (this.disposables.length) {
      const disposable = this.disposables.pop()
      try {
        disposable?.dispose()
      } catch (error) {
        this.logError('Failed to dispose monitor manager', error)
      }
    }
    this.clientSessions.clear()
    this.clientPorts.clear()
    this.portSessions.clear()
    this.sessionSnapshots.clear()
    for (const stream of this.externalHttpStreams.values()) {
      stream.abortController.abort()
    }
    this.externalHttpStreams.clear()
  }

  getRunningMonitors(): ReadonlyArray<{
    port: PortIdentifier
    baudrate?: string
  }> {
    return Array.from(this.runningMonitors.values())
  }

  getBridgeClient(): MonitorBridgeClient {
    return this.bridgeClient
  }

  async updateBridgeLogging(heartbeat: boolean): Promise<void> {
    await this.serviceClient.updateLoggingOptions({ heartbeat })
  }

  getMonitorState(port: PortIdentifier): MonitorRuntimeState {
    const key = createPortKey(port)
    const state = this.monitorStates.get(key) ?? 'disconnected'
    this.log('Queried monitor state', { key, state })
    return state
  }

  isPortDetected(port: PortIdentifier): boolean {
    return Boolean(this.detectedPorts[createPortKey(port)])
  }

  async getBridgeInfo(): Promise<MonitorBridgeInfo> {
    const info = await this.serviceClient.getBridgeInfo()
    this.log('Got monitor bridge info', info)

    this.bridgeConflictNotified = false
    return { httpBaseUrl: info.httpBaseUrl, wsUrl: info.wsUrl }
  }

  async pauseMonitor(port: PortIdentifier): Promise<boolean> {
    try {
      const params: RequestPauseResumeMonitorParams = { port }
      return await this.bridgeClient.pauseMonitor(params)
    } catch (error) {
      this.logError('Failed to pause monitor via RPC', error)
      return false
    }
  }

  async resumeMonitor(port: PortIdentifier): Promise<boolean> {
    try {
      const params: RequestPauseResumeMonitorParams = { port }
      return await this.bridgeClient.resumeMonitor(params)
    } catch (error) {
      this.logError('Failed to resume monitor via RPC', error)
      return false
    }
  }

  async updateBaudrate(port: PortIdentifier, baudrate: string): Promise<void> {
    await this.bridgeClient.updateBaudrate({ port, baudrate })
    this.updateSelectedBaudrateCache(port, baudrate)
    this.updateRunningMonitorBaudrate(port, baudrate)
  }

  registerExternalMonitorClient(
    clientId: string,
    port: PortIdentifier,
    options?: { autoStart?: boolean; baudrate?: string }
  ): void {
    this.externalMonitorClientIds.add(clientId)
    this.ensureBridgeEventForwarders()
    const portKey = createPortKey(port)
    const session = this.getOrCreateSession(port)
    session.attachClient(clientId)
    session.markDetected(Boolean(this.detectedPorts[portKey]))
    const previousPortKey = this.clientPorts.get(clientId)
    if (previousPortKey && previousPortKey !== portKey) {
      const previousSession = this.portSessions.get(previousPortKey)
      previousSession?.detachClient(clientId)
      if (previousSession) {
        this.emitSessionState(previousSession)
        this.pruneSessionIfIdle(previousPortKey, previousSession)
      }
    }
    const resolvedBaudrate =
      options?.baudrate ?? this.resolveDefaultBaudrateForPort(port)
    if (resolvedBaudrate) {
      this.selectedBaudrateCache.set(portKey, resolvedBaudrate)
      session.setBaudrate(resolvedBaudrate)
    }
    this.clientPorts.set(clientId, portKey)
    if (options?.autoStart !== false) {
      session.intentStart(clientId)
    }
    this.maybeApplySessionAction(session, 'external-client-attached')
    this.emitSessionState(session)
    if (session.snapshot().desired === 'running') {
      // Establish the bridge RPC connection first so monitor lifecycle events
      // are observed before the external HTTP stream opens the monitor.
      this.bridgeClient
        .requestDetectedPorts()
        .catch((error) => {
          this.logError(
            'Failed to initialize monitor bridge connection for external client',
            error
          )
        })
        .finally(() => {
          if (!this.externalMonitorClientIds.has(clientId)) {
            return
          }
          if (this.clientPorts.get(clientId) !== portKey) {
            return
          }
          const current = this.portSessions.get(portKey)
          if (!current || current.snapshot().desired !== 'running') {
            return
          }
          this.startExternalHttpStream(clientId, port)
        })
    }
  }

  unregisterExternalMonitorClient(
    clientId: string,
    port?: PortIdentifier
  ): void {
    this.externalMonitorClientIds.delete(clientId)
    const portKey =
      port !== undefined ? createPortKey(port) : this.clientPorts.get(clientId)
    if (!portKey) {
      return
    }
    const session = this.portSessions.get(portKey)
    session?.detachClient(clientId)
    this.stopExternalHttpStream(clientId)
    if (!port || this.clientPorts.get(clientId) === portKey) {
      this.clientPorts.delete(clientId)
    }
    if (session) {
      this.maybeApplySessionAction(session, 'external-client-detached')
      this.emitSessionState(session)
      this.pruneSessionIfIdle(portKey, session)
    }
  }

  async sendMonitorMessage(
    port: PortIdentifier,
    message: string | Uint8Array
  ): Promise<void> {
    const text =
      typeof message === 'string'
        ? message
        : Buffer.from(message).toString('utf8')
    await this.bridgeClient.sendMonitorMessage({ port, message: text })
  }

  getBaudrateOptions(
    port: PortIdentifier
  ): ReadonlyArray<{ value: string; isDefault: boolean }> {
    const settings = this.monitorSettingsByProtocol.protocols[port.protocol]
    if (!settings || settings.error) {
      return []
    }
    const descriptor = Array.isArray(settings.settings)
      ? settings.settings.find((s: any) => s.settingId === 'baudrate')
      : undefined
    if (!descriptor) {
      return []
    }
    const defaultValue =
      typeof descriptor.value === 'string' ? descriptor.value : undefined
    const options = Array.isArray(descriptor.enumValues)
      ? descriptor.enumValues
      : []
    return options.map((value: string) => ({
      value,
      isDefault: defaultValue === value,
    }))
  }

  getCachedBaudrate(port: PortIdentifier): string | undefined {
    return this.selectedBaudrateCache.get(createPortKey(port))
  }

  setSelectionResolver(
    resolver:
      | ((
          sender?: MessageParticipant
        ) =>
          | MonitorSelectionNotification
          | Promise<MonitorSelectionNotification>)
      | undefined
  ): void {
    this.selectionResolver = resolver
  }

  private async handleConnectMonitorClient(
    params: ConnectClientParams,
    sender?: MessageParticipant
  ): Promise<HostConnectClientResult> {
    if (!sender) {
      throw new Error('Missing message sender')
    }
    if (!params.clientId) {
      throw new Error('Missing clientId')
    }

    const result = await this.bridgeClient.connectClient(params)
    this.monitorSettingsByProtocol = result.monitorSettingsByProtocol
    this.detectedPorts = result.detectedPorts
    this.clientSessions.set(params.clientId, sender)
    this.clientChannels.set(params.clientId, this.resolveClientChannels(sender))
    const senderContext: {
      senderType?: MessageParticipant['type']
      webviewId?: string
      webviewType?: string
    } = {}
    if (isWebviewIdMessageParticipant(sender)) {
      senderContext.webviewId = sender.webviewId
    }
    if (isWebviewTypeMessageParticipant(sender)) {
      senderContext.webviewType = sender.webviewType
    }
    if (!senderContext.webviewId && !senderContext.webviewType) {
      senderContext.senderType = sender.type
    }
    this.log('Monitor client connected', {
      clientId: params.clientId,
      ...senderContext,
    })
    this.ensureBridgeEventForwarders()

    let selectedPort: PortIdentifier | undefined
    let selectedBaudrate: string | undefined
    if (this.selectionResolver) {
      try {
        const selection = await this.selectionResolver(sender)
        if (selection) {
          selectedPort = selection.port
          selectedBaudrate = selection.baudrate
        }
      } catch (error) {
        this.logError('Failed to resolve monitor selection', error)
      }
    }

    if (!selectedBaudrate && selectedPort) {
      const cached = this.selectedBaudrateCache.get(createPortKey(selectedPort))
      if (cached) {
        selectedBaudrate = cached
      }
    }

    if (!selectedBaudrate && selectedPort?.protocol) {
      const protocolSettings =
        result.monitorSettingsByProtocol.protocols[selectedPort.protocol]
      if (protocolSettings && Array.isArray(protocolSettings.settings)) {
        selectedBaudrate = protocolSettings.settings.find(
          (setting: { settingId?: string; value?: string }) =>
            setting.settingId === 'baudrate'
        )?.value
      }
    }
    const finalSelectedBaudrates = (result.selectedBaudrates ?? []).map(
      ([port, baud]) => [port, baud] as [typeof port, string]
    )

    if (selectedPort && selectedBaudrate) {
      const index = finalSelectedBaudrates.findIndex(
        ([port]) => createPortKey(port) === createPortKey(selectedPort)
      )
      if (index >= 0) {
        finalSelectedBaudrates[index][1] = selectedBaudrate
      } else {
        finalSelectedBaudrates.push([selectedPort, selectedBaudrate])
      }
      this.selectedBaudrateCache.set(
        createPortKey(selectedPort),
        selectedBaudrate
      )
    }

    for (const [port, baud] of finalSelectedBaudrates) {
      this.selectedBaudrateCache.set(createPortKey(port), baud)
    }

    if (selectedPort && this.isPortDetected(selectedPort)) {
      this.setMonitorState(selectedPort, 'connected')
    }

    const runningMonitors = (result.runningMonitors ?? []).map((entry) => {
      const key = createPortKey(entry.port)
      const cached = this.selectedBaudrateCache.get(key)
      return {
        port: entry.port,
        baudrate: cached ?? entry.baudrate,
        monitorSessionId: entry.monitorSessionId,
      }
    })
    this.syncRunningMonitors(runningMonitors)
    this.logicalTracker.applyDetectionSnapshot(this.detectedPorts)

    return {
      ...result,
      selectedPort,
      selectedBaudrate,
      selectedBaudrates: finalSelectedBaudrates,
      runningMonitors,
      physicalStates: this.physicalStates.snapshot(),
      sessionStates: this.snapshotSessions(),
      transport: 'http',
    }
  }

  private handleDisconnectMonitorClient(
    params: DisconnectMonitorClientParams,
    _sender?: MessageParticipant
  ): void {
    if (!params.clientId) {
      return
    }
    this.clientSessions.delete(params.clientId)
    this.clientChannels.delete(params.clientId)
    const portKey = this.clientPorts.get(params.clientId)
    if (portKey) {
      const session = this.portSessions.get(portKey)
      session?.detachClient(params.clientId)
      this.clientPorts.delete(params.clientId)
      if (session) {
        this.emitSessionState(session)
        this.pruneSessionIfIdle(portKey, session)
      }
    }
    this.log('Monitor client disconnected', { clientId: params.clientId })
  }

  private handleClientAttached(
    params: MonitorClientAttachParams,
    _sender?: MessageParticipant
  ): void {
    if (!params.clientId || !params.port) {
      return
    }
    const portKey = createPortKey(params.port)
    const session = this.getOrCreateSession(params.port)
    session.attachClient(params.clientId)
    session.markDetected(Boolean(this.detectedPorts[portKey]))

    const previousPortKey = this.clientPorts.get(params.clientId)
    if (previousPortKey && previousPortKey !== portKey) {
      const previousSession = this.portSessions.get(previousPortKey)
      previousSession?.detachClient(params.clientId)
      if (previousSession) {
        this.emitSessionState(previousSession)
        this.pruneSessionIfIdle(previousPortKey, previousSession)
      }
    }

    this.clientPorts.set(params.clientId, portKey)
    this.maybeApplySessionAction(session, 'client-attached')
    this.emitSessionState(session)
  }

  private handleClientDetached(
    params: MonitorClientDetachParams,
    _sender?: MessageParticipant
  ): void {
    if (!params.clientId || !params.port) {
      return
    }
    const portKey = createPortKey(params.port)
    const session = this.portSessions.get(portKey)
    if (!session) {
      return
    }
    session.detachClient(params.clientId)
    this.clientPorts.delete(params.clientId)
    this.maybeApplySessionAction(session, 'client-detached')
    this.emitSessionState(session)
    this.pruneSessionIfIdle(portKey, session)
  }

  private handleMonitorIntentStart(
    params: MonitorIntentParams,
    sender?: MessageParticipant
  ): void {
    if (!params.port) {
      return
    }
    const session = this.getOrCreateSession(params.port)
    const clientId = params.clientId ?? this.resolveClientId(sender)
    session.intentStart(clientId)
    this.maybeApplySessionAction(session, 'intent-start')
    this.emitSessionState(session)
  }

  private handleMonitorIntentStop(
    params: MonitorIntentParams,
    sender?: MessageParticipant
  ): void {
    if (!params.port) {
      return
    }
    const session = this.getOrCreateSession(params.port)
    const clientId = params.clientId ?? this.resolveClientId(sender)
    session.intentStop(clientId)
    this.logicalTracker.applyEvent({ type: 'USER_STOP', port: params.port })
    this.maybeApplySessionAction(session, 'intent-stop')
    this.emitSessionState(session)
  }

  private handleMonitorIntentResume(
    params: MonitorIntentParams,
    sender?: MessageParticipant
  ): void {
    if (!params.port) {
      return
    }
    const session = this.getOrCreateSession(params.port)
    const clientId = params.clientId ?? this.resolveClientId(sender)
    session.intentResume(clientId)
    this.maybeApplySessionAction(session, 'intent-resume')
    this.emitSessionState(session)
  }

  private resolveClientId(sender?: MessageParticipant): string | undefined {
    if (!sender) {
      return undefined
    }
    for (const [clientId, participant] of this.clientSessions.entries()) {
      if (equalParticipants(participant, sender)) {
        return clientId
      }
    }
    return undefined
  }

  private resolveClientChannels(
    sender?: MessageParticipant
  ): ReadonlyArray<string> {
    if (sender && isWebviewTypeMessageParticipant(sender)) {
      if (sender.webviewType === 'plotter') {
        return ['plotter']
      }
      if (sender.webviewType === 'monitor') {
        return ['monitor']
      }
    }
    return ['monitor']
  }

  private startExternalHttpStream(
    clientId: string,
    port: PortIdentifier
  ): void {
    const portKey = createPortKey(port)
    const existing = this.externalHttpStreams.get(clientId)
    if (existing && existing.portKey === portKey) {
      return
    }
    this.stopExternalHttpStream(clientId)
    const abortController = new AbortController()
    const streamState = {
      portKey,
      abortController,
      task: Promise.resolve(),
    }
    streamState.task = this.runExternalHttpStream(
      clientId,
      port,
      portKey,
      abortController.signal
    )
      .catch((error) => {
        if (!(error instanceof Error && error.name === 'AbortError')) {
          this.logError('External monitor HTTP stream failed', error)
        }
      })
      .finally(() => {
        if (this.externalHttpStreams.get(clientId) === streamState) {
          this.externalHttpStreams.delete(clientId)
        }
      })
    this.externalHttpStreams.set(clientId, streamState)
  }

  private stopExternalHttpStream(clientId: string): void {
    const existing = this.externalHttpStreams.get(clientId)
    if (!existing) {
      return
    }
    this.externalHttpStreams.delete(clientId)
    existing.abortController.abort()
  }

  private async runExternalHttpStream(
    clientId: string,
    initialPort: PortIdentifier,
    portKey: string,
    signal: AbortSignal
  ): Promise<void> {
    const isActive = () =>
      !signal.aborted &&
      this.externalMonitorClientIds.has(clientId) &&
      this.clientPorts.get(clientId) === portKey

    while (isActive()) {
      const streamPort =
        this.portSessions.get(portKey)?.snapshot().port ?? initialPort
      let response: Response | undefined
      try {
        const info = await this.serviceClient.getBridgeInfo()
        if (!isActive()) {
          return
        }
        const url = new URL(`${info.httpBaseUrl}/monitor`)
        url.searchParams.set('protocol', streamPort.protocol)
        url.searchParams.set('address', streamPort.address)
        const baudrate =
          this.selectedBaudrateCache.get(portKey) ??
          this.resolveDefaultBaudrateForPort(streamPort)
        if (baudrate) {
          this.selectedBaudrateCache.set(portKey, baudrate)
          this.portSessions.get(portKey)?.setBaudrate(baudrate)
          url.searchParams.set('baudrate', baudrate)
        }
        url.searchParams.set('clientid', clientId)
        response = await fetch(url.toString(), { signal })
        if (!response.ok) {
          const body = await response.text().catch(() => '')
          this.log('External monitor HTTP stream rejected', {
            clientId,
            portKey,
            status: response.status,
            body: body.slice(0, 160),
          })
          await delay(EXTERNAL_HTTP_RETRY_DELAY_MS)
          continue
        }
        const reader = response.body?.getReader()
        if (!reader) {
          await delay(EXTERNAL_HTTP_RETRY_DELAY_MS)
          continue
        }
        try {
          while (isActive()) {
            const { done, value } = await reader.read()
            if (done) {
              break
            }
            if (!value || value.length === 0) {
              continue
            }
            const currentPort =
              this.portSessions.get(portKey)?.snapshot().port ?? streamPort
            this.onDidReceiveMonitorDataEmitter.fire({
              port: currentPort,
              data: value,
            })
          }
        } finally {
          await reader.cancel().catch(() => undefined)
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return
        }
        this.logError('External monitor HTTP stream cycle failed', error)
      }
      if (!isActive()) {
        return
      }
      await delay(EXTERNAL_HTTP_RETRY_DELAY_MS)
    }
  }

  private handleMonitorOpenError(
    params: MonitorOpenErrorNotification,
    _sender?: MessageParticipant
  ): void {
    if (!params.port) {
      return
    }
    const session = this.getOrCreateSession(params.port)
    const message = typeof params.message === 'string' ? params.message : ''
    const isMissingPort =
      params.code === 'port-not-detected' ||
      params.status === 404 ||
      /no such file or directory/i.test(message)
    if (isMissingPort) {
      session.markDetected(false)
      session.markPaused('resource-missing')
      this.emitSessionState(session)
      return
    }
    session.markOpenError({
      status: params.status,
      code: params.code,
      message: params.message,
    })
    this.maybeApplySessionAction(session, 'open-error')
    this.emitSessionState(session)
  }

  dropClientSessionsForParticipant(participant: MessageParticipant): void {
    if (!isWebviewIdMessageParticipant(participant)) {
      return
    }
    const targetId = participant.webviewId
    for (const [clientId, session] of this.clientSessions.entries()) {
      if (
        isWebviewIdMessageParticipant(session) &&
        session.webviewId === targetId
      ) {
        this.clientSessions.delete(clientId)
        const portKey = this.clientPorts.get(clientId)
        if (portKey) {
          const portSession = this.portSessions.get(portKey)
          portSession?.detachClient(clientId)
          this.clientPorts.delete(clientId)
          if (portSession) {
            this.emitSessionState(portSession)
            this.pruneSessionIfIdle(portKey, portSession)
          }
        }
      }
    }
  }

  private getOrCreateSession(port: PortIdentifier): MonitorPortSession {
    const portKey = createPortKey(port)
    const existing = this.portSessions.get(portKey)
    if (existing) {
      existing.updatePort(port)
      const cachedBaudrate = this.selectedBaudrateCache.get(portKey)
      existing.setBaudrate(cachedBaudrate)
      return existing
    }
    const session = new MonitorPortSession(port)
    const cachedBaudrate = this.selectedBaudrateCache.get(portKey)
    session.setBaudrate(cachedBaudrate)
    session.markDetected(Boolean(this.detectedPorts[portKey]))
    this.portSessions.set(portKey, session)
    return session
  }

  private snapshotSessions(): ReadonlyArray<MonitorSessionState> {
    return Array.from(this.portSessions.values()).map((session) =>
      session.snapshot()
    )
  }

  private emitSessionState(session: MonitorPortSession): void {
    const snapshot = session.snapshot()
    const previous = this.sessionSnapshots.get(snapshot.portKey)
    if (previous && deepEqual(previous, snapshot)) {
      return
    }
    this.sessionSnapshots.set(snapshot.portKey, snapshot)
    this.forEachClient((clientId, participant) => {
      this.sendNotificationSafe(
        clientId,
        participant,
        notifyMonitorSessionState,
        snapshot
      )
    })
  }

  private maybeApplySessionAction(
    session: MonitorPortSession,
    reason: string
  ): void {
    const action = session.nextAction()
    if (!action) {
      return
    }
    this.emitHostTrace('extMonitorSessionAction', {
      portKey: createPortKey(action.port),
      action: action.type,
      attemptId: action.type === 'open' ? action.attemptId : undefined,
      reason,
    })
  }

  private pruneSessionIfIdle(
    portKey: string,
    session: MonitorPortSession
  ): void {
    const snapshot = session.snapshot()
    if (
      snapshot.clients.length === 0 &&
      snapshot.desired === 'stopped' &&
      snapshot.status === 'idle'
    ) {
      this.portSessions.delete(portKey)
      this.sessionSnapshots.delete(portKey)
    }
  }

  private async handleUpdateBaudrate(
    params: RequestUpdateBaudrateParams
  ): Promise<void> {
    await this.bridgeClient.updateBaudrate(params)
    const session = this.portSessions.get(createPortKey(params.port))
    session?.setBaudrate(params.baudrate)
    if (session) {
      this.emitSessionState(session)
    }
    this.updateSelectedBaudrateCache(params.port, params.baudrate)
    this.updateRunningMonitorBaudrate(params.port, params.baudrate)
  }

  private async handleSendMonitorMessage(
    params: RequestSendMonitorMessageParams
  ): Promise<void> {
    await this.bridgeClient.sendMonitorMessage(params)
  }

  private ensureBridgeEventForwarders(): void {
    if (this.bridgeEventsRegistered) {
      return
    }
    this.bridgeEventsRegistered = true

    this.disposables.push(
      this.bridgeClient.onDidChangeDetectedPorts((ports) => {
        this.detectedPorts = ports
        this.logicalTracker.applyDetectionSnapshot(ports)
        for (const [portKey, session] of this.portSessions.entries()) {
          const detectedPort = ports[portKey]?.port
          if (detectedPort) {
            session.updatePort(detectedPort)
          }
          session.markDetected(Boolean(ports[portKey]))
          this.maybeApplySessionAction(session, 'detected-ports')
          this.emitSessionState(session)
          this.pruneSessionIfIdle(portKey, session)
          const snapshot = session.snapshot()
          for (const clientId of snapshot.clients) {
            if (!this.externalMonitorClientIds.has(clientId)) {
              continue
            }
            if (snapshot.desired === 'running') {
              this.startExternalHttpStream(clientId, snapshot.port)
            } else {
              this.stopExternalHttpStream(clientId)
            }
          }
        }
        this.forEachClient((clientId, participant) => {
          this.sendNotificationSafe(
            clientId,
            participant,
            notifyMonitorViewDidChangeDetectedPorts,
            ports
          )
        })
        // Detected ports influence available monitors but do not directly
        // change cached baudrates.
      })
    )

    this.disposables.push(
      this.bridgeClient.onDidChangeMonitorSettings((payload) => {
        this.forEachClient((clientId, participant) => {
          this.sendNotificationSafe(
            clientId,
            participant,
            notifyMonitorViewDidChangeMonitorSettings,
            payload
          )
        })
        this.monitorSettingsByProtocol = payload
      })
    )

    this.disposables.push(
      this.bridgeClient.onDidChangeBaudrate((payload) => {
        this.forEachClient((clientId, participant) => {
          this.sendNotificationSafe(
            clientId,
            participant,
            notifyMonitorViewDidChangeBaudrate,
            payload
          )
        })
        const session = this.portSessions.get(createPortKey(payload.port))
        session?.setBaudrate(payload.baudrate)
        if (session) {
          this.emitSessionState(session)
        }
        this.updateSelectedBaudrateCache(payload.port, payload.baudrate)
        this.updateRunningMonitorBaudrate(payload.port, payload.baudrate)
      })
    )

    this.disposables.push(
      this.bridgeClient.onDidPauseMonitor((payload) => {
        this.forEachClient((clientId, participant) => {
          this.sendNotificationSafe(
            clientId,
            participant,
            notifyMonitorViewDidPause,
            payload
          )
        })
        const session = this.getOrCreateSession(payload.port)
        session.markPaused('suspend')
        this.emitSessionState(session)
        this.setMonitorState(payload.port, 'suspended')
      })
    )

    this.disposables.push(
      this.bridgeClient.onDidResumeMonitor((payload) => {
        this.forEachClient((clientId, participant) => {
          this.sendNotificationSafe(
            clientId,
            participant,
            notifyMonitorViewDidResume,
            payload
          )
        })
        const resumedPort = payload.didResumeOnPort ?? payload.didPauseOnPort
        if (resumedPort) {
          const monitorSessionId =
            this.monitorSessionIds.get(createPortKey(resumedPort)) ??
            this.monitorSessionIds.get(createPortKey(payload.didPauseOnPort))
          const session = this.getOrCreateSession(resumedPort)
          session.markMonitorStarted({
            monitorSessionId,
            baudrate: this.selectedBaudrateCache.get(
              createPortKey(resumedPort)
            ),
          })
          this.emitSessionState(session)
          this.physicalStates.markStart(resumedPort, {
            monitorSessionId,
            reason: 'resume',
          })
          this.setMonitorState(resumedPort, 'running')
          this.setRunningMonitor(resumedPort, undefined)
        }
      })
    )

    this.disposables.push(
      this.bridgeClient.onDidStartMonitor((event) => {
        if (event.monitorSessionId) {
          this.monitorSessionIds.set(
            createPortKey(event.port),
            event.monitorSessionId
          )
        }
        const session = this.getOrCreateSession(event.port)
        session.markMonitorStarted({
          monitorSessionId: event.monitorSessionId,
          baudrate: event.baudrate,
        })
        this.emitSessionState(session)
        this.physicalStates.markStart(event.port, {
          monitorSessionId: event.monitorSessionId,
          baudrate: event.baudrate,
          reason: 'start',
        })
        this.updateSelectedBaudrateCache(event.port, event.baudrate)
        this.setRunningMonitor(event.port, event.baudrate)
      })
    )

    this.disposables.push(
      this.bridgeClient.onDidStopMonitor((event) => {
        const session = this.getOrCreateSession(event.port)
        session.markMonitorStopped()
        this.maybeApplySessionAction(session, 'monitor-stopped')
        this.emitSessionState(session)
        this.physicalStates.markStop(event.port, {
          monitorSessionId: event.monitorSessionId,
          reason: 'stop',
        })
        this.removeRunningMonitor(event.port)
        this.monitorSessionIds.delete(createPortKey(event.port))
      })
    )
  }

  private forEachClient(
    callback: (clientId: string, participant: MessageParticipant) => void
  ): void {
    for (const [clientId, participant] of this.clientSessions.entries()) {
      callback(clientId, participant)
    }
  }

  private sendNotificationSafe<T>(
    clientId: string,
    participant: MessageParticipant,
    notification: NotificationType<T>,
    payload: T
  ): void {
    try {
      this.messenger.sendNotification(notification, participant, payload)
    } catch (error) {
      this.logError(
        `Failed to notify monitor client ${clientId} (${notification.method})`,
        error
      )
      this.clientSessions.delete(clientId)
    }
  }

  private emitHostTrace(
    event: string,
    data: Record<string, unknown> & { portKey?: string }
  ) {
    try {
      this.bridgeClient.sendTraceEvent({
        event,
        data,
        portKey: data.portKey as string | undefined,
        src: { layer: 'ext', pid: process.pid },
      })
    } catch (error) {
      this.logError('Failed to emit host trace', error)
    }
  }

  private syncRunningMonitors(
    entries: ReadonlyArray<{
      port: PortIdentifier
      baudrate?: string
      monitorSessionId?: string
    }>
  ) {
    this.runningMonitors.clear()
    this.monitorSessionIds.clear()
    entries.forEach((entry) => {
      const key = createPortKey(entry.port)
      this.runningMonitors.set(key, {
        port: entry.port,
        baudrate: entry.baudrate,
      })
      if (entry.baudrate) {
        this.selectedBaudrateCache.set(key, entry.baudrate)
      }
      if (entry.monitorSessionId) {
        this.monitorSessionIds.set(key, entry.monitorSessionId)
      }
      const session = this.getOrCreateSession(entry.port)
      session.markDetected(Boolean(this.detectedPorts[key]))
      session.markMonitorStarted({
        monitorSessionId: entry.monitorSessionId,
        baudrate: entry.baudrate,
      })
      this.emitSessionState(session)
      this.physicalStates.markStart(entry.port, {
        monitorSessionId: entry.monitorSessionId,
        baudrate: entry.baudrate,
        reason: 'snapshot',
      })
      this.setMonitorState(entry.port, 'running')
    })
    this.emitRunningMonitorsChanged()
  }

  private setRunningMonitor(port: PortIdentifier, baudrate?: string) {
    const key = createPortKey(port)
    this.runningMonitors.set(key, { port, baudrate })
    if (baudrate) {
      this.selectedBaudrateCache.set(key, baudrate)
    }
    this.setMonitorState(port, 'running')
    this.emitRunningMonitorsChanged()
  }

  private removeRunningMonitor(port: PortIdentifier) {
    const key = createPortKey(port)
    if (this.runningMonitors.delete(key)) {
      this.emitRunningMonitorsChanged()
    }
    this.setMonitorState(port, 'disconnected')
  }

  private setMonitorState(
    port: PortIdentifier,
    state: MonitorRuntimeState,
    reason?: string
  ) {
    const key = createPortKey(port)
    const previous = this.monitorStates.get(key)
    if (previous === state) {
      return
    }
    if (state === 'disconnected') {
      this.monitorStates.delete(key)
    } else {
      this.monitorStates.set(key, state)
    }
    this.log('Monitor state changed', {
      key,
      previous,
      state,
      reason,
      monitorSessionId: this.monitorSessionIds.get(key),
    })
    this.onDidChangeMonitorStateEmitter.fire({ port, state, reason })
  }

  private updateRunningMonitorBaudrate(port: PortIdentifier, baudrate: string) {
    const key = createPortKey(port)
    const existing = this.runningMonitors.get(key)
    if (existing) {
      this.runningMonitors.set(key, { port: existing.port, baudrate })
      this.emitRunningMonitorsChanged()
    }
  }

  private emitRunningMonitorsChanged() {
    this.onDidChangeRunningMonitorsEmitter.fire(this.getRunningMonitors())
  }

  private updateSelectedBaudrateCache(port: PortIdentifier, baudrate?: string) {
    if (!baudrate) {
      return
    }
    this.selectedBaudrateCache.set(createPortKey(port), baudrate)
  }

  private resolveDefaultBaudrateForPort(
    port: PortIdentifier
  ): string | undefined {
    const portKey = createPortKey(port)
    const cached = this.selectedBaudrateCache.get(portKey)
    if (cached) {
      return cached
    }
    const settings = this.monitorSettingsByProtocol.protocols[port.protocol]
    if (!settings || settings.error || !Array.isArray(settings.settings)) {
      return undefined
    }
    const descriptor = settings.settings.find(
      (setting: { settingId?: string; value?: string }) =>
        setting.settingId === 'baudrate' && typeof setting.value === 'string'
    )
    return descriptor?.value
  }

  private log(message: string, data?: unknown): void {
    this.outputChannel.appendLine(formatLog(message, data))
  }

  private logError(message: string, error: unknown): void {
    this.outputChannel.appendLine(`${message} ${formatError(error)}`)
  }

  private async handleTraceEvent(
    event: TraceEventNotification,
    sender?: MessageParticipant
  ): Promise<void> {
    const src = {
      ...(event.src ?? {}),
      layer: event.src?.layer ?? 'webview',
    }
    const enriched: TraceEventNotification = {
      ...event,
      src,
      ...(sender && isWebviewIdMessageParticipant(sender) && !event.webviewId
        ? { webviewId: sender.webviewId }
        : {}),
      ...(sender &&
      isWebviewTypeMessageParticipant(sender) &&
      !event.webviewType
        ? { webviewType: sender.webviewType }
        : {}),
    }
    try {
      await this.bridgeClient.sendTraceEvent(enriched)
    } catch (error) {
      this.logError('Failed to forward trace event', error)
    }
  }

  private handleBridgeLog(entry: MonitorBridgeLogEntry): void {
    const timestamp = entry.timestamp ?? new Date().toISOString()
    const context =
      entry.context && Object.keys(entry.context).length
        ? ` ${JSON.stringify(entry.context)}`
        : ''
    const line = `[monitor bridge] ${timestamp} [${entry.level}] ${entry.message}${context}`
    this.bridgeLogChannel.appendLine(line)
    if (entry.level === 'error' || entry.level === 'warn') {
      this.bridgeLogChannel.show(true)
    }
  }

  private async handleGetBridgeInfo(
    sender?: MessageParticipant
  ): Promise<MonitorBridgeInfo> {
    try {
      return await this.getBridgeInfo()
    } catch (error) {
      if (error instanceof BridgeInUseError && !this.bridgeConflictNotified) {
        this.bridgeConflictNotified = true
        vscode.window.showErrorMessage(error.message)
      }
      const message = error instanceof Error ? error.message : String(error)
      if (sender) {
        try {
          this.messenger.sendNotification(notifyMonitorBridgeError, sender, {
            message,
          })
        } catch (notifyError) {
          this.logError('Failed to notify monitor bridge error', notifyError)
        }
      }
      throw error
    }
  }
}
