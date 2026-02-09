import { createHash } from 'node:crypto'

import type { PortIdentifier } from 'boards-list'
import { createPortKey } from 'boards-list'
import * as vscode from 'vscode'
import type { MessageConnection } from 'vscode-jsonrpc'
import { ConsoleLogger, createWebSocketConnection } from 'vscode-ws-jsonrpc'
import WebSocket from 'ws'

import type { MonitorBridgeInfo } from '@boardlab/protocol'
import {
  RequestMonitorClose,
  RequestMonitorOpen,
  RequestMonitorSubscribe,
  RequestMonitorUnsubscribe,
  RequestMonitorWrite,
  RequestPortinoHello,
} from '@boardlab/protocol'

import { createNodeSocketAdapter } from './wsAdapters'

export interface MonitorBridgeWsClientOptions {
  readonly resolveBridgeInfo: () => Promise<MonitorBridgeInfo>
}

export interface MonitorBridgeSerialOptions {
  readonly dataBits?: number
  readonly parity?: string
  readonly stopBits?: number
  readonly rtscts?: boolean
  readonly [key: string]: unknown
}

export interface MonitorBridgeWsSubscription {
  readonly port: PortIdentifier
  readonly baudrate?: string
  readonly serialOptions?: MonitorBridgeSerialOptions
  readonly tailBytes?: number
}

export interface MonitorBridgeWsDataEvent {
  readonly portKey: string
  readonly monitorId: number
  readonly data: Uint8Array
}

export interface MonitorBridgeWsErrorEvent {
  readonly portKey?: string
  readonly code?: string
  readonly status?: number
  readonly message: string
}

interface SubscriptionState {
  port: PortIdentifier
  baudrate?: string
  serialOptions?: MonitorBridgeSerialOptions
  tailBytes?: number
  count: number
  portKey: string
}

function stableStringify(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return JSON.stringify(value)
  }
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(Object.fromEntries(entries))
}

function hashSerialOptions(options?: MonitorBridgeSerialOptions): string {
  if (!options || typeof options !== 'object') {
    return 'default'
  }
  const normalized = stableStringify(options)
  if (!normalized || normalized === '{}' || normalized === 'null') {
    return 'default'
  }
  return createHash('sha1').update(normalized).digest('hex').slice(0, 8)
}

function buildPortKeys(
  port: PortIdentifier,
  baudrate?: string,
  serialOptions?: MonitorBridgeSerialOptions
): { basePortKey: string; portKey: string } {
  const basePortKey = createPortKey(port)
  const baudPart = baudrate ? String(baudrate) : 'na'
  const optionsHash = hashSerialOptions(serialOptions)
  return {
    basePortKey,
    portKey: `${basePortKey}@${baudPart}@${optionsHash}`,
  }
}

export class MonitorBridgeWsClient implements vscode.Disposable {
  private controlSocket: WebSocket | undefined
  private dataSocket: WebSocket | undefined
  private controlConnection: MessageConnection | undefined
  private connectionPromise: Promise<void> | undefined
  private reconnectTimer: NodeJS.Timeout | undefined
  private clientId: string | undefined
  private readonly subscriptions = new Map<string, SubscriptionState>()
  private readonly monitorIdsByPortKey = new Map<string, number>()
  private readonly monitorIdToPortKey = new Map<number, string>()

  private readonly onDataEmitter =
    new vscode.EventEmitter<MonitorBridgeWsDataEvent>()

  private readonly onErrorEmitter =
    new vscode.EventEmitter<MonitorBridgeWsErrorEvent>()

  constructor(private readonly options: MonitorBridgeWsClientOptions) {}

  get onData(): vscode.Event<MonitorBridgeWsDataEvent> {
    return this.onDataEmitter.event
  }

  get onError(): vscode.Event<MonitorBridgeWsErrorEvent> {
    return this.onErrorEmitter.event
  }

  async resetMonitor(portKey: string): Promise<void> {
    try {
      await this.closeMonitor(portKey)
    } finally {
      this.forgetMonitor(portKey)
    }
  }

  forgetMonitor(portKey: string): void {
    const monitorId = this.monitorIdsByPortKey.get(portKey)
    if (!monitorId) {
      return
    }
    this.monitorIdsByPortKey.delete(portKey)
    this.monitorIdToPortKey.delete(monitorId)
  }

  async subscribe(params: MonitorBridgeWsSubscription): Promise<void> {
    const { basePortKey, portKey } = buildPortKeys(
      params.port,
      params.baudrate,
      params.serialOptions
    )
    const existing = this.subscriptions.get(basePortKey)
    if (existing) {
      existing.count += 1
      if (!this.monitorIdsByPortKey.get(basePortKey)) {
        await this.ensureConnection()
        await this.openAndSubscribe(basePortKey)
      }
      return
    }
    this.subscriptions.set(basePortKey, {
      port: params.port,
      baudrate: params.baudrate,
      serialOptions: params.serialOptions,
      tailBytes: params.tailBytes,
      count: 1,
      portKey,
    })
    await this.ensureConnection()
    await this.openAndSubscribe(basePortKey)
  }

  async unsubscribe(portKey: string): Promise<void> {
    const existing = this.subscriptions.get(portKey)
    if (!existing) {
      return
    }
    existing.count -= 1
    if (existing.count > 0) {
      return
    }
    this.subscriptions.delete(portKey)
    await this.ensureConnection()
    await this.closeMonitor(portKey)
  }

  async write(portKey: string, data: Uint8Array): Promise<void> {
    const monitorId = this.monitorIdsByPortKey.get(portKey)
    if (!monitorId) {
      throw new Error(`No active monitor for ${portKey}`)
    }
    const connection = await this.ensureConnection()
    try {
      await connection.sendRequest(RequestMonitorWrite, {
        monitorId,
        data: Array.from(data),
      })
    } catch (error) {
      this.emitError(portKey, error)
      throw error
    }
  }

  dispose(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.disposeSockets()
    this.onDataEmitter.dispose()
    this.onErrorEmitter.dispose()
  }

  private async openAndSubscribe(basePortKey: string): Promise<void> {
    const entry = this.subscriptions.get(basePortKey)
    if (!entry) {
      return
    }
    console.log('[MonitorBridgeWsClient] openAndSubscribe', {
      basePortKey,
      portKey: entry.portKey,
      baudrate: entry.baudrate,
    })
    const monitorId = await this.openMonitor(basePortKey, entry.portKey)
    const connection = await this.ensureConnection()
    try {
      console.log('[MonitorBridgeWsClient] subscribe', {
        basePortKey,
        monitorId,
        tailBytes: entry.tailBytes,
      })
      await connection.sendRequest(RequestMonitorSubscribe, {
        monitorId,
        tailBytes: entry.tailBytes,
      })
    } catch (error) {
      this.emitError(basePortKey, error)
      throw error
    }
  }

  private async openMonitor(
    basePortKey: string,
    portKey: string
  ): Promise<number> {
    const existing = this.monitorIdsByPortKey.get(basePortKey)
    if (existing) {
      return existing
    }
    const connection = await this.ensureConnection()
    try {
      console.log('[MonitorBridgeWsClient] openMonitor', {
        basePortKey,
        portKey,
      })
      const result = await connection.sendRequest(RequestMonitorOpen, {
        portKey,
      })
      console.log('[MonitorBridgeWsClient] openMonitor result', {
        basePortKey,
        monitorId: result.monitorId,
      })
      this.monitorIdsByPortKey.set(basePortKey, result.monitorId)
      this.monitorIdToPortKey.set(result.monitorId, basePortKey)
      return result.monitorId
    } catch (error) {
      this.emitError(basePortKey, error)
      throw error
    }
  }

  private async closeMonitor(basePortKey: string): Promise<void> {
    const monitorId = this.monitorIdsByPortKey.get(basePortKey)
    if (!monitorId) {
      return
    }
    const connection = await this.ensureConnection()
    try {
      await connection.sendRequest(RequestMonitorUnsubscribe, {
        monitorId,
      })
    } catch {}
    try {
      await connection.sendRequest(RequestMonitorClose, {
        monitorId,
      })
    } catch {}
    this.monitorIdsByPortKey.delete(basePortKey)
    this.monitorIdToPortKey.delete(monitorId)
  }

  private async ensureConnection(): Promise<MessageConnection> {
    if (this.connectionPromise) {
      await this.connectionPromise
      if (!this.controlConnection) {
        throw new Error('Monitor bridge connection unavailable')
      }
      return this.controlConnection
    }
    if (this.controlConnection && this.controlSocket && this.dataSocket) {
      return this.controlConnection
    }
    this.connectionPromise = this.openConnection()
    try {
      await this.connectionPromise
    } finally {
      this.connectionPromise = undefined
    }
    if (!this.controlConnection) {
      throw new Error('Monitor bridge connection unavailable')
    }
    return this.controlConnection
  }

  private async openConnection(): Promise<void> {
    const info = await this.options.resolveBridgeInfo()
    const controlUrl = new URL(info.wsUrl)
    controlUrl.pathname = '/control'

    const controlSocket = new WebSocket(controlUrl.toString(), {
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
        controlSocket.off('open', onOpen)
        controlSocket.off('error', onError)
      }
      controlSocket.once('open', onOpen)
      controlSocket.once('error', onError)
    })

    const socketAdapter = createNodeSocketAdapter(controlSocket)
    const connection = createWebSocketConnection(
      socketAdapter,
      new ConsoleLogger()
    )
    connection.listen()

    const hello = await connection.sendRequest(RequestPortinoHello)
    this.clientId = hello.clientId

    const dataUrl = new URL(info.wsUrl)
    dataUrl.pathname = '/data'
    dataUrl.searchParams.set('clientId', this.clientId)

    const dataSocket = new WebSocket(dataUrl.toString(), {
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
        dataSocket.off('open', onOpen)
        dataSocket.off('error', onError)
      }
      dataSocket.once('open', onOpen)
      dataSocket.once('error', onError)
    })

    dataSocket.on('message', (raw) => this.handleDataMessage(raw))

    const onClose = () => this.handleConnectionLost()
    const onError = (error: unknown) => this.handleConnectionLost(error)
    controlSocket.on('close', onClose)
    controlSocket.on('error', onError)
    dataSocket.on('close', onClose)
    dataSocket.on('error', onError)

    this.controlSocket = controlSocket
    this.dataSocket = dataSocket
    this.controlConnection = connection

    this.resubscribeAll().catch((error) => {
      console.error('[MonitorBridgeWsClient] resubscribe failed', error)
    })
  }

  private async resubscribeAll(): Promise<void> {
    for (const [portKey, entry] of this.subscriptions.entries()) {
      if (entry.count <= 0) {
        continue
      }
      try {
        await this.openAndSubscribe(portKey)
      } catch (error) {
        this.emitError(portKey, error)
      }
    }
  }

  private handleConnectionLost(error?: unknown): void {
    if (error) {
      console.warn('[MonitorBridgeWsClient] connection lost', error)
    } else {
      console.warn('[MonitorBridgeWsClient] connection closed')
    }
    this.disposeSockets()
    this.monitorIdsByPortKey.clear()
    this.monitorIdToPortKey.clear()
    this.clientId = undefined
    if (this.reconnectTimer) {
      return
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.ensureConnection().catch((err) => {
        console.error('[MonitorBridgeWsClient] reconnect failed', err)
      })
    }, 1_000)
  }

  private disposeSockets(): void {
    if (this.controlConnection) {
      try {
        this.controlConnection.dispose()
      } catch {}
      this.controlConnection = undefined
    }
    if (this.controlSocket) {
      try {
        this.controlSocket.close()
      } catch {}
      this.controlSocket = undefined
    }
    if (this.dataSocket) {
      try {
        this.dataSocket.close()
      } catch {}
      this.dataSocket = undefined
    }
  }

  private handleDataMessage(raw: WebSocket.RawData): void {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer)
    if (buf.length < 5) {
      return
    }
    const monitorId = buf.readUInt32LE(0)
    const kind = buf.readUInt8(4)
    if (kind !== 0) {
      return
    }
    const portKey = this.monitorIdToPortKey.get(monitorId)
    if (!portKey) {
      console.warn('[MonitorBridgeWsClient] data with unknown monitorId', {
        monitorId,
      })
      return
    }
    const payload = new Uint8Array(
      buf.buffer,
      buf.byteOffset + 5,
      buf.length - 5
    )
    console.log('[MonitorBridgeWsClient] data', {
      portKey,
      monitorId,
      bytes: payload.length,
    })
    this.onDataEmitter.fire({
      portKey,
      monitorId,
      data: payload,
    })
  }

  private emitError(portKey: string, error: unknown): void {
    const message =
      error instanceof Error ? error.message : String(error ?? 'Monitor error')
    const data =
      error && typeof error === 'object' && 'data' in error
        ? (error as { data?: unknown }).data
        : undefined
    const dataObject =
      data && typeof data === 'object'
        ? (data as { code?: unknown; status?: unknown })
        : undefined
    this.onErrorEmitter.fire({
      portKey,
      code: typeof dataObject?.code === 'string' ? dataObject.code : undefined,
      status:
        typeof dataObject?.status === 'number' ? dataObject.status : undefined,
      message,
    })
  }
}
