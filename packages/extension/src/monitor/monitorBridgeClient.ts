import { randomUUID } from 'node:crypto'

import type { DetectedPorts, PortIdentifier } from 'boards-list'
import { createPortKey } from 'boards-list'
import * as vscode from 'vscode'
import type { Disposable, MessageConnection } from 'vscode-jsonrpc'
import { ConsoleLogger, createWebSocketConnection } from 'vscode-ws-jsonrpc'
import WebSocket from 'ws'

import {
  ConnectClientParams,
  ConnectClientResult,
  DidChangeBaudrateNotification,
  DidPauseMonitorNotification,
  DidResumeMonitorNotification,
  NotifyDidChangeBaudrate,
  NotifyDidChangeDetectedPorts,
  NotifyDidChangeMonitorSettings,
  NotifyMonitorBridgeLog,
  NotifyMonitorDidPause,
  NotifyMonitorDidResume,
  NotifyMonitorDidStart,
  NotifyMonitorDidStop,
  RequestClientConnect,
  RequestDetectedPorts,
  RequestPauseMonitor,
  RequestPauseResumeMonitorParams,
  RequestResumeMonitor,
  RequestSendMonitorMessage,
  RequestSendMonitorMessageParams,
  RequestUpdateBaudrate,
  RequestUpdateBaudrateParams,
  type DidStartMonitorNotification,
  type DidStopMonitorNotification,
  type HostConnectClientResult,
  type MonitorBridgeInfo,
  type MonitorBridgeLogEntry,
  type MonitorSettingsByProtocol,
} from '@boardlab/protocol'

import { createNodeSocketAdapter } from './wsAdapters'

export interface MonitorBridgeClientOptions {
  readonly resolveBridgeInfo: () => Promise<MonitorBridgeInfo>
}

/**
 * Maintains a JSON-RPC connection to the BoardLab monitor bridge on behalf of
 * the extension host.
 */
export class MonitorBridgeClient implements vscode.Disposable {
  private connection: MessageConnection | undefined
  private connectionPromise: Promise<void> | undefined
  private connectionDisposables: Disposable[] = []
  private socket: WebSocket | undefined
  private reconnectTimer: NodeJS.Timeout | undefined
  private readonly clientId = randomUUID()
  private lastConnectResult: HostConnectClientResult | undefined
  private currentDetectedPorts: DetectedPorts = {}
  private currentMonitorSettings: MonitorSettingsByProtocol = {
    protocols: {},
  }

  private currentSelectedBaudrates: ReadonlyArray<
    readonly [PortIdentifier, string]
  > = []

  private currentSuspendedPortKeys: string[] = []
  private readonly runningMonitorKeys = new Map<
    string,
    { port: PortIdentifier; baudrate?: string }
  >()

  private readonly onDidStartMonitorEmitter = new vscode.EventEmitter<{
    port: PortIdentifier
    baudrate?: string
  }>()

  private readonly onDidStopMonitorEmitter =
    new vscode.EventEmitter<PortIdentifier>()

  private readonly onBridgeLogEmitter =
    new vscode.EventEmitter<MonitorBridgeLogEntry>()

  private readonly onDidChangeDetectedPortsEmitter =
    new vscode.EventEmitter<DetectedPorts>()

  private readonly onDidChangeMonitorSettingsEmitter =
    new vscode.EventEmitter<MonitorSettingsByProtocol>()

  private readonly onDidChangeBaudrateEmitter =
    new vscode.EventEmitter<DidChangeBaudrateNotification>()

  private readonly onDidPauseMonitorEmitter =
    new vscode.EventEmitter<DidPauseMonitorNotification>()

  private readonly onDidResumeMonitorEmitter =
    new vscode.EventEmitter<DidResumeMonitorNotification>()

  constructor(private readonly options: MonitorBridgeClientOptions) {}

  get onDidChangeDetectedPorts(): vscode.Event<DetectedPorts> {
    return this.onDidChangeDetectedPortsEmitter.event
  }

  get onDidChangeMonitorSettings(): vscode.Event<MonitorSettingsByProtocol> {
    return this.onDidChangeMonitorSettingsEmitter.event
  }

  get onDidChangeBaudrate(): vscode.Event<DidChangeBaudrateNotification> {
    return this.onDidChangeBaudrateEmitter.event
  }

  get onDidPauseMonitor(): vscode.Event<DidPauseMonitorNotification> {
    return this.onDidPauseMonitorEmitter.event
  }

  get onDidResumeMonitor(): vscode.Event<DidResumeMonitorNotification> {
    return this.onDidResumeMonitorEmitter.event
  }

  get onDidStartMonitor(): vscode.Event<{
    port: PortIdentifier
    baudrate?: string
  }> {
    return this.onDidStartMonitorEmitter.event
  }

  get onDidStopMonitor(): vscode.Event<PortIdentifier> {
    return this.onDidStopMonitorEmitter.event
  }

  get onBridgeLog(): vscode.Event<MonitorBridgeLogEntry> {
    return this.onBridgeLogEmitter.event
  }

  async connectClient(
    _params: ConnectClientParams
  ): Promise<HostConnectClientResult> {
    await this.ensureConnection()
    if (!this.lastConnectResult) {
      throw new Error('BoardLab monitor bridge snapshot unavailable')
    }
    return {
      detectedPorts: this.currentDetectedPorts,
      monitorSettingsByProtocol: this.currentMonitorSettings,
      selectedBaudrates: this.currentSelectedBaudrates,
      suspendedPortKeys: this.currentSuspendedPortKeys,
      runningMonitors: Array.from(this.runningMonitorKeys.values()),
    }
  }

  async requestDetectedPorts(): Promise<DetectedPorts> {
    const connection = await this.ensureConnection()
    const ports = await connection.sendRequest<DetectedPorts>(
      RequestDetectedPorts.method
    )
    this.currentDetectedPorts = ports
    this.onDidChangeDetectedPortsEmitter.fire(ports)
    return ports
  }

  async updateBaudrate(params: RequestUpdateBaudrateParams): Promise<void> {
    const connection = await this.ensureConnection()
    await connection.sendRequest(RequestUpdateBaudrate.method, params)
    this.updateSelectedBaudrate(params.port, params.baudrate)
  }

  async sendMonitorMessage(
    params: RequestSendMonitorMessageParams
  ): Promise<void> {
    const connection = await this.ensureConnection()
    await connection.sendRequest(RequestSendMonitorMessage.method, params)
  }

  async pauseMonitor(
    params: RequestPauseResumeMonitorParams
  ): Promise<boolean> {
    const connection = await this.ensureConnection()
    return connection.sendRequest(RequestPauseMonitor.method, params)
  }

  async resumeMonitor(
    params: RequestPauseResumeMonitorParams
  ): Promise<boolean> {
    const connection = await this.ensureConnection()
    return connection.sendRequest(RequestResumeMonitor.method, params)
  }

  dispose(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.disposeConnection()
    this.onDidChangeDetectedPortsEmitter.dispose()
    this.onDidChangeMonitorSettingsEmitter.dispose()
    this.onDidChangeBaudrateEmitter.dispose()
    this.onDidPauseMonitorEmitter.dispose()
    this.onDidResumeMonitorEmitter.dispose()
    this.onDidStartMonitorEmitter.dispose()
    this.onDidStopMonitorEmitter.dispose()
    this.onBridgeLogEmitter.dispose()
  }

  private async ensureConnection(): Promise<MessageConnection> {
    if (this.connection) {
      return this.connection
    }
    if (this.connectionPromise) {
      await this.connectionPromise
      if (!this.connection) {
        throw new Error(
          'Failed to establish BoardLab monitor bridge connection'
        )
      }
      return this.connection
    }

    this.connectionPromise = this.openConnection()
    try {
      await this.connectionPromise
    } finally {
      this.connectionPromise = undefined
    }
    if (!this.connection) {
      throw new Error('Failed to establish BoardLab monitor bridge connection')
    }
    return this.connection
  }

  private async openConnection(): Promise<void> {
    const info = await this.options.resolveBridgeInfo()

    const socket = new WebSocket(info.wsUrl, {
      perMessageDeflate: false,
    })

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup()
        resolve()
      }
      const onError = (error: unknown) => {
        cleanup()
        reject(error)
      }
      const cleanup = () => {
        socket.off('open', onOpen)
        socket.off('error', onError)
      }
      socket.once('open', onOpen)
      socket.once('error', onError)
    })

    const connection = createWebSocketConnection(
      createNodeSocketAdapter(socket),
      new ConsoleLogger()
    )

    this.socket = socket
    this.connection = connection

    const disposables: Disposable[] = []
    disposables.push(
      connection.onClose(() => this.handleConnectionLost()),
      connection.onError((error) => this.handleConnectionLost(error)),
      connection.onNotification(NotifyDidChangeDetectedPorts, (ports) => {
        this.currentDetectedPorts = ports
        this.onDidChangeDetectedPortsEmitter.fire(ports)
      }),
      connection.onNotification(NotifyDidChangeMonitorSettings, (payload) => {
        this.currentMonitorSettings = payload
        this.onDidChangeMonitorSettingsEmitter.fire(payload)
      }),
      connection.onNotification(NotifyDidChangeBaudrate, (payload) => {
        this.updateSelectedBaudrate(payload.port, payload.baudrate)
        this.onDidChangeBaudrateEmitter.fire(payload)
      }),
      connection.onNotification(NotifyMonitorDidPause, (payload) => {
        this.toggleSuspended(payload.port, true)
        this.onDidPauseMonitorEmitter.fire(payload)
      }),
      connection.onNotification(NotifyMonitorDidResume, (payload) => {
        const resumePort = payload.didResumeOnPort ?? payload.didPauseOnPort
        if (resumePort) {
          this.toggleSuspended(resumePort, false)
        }
        this.onDidResumeMonitorEmitter.fire(payload)
      }),
      connection.onNotification(
        NotifyMonitorDidStart,
        (payload: DidStartMonitorNotification) => {
          const key = createPortKey(payload.port)
          this.runningMonitorKeys.set(key, {
            port: payload.port,
            baudrate: payload.baudrate,
          })
          this.onDidStartMonitorEmitter.fire({
            port: payload.port,
            baudrate: payload.baudrate,
          })
        }
      ),
      connection.onNotification(
        NotifyMonitorDidStop,
        (payload: DidStopMonitorNotification) => {
          const key = createPortKey(payload.port)
          this.runningMonitorKeys.delete(key)
          this.toggleSuspended(payload.port, false)
          this.onDidStopMonitorEmitter.fire(payload.port)
        }
      ),
      connection.onNotification(
        NotifyMonitorBridgeLog,
        (payload: MonitorBridgeLogEntry) => {
          this.onBridgeLogEmitter.fire(payload)
        }
      )
    )
    this.connectionDisposables = disposables

    connection.listen()

    // Establish a logical connection so the bridge recognizes this participant.
    const snapshot = await connection.sendRequest<ConnectClientResult>(
      RequestClientConnect.method,
      {
        clientId: this.clientId,
      }
    )
    this.applyInitialSnapshot(snapshot)
  }

  private handleConnectionLost(error?: unknown) {
    if (error) {
      console.warn('[MonitorBridgeClient] connection lost', error)
    } else {
      console.warn('[MonitorBridgeClient] connection closed')
    }
    this.disposeConnection()
    if (this.reconnectTimer) {
      return
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.ensureConnection().catch((err) => {
        console.error('[MonitorBridgeClient] reconnect failed', err)
      })
    }, 1_000)
  }

  private disposeConnection() {
    if (this.connection) {
      try {
        this.connection.dispose()
      } catch {}
      this.connection = undefined
    }
    for (const disposable of this.connectionDisposables.splice(0)) {
      try {
        disposable.dispose()
      } catch {}
    }
    if (this.socket) {
      try {
        this.socket.close()
      } catch {}
      this.socket = undefined
    }
  }

  private applyInitialSnapshot(snapshot: HostConnectClientResult) {
    this.lastConnectResult = snapshot
    this.currentDetectedPorts = snapshot.detectedPorts
    this.currentMonitorSettings = snapshot.monitorSettingsByProtocol
    this.currentSelectedBaudrates = snapshot.selectedBaudrates ?? []
    this.runningMonitorKeys.clear()
    snapshot.runningMonitors?.forEach((entry) => {
      this.runningMonitorKeys.set(createPortKey(entry.port), entry)
    })
    const suspendedKeys = snapshot.suspendedPortKeys ?? []
    if (suspendedKeys.length) {
      const runningKeys = new Set(this.runningMonitorKeys.keys())
      this.currentSuspendedPortKeys = suspendedKeys.filter((key) =>
        runningKeys.has(key)
      )
    } else {
      this.currentSuspendedPortKeys = []
    }
  }

  private updateSelectedBaudrate(port: PortIdentifier, baudrate: string) {
    const key = createPortKey(port)
    const next = [...this.currentSelectedBaudrates]
    const index = next.findIndex(
      ([existing]) => createPortKey(existing) === key
    )
    if (index >= 0) {
      next[index] = [port, baudrate]
    } else {
      next.push([port, baudrate])
    }
    this.currentSelectedBaudrates = next
  }

  private toggleSuspended(port: PortIdentifier, suspended: boolean) {
    const key = createPortKey(port)
    const set = new Set(this.currentSuspendedPortKeys)
    if (suspended) {
      set.add(key)
    } else {
      set.delete(key)
    }
    this.currentSuspendedPortKeys = Array.from(set)
  }
}
