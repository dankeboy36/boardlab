// @ts-check
import path from 'node:path'

import { EnumerateMonitorPortSettingsRequest, Port } from 'ardunno-cli'
import { createPortKey, parsePortKey } from 'boards-list'
import defer from 'p-defer'

import { watchBoardListState } from './boardListWatch.js'
import { createCoreClient, initCoreClient } from './coreClient.js'
import { createMonitor } from './monitor.js'
import { startDaemon } from './startDaemon.js'

/**
 * @typedef {Object} MonitorRef
 * @property {import('./monitor.js').PortinoMonitor} monitor
 * @property {number} refs
 * @property {string | undefined} baudrate
 */

/**
 * @callback CreateBoardListWatchCallback
 * @returns {Promise<import('./boardListWatch.js').BoardListStateWatcher>}
 */

/**
 * @callback AcquireMonitorCallback
 * @param {{
 *   port: import('boards-list').PortIdentifier
 *   baudrate?: string
 *   fqbn?: import('fqbn').FQBN
 * }} params
 * @param {(
 *   event: import('@boardlab/protocol').DidChangeBaudrateNotification
 * ) => void} onDidChangeBaudrate
 * @returns {Promise<import('./monitor.js').PortinoMonitor>}
 */

/**
 * // TODO: add FQBN refinement
 *
 * @callback FetchMonitorSettingsForProtocolCallback
 * @param {...string} protocols
 * @returns {Promise<
 *   Record<
 *     string,
 *     import('ardunno-cli').MonitorPortSettingDescriptor[] | Error
 *   >
 * >}
 */

/**
 * @callback UpdateBaudrateCallback
 * @param {import('boards-list').PortIdentifier} port
 * @param {string} baudrate
 * @param {(
 *   event: import('@boardlab/protocol').DidChangeBaudrateNotification
 * ) => void} onDidChangeBaudrate
 * @returns {Promise<void>}
 */

/**
 * @callback ReleaseMonitorCallback
 * @param {import('boards-list').PortIdentifier} [port]
 * @returns {Promise<void>}
 */

/**
 * @callback SuspendCallback
 * @param {import('boards-list').PortIdentifier} port
 * @param {() => Promise<import('boards-list').PortIdentifier | undefined>} task
 * @param {(
 *   event: import('@boardlab/protocol').DidPauseMonitorNotification
 * ) => void} onDidPauseMonitor
 * @param {(
 *   event: import('@boardlab/protocol').DidResumeMonitorNotification
 * ) => void} onDidResumeMonitor
 * @returns {Promise<void>}
 */

/**
 * @callback DisposeCallback
 * @returns {Promise<void>}
 */

/**
 * @typedef {Object} CreateBoardListWatchProps
 * @property {CreateBoardListWatchCallback} createBoardListWatch
 */

/**
 * @typedef {Object} AcquireMonitorProps
 * @property {AcquireMonitorCallback} acquireMonitor
 */

/**
 * @typedef {Object} FetchMonitorSettingsForProtocolProps
 * @property {FetchMonitorSettingsForProtocolCallback} fetchMonitorSettingsForProtocol
 */

/**
 * @typedef {Object} UpdateBaudrateProps
 * @property {UpdateBaudrateCallback} updateBaudrate
 */

/**
 * @typedef {Object} SelectedBaudratesProps
 * @property {[import('boards-list').PortIdentifier, string][]} selectedBaudrates
 */

/**
 * @typedef {Object} SuspendedPortKeysProps
 * @property {string[]} suspendedPortKeys
 */

/**
 * @typedef {Object} MonitorSummary
 * @property {string} portKey
 * @property {import('boards-list').PortIdentifier} port
 * @property {number} refs
 * @property {string | undefined} baudrate
 * @property {boolean} paused
 */

/**
 * @typedef {Object} MonitorSummariesProps
 * @property {() => MonitorSummary[]} getMonitorSummaries
 */

/**
 * @typedef {Object} ReleaseMonitorProps
 * @property {ReleaseMonitorCallback} releaseMonitor
 */

/**
 * @callback PauseMonitorCallback
 * @param {import('boards-list').PortIdentifier} port
 * @returns {Promise<boolean>}
 */

/**
 * @callback ResumeMonitorCallback
 * @param {import('boards-list').PortIdentifier} port
 * @returns {Promise<boolean>}
 */

/**
 * @typedef {Object} PauseResumeMonitorProps
 * @property {PauseMonitorCallback} pauseMonitor
 * @property {ResumeMonitorCallback} resumeMonitor
 */

/**
 * @typedef {Object} DisposeProps
 * @property {DisposeCallback} dispose
 */

/**
 * @typedef {CreateBoardListWatchProps &
 *   AcquireMonitorProps &
 *   FetchMonitorSettingsForProtocolProps &
 *   UpdateBaudrateProps &
 *   SelectedBaudratesProps &
 *   SuspendedPortKeysProps &
 *   MonitorSummariesProps &
 *   ReleaseMonitorProps &
 *   PauseResumeMonitorProps &
 *   DisposeProps} CliBridge
 */

/** @type {CliBridge} */
export class DaemonCliBridge {
  /**
   * @param {{
   *   address?: import('./startDaemon.js').DaemonAddress
   *   disposeMonitorOnLastClose?: boolean
   *   cliPath?: string
   * }} options
   */
  constructor(options = {}) {
    /** @type {string | undefined} */
    this._cliPathOverride = options.cliPath
    this._disposeMonitorOnLastClose = options.disposeMonitorOnLastClose ?? true

    /**
     * @type {import('p-defer').DeferredPromise<{
     *       address: import('./startDaemon.js').DaemonAddress
     *       cp?: import('node:child_process').ChildProcess
     *     }>
     *   | undefined}
     */
    this._daemon = undefined
    if (options.address) {
      this._daemon = defer()
      this._daemon.resolve({ address: options.address })
    }

    /**
     * @type {import('p-defer').DeferredPromise<
     *       Awaited<ReturnType<typeof initCoreClient>>
     *     >
     *   | undefined}
     */
    this._coreClient = undefined

    /** @type {Record<string, MonitorRef>} */
    this._monitors = {}

    /**
     * @type {Record<
     *   string,
     *   Promise<import('ardunno-cli').MonitorPortSettingDescriptor[]> | Error
     * >}
     */
    this._monitorSettings = {}
  }

  async createBoardListWatch() {
    const { client, instance } = await this._initClientIfNeeded()
    return watchBoardListState(client, instance)
  }

  async _startDaemonIfNeeded() {
    if (this._daemon) return this._daemon.promise

    /**
     * @type {import('p-defer').DeferredPromise<{
     *   address: import('./startDaemon.js').DaemonAddress
     *   cp?: import('node:child_process').ChildProcess
     * }>}
     */
    const deferred = defer()
    this._daemon = deferred
    this._startDaemon().then(
      (daemon) => deferred.resolve(daemon),
      (err) => {
        deferred.reject(err)
        this._daemon = undefined
      }
    )

    return this._daemon.promise
  }

  async _startDaemon() {
    const cliPath = this._cliPathOverride
      ? this._cliPathOverride
      : path.resolve(__dirname, '../arduino-cli')

    const daemon = await startDaemon({ cliPath })
    return daemon
  }

  async _initClientIfNeeded() {
    if (this._coreClient) return this._coreClient.promise

    /**
     * @type {import('p-defer').DeferredPromise<
     *   Awaited<ReturnType<typeof initCoreClient>>
     * >}
     */
    const deferred = defer()
    this._coreClient = deferred

    this._initClient().then(
      (coreClient) => deferred.resolve(coreClient),
      (err) => {
        deferred.reject(err)
        this._coreClient = undefined
      }
    )

    return this._coreClient.promise
  }

  async _initClient() {
    const { address } = await this._startDaemonIfNeeded()
    const core = createCoreClient({ address })
    const coreClient = await initCoreClient(core)
    return coreClient
  }

  /** @type {AcquireMonitorCallback} */
  async acquireMonitor(
    { port, baudrate = undefined, fqbn = undefined },
    onDidChangeBaudrate
  ) {
    const { client, instance } = await this._initClientIfNeeded()

    const portIdentifierKey = createPortKey(port)
    const existingMonitorRef = this._monitors[portIdentifierKey]
    if (existingMonitorRef) {
      if (typeof baudrate === 'string') {
        await this._maybeUpdateBaudrate(
          existingMonitorRef,
          port,
          baudrate,
          onDidChangeBaudrate
        )
      }
      existingMonitorRef.refs++
      return existingMonitorRef.monitor
    }

    const monitor = createMonitor({
      client,
      instance,
      port: Port.fromPartial(port),
      baudrate,
      fqbn,
    })
    this._monitors[portIdentifierKey] = {
      monitor,
      refs: 1,
      baudrate,
    }

    return monitor
  }

  /** @type {FetchMonitorSettingsForProtocolCallback} */
  async fetchMonitorSettingsForProtocol(...protocols) {
    const fetches = []

    for (const protocol of protocols) {
      const fetchPromise = this._monitorSettings[protocol]
      if (!fetchPromise) {
        const deferred = defer()
        this._monitorSettings[protocol] = deferred.promise
        this._fetchMonitorPortSettings(protocol).then(
          (settings) => deferred.resolve(settings),
          (error) => deferred.resolve(error)
        )
      }
      fetches.push(this._monitorSettings[protocol])
    }

    const results = await Promise.all(fetches)

    /**
     * @type {Record<
     *   string,
     *   import('ardunno-cli').MonitorPortSettingDescriptor[] | Error
     * >}
     */
    const settings = {}
    for (let i = 0; i < protocols.length; i++) {
      settings[protocols[i]] = results[i]
    }
    return settings
  }

  /**
   * @param {string} [protocol='serial'] Default is `'serial'`
   * @param {import('fqbn').FQBN} [fqbn=undefined] Default is `undefined`
   * @returns {Promise<import('ardunno-cli').MonitorPortSettingDescriptor[]>}
   */
  async _fetchMonitorPortSettings(protocol = 'serial', fqbn = undefined) {
    const { client, instance } = await this._initClientIfNeeded()
    const { settings } = await client.enumerateMonitorPortSettings(
      EnumerateMonitorPortSettingsRequest.fromPartial({
        instance,
        fqbn: fqbn?.toString(),
        portProtocol: protocol,
      })
    )
    return settings
  }

  /** @type {UpdateBaudrateCallback} */
  async updateBaudrate(port, baudrate, onDidChangeBaudrate) {
    const portIdentifierKey = createPortKey(port)
    const monitorRef = this._monitors[portIdentifierKey]
    if (!monitorRef) {
      throw new Error(`Monitor for port ${portIdentifierKey} not found`)
    }
    await this._maybeUpdateBaudrate(
      monitorRef,
      port,
      baudrate,
      onDidChangeBaudrate
    )
  }

  /**
   * @param {MonitorRef} monitorRef
   * @param {import('boards-list').PortIdentifier} port
   * @param {string} baudrate
   * @param {(
   *   event: import('@boardlab/protocol').DidChangeBaudrateNotification
   * ) => void} onDidChangeBaudrate
   */
  async _maybeUpdateBaudrate(monitorRef, port, baudrate, onDidChangeBaudrate) {
    if (monitorRef.baudrate === baudrate) {
      return
    }
    await monitorRef.monitor.updateBaudrate(baudrate)
    monitorRef.baudrate = baudrate
    onDidChangeBaudrate({ port, baudrate })
  }

  get selectedBaudrates() {
    /** @type {[import('boards-list').PortIdentifier, string][]} */
    const baudrates = []
    for (const portIdentifierKey in this._monitors) {
      const monitorRef = this._monitors[portIdentifierKey]
      const port = parsePortKey(portIdentifierKey)
      if (!port) {
        console.warn(
          '[portino][cliBridge] skipping invalid port identifier key',
          portIdentifierKey
        )
        continue
      }
      if (typeof monitorRef.baudrate === 'string') {
        baudrates.push([
          { protocol: port.protocol, address: port.address },
          monitorRef.baudrate,
        ])
      }
    }
    return baudrates
  }

  getMonitorSummaries() {
    /** @type {MonitorSummary[]} */
    const summaries = []
    for (const portIdentifierKey in this._monitors) {
      const monitorRef = this._monitors[portIdentifierKey]
      const port = parsePortKey(portIdentifierKey)
      if (!port) {
        continue
      }
      summaries.push({
        portKey: portIdentifierKey,
        port,
        refs: monitorRef.refs,
        baudrate: monitorRef.baudrate,
        paused: monitorRef.monitor.isPaused(),
      })
    }
    return summaries
  }

  /** @type {string[]} */
  get suspendedPortKeys() {
    return Object.entries(this._monitors)
      .filter(([, ref]) => ref.monitor.isPaused())
      .map(([portKey]) => portKey)
  }

  /** @type {ReleaseMonitorCallback} */
  async releaseMonitor(port) {
    if (!port) {
      // Release all monitors if no port is specified.
      this._releaseAllMonitors()
      return
    }
    const portIdentifierKey = createPortKey(port)
    const monitorRef = this._monitors[portIdentifierKey]
    if (!monitorRef) {
      // Already released or never acquired; treat as no-op.
      return
    }

    monitorRef.refs--
    if (monitorRef.refs > 0) return

    if (this._disposeMonitorOnLastClose) {
      await monitorRef.monitor.dispose?.()
      delete this._monitors[portIdentifierKey]
    }
  }

  /** @type {PauseMonitorCallback} */
  async pauseMonitor(port) {
    const portIdentifierKey = createPortKey(port)
    const monitorRef = this._monitors[portIdentifierKey]
    if (!monitorRef) {
      return false
    }
    if (monitorRef.monitor.isPaused()) {
      return false
    }
    console.log('[portino][cliBridge] pauseMonitor:start', {
      port: portIdentifierKey,
    })
    await monitorRef.monitor.pause()
    console.log('[portino][cliBridge] pauseMonitor:resolved', {
      port: portIdentifierKey,
    })
    return true
  }

  /** @type {ResumeMonitorCallback} */
  async resumeMonitor(port) {
    const portIdentifierKey = createPortKey(port)
    const monitorRef = this._monitors[portIdentifierKey]
    if (!monitorRef) {
      return false
    }
    if (!monitorRef.monitor.isPaused()) {
      return false
    }
    console.log('[portino][cliBridge] resumeMonitor:start', {
      port: portIdentifierKey,
    })
    await monitorRef.monitor.resume()
    console.log('[portino][cliBridge] resumeMonitor:resolved', {
      port: portIdentifierKey,
    })
    return true
  }

  /** @type {SuspendCallback} */
  async suspend(port, task, onDidPauseMonitor, onDidResumeMonitor) {
    const portIdentifierKey = createPortKey(port)
    const monitorRef = this._monitors[portIdentifierKey]
    if (monitorRef) {
      await monitorRef.monitor.pause()
      onDidPauseMonitor({ port })
      /** @type {import('boards-list').PortIdentifier | undefined} */
      let newPort
      try {
        newPort = await task()
      } finally {
        await monitorRef.monitor.resume()
        onDidResumeMonitor({
          didPauseOnPort: port,
          didResumeOnPort: newPort,
        })
      }
    }
  }

  async _releaseAllMonitors() {
    for (const portIdentifierKey in this._monitors) {
      const monitorRef = this._monitors[portIdentifierKey]
      await monitorRef.monitor.dispose()
      delete this._monitors[portIdentifierKey]
    }
  }

  /** @type {DisposeCallback} */
  async dispose() {
    if (this._daemon) {
      const { cp } = await this._daemon.promise
      if (cp && !cp.killed) {
        cp.kill() // TODO: proper kill with await on exit
      }
    }

    // TODO: close gRPC channel if was created by this instance

    await this._releaseAllMonitors()
  }
}
