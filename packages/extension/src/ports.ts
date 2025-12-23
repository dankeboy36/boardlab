import {
  DetectedPort,
  DetectedPorts,
  Port,
  createBoardsList,
  createPortKey,
  findMatchingPortIndex,
} from 'boards-list'
import * as vscode from 'vscode'

import { portQuickItemLabel } from './boards'
import { Arduino, PortQName, revivePort } from './cli/arduino'
import {
  InmemoryRecentItems,
  QuickInputNoopLabel,
  RecentItems,
  disposeAll,
  noopRecentItems,
} from './utils'

export class InmemoryRecentPortQNames extends InmemoryRecentItems<PortQName> {}

export async function pickPort(
  detectedPorts: () => DetectedPorts,
  onDidChangeDetectedPorts: vscode.Event<unknown>,
  pinnedPorts: RecentItems<PortQName> = noopRecentItems(),
  recentPorts: RecentItems<PortQName> = noopRecentItems()
): Promise<Port | undefined> {
  const updateItems = () =>
    (input.items = toPortItems(detectedPorts(), recentPorts.items))
  const toDispose: vscode.Disposable[] = []
  const input = vscode.window.createQuickPick()
  // https://github.com/microsoft/vscode/issues/73904#issuecomment-680298036

  ;(input as any).sortByLabel = false
  input.matchOnDescription = true
  input.matchOnDetail = true
  input.placeholder = 'Filter port by protocol or address'
  updateItems()
  input.show()
  try {
    const selected = await new Promise<Port | undefined>((resolve) => {
      toDispose.push(
        input.onDidHide(() => {
          resolve(undefined)
          input.dispose()
        }),
        input.onDidChangeSelection((items) => {
          const item = items[0]
          if (item instanceof QuickInputNoopLabel) {
            return
          }
          let port: Port | undefined
          if (item instanceof DetectedPortQuickItem) {
            port = item.detectedPort.port
          }
          resolve(port)
          input.hide()
        }),
        onDidChangeDetectedPorts(updateItems)
      )
    })
    return selected
  } finally {
    disposeAll(...toDispose)
  }
}

export async function pickPortQName(
  detectedPorts: () => DetectedPorts,
  onDidChangeDetectedPorts: vscode.Event<unknown>,
  recentPortQName: RecentItems<PortQName> = new InmemoryRecentPortQNames()
): Promise<PortQName | undefined> {
  const port = await pickPort(
    detectedPorts,
    onDidChangeDetectedPorts,
    recentPortQName
  )
  return port ? createPortKey(port) : undefined
}

function toPortItems(
  detectedPorts: DetectedPorts,
  recentPortQNames: PortQName[]
): vscode.QuickPickItem[] {
  const boardList = createBoardsList(detectedPorts)
  const groupedPorts = boardList.portsGroupedByProtocol()
  if (!Object.keys(groupedPorts).length) {
    return [new QuickInputNoopLabel('No detected ports')]
  }
  const quickItems: vscode.QuickPickItem[] = []
  for (const [protocol, ports] of Object.entries(groupedPorts)) {
    quickItems.push(
      { kind: vscode.QuickPickItemKind.Separator, label: `${protocol} ports` },
      ...ports.map(
        (detectedPort) => new DetectedPortQuickItem(detectedPort, false)
      )
    )
  }
  return quickItems
}

// Removed unused PortQNameQuickItem

class DetectedPortQuickItem implements vscode.QuickPickItem {
  label: string
  description?: string
  detail?: string

  constructor(
    readonly detectedPort: DetectedPort,
    selected: boolean
  ) {
    // TODO: change vscode-arduino-api's Port#properties
    this.label = portQuickItemLabel(detectedPort.port as any, selected)
    const boards = detectedPort.boards
    if (boards) {
      if (detectedPort.boards.length === 1) {
        this.description = detectedPort.boards[0].name
      } else if (detectedPort.boards.length > 1) {
        this.detail = detectedPort.boards
          .map(
            (board) => `${board.name}${board.fqbn ? ` (${board.fqbn})` : ''}`
          )
          .join(', ')
      }
    }
  }
}

export function resolvePort(
  portKey: PortQName | undefined,
  arduino: Arduino,
  detectedPorts: DetectedPorts
): Port | undefined {
  if (portKey) {
    const port = revivePort(portKey)
    if (port) {
      const index = findMatchingPortIndex(port, Object.values(detectedPorts))
      const matchingPort = Object.values(detectedPorts)[index]
      return matchingPort?.port
    }
  }
  return undefined
}

export function portProtocolIcon(
  { protocol }: Pick<Port, 'protocol'>,
  escape = true
): string {
  let iconName: string
  switch (protocol) {
    case 'serial':
      iconName = 'plug'
      break
    case 'network':
      iconName = 'radio-tower'
      break
    default:
      iconName = 'extensions'
  }
  return escape ? `$(${iconName})` : iconName
}
