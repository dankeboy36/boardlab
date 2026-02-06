import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ConsoleLogger, createWebSocketConnection } from 'vscode-ws-jsonrpc'
import WebSocket from 'ws'
import { createPortKey } from 'boards-list'

import { createServer } from '../out/server.js'
import { MockCliBridge } from '../out/mockCliBridge.js'

const waitOpen = (/** @type {WebSocket} */ socket) =>
  new Promise((resolve, reject) => {
    const onOpen = () => {
      cleanup()
      resolve(undefined)
    }
    const onError = (/** @type {unknown} */ error) => {
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

const createSocketAdapter = (socket) => ({
  send: (content) => socket.send(content),
  onMessage: (cb) => socket.on('message', (data) => cb(data)),
  onError: (cb) => socket.on('error', (err) => cb(err)),
  onClose: (cb) => {
    socket.on('close', (code, reasonBuffer) => {
      let reason = ''
      if (typeof reasonBuffer === 'string') {
        reason = reasonBuffer
      } else if (reasonBuffer instanceof Buffer) {
        reason = reasonBuffer.toString('utf8')
      }
      cb(code ?? 0, reason)
    })
  },
  dispose: () => socket.close(),
})

const createDataWaiter = () => {
  const pending = []
  return {
    handleFrame: (monitorId, data) => {
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        const entry = pending[i]
        if (entry.monitorId !== monitorId) {
          continue
        }
        if (entry.predicate && !entry.predicate(data)) {
          continue
        }
        clearTimeout(entry.timeout)
        pending.splice(i, 1)
        entry.resolve(data)
      }
    },
    waitFor: (monitorId, predicate, timeoutMs = 4000) =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timed out waiting for data'))
        }, timeoutMs)
        pending.push({ monitorId, predicate, resolve, reject, timeout })
      }),
  }
}

const waitForSocketClose = (socket, timeoutMs = 2000) =>
  new Promise((resolve) => {
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      try {
        socket.terminate()
      } catch {}
      resolve()
    }, timeoutMs)
    socket.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })

const createClient = async (port) => {
  const controlSocket = new WebSocket(`ws://127.0.0.1:${port}/control`, {
    perMessageDeflate: false,
  })
  await waitOpen(controlSocket)
  const connection = createWebSocketConnection(
    createSocketAdapter(controlSocket),
    new ConsoleLogger()
  )
  connection.listen()
  const hello = await connection.sendRequest('portino.hello')

  const dataSocket = new WebSocket(
    `ws://127.0.0.1:${port}/data?clientId=${hello.clientId}`,
    { perMessageDeflate: false }
  )
  await waitOpen(dataSocket)
  const dataWaiter = createDataWaiter()
  dataSocket.on('message', (raw) => {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    if (buf.length < 5) {
      return
    }
    const monitorId = buf.readUInt32LE(0)
    const kind = buf.readUInt8(4)
    if (kind !== 0) {
      return
    }
    const payload = buf.subarray(5)
    dataWaiter.handleFrame(monitorId, payload)
  })

  return {
    connection,
    controlSocket,
    dataSocket,
    clientId: hello.clientId,
    dataWaiter,
    async close() {
      try {
        connection.dispose()
      } catch {}
      try {
        controlSocket.close()
      } catch {}
      try {
        dataSocket.close()
      } catch {}
      await Promise.all([
        waitForSocketClose(controlSocket),
        waitForSocketClose(dataSocket),
      ])
    },
  }
}

const waitForCondition = async (predicate, timeoutMs = 4000) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for condition')
}

describe('portino ws multi-client', () => {
  let server
  let cliBridge
  let portKey

  beforeAll(async () => {
    cliBridge = new MockCliBridge()
    server = await createServer({
      port: 0,
      cliBridgeFactory: () => cliBridge,
    })
    const basePortKey = createPortKey({
      protocol: 'serial',
      address: '/dev/tty.usbmock-1',
    })
    portKey = `${basePortKey}@115200@default`
  })

  afterAll(async () => {
    try {
      await server?.close()
    } finally {
      await cliBridge?.dispose?.()
    }
  })

  afterEach(async () => {
    if (!cliBridge) {
      return
    }
    try {
      await waitForCondition(() => cliBridge.getMonitorSummaries().length === 0)
    } catch {}
  })

  it('two-clients-shared-open', async () => {
    const client1 = await createClient(server.port)
    const client2 = await createClient(server.port)

    const { monitorId: monitorId1 } = await client1.connection.sendRequest(
      'monitor.open',
      { portKey }
    )
    const { monitorId: monitorId2 } = await client2.connection.sendRequest(
      'monitor.open',
      { portKey }
    )
    await client1.connection.sendRequest('monitor.subscribe', {
      monitorId: monitorId1,
    })
    await client2.connection.sendRequest('monitor.subscribe', {
      monitorId: monitorId2,
    })

    const data1Promise = client1.dataWaiter.waitFor(monitorId1)
    const data2Promise = client2.dataWaiter.waitFor(monitorId2)

    const payload = Array.from(Buffer.from('ping-one'))
    const writeResult = await client1.connection.sendRequest('monitor.write', {
      monitorId: monitorId1,
      data: payload,
    })

    const data1 = await data1Promise
    const data2 = await data2Promise

    expect(writeResult?.bytesWritten).toBe(payload.length)
    expect(data1.length).toBeGreaterThan(0)
    expect(data2.length).toBeGreaterThan(0)

    await client1.close()
    await client2.close()
  })

  it('refcount-lifecycle', async () => {
    const client1 = await createClient(server.port)
    const client2 = await createClient(server.port)

    const { monitorId: monitorId1 } = await client1.connection.sendRequest(
      'monitor.open',
      { portKey }
    )
    const { monitorId: monitorId2 } = await client2.connection.sendRequest(
      'monitor.open',
      { portKey }
    )
    await client1.connection.sendRequest('monitor.subscribe', {
      monitorId: monitorId1,
    })
    await client2.connection.sendRequest('monitor.subscribe', {
      monitorId: monitorId2,
    })

    await waitForCondition(() => cliBridge.getMonitorSummaries().length === 1)

    await client1.connection.sendRequest('monitor.unsubscribe', {
      monitorId: monitorId1,
    })
    await waitForCondition(() => cliBridge.getMonitorSummaries().length === 1)

    await client2.connection.sendRequest('monitor.unsubscribe', {
      monitorId: monitorId2,
    })
    await waitForCondition(() => cliBridge.getMonitorSummaries().length === 0)

    await client1.connection.sendRequest('monitor.close', {
      monitorId: monitorId1,
    })
    await client2.connection.sendRequest('monitor.close', {
      monitorId: monitorId2,
    })

    await client1.close()
    await client2.close()
  })

  it('config-conflict', async () => {
    const client1 = await createClient(server.port)
    const client2 = await createClient(server.port)

    const { monitorId } = await client1.connection.sendRequest('monitor.open', {
      portKey,
    })
    await client1.connection.sendRequest('monitor.subscribe', { monitorId })
    const initialPayload = Array.from(Buffer.from('config-conflict-initial'))
    const initialDataPromise = client1.dataWaiter.waitFor(monitorId)
    await client1.connection.sendRequest('monitor.write', {
      monitorId,
      data: initialPayload,
    })
    await initialDataPromise
    const conflictKey = portKey.replace('@115200@', '@921600@')

    let error
    try {
      await client2.connection.sendRequest('monitor.open', {
        portKey: conflictKey,
      })
    } catch (err) {
      error = err
    }

    expect(error).toBeTruthy()
    expect(error?.data?.code).toBe('PORT_IN_USE_DIFFERENT_CONFIG')

    const followupPayload = Array.from(Buffer.from('config-conflict-followup'))
    const followupDataPromise = client1.dataWaiter.waitFor(monitorId)
    await client1.connection.sendRequest('monitor.write', {
      monitorId,
      data: followupPayload,
    })
    await followupDataPromise

    await client1.close()
    await client2.close()
  })

  it('disconnect-cleanup', async () => {
    const client = await createClient(server.port)
    const { monitorId } = await client.connection.sendRequest('monitor.open', {
      portKey,
    })
    await client.connection.sendRequest('monitor.subscribe', { monitorId })

    await waitForCondition(() => cliBridge.getMonitorSummaries().length === 1)

    client.controlSocket.terminate()

    await waitForCondition(() => cliBridge.getMonitorSummaries().length === 0)

    await client.close()
  })
})
