import {
  createPortKey,
  type DetectedPort,
  type DetectedPorts,
} from 'boards-list'
import { describe, expect, it } from 'vitest'
import * as vscode from 'vscode'

const loadPortsModule = async () => import('./ports')

function labelsOf(items: readonly any[]): string[] {
  return items
    .filter((item) => item && typeof item.label === 'string')
    .map((item) => item.label as string)
}

function findByLabel(items: readonly any[], label: string): any {
  return items.find((item) => item?.label === label)
}

function labelsInRange(
  items: readonly any[],
  fromLabel: string,
  untilLabel?: string
): string[] {
  const labels = labelsOf(items)
  const fromIndex = labels.indexOf(fromLabel)
  if (fromIndex < 0) {
    return []
  }
  const tail = labels.slice(fromIndex + 1)
  if (!untilLabel) {
    return tail
  }
  const untilIndex = tail.indexOf(untilLabel)
  return untilIndex < 0 ? tail : tail.slice(0, untilIndex)
}

class FakeQuickPick {
  items: vscode.QuickPickItem[] = []
  busy = false
  placeholder = ''
  matchOnDescription = false
  matchOnDetail = false
  readonly onDidChangeSelectionEmitter = new vscode.EventEmitter<
    vscode.QuickPickItem[]
  >()

  readonly onDidHideEmitter = new vscode.EventEmitter<void>()
  readonly onDidTriggerItemButtonEmitter = new vscode.EventEmitter<{
    button: vscode.QuickInputButton
    item: vscode.QuickPickItem
  }>()

  readonly onDidChangeSelection = this.onDidChangeSelectionEmitter.event
  readonly onDidHide = this.onDidHideEmitter.event
  readonly onDidTriggerItemButton = this.onDidTriggerItemButtonEmitter.event

  show(): void {
    // NOOP
  }

  hide(): void {
    this.onDidHideEmitter.fire()
  }

  dispose(): void {
    this.onDidChangeSelectionEmitter.dispose()
    this.onDidHideEmitter.dispose()
    this.onDidTriggerItemButtonEmitter.dispose()
  }
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 1_000
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for condition')
}

describe('toPortItems (history + detection alignment)', () => {
  it('shows unresolved pinned and recent ports from user history', async () => {
    const { toPortItems } = await loadPortsModule()

    const pinnedKey = createPortKey({
      protocol: 'serial',
      address: '/dev/cu.usbmodem-offline',
    })
    const recentKey = createPortKey({
      protocol: 'network',
      address: '192.168.4.1:3232',
    })

    const items = await toPortItems(
      {} as DetectedPorts,
      [pinnedKey],
      [recentKey]
    )
    const labels = labelsOf(items)

    expect(labels).toContain('pinned ports')
    expect(labels).toContain('recent ports')
    expect(labels).toContain('$(plug) /dev/cu.usbmodem-offline')
    expect(labels).toContain('$(radio-tower) 192.168.4.1:3232')

    const unresolvedCount = items.filter(
      (item) => item?.description === 'not detected'
    ).length
    expect(unresolvedCount).toBe(2)
  })

  it('resolves history ports when detected and avoids duplicate protocol entries', async () => {
    const { toPortItems } = await loadPortsModule()

    const detectedPort: DetectedPort = {
      port: {
        protocol: 'serial',
        address: '/dev/cu.usbmodem14101',
        label: 'tty.usbmodem14101',
        protocolLabel: 'Serial Port',
      },
      boards: [{ name: 'Arduino Nano', fqbn: 'arduino:avr:nano' }],
    }
    const portKey = createPortKey(detectedPort.port)
    const detectedPorts: DetectedPorts = {
      [portKey]: detectedPort,
    }

    const items = await toPortItems(detectedPorts, [portKey], [])
    const labels = labelsOf(items)

    expect(labels).toContain('pinned ports')
    expect(labels).toContain('$(plug) tty.usbmodem14101')
    expect(labels).not.toContain('serial ports')

    const resolvedItem = items.find(
      (item) => item?.label === '$(plug) tty.usbmodem14101'
    )
    expect(resolvedItem?.description).toBe('Arduino Nano')
  })

  it('limits recent history to 3 items and excludes ports already pinned', async () => {
    const { toPortItems } = await loadPortsModule()

    const p1 = createPortKey({ protocol: 'serial', address: '/dev/p1' })
    const p2 = createPortKey({ protocol: 'serial', address: '/dev/p2' })
    const p3 = createPortKey({ protocol: 'serial', address: '/dev/p3' })
    const p4 = createPortKey({ protocol: 'serial', address: '/dev/p4' })

    const items = await toPortItems({} as DetectedPorts, [p1], [p1, p2, p3, p4])
    const recentLabels = labelsInRange(items, 'recent ports')
    expect(recentLabels).toEqual([
      '$(plug) /dev/p2',
      '$(plug) /dev/p3',
      '$(plug) /dev/p4',
    ])
  })

  it('ignores invalid history keys that cannot be revived to a port', async () => {
    const { toPortItems } = await loadPortsModule()

    const items = await toPortItems({} as DetectedPorts, ['invalid'], [])
    expect(labelsOf(items)).toEqual(['No detected ports'])
  })
})

describe('pickPort (live detected ports refresh)', () => {
  it('updates recent port item from unresolved to resolved when detection appears', async () => {
    const { InmemoryRecentPortQNames, pickPort } = await loadPortsModule()

    const fakeQuickPick = new FakeQuickPick()
    Object.defineProperty(vscode, 'window', {
      configurable: true,
      writable: true,
      value: { createQuickPick: () => fakeQuickPick },
    })

    const portKey = createPortKey({
      protocol: 'serial',
      address: '/dev/tty.usbmodem14101',
    })
    const recent = new InmemoryRecentPortQNames()
    await recent.add(portKey)
    const pinned = new InmemoryRecentPortQNames()
    const onDidChangeDetectedPorts = new vscode.EventEmitter<void>()
    let currentDetectedPorts: DetectedPorts = {}

    try {
      const pickPromise = pickPort(
        () => currentDetectedPorts,
        onDidChangeDetectedPorts.event,
        pinned,
        recent
      )

      await waitFor(
        () =>
          findByLabel(fakeQuickPick.items, '$(plug) /dev/tty.usbmodem14101')
            ?.description === 'not detected'
      )

      const detectedPort: DetectedPort = {
        port: {
          protocol: 'serial',
          address: '/dev/tty.usbmodem14101',
          label: 'tty.usbmodem14101',
          protocolLabel: 'Serial Port',
        },
        boards: [{ name: 'Arduino Nano', fqbn: 'arduino:avr:nano' }],
      }
      currentDetectedPorts = {
        [createPortKey(detectedPort.port)]: detectedPort,
      }
      onDidChangeDetectedPorts.fire()

      await waitFor(
        () =>
          findByLabel(fakeQuickPick.items, '$(plug) tty.usbmodem14101')
            ?.description === 'Arduino Nano'
      )

      fakeQuickPick.hide()
      await pickPromise
    } finally {
      recent.dispose()
      pinned.dispose()
      onDidChangeDetectedPorts.dispose()
      // @ts-ignore
      delete vscode.window
    }
  })
})
