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
  notifyMonitorClientAttached,
  notifyMonitorClientDetached,
  notifyMonitorIntentStart,
  notifyMonitorIntentStop,
  notifyMonitorStreamData,
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

    const targetPort: PortIdentifier = {
      protocol: 'serial',
      address: '/dev/tty.usbmock-1',
    }

    monitorManager.setSelectionResolver(() => ({
      port: targetPort,
      baudrate: '9600',
    }))

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

    messenger.triggerNotification(
      notifyMonitorClientAttached,
      { clientId: connectParams.clientId, port: targetPort },
      sender
    )
    messenger.triggerNotification(
      notifyMonitorIntentStart,
      { clientId: connectParams.clientId, port: targetPort },
      sender
    )

    await waitFor(
      () => monitorManager.getMonitorState(targetPort) === 'running'
    )
    assert.strictEqual(monitorManager.getMonitorState(targetPort), 'running')

    await waitFor(() =>
      messenger.sentNotifications.some(
        (entry) => entry.method === notifyMonitorStreamData.method
      )
    )

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

    messenger.triggerNotification(
      notifyMonitorIntentStop,
      { clientId: connectParams.clientId, port: targetPort },
      sender
    )
    messenger.triggerNotification(
      notifyMonitorClientDetached,
      { clientId: connectParams.clientId, port: targetPort },
      sender
    )

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
})
