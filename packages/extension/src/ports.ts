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
  matchesQuickPickConstraints,
  type QuickPickConstraints,
} from './quickPickConstraints'
import {
  InmemoryRecentItems,
  QuickInputNoopLabel,
  RecentItems,
  disposeAll,
  inputButton,
  noopRecentItems,
} from './utils'

export class InmemoryRecentPortQNames extends InmemoryRecentItems<PortQName> {}

const pinButton = inputButton('pin', 'Pin port')
const pinnedButton = inputButton('pinned', 'Unpin port')
const removeButton = inputButton('discard', 'Remove from history')

export interface PortPickCandidate {
  readonly detectedPort: DetectedPort
  readonly port: Port
}

export interface PortPickOptions
  extends QuickPickConstraints<PortPickCandidate> {}

async function isPortAllowed(
  detectedPort: DetectedPort,
  options: PortPickOptions
): Promise<boolean> {
  return matchesQuickPickConstraints(
    {
      detectedPort,
      port: detectedPort.port,
    },
    options
  )
}

export async function pickPort(
  detectedPorts: () => DetectedPorts,
  onDidChangeDetectedPorts: vscode.Event<unknown>,
  pinnedPorts: RecentItems<PortQName> = noopRecentItems(),
  recentPorts: RecentItems<PortQName> = noopRecentItems(),
  options: PortPickOptions = {}
): Promise<Port | undefined> {
  let updateToken = 0
  const updateItems = () => {
    const currentToken = ++updateToken
    ;(async () => {
      input.busy = true
      try {
        const items = await toPortItems(
          detectedPorts(),
          pinnedPorts.items,
          recentPorts.items,
          options
        )
        if (currentToken !== updateToken) {
          return
        }
        input.items = items
      } finally {
        if (currentToken === updateToken) {
          input.busy = false
        }
      }
    })()
  }
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
          ;(async () => {
            const item = items[0]
            if (item instanceof QuickInputNoopLabel) {
              return
            }
            let port: Port | undefined
            if (item instanceof DetectedPortQuickItem) {
              port = item.detectedPort.port
            }
            if (!port) {
              return
            }
            // Fire and forget; history update is persisted via memento.
            recentPorts.add(createPortKey(port))
            resolve(port)
            input.hide()
          })()
        }),
        input.onDidTriggerItemButton(async ({ item, button }) => {
          if (!(item instanceof DetectedPortQuickItem)) {
            return
          }
          const portKey = createPortKey(item.detectedPort.port)
          if (button === pinnedButton) {
            await pinnedPorts.remove(portKey)
          } else if (button === pinButton) {
            await pinnedPorts.add(portKey)
          } else if (button === removeButton) {
            await recentPorts.remove(portKey)
          }
        }),
        pinnedPorts.onDidUpdate(updateItems),
        recentPorts.onDidUpdate(updateItems),
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
    noopRecentItems(),
    recentPortQName
  )
  return port ? createPortKey(port) : undefined
}

export async function toPortItems(
  detectedPorts: DetectedPorts,
  pinnedPortQNames: PortQName[],
  recentPortQNames: PortQName[],
  options: PortPickOptions = {}
): Promise<vscode.QuickPickItem[]> {
  const detectedPortsByKey = new Map<PortQName, DetectedPort>()
  for (const detectedPort of Object.values(detectedPorts)) {
    if (await isPortAllowed(detectedPort, options)) {
      detectedPortsByKey.set(createPortKey(detectedPort.port), detectedPort)
    }
  }
  const pinned = pinnedPortQNames.filter((portKey) =>
    detectedPortsByKey.has(portKey)
  )
  const recent = recentPortQNames
    .filter(
      (portKey) =>
        !pinned.some((pinnedPortKey) => pinnedPortKey === portKey) &&
        detectedPortsByKey.has(portKey)
    )
    .slice(0, 3)
  const historyPortKeys = new Set<PortQName>([...pinned, ...recent])

  const boardList = createBoardsList(detectedPorts)
  const groupedPorts = boardList.portsGroupedByProtocol()
  const quickItems: vscode.QuickPickItem[] = []
  const hasDetectedPorts = Object.keys(groupedPorts).length > 0

  if (pinned.length) {
    quickItems.push({
      kind: vscode.QuickPickItemKind.Separator,
      label: 'pinned ports',
    })
    for (const portKey of pinned) {
      const detectedPort = detectedPortsByKey.get(portKey)
      if (!detectedPort) {
        continue
      }
      const item = new DetectedPortQuickItem(detectedPort, false)
      setPortButtons(item, pinnedPortQNames, recentPortQNames)
      quickItems.push(item)
    }
  }

  if (recent.length) {
    quickItems.push({
      kind: vscode.QuickPickItemKind.Separator,
      label: 'recent ports',
    })
    for (const portKey of recent) {
      const detectedPort = detectedPortsByKey.get(portKey)
      if (!detectedPort) {
        continue
      }
      const item = new DetectedPortQuickItem(detectedPort, false)
      setPortButtons(item, pinnedPortQNames, recentPortQNames)
      quickItems.push(item)
    }
  }

  for (const [protocol, ports] of Object.entries(groupedPorts)) {
    const visiblePorts = ports.filter(
      (detectedPort) =>
        detectedPortsByKey.has(createPortKey(detectedPort.port)) &&
        !historyPortKeys.has(createPortKey(detectedPort.port))
    )
    if (!visiblePorts.length) {
      continue
    }
    quickItems.push(
      { kind: vscode.QuickPickItemKind.Separator, label: `${protocol} ports` },
      ...visiblePorts.map((detectedPort) => {
        const item = new DetectedPortQuickItem(detectedPort, false)
        setPortButtons(item, pinnedPortQNames, recentPortQNames)
        return item
      })
    )
  }
  if (!quickItems.length) {
    return [
      new QuickInputNoopLabel(
        hasDetectedPorts ? 'No matching ports' : 'No detected ports'
      ),
    ]
  }
  return quickItems
}

// Removed unused PortQNameQuickItem

class DetectedPortQuickItem implements vscode.QuickPickItem {
  readonly buttons: vscode.QuickInputButton[] = []
  label: string
  description?: string
  detail?: string

  constructor(
    readonly detectedPort: DetectedPort,
    selected: boolean
  ) {
    this.label = portQuickItemLabel(detectedPort.port, selected)
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

function setPortButtons(
  item: DetectedPortQuickItem,
  pinnedPortQNames: PortQName[],
  recentPortQNames: PortQName[]
): void {
  const portKey = createPortKey(item.detectedPort.port)
  if (pinnedPortQNames.some((candidate) => candidate === portKey)) {
    item.buttons.push(pinnedButton)
  } else {
    item.buttons.push(pinButton)
  }
  if (recentPortQNames.some((candidate) => candidate === portKey)) {
    item.buttons.push(removeButton)
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
