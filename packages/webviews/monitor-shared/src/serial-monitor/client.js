// @ts-check
import {
  connectMonitorClient,
  disconnectMonitorClient,
  notifyMonitorViewDidChangeBaudrate,
  notifyMonitorViewDidChangeDetectedPorts,
  notifyMonitorViewDidChangeMonitorSettings,
  notifyMonitorViewDidPause,
  notifyMonitorViewDidResume,
  requestMonitorDetectedPorts,
  requestMonitorSendMessage,
  requestMonitorUpdateBaudrate,
} from '@boardlab/protocol'
import { EventEmitter } from '@c4312/evt'
import { nanoid } from 'nanoid'
import defer from 'p-defer'
import { CancellationTokenImpl, HOST_EXTENSION } from 'vscode-messenger-common'

class MessengerControlTransport {
  /** @param {import('vscode-messenger-webview').Messenger} messenger */
  constructor(messenger) {
    this._messenger = messenger
    this._didChangeDetectedPorts = new EventEmitter()
    this._didChangeMonitorSettings = new EventEmitter()
    this._didChangeBaudrate = new EventEmitter()
    this._didPauseMonitor = new EventEmitter()
    this._didResumeMonitor = new EventEmitter()

    this._messenger.onNotification(
      notifyMonitorViewDidChangeDetectedPorts,
      (ports) => this._didChangeDetectedPorts.fire(ports)
    )
    this._messenger.onNotification(
      notifyMonitorViewDidChangeMonitorSettings,
      (payload) => this._didChangeMonitorSettings.fire(payload)
    )
    this._messenger.onNotification(
      notifyMonitorViewDidChangeBaudrate,
      (payload) => this._didChangeBaudrate.fire(payload)
    )
    this._messenger.onNotification(notifyMonitorViewDidPause, (payload) =>
      this._didPauseMonitor.fire(payload)
    )
    this._messenger.onNotification(notifyMonitorViewDidResume, (payload) =>
      this._didResumeMonitor.fire(payload)
    )

    this._disposables = [
      this._didChangeDetectedPorts,
      this._didChangeMonitorSettings,
      this._didChangeBaudrate,
      this._didPauseMonitor,
      this._didResumeMonitor,
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

  /**
   * @returns {import('@c4312/evt').Event<
   *   import('@boardlab/protocol').DidChangeBaudrateNotification
   * >}
   */
  get onDidChangeBaudrate() {
    return this._didChangeBaudrate.event
  }

  /**
   * @returns {import('@c4312/evt').Event<
   *   import('@boardlab/protocol').DidPauseMonitorNotification
   * >}
   */
  get onDidPauseMonitor() {
    return this._didPauseMonitor.event
  }

  /**
   * @returns {import('@c4312/evt').Event<
   *   import('@boardlab/protocol').DidResumeMonitorNotification
   * >}
   */
  get onDidResumeMonitor() {
    return this._didResumeMonitor.event
  }

  /**
   * @param {string} clientId
   * @param {{ signal?: AbortSignal }} [options]
   */
  async connect(clientId, options = {}) {
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
   *   httpBaseUrl: string
   * }} options
   */
  constructor({ messenger, httpBaseUrl }) {
    this._messenger = messenger
    this._clientId = nanoid()
    this._transport = new MessengerControlTransport(messenger)
    this._httpBaseUrl = new URL(httpBaseUrl)

    this._didChangeDetectedPorts = new EventEmitter()
    this._didChangeMonitorSettings = new EventEmitter()
    this._didChangeBaudrate = new EventEmitter()
    this._didPauseMonitor = new EventEmitter()
    this._didResumeMonitor = new EventEmitter()

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
      this._didPauseMonitor,
      this._transport.onDidPauseMonitor((payload) =>
        this._fireDidPauseMonitor(payload)
      ),
      this._didResumeMonitor,
      this._transport.onDidResumeMonitor((payload) =>
        this._fireDidResumeMonitor(payload)
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
        .then(deferred.resolve, deferred.reject)
      this._deferredConnect = deferred
    }
    return this._deferredConnect.promise
  }

  /** @returns {import('@c4312/evt').Event<import('boards-list').DetectedPorts>} */
  get onDidChangeDetectedPorts() {
    return this._didChangeDetectedPorts.event
  }

  /**
   * @returns {import('@c4312/evt').Event<
   *   import('@boardlab/protocol').DidPauseMonitorNotification
   * >}
   */
  get onDidPauseMonitor() {
    return this._didPauseMonitor.event
  }

  /**
   * @returns {import('@c4312/evt').Event<
   *   import('@boardlab/protocol').DidResumeMonitorNotification
   * >}
   */
  get onDidResumeMonitor() {
    return this._didResumeMonitor.event
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
    this._transport.dispose()
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
  async openMonitor({ port: { address, protocol }, baudrate }, options = {}) {
    const dataUrl = this._createHttpUrl('/monitor')
    dataUrl.searchParams.set('protocol', protocol)
    dataUrl.searchParams.set('address', address)
    if (baudrate) {
      dataUrl.searchParams.set('baudrate', baudrate)
    }
    dataUrl.searchParams.set('clientid', this._clientId)

    const res = await fetch(dataUrl.toString(), { signal: options.signal })
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`Failed to open monitor on ${address}: ${text}`)
    }

    const reader = res.body?.getReader()
    if (!reader) {
      throw new Error('No reader available for response body')
    }

    return reader
  }

  /**
   * @typedef {Object} CompileParams
   * @property {import('fqbn').FQBN} fqbn
   * @property {string} sketchFolderPath
   */

  /**
   * @param {CompileParams} params
   * @param {{ signal?: AbortSignal }} [options]
   */
  async compile({ fqbn, sketchFolderPath }, options = {}) {
    const dataUrl = this._createHttpUrl('/compile')
    dataUrl.searchParams.set('fqbn', fqbn.toString())
    dataUrl.searchParams.set('sketch', encodeURIComponent(sketchFolderPath))

    const res = await fetch(dataUrl.toString(), {
      method: 'POST',
      signal: options.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(
        `Failed to compile sketch ${sketchFolderPath} for board ${fqbn}: ${text}`
      )
    }
  }

  /**
   * @typedef {Object} UploadParams
   * @property {import('fqbn').FQBN} fqbn
   * @property {string} sketchFolderPath
   * @property {import('boards-list').PortIdentifier} port
   */

  /**
   * @param {UploadParams} params
   * @param {{ signal?: AbortSignal }} [options]
   */
  async upload(
    { fqbn, sketchFolderPath, port: { protocol, address } },
    options = {}
  ) {
    const dataUrl = this._createHttpUrl('/upload')
    dataUrl.searchParams.set('fqbn', encodeURIComponent(fqbn.toString()))
    dataUrl.searchParams.set('sketch', encodeURIComponent(sketchFolderPath))
    dataUrl.searchParams.set('protocol', protocol)
    dataUrl.searchParams.set('address', encodeURIComponent(address))

    const res = await fetch(dataUrl.toString(), {
      method: 'POST',
      signal: options.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(
        `Failed to compile sketch ${sketchFolderPath} for board ${fqbn}: ${text}`
      )
    }
  }

  /** @param {string} pathname */
  _createHttpUrl(pathname) {
    const base = new URL(this._httpBaseUrl.toString())
    base.pathname = pathname
    base.search = ''
    base.hash = ''
    return base
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

  /** @param {import('@boardlab/protocol').DidPauseMonitorNotification} payload */
  _fireDidPauseMonitor(payload) {
    this._didPauseMonitor.fire(payload)
  }

  /** @param {import('@boardlab/protocol').DidResumeMonitorNotification} payload */
  _fireDidResumeMonitor(payload) {
    this._didResumeMonitor.fire(payload)
  }
}

/** @param {URL} wsUrl */
function deriveHttpBase(wsUrl) {
  const base = new URL(wsUrl.toString())
  base.protocol = base.protocol === 'wss:' ? 'https:' : 'http:'
  base.pathname = ''
  base.hash = ''
  base.search = ''
  return base
}
