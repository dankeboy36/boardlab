// @ts-check
import EventEmitter from 'node:events'

import { Port } from 'ardunno-cli'
import { createPortKey } from 'boards-list'
import pDefer from 'p-defer'

/** A lightweight in-memory mock of CliBridge for tests. */

/** @type {import('./cliBridge.js').CliBridge} */
export class MockCliBridge {
  /** @type {string[]} */
  suspendedPortKeys = []
  /**
   * @param {{
   *   ports?: {
   *     protocol: string
   *     address: string
   *     boards?: { name: string; fqbn: string }[]
   *   }[]
   *   baudrates?: string[]
   *   busyPorts?: Set<string>
   * }} [options]
   */
  constructor(options = {}) {
    this._ports = options.ports ?? [
      {
        protocol: 'serial',
        address: '/dev/tty.usbmock-1',
        boards: [{ name: 'Mock Uno', fqbn: 'arduino:avr:uno' }],
      },
      {
        protocol: 'serial',
        address: '/dev/tty.usbmock-2',
        boards: [{ name: 'Mock Nano', fqbn: 'arduino:avr:nano' }],
      },
      {
        protocol: 'teensy',
        address: 'usb:1000000',
        boards: [{ name: 'Mock Teensy', fqbn: 'teensy:avr:teensy41' }],
      },
      {
        protocol: 'network',
        address: '192.168.1.100',
        boards: [{ name: 'Mock Ethernet Board', fqbn: 'arduino:samd:mkr1000' }],
      },
    ]
    this._baudrates = options.baudrates ?? ['9600', '115200']
    this._busy = options.busyPorts ?? new Set()
    /**
     * @type {Record<
     *   string,
     *   {
     *     monitor: import('./monitor.js').PortinoMonitor
     *     refs: number
     *     baudrate?: string
     *   }
     * >}
     */
    this._monitors = {}
    /** @type {Record<string, number>} */
    this._portCounters = {}
    /** @type {import('events').EventEmitter | undefined} */
    this._watcherEmitter = undefined
    /** @type {Record<string, import('boards-list').DetectedPort>} */
    this._watcherState = {}
  }

  /** @type {import('./cliBridge.js').CreateBoardListWatchCallback} */
  async createBoardListWatch() {
    const emitter = new EventEmitter()
    this._watcherEmitter = emitter
    // Build state from current ports
    this._watcherState = {}
    for (const p of this._ports) {
      const key = createPortKey({ protocol: p.protocol, address: p.address })
      this._watcherState[key] = {
        port: Port.fromPartial({ protocol: p.protocol, address: p.address }),
        boards: (p.boards ?? []).map((b) => ({ name: b.name, fqbn: b.fqbn })),
      }
    }
    // Emit an initial update on next tick
    setTimeout(() => emitter.emit('update', { ...this._watcherState }), 0)
    const self = this
    return {
      emitter,
      get state() {
        return { ...self._watcherState }
      },
      dispose: () => emitter.removeAllListeners(),
    }
  }

  /** @private */
  _notifyBoardListUpdate() {
    if (!this._watcherEmitter) return
    try {
      this._watcherEmitter.emit('update', { ...this._watcherState })
    } catch {}
  }

  /**
   * Simulate device detach. Accepts a port identifier or port key string.
   *
   * @param {import('boards-list').PortIdentifier | string} port
   */
  detachPort(port) {
    const key = typeof port === 'string' ? port : createPortKey(port)
    // Remove from exposed watcher state
    if (this._watcherState[key]) delete this._watcherState[key]
    // Remove from internal list of available ports
    this._ports = this._ports.filter(
      (p) => createPortKey({ protocol: p.protocol, address: p.address }) !== key
    )
    this._notifyBoardListUpdate()
  }

  /**
   * Simulate device attach.
   *
   * @param {{
   *   protocol: string
   *   address: string
   *   boards?: { name: string; fqbn: string }[]
   * }} p
   */
  attachPort(p) {
    const key = createPortKey({ protocol: p.protocol, address: p.address })
    // Add to internal list if not present
    if (
      !this._ports.find(
        (q) =>
          createPortKey({ protocol: q.protocol, address: q.address }) === key
      )
    ) {
      this._ports.push({
        protocol: p.protocol,
        address: p.address,
        boards: p.boards ?? [],
      })
    }
    this._watcherState[key] = {
      port: Port.fromPartial({ protocol: p.protocol, address: p.address }),
      boards: (p.boards ?? []).map((b) => ({ name: b.name, fqbn: b.fqbn })),
    }
    this._notifyBoardListUpdate()
  }

  /** @type {import('./cliBridge.js').FetchMonitorSettingsForProtocolCallback} */
  async fetchMonitorSettingsForProtocol(...protocols) {
    /** @type {Record<string, any[] | Error>} */
    const result = {}
    for (const p of protocols) {
      if (p === 'serial') {
        result[p] = [
          {
            settingId: 'baudrate',
            value: this._baudrates[0],
            enumValues: this._baudrates,
          },
        ]
      } else if (p === 'teensy') {
        result[p] = []
      } else {
        result[p] = new Error(`Unsupported protocol: ${p}`)
      }
    }
    return result
  }

  /** @type {import('./cliBridge.js').AcquireMonitorCallback} */
  async acquireMonitor(params, onDidChangeBaudrate) {
    const key = createPortKey(params.port)
    if (this._busy.has(key)) {
      const err = new Error('Serial port busy')
      // Simulate grpc ClientError detail formatting
      // @ts-ignore
      err.details = 'Serial port busy'
      throw err
    }
    const existing = this._monitors[key]
    if (existing) {
      if (params.baudrate && existing.baudrate !== params.baudrate) {
        await existing.monitor.updateBaudrate(params.baudrate)
        existing.baudrate = params.baudrate
        onDidChangeBaudrate({ port: params.port, baudrate: params.baudrate })
      }
      existing.refs += 1
      return existing.monitor
    }

    const monitor = this._createMockMonitor(params, onDidChangeBaudrate)
    this._monitors[key] = { monitor, refs: 1, baudrate: params.baudrate }
    return monitor
  }

  /** @type {import('./cliBridge.js').ReleaseMonitorCallback} */
  async releaseMonitor(port) {
    if (!port) {
      const ports = Object.keys(this._monitors)
      await Promise.all(ports.map((p) => this.releaseMonitor(parsePortKey(p))))
      return
    }
    const key = createPortKey(port)
    const ref = this._monitors[key]
    if (!ref) return
    ref.refs -= 1
    if (ref.refs <= 0) {
      try {
        await ref.monitor.dispose()
      } catch {}
      delete this._monitors[key]
      this.suspendedPortKeys = this.suspendedPortKeys.filter((k) => k !== key)
    }
  }

  /** @type {import('./cliBridge.js').PauseMonitorCallback} */
  async pauseMonitor(port) {
    const key = createPortKey(port)
    const ref = this._monitors[key]
    if (!ref) {
      return false
    }
    if (!this.suspendedPortKeys.includes(key)) {
      await ref.monitor.pause?.()
      this.suspendedPortKeys.push(key)
      return true
    }
    return false
  }

  /** @type {import('./cliBridge.js').ResumeMonitorCallback} */
  async resumeMonitor(port) {
    const key = createPortKey(port)
    const ref = this._monitors[key]
    if (!ref) {
      return false
    }
    if (this.suspendedPortKeys.includes(key)) {
      await ref.monitor.resume?.()
      this.suspendedPortKeys = this.suspendedPortKeys.filter((k) => k !== key)
      return true
    }
    return false
  }

  /** @type {import('./cliBridge.js').UpdateBaudrateCallback} */
  async updateBaudrate(port, baudrate, onDidChangeBaudrate) {
    const key = createPortKey(port)
    const ref = this._monitors[key]
    if (!ref) throw new Error(`Monitor for port ${key} not found`)
    await ref.monitor.updateBaudrate(baudrate)
    ref.baudrate = baudrate
    onDidChangeBaudrate({ port, baudrate })
  }

  get selectedBaudrates() {
    /** @type {[import('boards-list').PortIdentifier, string][]} */
    const res = []
    for (const key of Object.keys(this._monitors)) {
      const ref = this._monitors[key]
      const [protoPart, address] = key.split('://')
      const [, protocol] = protoPart.split('arduino+')
      if (ref.baudrate) res.push([{ protocol, address }, ref.baudrate])
    }
    return res
  }

  getMonitorSummaries() {
    /** @type {import('./cliBridge.js').MonitorSummary[]} */
    const summary = []
    for (const key of Object.keys(this._monitors)) {
      const ref = this._monitors[key]
      const port = parsePortKey(key)
      summary.push({
        portKey: key,
        port,
        refs: ref.refs,
        baudrate: ref.baudrate,
        paused: ref.monitor.isPaused(),
      })
    }
    return summary
  }

  /** @type {import('./cliBridge.js').DisposeCallback} */
  async dispose() {
    for (const key of Object.keys(this._monitors)) {
      const ref = this._monitors[key]
      try {
        await ref.monitor.dispose()
      } catch {}
      delete this._monitors[key]
    }
  }

  /** @private */
  _createMockMonitor(params, onDidChangeBaudrate) {
    let aborted = false
    let baud = params.baudrate ?? this._baudrates[0]
    const key = createPortKey(params.port)
    const self = this
    let count =
      typeof self._portCounters[key] === 'number' ? self._portCounters[key] : 0
    /** @type {NodeJS.Timeout | undefined} */
    let timer
    /** @type {import('p-defer').DeferredPromise<void>} */
    const deferredReady = pDefer()
    setTimeout(() => deferredReady.resolve(), 10)

    /** @type {string[]} */
    const pendingMessages = []
    let paused = false
    /** @type {(() => void)[]} */
    const resumeResolvers = []

    async function* messages() {
      // Periodically emit a line indicating the current baud and port address
      const label = `${params.port.address}`
      const enc = new TextEncoder()
      // it's modified on dispose, though
      // eslint-disable-next-line no-unmodified-loop-condition
      while (!aborted) {
        if (paused) {
          await new Promise((resolve) => {
            resumeResolvers.push(() => resolve())
          })
          // The resume may coincide with dispose; check loop condition again
          continue
        }
        let unsentMessage = pendingMessages.shift()
        while (unsentMessage) {
          const buf = enc.encode(unsentMessage + '\n')
          yield buf
          unsentMessage = pendingMessages.shift()
        }

        const buf = enc.encode(
          `[mock:${baud}] [count:${count}] hello from ${label}\n`
        )
        yield buf
        count += 1
        self._portCounters[key] = count
        await new Promise((resolve) => (timer = setTimeout(resolve, 50)))
      }
    }

    /** @type {import('./monitor.js').PortinoMonitor} */
    const mockMonitor = {
      messages: messages(),
      sendMessage: (message) => pendingMessages.push(message),
      updateBaudrate: async (b) => {
        baud = b
        try {
          onDidChangeBaudrate?.({ port: params.port, baudrate: b })
        } catch {}
      },
      ready: deferredReady.promise,
      dispose: async () => {
        aborted = true
        if (resumeResolvers.length > 0) {
          resumeResolvers.splice(0).forEach((resolve) => {
            try {
              resolve()
            } catch {}
          })
        }
        if (timer) clearTimeout(timer)
      },
      isPaused: () => paused,
      pause: async () => {
        paused = true
      },
      resume: async () => {
        if (!paused) {
          return
        }
        paused = false
        if (resumeResolvers.length > 0) {
          resumeResolvers.splice(0).forEach((resolve) => {
            try {
              resolve()
            } catch {}
          })
        }
      },
    }
    return mockMonitor
  }
}

function parsePortKey(portKey) {
  const [protoPart, address] = portKey.split('://')
  const [, protocol] = protoPart.split('arduino+')
  if (!protocol || !address) {
    throw new Error(`Invalid port key: ${portKey}`)
  }
  return { protocol, address }
}
