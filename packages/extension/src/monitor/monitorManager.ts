import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { createServer as createMonitorBridgeServer } from '@boardlab/portino-bridge'
import {
  connectMonitorClient,
  disconnectMonitorClient,
  getMonitorBridgeInfo,
  notifyMonitorBridgeError,
  notifyMonitorViewDidChangeBaudrate,
  notifyMonitorViewDidChangeDetectedPorts,
  notifyMonitorViewDidChangeMonitorSettings,
  notifyMonitorViewDidPause,
  notifyMonitorViewDidResume,
  requestMonitorDetectedPorts,
  requestMonitorPause,
  requestMonitorResume,
  requestMonitorSendMessage,
  requestMonitorUpdateBaudrate,
  type ConnectClientParams,
  type DisconnectMonitorClientParams,
  type HostConnectClientResult,
  type MonitorBridgeInfo,
  type MonitorSelectionNotification,
  type MonitorSettingsByProtocol,
  type RequestPauseResumeMonitorParams,
  type RequestSendMonitorMessageParams,
  type RequestUpdateBaudrateParams,
} from '@boardlab/protocol'
import { createPortKey, type PortIdentifier } from 'boards-list'
import * as vscode from 'vscode'
import type { Messenger } from 'vscode-messenger'
import type {
  MessageParticipant,
  NotificationType,
} from 'vscode-messenger-common'

import type { CliContext } from '../cli/context'
import { MonitorBridgeClient } from './monitorBridgeClient'

const DEFAULT_BRIDGE_HOST = '127.0.0.1'
const DEFAULT_BRIDGE_PORT = 55888
const WAIT_ATTEMPTS = 50
const WAIT_DELAY_MS = 200
const PROBE_TIMEOUT_MS = 1_000_000

interface ServiceReadyInfo extends MonitorBridgeInfo {
  readonly ownerPid: number
  readonly port: number
  readonly startedAt?: number
}

interface AttachResponse {
  readonly token: string
  readonly httpBaseUrl: string
  readonly wsUrl: string
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

export interface MonitorBridgeServiceClientOptions {
  readonly preferredPort?: number
  readonly mode?: MonitorBridgeMode
  readonly inProcessServerFactory?: InProcessServerFactory
}

export type MonitorBridgeMode = 'external-process' | 'in-process'

type InProcessServerInstance = Awaited<
  ReturnType<typeof createMonitorBridgeServer>
>

type InProcessServerFactory = (params: {
  port: number
  cliPath: string
}) => Promise<InProcessServerInstance>

const DEFAULT_BRIDGE_MODE: MonitorBridgeMode = 'external-process'

const defaultInProcessServerFactory: InProcessServerFactory = async ({
  port,
  cliPath,
}) => {
  return createMonitorBridgeServer({
    port,
    cliPath,
  })
}

function isAddressInUseError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EADDRINUSE'
  )
}

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

class MonitorBridgeServiceClient implements vscode.Disposable {
  private readonly clientId = randomUUID()
  private preferredPort: number
  private readonly mode: MonitorBridgeMode
  private readonly inProcessServerFactory: InProcessServerFactory
  private readyInfo: ServiceReadyInfo | undefined
  private ensuring: Promise<ServiceReadyInfo> | undefined
  private attachPromise: Promise<void> | undefined
  private attachToken: string | undefined
  private disposed = false
  private inProcessServer: InProcessServerInstance | undefined

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
    this.mode = options.mode ?? DEFAULT_BRIDGE_MODE
    this.inProcessServerFactory =
      options.inProcessServerFactory ?? defaultInProcessServerFactory
  }

  async getBridgeInfo(): Promise<ServiceReadyInfo> {
    const ready = await this.ensureService()
    await this.ensureAttached(ready)
    return ready
  }

  dispose(): void {
    this.disposed = true
    this.detach().catch((error) => {
      this.logError('Failed to detach from monitor bridge service', error)
    })
    this.shutdownInProcessServer().catch((error) => {
      this.logError('Failed to close in-process monitor bridge server', error)
    })
  }

  private async shutdownInProcessServer(): Promise<void> {
    const server = this.inProcessServer
    if (!server) {
      return
    }
    this.inProcessServer = undefined
    await server.close()
  }

  private async ensureService(): Promise<ServiceReadyInfo> {
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

    const actualPort = await this.launchService(this.preferredPort)
    const portToProbe = actualPort > 0 ? actualPort : this.preferredPort
    const ready = await this.waitForBridge(portToProbe)
    if (ready.port > 0) {
      this.preferredPort = ready.port
    }
    this.readyInfo = ready
    this.attachToken = undefined
    return ready
  }

  private async tryPreferredPort(): Promise<ServiceReadyInfo | undefined> {
    return this.fetchHealth(this.preferredPort).catch((error) => {
      if (error instanceof BridgeInUseError) {
        throw error
      }
      return undefined
    })
  }

  private async waitForBridge(port: number): Promise<ServiceReadyInfo> {
    if (port <= 0) {
      throw new Error('Invalid BoardLab monitor bridge port')
    }
    for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt++) {
      try {
        const ready = await this.fetchHealth(port)
        if (ready) {
          return ready
        }
      } catch (error) {
        if (error instanceof BridgeInUseError) {
          throw error
        }
      }
      await delay(WAIT_DELAY_MS)
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
      const pid =
        typeof payload.pid === 'number' && Number.isFinite(payload.pid)
          ? payload.pid
          : 0

      return {
        ownerPid: pid,
        port,
        wsUrl,
        httpBaseUrl,
        startedAt: Date.now(),
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

  private async launchService(port: number): Promise<number> {
    if (this.mode === 'in-process') {
      await this.shutdownInProcessServer()
      const cliPath = await this.resolveCliPath()
      try {
        const server = await this.inProcessServerFactory({
          port,
          cliPath,
        })
        this.inProcessServer = server
        return server.port
      } catch (error) {
        if (isAddressInUseError(error)) {
          throw new BridgeInUseError(port, 'address-in-use', error)
        }
        throw new Error(
          `Failed to launch in-process monitor bridge service: ${String(error)}`
        )
      }
    }

    const cliPath = await this.resolveCliPath()
    const entry = this.serviceEntryPoint
    const args = [entry, '--cli-path', cliPath, '--port', String(port)]

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
      child.on('error', (error) => {
        this.logError('monitor bridge service process error', error)
      })
      child.on('exit', (code, signal) => {
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
}

type MonitorBridgeClientOptions = ConstructorParameters<
  typeof MonitorBridgeClient
>[0]

export interface MonitorManagerOptions {
  readonly serviceClientOptions?: Partial<MonitorBridgeServiceClientOptions>
  readonly serviceClientFactory?: (
    context: vscode.ExtensionContext,
    resolveCliPath: () => Promise<string>,
    outputChannel: vscode.OutputChannel,
    options: MonitorBridgeServiceClientOptions
  ) => MonitorBridgeServiceClient
  readonly bridgeClientFactory?: (
    options: MonitorBridgeClientOptions
  ) => MonitorBridgeClient
}

export class MonitorManager implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = []
  private readonly serviceClient: MonitorBridgeServiceClient
  private readonly bridgeClient: MonitorBridgeClient
  private readonly outputChannel: vscode.OutputChannel
  private readonly clientSessions = new Map<string, MessageParticipant>()
  private bridgeEventsRegistered = false
  private bridgeConflictNotified = false
  private selectionResolver?: (
    sender?: MessageParticipant
  ) =>
    | MonitorSelectionNotification
    | Promise<MonitorSelectionNotification>
    | undefined

  private readonly selectedBaudrateCache = new Map<string, string>()
  private readonly runningMonitors = new Map<
    string,
    { port: PortIdentifier; baudrate?: string }
  >()

  private readonly monitorStates = new Map<string, MonitorRuntimeState>()
  private readonly onDidChangeMonitorStateEmitter =
    new vscode.EventEmitter<MonitorStateChangeEvent>()

  readonly onDidChangeMonitorState = this.onDidChangeMonitorStateEmitter.event

  private monitorSettingsByProtocol: MonitorSettingsByProtocol = {
    protocols: {},
  }

  private readonly onDidChangeRunningMonitorsEmitter = new vscode.EventEmitter<
    ReadonlyArray<{ port: PortIdentifier; baudrate?: string }>
  >()

  readonly onDidChangeRunningMonitors =
    this.onDidChangeRunningMonitorsEmitter.event

  constructor(
    context: vscode.ExtensionContext,
    private readonly cliContext: CliContext,
    private readonly messenger: Messenger,
    outputChannel: vscode.OutputChannel,
    options: MonitorManagerOptions = {}
  ) {
    this.outputChannel = outputChannel
    const configuration = vscode.workspace.getConfiguration('boardlab.monitor')
    const configuredPort = configuration.get<number>('bridgePort', 0)
    const preferredPort =
      configuredPort > 0 ? configuredPort : DEFAULT_BRIDGE_PORT
    const configuredMode = configuration.get<MonitorBridgeMode>(
      'bridgeMode',
      DEFAULT_BRIDGE_MODE
    )

    const overrides = options.serviceClientOptions ?? {}
    const serviceClientOptions: MonitorBridgeServiceClientOptions = {
      preferredPort:
        overrides.preferredPort !== undefined
          ? overrides.preferredPort
          : preferredPort,
      mode: overrides.mode !== undefined ? overrides.mode : configuredMode,
      inProcessServerFactory: overrides.inProcessServerFactory,
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
    this.disposables.push(this.onDidChangeMonitorStateEmitter)
    this.disposables.push(this.onDidChangeRunningMonitorsEmitter)
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
  }

  getRunningMonitors(): ReadonlyArray<{
    port: PortIdentifier
    baudrate?: string
  }> {
    return Array.from(this.runningMonitors.values())
  }

  getMonitorState(port: PortIdentifier): MonitorRuntimeState {
    return this.monitorStates.get(createPortKey(port)) ?? 'disconnected'
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
    this.clientSessions.set(params.clientId, sender)
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

    if (selectedPort) {
      this.setMonitorState(selectedPort, 'connected')
    }

    const runningMonitors = (result.runningMonitors ?? []).map((entry) => {
      const key = createPortKey(entry.port)
      const cached = this.selectedBaudrateCache.get(key)
      return {
        port: entry.port,
        baudrate: cached ?? entry.baudrate,
      }
    })
    this.syncRunningMonitors(runningMonitors)

    return {
      ...result,
      selectedPort,
      selectedBaudrate,
      selectedBaudrates: finalSelectedBaudrates,
      runningMonitors,
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
  }

  private async handleUpdateBaudrate(
    params: RequestUpdateBaudrateParams
  ): Promise<void> {
    await this.bridgeClient.updateBaudrate(params)
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
          this.setMonitorState(resumedPort, 'running')
          this.setRunningMonitor(resumedPort, undefined)
        }
      })
    )

    this.disposables.push(
      this.bridgeClient.onDidStartMonitor((event) => {
        this.updateSelectedBaudrateCache(event.port, event.baudrate)
        this.setRunningMonitor(event.port, event.baudrate)
      })
    )

    this.disposables.push(
      this.bridgeClient.onDidStopMonitor((port) => {
        this.removeRunningMonitor(port)
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

  private syncRunningMonitors(
    entries: ReadonlyArray<{ port: PortIdentifier; baudrate?: string }>
  ) {
    this.runningMonitors.clear()
    entries.forEach((entry) => {
      const key = createPortKey(entry.port)
      this.runningMonitors.set(key, {
        port: entry.port,
        baudrate: entry.baudrate,
      })
      if (entry.baudrate) {
        this.selectedBaudrateCache.set(key, entry.baudrate)
      }
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

  private log(message: string, data?: unknown): void {
    this.outputChannel.appendLine(formatLog(message, data))
  }

  private logError(message: string, error: unknown): void {
    this.outputChannel.appendLine(`${message} ${formatError(error)}`)
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
