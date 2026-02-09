// @ts-check
import { EventEmitter } from '@c4312/evt'
import { createPortKey } from 'boards-list'
import { nanoid } from 'nanoid'
import defer from 'p-defer'
import { CancellationTokenImpl, HOST_EXTENSION } from 'vscode-messenger-common'

import { messengerx } from '@boardlab/base'
import {
  connectMonitorClient,
  disconnectMonitorClient,
  notifyMonitorClientAttached,
  notifyMonitorClientDetached,
  notifyMonitorIntentResume,
  notifyMonitorIntentStart,
  notifyMonitorIntentStop,
  notifyMonitorOpenError,
  notifyMonitorSessionState,
  notifyMonitorStreamData,
  notifyMonitorStreamError,
  notifyMonitorViewDidChangeBaudrate,
  notifyMonitorViewDidChangeDetectedPorts,
  notifyMonitorViewDidChangeMonitorSettings,
  requestMonitorDetectedPorts,
  requestMonitorSendMessage,
  requestMonitorSessionSnapshot,
  requestMonitorUpdateBaudrate,
  notifyMonitorPhysicalStateChanged,
  requestMonitorPhysicalStateSnapshot,
} from '@boardlab/protocol'

/** @typedef {import('@boardlab/protocol').MonitorPhysicalState} MonitorPhysicalState */

const CLIENT_KEY_STORAGE = 'boardlab.monitor.clientKey'

const resolveWebviewId = () => {
  try {
    if (typeof window !== 'undefined') {
      return (
        window.__BOARDLAB_WEBVIEW_ID__ ||
        window.__BOARDLAB_WEBVIEW_TYPE__ ||
        undefined
      )
    }
  } catch {}
  return undefined
}

const resolveClientKey = () => {
  try {
    const webviewId = resolveWebviewId()
    const storageKey = webviewId
      ? `${CLIENT_KEY_STORAGE}:${webviewId}`
      : CLIENT_KEY_STORAGE
    if (typeof window.sessionStorage !== 'undefined') {
      const existing = window.sessionStorage.getItem(storageKey)
      if (existing) {
        return existing
      }
      const next = nanoid()
      window.sessionStorage.setItem(storageKey, next)
      return next
    }
  } catch {}
  return nanoid()
}

class MessengerControlTransport {
  /** @param {import('vscode-messenger-webview').Messenger} messenger */
  constructor(messenger) {
    this._messenger = messenger
    this._didChangeDetectedPorts = new EventEmitter()
    this._didChangeMonitorSettings = new EventEmitter()
    this._didChangeBaudrate = new EventEmitter()
    this._didChangePhysicalState = new EventEmitter()
    this._didChangeSessionState = new EventEmitter()

    const messengerRef = this._messenger
    const messengerDisposables = [
      messengerx.onNotification(
        messengerRef,
        notifyMonitorViewDidChangeDetectedPorts,
        (ports) => this._didChangeDetectedPorts.fire(ports)
      ),
      messengerx.onNotification(
        messengerRef,
        notifyMonitorViewDidChangeMonitorSettings,
        (payload) => this._didChangeMonitorSettings.fire(payload)
      ),
      messengerx.onNotification(
        messengerRef,
        notifyMonitorViewDidChangeBaudrate,
        (payload) => this._didChangeBaudrate.fire(payload)
      ),
      messengerx.onNotification(
        messengerRef,
        notifyMonitorPhysicalStateChanged,
        (payload) => this._didChangePhysicalState.fire(payload)
      ),
      messengerx.onNotification(
        messengerRef,
        notifyMonitorSessionState,
        (payload) => {
          console.log('[monitor-webview] notifyMonitorSessionState', payload)
          this._didChangeSessionState.fire(payload)
        }
      ),
    ]

    this._disposables = [
      this._didChangeDetectedPorts,
      this._didChangeMonitorSettings,
      this._didChangeBaudrate,
      this._didChangePhysicalState,
      this._didChangeSessionState,
      ...messengerDisposables,
    ]
  }

  /** @returns {import('@c4312/evt').Event<import('boards-list').DetectedPorts>} */
  get onDidChangeDetectedPorts() {
    return this._didChangeDetectedPorts.event
  }

  /**
   * @returns {import('@c4312/evt').Event<
   *   import('@boardlab/protocol').MonitorSettingsByProtocol
   * >}
   */
  get onDidChangeMonitorSettings() {
    return this._didChangeMonitorSettings.event
  }

  /** @returns {import('@c4312/evt').Event<MonitorPhysicalState>} */
  get onDidChangePhysicalState() {
    return this._didChangePhysicalState.event
  }

  /**
   * @returns {import('@c4312/evt').Event<
   *   import('@boardlab/protocol').MonitorSessionState
   * >}
   */
  get onDidChangeSessionState() {
    return this._didChangeSessionState.event
  }

  /**
   * @returns {import('@c4312/evt').Event<
   *   import('@boardlab/protocol').DidChangeBaudrateNotification
   * >}
   */
  get onDidChangeBaudrate() {
    return this._didChangeBaudrate.event
  }

  /**
   * @param {string} clientId
   * @param {{ signal?: AbortSignal }} [options]
   */
  async connect(clientId, options = {}) {
    console.info('[monitor client] connect', { clientId })
    const token = new CancellationTokenImpl()
    const { signal } = options
    if (signal) {
      const abortHandler = () => {
        token.cancel()
        signal.removeEventListener('abort', abortHandler)
      }
      signal.addEventListener('abort', abortHandler)
    }

    return this._messenger.sendRequest(
      connectMonitorClient,
      HOST_EXTENSION,
      {
        clientId,
      },
      token
    )
  }

  /** @param {{ signal?: AbortSignal }} [options] */
  async detectedPorts(options = {}) {
    const token = new CancellationTokenImpl()
    const { signal } = options
    if (signal) {
      const abortHandler = () => {
        token.cancel()
        signal.removeEventListener('abort', abortHandler)
      }
      signal.addEventListener('abort', abortHandler)
    }

    return this._messenger.sendRequest(
      requestMonitorDetectedPorts,
      HOST_EXTENSION,
      /** @type {unknown} */ (undefined),
      token
    )
  }

  /** @param {{ signal?: AbortSignal }} [options] */
  async physicalStates(options = {}) {
    const token = new CancellationTokenImpl()
    const { signal } = options
    if (signal) {
      const abortHandler = () => {
        token.cancel()
        signal.removeEventListener('abort', abortHandler)
      }
      signal.addEventListener('abort', abortHandler)
    }

    return this._messenger.sendRequest(
      requestMonitorPhysicalStateSnapshot,
      HOST_EXTENSION,
      /** @type {unknown} */ (undefined),
      token
    )
  }

  /** @param {{ signal?: AbortSignal }} [options] */
  async sessionStates(options = {}) {
    const token = new CancellationTokenImpl()
    const { signal } = options
    if (signal) {
      const abortHandler = () => {
        token.cancel()
        signal.removeEventListener('abort', abortHandler)
      }
      signal.addEventListener('abort', abortHandler)
    }

    return this._messenger.sendRequest(
      requestMonitorSessionSnapshot,
      HOST_EXTENSION,
      /** @type {unknown} */ (undefined),
      token
    )
  }

  /**
   * @param {import('@boardlab/protocol').RequestUpdateBaudrateParams} params
   * @param {{ signal?: AbortSignal }} [options]
   */
  async updateBaudrate(params, options = {}) {
    const token = new CancellationTokenImpl()
    const { signal } = options
    if (signal) {
      const abortHandler = () => {
        token.cancel()
        signal.removeEventListener('abort', abortHandler)
      }
      signal.addEventListener('abort', abortHandler)
    }

    return this._messenger.sendRequest(
      requestMonitorUpdateBaudrate,
      HOST_EXTENSION,
      params,
      token
    )
  }

  /**
   * @param {import('@boardlab/protocol').RequestSendMonitorMessageParams} params
   * @param {{ signal?: AbortSignal }} [options]
   */
  async sendMonitorMessage(params, options = {}) {
    const token = new CancellationTokenImpl()
    const { signal } = options
    if (signal) {
      const abortHandler = () => {
        token.cancel()
        signal.removeEventListener('abort', abortHandler)
      }
      signal.addEventListener('abort', abortHandler)
    }
    return this._messenger.sendRequest(
      requestMonitorSendMessage,
      HOST_EXTENSION,
      params,
      token
    )
  }

  dispose() {
    while (this._disposables.length) {
      try {
        this._disposables.pop()?.dispose()
      } catch (error) {
        console.error(
          '[MonitorClient] dispose messenger transport failed',
          error
        )
      }
    }
  }
}

export class MonitorClient {
  /**
   * @param {{
   *   messenger: import('vscode-messenger-webview').Messenger
   * }} options
   */
  constructor({ messenger }) {
    this._messenger = messenger
    this._clientId = resolveClientKey()
    this._transport = new MessengerControlTransport(messenger)
    this._streamControllers = new Map()

    this._didChangeDetectedPorts = new EventEmitter()
    this._didChangeMonitorSettings = new EventEmitter()
    this._didChangeBaudrate = new EventEmitter()
    this._didChangePhysicalState = new EventEmitter()
    this._didChangeSessionState = new EventEmitter()

    this._transportDisposables = [
      this._didChangeDetectedPorts,
      this._transport.onDidChangeDetectedPorts((ports) =>
        this._fireDidChangeDetectedPorts(ports)
      ),
      this._didChangeMonitorSettings,
      this._transport.onDidChangeMonitorSettings((payload) =>
        this._fireDidChangeMonitorSettings(payload)
      ),
      this._didChangeBaudrate,
      this._transport.onDidChangeBaudrate((payload) =>
        this._fireDidChangeBaudrate(payload)
      ),
      this._didChangePhysicalState,
      this._transport.onDidChangePhysicalState((payload) =>
        this._fireDidChangePhysicalState(payload)
      ),
      this._didChangeSessionState,
      this._transport.onDidChangeSessionState((payload) =>
        this._fireDidChangeSessionState(payload)
      ),
      messengerx.onNotification(messenger, notifyMonitorStreamData, (payload) =>
        this._handleStreamData(payload)
      ),
      messengerx.onNotification(
        messenger,
        notifyMonitorStreamError,
        (payload) => this._handleStreamError(payload)
      ),
    ]

    /**
     * @type {import('p-defer').DeferredPromise<
     *       import('@boardlab/protocol').HostConnectClientResult
     *     >
     *   | undefined}
     */
    this._deferredConnect = undefined
  }

  async connect() {
    if (!this._deferredConnect) {
      const deferred = defer()
      const signal = AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined
      this._transport
        .connect(this._clientId, { signal })
        .then((result) => deferred.resolve(result), deferred.reject)
      this._deferredConnect = deferred
    }
    return this._deferredConnect.promise
  }

  get id() {
    return this._clientId
  }

  /** @returns {import('@c4312/evt').Event<import('boards-list').DetectedPorts>} */
  get onDidChangeDetectedPorts() {
    return this._didChangeDetectedPorts.event
  }

  /** @returns {import('@c4312/evt').Event<MonitorPhysicalState>} */
  get onDidChangePhysicalState() {
    return this._didChangePhysicalState.event
  }

  /**
   * @returns {import('@c4312/evt').Event<
   *   import('@boardlab/protocol').MonitorSessionState
   * >}
   */
  get onDidChangeSessionState() {
    return this._didChangeSessionState.event
  }

  /**
   * @returns {import('@c4312/evt').Event<
   *   import('@boardlab/protocol').MonitorSettingsByProtocol
   * >}
   */
  get onDidChangeMonitorSettings() {
    return this._didChangeMonitorSettings.event
  }

  /** @param {{ signal?: AbortSignal }} [options] */
  async detectedPorts(options = {}) {
    return this._transport.detectedPorts(options)
  }

  /** @param {{ signal?: AbortSignal }} [options] */
  async physicalStates(options = {}) {
    return this._transport.physicalStates(options)
  }

  /** @param {{ signal?: AbortSignal }} [options] */
  async sessionStates(options = {}) {
    return this._transport.sessionStates(options)
  }

  /**
   * @returns {import('@c4312/evt').Event<
   *   import('@boardlab/protocol').DidChangeBaudrateNotification
   * >}
   */
  get onDidChangeBaudrate() {
    return this._didChangeBaudrate.event
  }

  /**
   * @param {import('@boardlab/protocol').RequestUpdateBaudrateParams} params
   * @param {{ signal?: AbortSignal }} [options]
   */
  async updateBaudrate(params, options = {}) {
    return this._transport.updateBaudrate(params, options)
  }

  /**
   * @param {import('@boardlab/protocol').RequestSendMonitorMessageParams} params
   * @param {{ signal?: AbortSignal }} [options]
   */
  async sendMonitorMessage(params, options) {
    return this._transport.sendMonitorMessage(params, options)
  }

  async dispose() {
    try {
      if (this._messenger) {
        this._messenger.sendNotification(
          disconnectMonitorClient,
          HOST_EXTENSION,
          { clientId: this._clientId }
        )
      }
    } catch (error) {
      console.error('Failed to notify monitor disconnect', error)
    }

    while (this._transportDisposables.length) {
      try {
        this._transportDisposables.pop()?.dispose()
      } catch (error) {
        console.error('Failed to dispose monitor client listener', error)
      }
    }
    for (const portKey of this._streamControllers.keys()) {
      this._closeStream(portKey)
    }
    this._transport.dispose()
  }

  /** @param {import('boards-list').PortIdentifier} port */
  notifyClientAttached(port) {
    try {
      this._messenger.sendNotification(
        notifyMonitorClientAttached,
        HOST_EXTENSION,
        { clientId: this._clientId, port }
      )
    } catch (error) {
      console.error('Failed to notify monitor client attached', error)
    }
  }

  /** @param {import('boards-list').PortIdentifier} port */
  notifyClientDetached(port) {
    try {
      this._messenger.sendNotification(
        notifyMonitorClientDetached,
        HOST_EXTENSION,
        { clientId: this._clientId, port }
      )
    } catch (error) {
      console.error('Failed to notify monitor client detached', error)
    }
  }

  /** @param {import('boards-list').PortIdentifier} port */
  notifyIntentStart(port) {
    try {
      this._messenger.sendNotification(
        notifyMonitorIntentStart,
        HOST_EXTENSION,
        { port, clientId: this._clientId }
      )
    } catch (error) {
      console.error('Failed to notify monitor intent start', error)
    }
  }

  /** @param {import('boards-list').PortIdentifier} port */
  notifyIntentStop(port) {
    try {
      this._messenger.sendNotification(
        notifyMonitorIntentStop,
        HOST_EXTENSION,
        { port, clientId: this._clientId }
      )
    } catch (error) {
      console.error('Failed to notify monitor intent stop', error)
    }
  }

  /** @param {import('boards-list').PortIdentifier} port */
  notifyIntentResume(port) {
    try {
      this._messenger.sendNotification(
        notifyMonitorIntentResume,
        HOST_EXTENSION,
        { port, clientId: this._clientId }
      )
    } catch (error) {
      console.error('Failed to notify monitor intent resume', error)
    }
  }

  /** @param {import('@boardlab/protocol').MonitorOpenErrorNotification} payload */
  notifyOpenError(payload) {
    try {
      this._messenger.sendNotification(
        notifyMonitorOpenError,
        HOST_EXTENSION,
        payload
      )
    } catch (error) {
      console.error('Failed to notify monitor open error', error)
    }
  }

  /**
   * @typedef {Object} OpenMonitorParams
   * @property {import('boards-list').PortIdentifier} port
   * @property {string} [baudrate]
   * @property {{ signal?: AbortSignal }} [options]
   */

  /**
   * @param {OpenMonitorParams} params
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<
   *   ReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>>
   * >}
   */
  async openMonitor({ port, baudrate }, options = {}) {
    const { address, protocol } = port
    console.info('[monitor client] openMonitor', {
      address,
      protocol,
      baudrate,
    })
    return this._openWsMonitor(port, options)
  }

  /**
   * @param {import('boards-list').PortIdentifier} port
   * @param {{ signal?: AbortSignal }} [options]
   */
  _openWsMonitor(port, options = {}) {
    const portKey = createPortKey(port)
    this._closeStream(portKey)
    const stream = new ReadableStream({
      start: (controller) => {
        this._streamControllers.set(portKey, controller)
      },
      cancel: () => {
        this._streamControllers.delete(portKey)
      },
    })
    const reader = stream.getReader()
    const { signal } = options
    if (signal) {
      const abortHandler = () => {
        this._closeStream(portKey)
        signal.removeEventListener('abort', abortHandler)
      }
      if (signal.aborted) {
        abortHandler()
      } else {
        signal.addEventListener('abort', abortHandler)
      }
    }
    return reader
  }

  /** @param {import('boards-list').DetectedPorts} detectedPorts */
  _fireDidChangeDetectedPorts(detectedPorts) {
    this._didChangeDetectedPorts.fire(detectedPorts)
  }

  /** @param {import('@boardlab/protocol').MonitorSettingsByProtocol} payload */
  _fireDidChangeMonitorSettings(payload) {
    this._didChangeMonitorSettings.fire(payload)
  }

  /** @param {import('@boardlab/protocol').DidChangeBaudrateNotification} payload */
  _fireDidChangeBaudrate(payload) {
    this._didChangeBaudrate.fire(payload)
  }

  /** @param {MonitorPhysicalState} payload */
  _fireDidChangePhysicalState(payload) {
    this._didChangePhysicalState.fire(payload)
  }

  /** @param {import('@boardlab/protocol').MonitorSessionState} payload */
  _fireDidChangeSessionState(payload) {
    this._didChangeSessionState.fire(payload)
  }

  _closeStream(portKey, error) {
    const controller = this._streamControllers.get(portKey)
    if (!controller) {
      return
    }
    this._streamControllers.delete(portKey)
    try {
      if (error) {
        controller.error(error)
      } else {
        controller.close()
      }
    } catch (err) {
      console.warn('[MonitorClient] Failed to close stream', err)
    }
  }

  _handleStreamData(payload) {
    if (!payload || typeof payload.portKey !== 'string') {
      return
    }
    const controller = this._streamControllers.get(payload.portKey)
    if (!controller) {
      console.log('[monitor-webview] stream data with no controller', {
        portKey: payload.portKey,
      })
      return
    }
    const data = payload.data
    let chunk
    if (data instanceof Uint8Array) {
      chunk = data
    } else if (data instanceof ArrayBuffer) {
      chunk = new Uint8Array(data)
    } else if (ArrayBuffer.isView(data)) {
      chunk = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    } else if (Array.isArray(data)) {
      chunk = new Uint8Array(data)
    }
    if (!chunk) {
      console.log('[monitor-webview] stream data unrecognized payload', {
        portKey: payload.portKey,
        dataType: typeof data,
      })
      return
    }
    try {
      console.log('[monitor-webview] stream data enqueue', {
        portKey: payload.portKey,
        bytes: chunk.length,
      })
      controller.enqueue(chunk)
    } catch (error) {
      console.warn('[MonitorClient] Failed to enqueue monitor data', error)
    }
  }

  _handleStreamError(payload) {
    if (!payload || typeof payload.portKey !== 'string') {
      return
    }
    console.log('[monitor-webview] stream error', payload)
    const message =
      typeof payload.message === 'string'
        ? payload.message
        : 'Monitor stream error'
    const error = Object.assign(new Error(message), {
      code: payload.code,
      status: payload.status,
      source: 'bridge',
    })
    this._closeStream(payload.portKey, error)
  }
}
