import assert from 'node:assert/strict'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import type { PortIdentifier } from 'boards-list'
import * as vscode from 'vscode'
import type { Messenger } from 'vscode-messenger'
import type {
  MessageParticipant,
  NotificationType,
  RequestType,
} from 'vscode-messenger-common'

import { createServer } from '@boardlab/portino-bridge'
import { MockCliBridge } from '@boardlab/portino-bridge/mockCliBridge'
import {
  connectMonitorClient,
  type ConnectClientParams,
} from '@boardlab/protocol'

import type { CliContext } from '../../cli/context'
import {
  MonitorManager,
  type MonitorManagerOptions,
} from '../../monitor/monitorManager'

class TestMemento implements vscode.Memento {
  private readonly values = new Map<string, unknown>()

  get<T>(key: string, defaultValue?: T): T | undefined {
    if (this.values.has(key)) {
      return this.values.get(key) as T
    }
    return defaultValue
  }

  update<T>(key: string, value: T): Thenable<void> {
    if (value === undefined) {
      this.values.delete(key)
    } else {
      this.values.set(key, value)
    }
    return Promise.resolve()
  }

  keys(): readonly string[] {
    return Array.from(this.values.keys())
  }
}

type RequestHandler<T, R> = (
  params: T,
  sender?: MessageParticipant
) => R | Promise<R>

type NotificationHandler<T> = (
  params: T,
  sender?: MessageParticipant
) => void | Promise<void>

class TestMessenger {
  private readonly requestHandlers = new Map<string, RequestHandler<any, any>>()
  private readonly notificationHandlers = new Map<
    string,
    NotificationHandler<any>
  >()

  readonly sentNotifications: Array<{
    method: string
    participant: MessageParticipant
    payload: unknown
  }> = []

  onRequest<T, R>(
    type: RequestType<T, R>,
    handler: RequestHandler<T, R>,
    _options?: { sender?: MessageParticipant }
  ): vscode.Disposable {
    this.requestHandlers.set(type.method, handler as RequestHandler<any, any>)
    return {
      dispose: () => {
        this.requestHandlers.delete(type.method)
      },
    }
  }

  onNotification<T>(
    type: NotificationType<T>,
    handler: NotificationHandler<T>,
    _options?: { sender?: MessageParticipant }
  ): vscode.Disposable {
    this.notificationHandlers.set(
      type.method,
      handler as NotificationHandler<any>
    )
    return {
      dispose: () => {
        this.notificationHandlers.delete(type.method)
      },
    }
  }

  async triggerRequest<T, R>(
    type: RequestType<T, R>,
    params: T,
    sender?: MessageParticipant
  ): Promise<R> {
    const handler = this.requestHandlers.get(type.method)
    if (!handler) {
      throw new Error(`No handler registered for ${type.method}`)
    }
    return Promise.resolve(handler(params, sender))
  }

  triggerNotification<T>(
    type: NotificationType<T>,
    params: T,
    sender?: MessageParticipant
  ): void {
    const handler = this.notificationHandlers.get(type.method)
    if (handler) {
      handler(params, sender)
    }
  }

  sendNotification<T>(
    notification: NotificationType<T>,
    participant: MessageParticipant,
    payload: T
  ): void {
    this.sentNotifications.push({
      method: notification.method,
      participant,
      payload,
    })
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  intervalMs = 20
): Promise<void> {
  const start = Date.now()
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition')
    }
    await delay(intervalMs)
  }
}

describe('MonitorManager (in-process bridge)', function () {
  this.timeout(20_000)

  const originalGetConfiguration = vscode.workspace.getConfiguration

  before(() => {
    ;(vscode.workspace.getConfiguration as unknown) = function (
      section?: string,
      scopeOrUri?: unknown,
      ...rest: unknown[]
    ) {
      if (section === 'boardlab.monitor') {
        return {
          get<T>(key: string, defaultValue: T): T {
            if (key === 'bridgePort') {
              return 55888 as T
            }
            if (key === 'bridgeMode') {
              return 'external-process' as T
            }
            return defaultValue
          },
        }
      }
      return (originalGetConfiguration as any).apply(vscode.workspace, [
        section,
        scopeOrUri,
        ...rest,
      ])
    }
  })

  after(() => {
    ;(vscode.workspace.getConfiguration as unknown) = originalGetConfiguration
  })

  it('embeds the monitor bridge and tracks monitor lifecycle', async () => {
    const mockBridge = new MockCliBridge()
    const messenger = new TestMessenger()
    const extensionPath = path.resolve(__dirname, '..', '..', '..', '..')
    const context: vscode.ExtensionContext = {
      extensionPath,
      subscriptions: [],
      workspaceState: new TestMemento(),
      globalState: new TestMemento(),
    } as unknown as vscode.ExtensionContext
    const cliContext: CliContext = {
      resolveExecutablePath: async () => '/tmp/mock-cli',
    } as unknown as CliContext
    const outputChannel: vscode.OutputChannel = {
      name: 'BoardLab',
      append: () => undefined,
      appendLine: () => undefined,
      replace: () => undefined,
      clear: () => undefined,
      show: () => undefined,
      hide: () => undefined,
      dispose: () => undefined,
    } as unknown as vscode.OutputChannel

    const managerOptions: MonitorManagerOptions = {
      serviceClientOptions: {
        mode: 'in-process',
        preferredPort: 0,
        inProcessServerFactory: async ({ port }) =>
          createServer({
            port,
            cliBridgeFactory: () => mockBridge as any,
            debug: false,
            testIntrospection: true,
          } as any),
      },
    }

    const monitorManager = new MonitorManager(
      context,
      cliContext,
      messenger as unknown as Messenger,
      outputChannel,
      managerOptions
    )

    const runningEvents: PortIdentifier[][] = []
    const onRunning = monitorManager.onDidChangeRunningMonitors((monitors) => {
      runningEvents.push(monitors.map((entry) => entry.port))
    })

    const sender: MessageParticipant = { id: 'test-webview' } as any
    const connectParams: ConnectClientParams = {
      clientId: 'client-1',
    }

    await messenger.triggerRequest(connectMonitorClient, connectParams, sender)

    const info = await monitorManager.getBridgeInfo()
    assert.ok(info.httpBaseUrl)
    assert.ok(info.wsUrl)

    const targetPort: PortIdentifier = {
      protocol: 'serial',
      address: '/dev/tty.usbmock-1',
    }

    const url = new URL(`${info.httpBaseUrl}/monitor`)
    url.searchParams.set('protocol', targetPort.protocol)
    url.searchParams.set('address', targetPort.address)
    url.searchParams.set('baudrate', '9600')
    url.searchParams.set('clientid', connectParams.clientId)

    const controller = new AbortController()
    const response = await fetch(url, { signal: controller.signal })
    assert.strictEqual(response.ok, true)
    const reader = response.body?.getReader()
    assert.ok(reader)

    const firstChunk = await reader.read()
    assert.strictEqual(firstChunk.done, false)
    assert.ok(firstChunk.value)

    await waitFor(
      () => monitorManager.getMonitorState(targetPort) === 'running'
    )
    assert.strictEqual(monitorManager.getMonitorState(targetPort), 'running')

    const paused = await monitorManager.pauseMonitor(targetPort)
    assert.strictEqual(paused, true)
    await waitFor(
      () => monitorManager.getMonitorState(targetPort) === 'suspended'
    )

    const resumed = await monitorManager.resumeMonitor(targetPort)
    assert.strictEqual(resumed, true)
    await waitFor(
      () => monitorManager.getMonitorState(targetPort) === 'running'
    )

    controller.abort()
    try {
      await reader.cancel()
    } catch {}

    await waitFor(
      () => monitorManager.getMonitorState(targetPort) === 'disconnected'
    )
    await waitFor(() => monitorManager.getRunningMonitors().length === 0)

    assert.ok(
      runningEvents.some((event) =>
        event.some(
          (port) =>
            port.protocol === targetPort.protocol &&
            port.address === targetPort.address
        )
      ),
      'expected at least one running monitor event'
    )

    onRunning.dispose()
    monitorManager.dispose()
    await mockBridge.dispose()
  })

  it('supports extension-host monitor clients without webview monitor wiring', async () => {
    const mockBridge = new MockCliBridge()
    const messenger = new TestMessenger()
    const extensionPath = path.resolve(__dirname, '..', '..', '..', '..')
    const context: vscode.ExtensionContext = {
      extensionPath,
      subscriptions: [],
      workspaceState: new TestMemento(),
      globalState: new TestMemento(),
    } as unknown as vscode.ExtensionContext
    const cliContext: CliContext = {
      resolveExecutablePath: async () => '/tmp/mock-cli',
    } as unknown as CliContext
    const outputChannel: vscode.OutputChannel = {
      name: 'BoardLab',
      append: () => undefined,
      appendLine: () => undefined,
      replace: () => undefined,
      clear: () => undefined,
      show: () => undefined,
      hide: () => undefined,
      dispose: () => undefined,
    } as unknown as vscode.OutputChannel

    const managerOptions: MonitorManagerOptions = {
      serviceClientOptions: {
        mode: 'in-process',
        preferredPort: 0,
        inProcessServerFactory: async ({ port }) =>
          createServer({
            port,
            cliBridgeFactory: () => mockBridge as any,
            debug: false,
            testIntrospection: true,
          } as any),
      },
    }

    const monitorManager = new MonitorManager(
      context,
      cliContext,
      messenger as unknown as Messenger,
      outputChannel,
      managerOptions
    )

    try {
      const targetPort: PortIdentifier = {
        protocol: 'serial',
        address: '/dev/tty.usbmock-1',
      }
      let seenData = 0
      const dataDisposable = monitorManager.onDidReceiveMonitorData((event) => {
        if (
          event.port.protocol === targetPort.protocol &&
          event.port.address === targetPort.address
        ) {
          seenData += 1
        }
      })

      const stateTransitions: string[] = []
      const stateDisposable = monitorManager.onDidChangeMonitorState(
        (event) => {
          if (
            event.port.protocol === targetPort.protocol &&
            event.port.address === targetPort.address
          ) {
            stateTransitions.push(event.state)
          }
        }
      )

      monitorManager.registerExternalMonitorClient('ext-client', targetPort, {
        baudrate: '9600',
      })

      await waitFor(
        () => monitorManager.getMonitorState(targetPort) === 'running'
      )
      await waitFor(() => seenData > 0)
      await waitFor(() =>
        monitorManager
          .getRunningMonitors()
          .some(
            (entry) =>
              entry.port.protocol === targetPort.protocol &&
              entry.port.address === targetPort.address
          )
      )

      monitorManager.unregisterExternalMonitorClient('ext-client', targetPort)
      await waitFor(
        () => monitorManager.getMonitorState(targetPort) === 'disconnected'
      )
      await waitFor(
        () =>
          !monitorManager
            .getRunningMonitors()
            .some(
              (entry) =>
                entry.port.protocol === targetPort.protocol &&
                entry.port.address === targetPort.address
            )
      )

      assert.ok(
        stateTransitions.includes('running'),
        'expected running state transition for external client monitor'
      )
      assert.ok(seenData > 0, 'expected monitor data for external client')

      dataDisposable.dispose()
      stateDisposable.dispose()
    } finally {
      monitorManager.dispose()
      await mockBridge.dispose()
    }
  })
})
