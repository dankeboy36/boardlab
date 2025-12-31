import type { DetectedPorts } from 'boards-list'
import * as vscode from 'vscode'
import type { Disposable, MessageConnection } from 'vscode-jsonrpc'
import {
  ConsoleLogger,
  createWebSocketConnection,
  type IWebSocket,
} from 'vscode-ws-jsonrpc'
import WebSocket from 'ws'

import {
  MonitorBridgeInfo,
  NotifyDidChangeDetectedPorts,
  RequestDetectedPorts,
} from '@boardlab/protocol'

export type PortId = string

export interface DefaultBaudrateHint {
  readonly portId: PortId
  readonly baudrate: number
}

interface ReconnectOptions {
  readonly immediate?: boolean
}

const HEARTBEAT_INTERVAL_MS = 30_000
const HEARTBEAT_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS + 1_000

/** Subscribes to the shared monitor bridge to surface detected port changes. */
export class BoardsListWatcher implements vscode.Disposable {
  private readonly onDidChangeDetectedPortsEmitter =
    new vscode.EventEmitter<DetectedPorts>()

  private readonly onDidChangeDefaultBaudrateHintEmitter =
    new vscode.EventEmitter<DefaultBaudrateHint | undefined>()

  private readonly onDidChangeCliDaemonConnectionEmitter =
    new vscode.EventEmitter<boolean>()

  private readonly disposables: vscode.Disposable[] = [
    this.onDidChangeDetectedPortsEmitter,
    this.onDidChangeDefaultBaudrateHintEmitter,
    this.onDidChangeCliDaemonConnectionEmitter,
  ]

  private socket: WebSocket | undefined
  private connection: MessageConnection | undefined
  private connectionDisposables: Disposable[] = []
  private reconnectTimer: NodeJS.Timeout | undefined
  private heartbeatInterval: NodeJS.Timeout | undefined
  private heartbeatTimeout: NodeJS.Timeout | undefined
  private started = false
  private disposed = false
  private connecting = false
  private retryAttempts = 0
  private lastSnapshotKey: string | undefined
  private _detectedPorts: DetectedPorts = {}

  constructor(
    private readonly resolveBridgeInfo: () => Promise<MonitorBridgeInfo>
  ) {}

  get onDidChangeDetectedPorts(): vscode.Event<DetectedPorts> {
    return this.onDidChangeDetectedPortsEmitter.event
  }

  get detectedPorts(): DetectedPorts {
    return this._detectedPorts
  }

  get onDidChangeDefaultBaudrateHint(): vscode.Event<
    DefaultBaudrateHint | undefined
  > {
    return this.onDidChangeDefaultBaudrateHintEmitter.event
  }

  get onDidChangeCliDaemonConnection(): vscode.Event<boolean> {
    return this.onDidChangeCliDaemonConnectionEmitter.event
  }

  start(): void {
    if (this.started || this.disposed) {
      return
    }
    this.started = true
    this.connect()
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.cleanupConnection({ reconnect: false })
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    while (this.disposables.length > 0) {
      const disposable = this.disposables.pop()
      try {
        disposable?.dispose()
      } catch (error) {
        console.error('[BoardsListWatcher] dispose failed', error)
      }
    }
  }

  private async connect(): Promise<void> {
    if (this.connecting || this.disposed) {
      return
    }
    this.connecting = true

    try {
      const info = await this.resolveBridgeInfo().catch((error) => {
        console.error(
          '[BoardsListWatcher] Failed to resolve bridge info',
          error
        )
        throw error
      })
      if (!info?.wsUrl) {
        throw new Error('Missing BoardLab monitor bridge WebSocket URL')
      }
      await this.openSocket(info.wsUrl)
    } catch (error) {
      if (!this.disposed) {
        this.scheduleReconnect()
      }
      console.error('[BoardsListWatcher] connect failed', error)
    } finally {
      this.connecting = false
    }
  }

  private async openSocket(wsUrl: string): Promise<void> {
    return new Promise((resolve) => {
      const socket = new WebSocket(wsUrl)
      this.socket = socket

      const handleCloseOrError = (reason: unknown) => {
        if (this.socket !== socket) {
          return
        }
        this.cleanupConnection()
        this.scheduleReconnect()
        if (reason instanceof Error) {
          console.error('[BoardsListWatcher] socket error', reason)
        }
        resolve()
      }

      socket.on('open', () => {
        if (this.socket !== socket) {
          socket.close()
          resolve()
          return
        }
        this.retryAttempts = 0
        this.startHeartbeat(socket)
        this.wireConnection(socket)
        resolve()
      })
      socket.on('close', () => handleCloseOrError(undefined))
      socket.on('error', (err) => handleCloseOrError(err as Error))
    })
  }

  private wireConnection(socket: WebSocket): void {
    const socketAdapter = this.createSocketAdapter(socket)
    const connection = createWebSocketConnection(
      socketAdapter,
      new ConsoleLogger()
    )
    this.connection = connection

    const onCloseDisposable = connection.onClose(() => {
      this.cleanupConnection()
      this.scheduleReconnect({ immediate: true })
    })
    const onErrorDisposable = connection.onError((error) => {
      console.error('[BoardsListWatcher] connection error', error)
      this.cleanupConnection()
      this.scheduleReconnect({ immediate: true })
    })
    const onDetectedPortsDisposable = connection.onNotification(
      NotifyDidChangeDetectedPorts,
      (detectedPorts) => this.handleDetectedPorts(detectedPorts)
    )

    this.connectionDisposables = [
      onCloseDisposable,
      onErrorDisposable,
      onDetectedPortsDisposable,
    ]

    connection.listen()

    this.onDidChangeCliDaemonConnectionEmitter.fire(true)

    connection
      .sendRequest<DetectedPorts>(RequestDetectedPorts.method)
      .then((detectedPorts) => this.handleDetectedPorts(detectedPorts))
      .catch((error) =>
        console.error('[BoardsListWatcher] Failed to request ports', error)
      )
  }

  private createSocketAdapter(socket: WebSocket): IWebSocket {
    return {
      send: (content: string) => socket.send(content),
      onMessage: (cb: (data: unknown) => void) => {
        socket.on('message', (data) => cb(data))
      },
      onError: (cb: (reason: unknown) => void) => {
        socket.on('error', (err) => cb(err))
      },
      onClose: (cb: (code: number, reason: string) => void) => {
        socket.on('close', (code, reason) => {
          const asString =
            typeof reason === 'string'
              ? reason
              : reason instanceof Buffer
                ? reason.toString('utf8')
                : ''
          cb(code ?? 0, asString)
        })
      },
      dispose: () => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.close()
        } else if (typeof socket.terminate === 'function') {
          socket.terminate()
        }
      },
    }
  }

  private startHeartbeat(socket: WebSocket): void {
    const heartbeat = () => {
      if (this.heartbeatTimeout) {
        clearTimeout(this.heartbeatTimeout)
      }
      this.heartbeatTimeout = setTimeout(() => {
        if (socket.readyState === WebSocket.OPEN) {
          console.warn(
            '[BoardsListWatcher] heartbeat timeout; terminating socket'
          )
          try {
            socket.terminate()
          } catch (error) {
            console.error(
              '[BoardsListWatcher] failed to terminate socket after timeout',
              error
            )
          }
        }
      }, HEARTBEAT_TIMEOUT_MS)
    }

    heartbeat()
    socket.on('pong', heartbeat)

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
    }
    this.heartbeatInterval = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.ping()
        } catch (error) {
          console.error(
            '[BoardsListWatcher] failed to ping BoardLab monitor bridge',
            error
          )
        }
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  private clearHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = undefined
    }
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout)
      this.heartbeatTimeout = undefined
    }
  }

  private handleDetectedPorts(detectedPorts: DetectedPorts): void {
    const snapshotKey = JSON.stringify(detectedPorts)
    if (snapshotKey === this.lastSnapshotKey) {
      return
    }
    this._detectedPorts = detectedPorts
    this.lastSnapshotKey = snapshotKey
    this.onDidChangeDetectedPortsEmitter.fire(detectedPorts)
  }

  private scheduleReconnect(options: ReconnectOptions = {}): void {
    if (!this.started || this.disposed) {
      return
    }
    if (this.connecting) {
      return
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }

    const delay = options.immediate
      ? 0
      : Math.min(1000 * Math.pow(2, this.retryAttempts), 5000)
    this.retryAttempts = Math.min(this.retryAttempts + 1, 5)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, delay)
  }

  private cleanupConnection({
    reconnect = false,
  }: { reconnect?: boolean } = {}) {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }

    this.clearHeartbeat()

    const connection = this.connection
    this.connection = undefined
    this.connectionDisposables.forEach((disposable) => {
      try {
        disposable.dispose()
      } catch (error) {
        console.error('[BoardsListWatcher] dispose connection failed', error)
      }
    })
    this.connectionDisposables = []

    if (connection) {
      try {
        connection.dispose()
      } catch (error) {
        console.error('[BoardsListWatcher] connection dispose failed', error)
      }
    }

    const socket = this.socket
    this.socket = undefined
    if (socket) {
      try {
        socket.removeAllListeners()
        if (socket.readyState === WebSocket.OPEN) {
          socket.close()
        } else if (typeof socket.terminate === 'function') {
          socket.terminate()
        }
      } catch (error) {
        console.error('[BoardsListWatcher] socket cleanup failed', error)
      }
    }

    if (reconnect && !this.disposed) {
      this.scheduleReconnect({ immediate: true })
    }

    this.onDidChangeCliDaemonConnectionEmitter.fire(false)
  }
}
