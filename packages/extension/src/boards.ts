import {
  BoardDetailsResponse,
  BoardListItem,
  Platform,
  Port,
  ToolsDependencies,
} from 'ardunno-cli'
import {
  BoardIdentifier,
  BoardsConfig,
  BoardsList,
  BoardsListItemWithBoard,
  DetectedPorts,
  boardIdentifierEquals,
  createBoardsList,
  isBoardIdentifier,
} from 'boards-list'
import { FQBN } from 'fqbn'
import { ClientError, Status } from 'nice-grpc-common'
import * as vscode from 'vscode'
import {
  BoardDetails as ApiBoardDetails,
  BuildProperties as ApiBuildProperties,
  ConfigOption as ApiConfigOption,
  ConfigValue as ApiConfigValue,
  Tool as ApiTool,
  BoardDetails,
} from 'vscode-arduino-api'

import { Arduino } from './cli/arduino'
import { portProtocolIcon } from './ports'
import {
  InmemoryRecentItems,
  QuickInputNoopLabel,
  RecentItems,
  disposeAll,
  inputButton,
  noopRecentItems,
} from './utils'

export class InmemoryRecentBoards extends InmemoryRecentItems<BoardIdentifier> {
  constructor() {
    super(boardIdentifierEquals)
  }
}

const pinButton = inputButton('pin', 'Pin board')
const pinnedButton = inputButton('pinned', 'Unpin board')
const removeButton = inputButton('discard', 'Remove from history')

type PickBoardResult = BoardIdentifier | BoardsListItemWithBoard

function isPlatform(arg: unknown): arg is Required<Platform> {
  // TODO: https://github.com/dankeboy36/boardlab-cli/issues/4
  return (
    typeof arg === 'object' &&
    arg !== null &&
    'metadata' in arg &&
    'release' in arg
  )
}

export function isApiBoardListItem(
  board: BoardIdentifier
): board is Required<BoardListItem> {
  return 'platform' in board && isPlatform(board.platform)
}

export async function pickBoard(
  arduino: Arduino,
  boardsConfig: BoardsConfig | undefined,
  detectedPorts: DetectedPorts,
  onDidChangeDetectedPorts: vscode.Event<unknown>,
  recentItems: RecentItems<BoardIdentifier> = noopRecentItems(),
  pinnedItems: RecentItems<BoardIdentifier> = noopRecentItems()
): Promise<PickBoardResult | undefined> {
  const toDispose: vscode.Disposable[] = []
  const input = vscode.window.createQuickPick()

  // https://github.com/microsoft/vscode/issues/73904#issuecomment-680298036
  ;(input as any).sortByLabel = false
  // https://github.com/microsoft/vscode/issues/83425
  ;(input as any).matchOnLabel = false
  input.placeholder = 'Filter boards by name or FQBN'
  input.busy = true
  // input.ignoreFocusOut = true // TODO:  (debug only)
  input.show()
  try {
    const selected = await new Promise<PickBoardResult | undefined>(
      (resolve) => {
        const cancel = new AbortController()
        let searchResultBoards: BoardListItem[] | undefined
        const search = async (searchArgs = '') => {
          input.busy = true
          try {
            searchResultBoards = !searchArgs
              ? undefined
              : await arduino.searchBoard({ searchArgs }, cancel.signal)
            updateItems()
          } finally {
            input.busy = false
          }
        }
        const updateItems = (): void => {
          const boardsList = createBoardsList(detectedPorts, boardsConfig)
          input.items = toBoardQuickPickItems(
            boardsList,
            searchResultBoards?.slice(),
            pinnedItems.items,
            recentItems.items
          )
        }
        toDispose.push(
          input.onDidChangeValue(search),
          input.onDidHide(() => {
            cancel.abort()
            resolve(undefined)
            input.dispose()
          }),
          input.onDidChangeSelection((items) => {
            const item = items[0]
            if (item instanceof QuickInputNoopLabel) {
              return
            }
            let result: PickBoardResult | undefined
            let selectedBoardForHistory: BoardIdentifier | undefined
            if (item instanceof BoardQuickPickItem) {
              result = item.data
              selectedBoardForHistory = item.data
            } else if (item instanceof BoardsListQuickPickItem) {
              result = item.item
              selectedBoardForHistory = item.item.board
            }
            if (selectedBoardForHistory) {
              // Fire and forget; history update is persisted via memento.
              recentItems.add(selectedBoardForHistory)
            }
            resolve(result)
            input.hide()
          }),
          input.onDidTriggerItemButton(async ({ item, button }) => {
            if (item instanceof QuickInputNoopLabel) {
              return
            }
            if (!(item instanceof BoardQuickPickItem)) {
              return
            }
            const data = item.data
            if (!data) {
              return
            }
            if (button === pinnedButton) {
              await pinnedItems.remove(data)
            } else if (button === pinButton) {
              await pinnedItems.add(data)
            } else if (button === removeButton) {
              await recentItems.remove(data)
            }
          }),
          onDidChangeDetectedPorts(updateItems),
          pinnedItems.onDidUpdate(updateItems),
          recentItems.onDidUpdate(updateItems)
        )
        updateItems()
        input.busy = false
      }
    )
    return selected
  } finally {
    disposeAll(...toDispose)
  }
}

export function toBoardQuickPickItems(
  boardsList: BoardsList,
  searchResultBoards: BoardListItem[] | undefined,
  pinnedBoards: BoardIdentifier[],
  recentBoards: BoardIdentifier[]
): vscode.QuickPickItem[] {
  const quickItems: vscode.QuickPickItem[] = []
  const pinnedAll = pinnedBoards.slice()
  const recentAll = recentBoards.slice()

  // When searching, only show pinned/recent entries that match the search
  // result. When no search term is active, show all pinned/recent.
  let pinned = pinnedAll
  let recent = recentAll
  if (searchResultBoards) {
    pinned = pinnedAll.filter((candidate) =>
      searchResultBoards.some((other) =>
        boardIdentifierEquals(candidate, other as any)
      )
    )
    recent = recentAll.filter((candidate) =>
      searchResultBoards.some((other) =>
        boardIdentifierEquals(candidate, other as any)
      )
    )
  }

  // Recent items should not duplicate pinned ones and are capped.
  recent = recent
    .filter(
      (candidate) =>
        !pinned.some((pinnedBoard) =>
          boardIdentifierEquals(pinnedBoard, candidate)
        )
    )
    .slice(0, 3)

  if (pinned.length) {
    quickItems.push({
      label: 'pinned boards',
      kind: vscode.QuickPickItemKind.Separator,
    })
    for (const board of pinned) {
      const item = new BoardQuickPickItem(board)
      setBoardButtons(item, pinnedBoards, recentBoards)
      quickItems.push(item)
    }
  }

  if (recent.length) {
    quickItems.push({
      label: 'recent boards',
      kind: vscode.QuickPickItemKind.Separator,
    })
    for (const board of recent) {
      const item = new BoardQuickPickItem(board)
      setBoardButtons(item, pinnedBoards, recentBoards)
      quickItems.push(item)
    }
  }

  const attachedItems: vscode.QuickPickItem[] = []
  for (const item of boardsList.boards) {
    if (searchResultBoards) {
      const searchResultItemIndex = searchResultBoards.findIndex((other) =>
        boardIdentifierEquals(other, item.board)
      )
      if (searchResultItemIndex >= 0) {
        searchResultBoards.splice(searchResultItemIndex, 1)
        const qpItem = new BoardsListQuickPickItem(item)
        setBoardButtons(qpItem, pinnedBoards, recentBoards)
        attachedItems.push(qpItem)
      }
    } else {
      const qpItem = new BoardsListQuickPickItem(item)
      setBoardButtons(qpItem, pinnedBoards, recentBoards)
      attachedItems.push(qpItem)
    }
  }
  if (attachedItems.length) {
    quickItems.push({
      label: 'attached boards',
      kind: vscode.QuickPickItemKind.Separator,
    })
    quickItems.push(...attachedItems)
  }

  if (searchResultBoards) {
    const searchOnlyBoards = searchResultBoards.filter(
      (board) =>
        !pinned.some((pinnedBoard) =>
          boardIdentifierEquals(pinnedBoard, board)
        ) &&
        !recent.some((recentBoard) => boardIdentifierEquals(recentBoard, board))
    )
    if (searchOnlyBoards.length) {
      quickItems.push({
        label: 'search result',
        kind: vscode.QuickPickItemKind.Separator,
      })
      quickItems.push(
        ...searchOnlyBoards.map((board) => {
          const item = new BoardQuickPickItem(board)
          setBoardButtons(item, pinnedBoards, recentBoards)
          return item
        })
      )
    }
  }

  if (!quickItems.length) {
    return [new QuickInputNoopLabel('No matching results')]
  }

  // When multiple items have the same label (board name), add a description
  // with the platform's name to disambiguate and push deprecated platforms
  // to the bottom of that label group. Otherwise keep the UI minimal.
  const labelsMapping = new Map<
    string,
    { index: number; item: BoardQuickPickItem }[]
  >()
  quickItems.forEach((quickItem, index) => {
    if (!(quickItem instanceof BoardQuickPickItem)) {
      return
    }
    if (!labelsMapping.has(quickItem.label)) {
      labelsMapping.set(quickItem.label, [])
    }
    labelsMapping.get(quickItem.label)?.push({ index, item: quickItem })
  })

  for (const entries of labelsMapping.values()) {
    if (entries.length > 1) {
      // 1) Add description from platform release name for disambiguation
      entries.forEach(({ item }) => {
        const platform = (item.board as any)?.platform
        const releaseName: string | undefined =
          platform?.release?.name ?? platform?.name
        if (releaseName) {
          item.description = releaseName
        }
      })

      // 2) Reorder items so non-deprecated platforms appear first
      const sorted = entries.slice().sort((left, right) => {
        const leftDeprecated = left.item.isDeprecatedPlatform ? 1 : 0
        const rightDeprecated = right.item.isDeprecatedPlatform ? 1 : 0
        return leftDeprecated - rightDeprecated
      })
      sorted.forEach(({ item }, offset) => {
        const targetIndex = entries[offset]!.index
        quickItems[targetIndex] = item
      })
    }
  }

  return quickItems
}

function setBoardButtons(
  item: BaseQuickPickItem<BoardIdentifier>,
  pinnedBoards: BoardIdentifier[],
  recentBoards: BoardIdentifier[]
): void {
  const board = item.data
  const isPinned = pinnedBoards.some((candidate) =>
    boardIdentifierEquals(candidate, board)
  )
  const isRecent = recentBoards.some((candidate) =>
    boardIdentifierEquals(candidate, board)
  )
  item.buttons.length = 0
  if (isPinned) {
    item.buttons.push(pinnedButton)
  } else {
    item.buttons.push(pinButton)
  }
  if (isRecent) {
    item.buttons.push(removeButton)
  }
}

class BaseQuickPickItem<T> implements vscode.QuickPickItem {
  readonly buttons: vscode.QuickInputButton[] = []
  readonly alwaysShow = true
  constructor(
    public label: string,
    public data: T
  ) {}
}

class BoardQuickPickItem extends BaseQuickPickItem<BoardIdentifier> {
  description?: string
  isDeprecatedPlatform?: boolean

  constructor(readonly board: BoardIdentifier) {
    super(board.name, board)
    // Platform metadata is inspected here only to compute deprecation state;
    // description is applied later only when labels collide.
    const platform = (board as any)?.platform
    const release = platform?.release
    if (release) {
      const name = String(release.name ?? '')
      const nameDeprecated = /^\s*\[deprecated/i.test(name)
      this.isDeprecatedPlatform = nameDeprecated
    }
  }
}

class BoardsListQuickPickItem extends BoardQuickPickItem {
  constructor(readonly item: BoardsListItemWithBoard) {
    super(item.board)
  }
}
export function portQuickItemLabel(port: Port, selected = false): string {
  const icon = portProtocolIcon(port)
  return `${selected ? '$(check) ' : ''}${icon} ${port.label}`
}

export async function getBoardDetails(
  fqbn: string,
  arduino: Arduino
): Promise<ApiBoardDetails | undefined> {
  try {
    return await ensureBoardDetails(fqbn, arduino)
  } catch (err) {
    return undefined
  }
}

export async function ensureBoardDetails(
  fqbn: string,
  arduino: Arduino
): Promise<ApiBoardDetails> {
  try {
    const response = await arduino.boardDetails({ fqbn })
    return toApiBoardDetails(response)
  } catch (err) {
    console.warn(`Failed getting board details for ${fqbn}`, err)
    if (err instanceof ClientError && err.code === Status.NOT_FOUND) {
      throw new PlatformNotInstalledError(fqbn)
    }
    throw err
  }
}

export class PlatformNotInstalledError extends Error {
  constructor(readonly fqbn: string) {
    super(`Platform is not installed for '${fqbn}'.`)
  }
}

export function toApiBoardDetails(
  response: BoardDetailsResponse
): ApiBoardDetails {
  const {
    fqbn,
    programmers,
    configOptions,
    toolsDependencies,
    defaultProgrammerId,
    name,
  } = response
  return {
    defaultProgrammerId,
    name,
    buildProperties: toApiBuildProperties(response.buildProperties),
    configOptions: configOptions.map(toApiConfigOption),
    fqbn,
    programmers,
    toolsDependencies: toolsDependencies.map(toApiTool),
  }
}

function toApiConfigOption(configOption: ApiConfigOption): ApiConfigOption {
  const { optionLabel, values, option } = configOption
  return { optionLabel, option, values: values.map(toApiConfigValue) }
}

function toApiConfigValue(configValue: ApiConfigValue): ApiConfigValue {
  const { valueLabel, selected, value } = configValue
  return { selected, value, valueLabel }
}

function toApiTool(toolDependency: ToolsDependencies): ApiTool {
  const { name, packager, version } = toolDependency
  return { name, packager, version }
}

const propertySep = '='

function parseProperty(
  property: string
): [key: string, value: string] | undefined {
  const segments = property.split(propertySep)
  if (segments.length < 2) {
    console.warn(`Could not parse build property: ${property}.`)
    return undefined
  }

  const [key, ...rest] = segments
  if (!key) {
    console.warn(`Could not determine property key from raw: ${property}.`)
    return undefined
  }
  const value = rest.join(propertySep)
  return [key, value]
}

export function toApiBuildProperties(properties: string[]): ApiBuildProperties {
  return properties.reduce(
    (acc, curr) => {
      const entry = parseProperty(curr)
      if (entry) {
        const [key, value] = entry
        acc[key] = value
      }
      return acc
    },
    <Record<string, string>>{}
  )
}

export function isBoardDetails(arg: unknown): arg is BoardDetails {
  if (!isBoardIdentifier(arg)) {
    return false
  }
  return (arg as BoardDetails).configOptions !== undefined
}

/**
 * Returns with a copy of the config options after altering the selected value.
 * Errors when the option to change or the new value is invalid.
 */
export function selectConfigValue(
  options: readonly ApiConfigOption[],
  optionToChange: string,
  newValue: string
): ApiConfigOption[] {
  const copy = options.slice()
  const option = copy.find((o) => o.option === optionToChange)
  if (!option) {
    throw new Error(
      `Config option not found: '${optionToChange}': ${JSON.stringify(options)}`
    )
  }
  const valueIndex = option.values.findIndex((v) => v.value === newValue)
  if (valueIndex < 0) {
    throw new Error(
      `Config value not found: '${newValue}': ${JSON.stringify(option)}`
    )
  }
  option.values.forEach((v, index) => (v.selected = index === valueIndex))
  return copy
}

export function getSelectedConfigValue(
  option: string,
  configValues: readonly ApiConfigValue[],
  currentConfigOptionsFQBN: string
): ApiConfigValue | undefined {
  const { options = {} } = new FQBN(currentConfigOptionsFQBN)
  const predicate: (v: ApiConfigValue) => boolean = options[option]
    ? (v) => v.value === options[option]
    : (v) => v.selected
  const selectedValue = configValues.find(predicate)
  return selectedValue
}
