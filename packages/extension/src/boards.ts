import {
  BoardDetailsResponse,
  BoardListItem,
  Platform,
  ToolsDependencies,
} from 'ardunno-cli'
import {
  BoardIdentifier,
  BoardsConfig,
  BoardsList,
  BoardsListItemWithBoard,
  DetectedPorts,
  Port,
  PortIdentifier,
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

export class InmemoryRecentBoards extends InmemoryRecentItems<BoardIdentifier> {
  constructor() {
    super(boardIdentifierEquals)
  }
}

const pinButton = inputButton('pin', 'Pin board')
const pinnedButton = inputButton('pinned', 'Unpin board')
const removeButton = inputButton('discard', 'Remove from history')

type PickBoardResult = BoardIdentifier | BoardsListItemWithBoard
export type { PickBoardResult }

export interface BoardPickCandidate {
  readonly board: BoardIdentifier
  readonly port?: PortIdentifier
  readonly selection: PickBoardResult
}

export interface BoardPickOptions
  extends QuickPickConstraints<BoardPickCandidate> {}

function toBoardPickCandidate(selection: PickBoardResult): BoardPickCandidate {
  if (isBoardIdentifier(selection)) {
    return {
      board: selection,
      selection,
    }
  }
  return {
    board: selection.board,
    port: selection.port,
    selection,
  }
}

async function filterBoardIdentifiersForQuickPick<
  TBoard extends BoardIdentifier,
>(boards: ReadonlyArray<TBoard>, options: BoardPickOptions): Promise<TBoard[]> {
  const result: TBoard[] = []
  for (const board of boards) {
    if (
      await matchesQuickPickConstraints<BoardPickCandidate>(
        {
          board,
          selection: board,
        },
        options
      )
    ) {
      result.push(board)
    }
  }
  return result
}

async function isBoardSelectionAllowed(
  selection: PickBoardResult,
  options: BoardPickOptions
): Promise<boolean> {
  return matchesQuickPickConstraints(toBoardPickCandidate(selection), options)
}

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
  detectedPorts: () => DetectedPorts,
  onDidChangeDetectedPorts: vscode.Event<unknown>,
  recentItems: RecentItems<BoardIdentifier> = noopRecentItems(),
  pinnedItems: RecentItems<BoardIdentifier> = noopRecentItems(),
  options: BoardPickOptions = {}
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
        let updateToken = 0
        let searchResultBoards: BoardListItem[] | undefined
        const search = async (searchArgs = '') => {
          input.busy = true
          try {
            searchResultBoards = !searchArgs
              ? undefined
              : await arduino.searchBoard({ searchArgs }, cancel.signal)
          } finally {
            updateItems()
          }
        }
        const updateItems = (): void => {
          const currentToken = ++updateToken
          ;(async () => {
            input.busy = true
            try {
              const boardsList = createBoardsList(detectedPorts(), boardsConfig)
              const items = await toBoardQuickPickItems(
                boardsList,
                searchResultBoards?.slice(),
                pinnedItems.items,
                recentItems.items,
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
        toDispose.push(
          input.onDidChangeValue(search),
          input.onDidHide(() => {
            cancel.abort()
            resolve(undefined)
            input.dispose()
          }),
          input.onDidChangeSelection((items) => {
            ;(async () => {
              const item = items[0]
              if (item instanceof QuickInputNoopLabel) {
                return
              }
              let result: PickBoardResult | undefined
              let selectedBoardForHistory: BoardIdentifier | undefined
              if (item instanceof BoardsListQuickPickItem) {
                result = item.item
                selectedBoardForHistory = item.item.board
              } else if (item instanceof BoardQuickPickItem) {
                result = item.data
                selectedBoardForHistory = item.data
              }
              if (!result || !selectedBoardForHistory) {
                return
              }
              // Fire and forget; history update is persisted via memento.
              recentItems.add(selectedBoardForHistory)
              resolve(result)
              input.hide()
            })()
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
      }
    )
    return selected
  } finally {
    disposeAll(...toDispose)
  }
}

export async function toBoardQuickPickItems(
  boardsList: BoardsList,
  searchResultBoards: BoardListItem[] | undefined,
  pinnedBoards: BoardIdentifier[],
  recentBoards: BoardIdentifier[],
  options: BoardPickOptions = {}
): Promise<vscode.QuickPickItem[]> {
  const quickItems: vscode.QuickPickItem[] = []
  const filteredSearchResultBoards = searchResultBoards
    ? await filterBoardIdentifiersForQuickPick(searchResultBoards, options)
    : undefined
  const pinnedAll = await filterBoardIdentifiersForQuickPick(
    pinnedBoards.slice(),
    options
  )
  const recentAll = await filterBoardIdentifiersForQuickPick(
    recentBoards.slice(),
    options
  )

  // When searching, only show pinned/recent entries that match the search
  // result. When no search term is active, show all pinned/recent.
  let pinned = pinnedAll
  let recent = recentAll
  if (filteredSearchResultBoards) {
    pinned = pinnedAll.filter((candidate) =>
      filteredSearchResultBoards.some((other) =>
        boardIdentifierEquals(candidate, other as any)
      )
    )
    recent = recentAll.filter((candidate) =>
      filteredSearchResultBoards.some((other) =>
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

  function findMatchingIdentifiedBoard(
    other: BoardIdentifier
  ): BoardsListItemWithBoard | undefined {
    return boardsList.boards.find((b) => {
      if (other.fqbn && b.board.fqbn) {
        try {
          return new FQBN(other.fqbn)
            .sanitize()
            .equals(new FQBN(b.board.fqbn).sanitize())
        } catch {}
      }
      return false
    })
  }

  if (pinned.length) {
    quickItems.push({
      label: 'pinned boards',
      kind: vscode.QuickPickItemKind.Separator,
    })
    for (const board of pinned) {
      const matchingIdentifiedBoard = findMatchingIdentifiedBoard(board)
      const item = matchingIdentifiedBoard
        ? new BoardsListQuickPickItem(matchingIdentifiedBoard)
        : new BoardQuickPickItem(board)
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
      const matchingIdentifiedBoard = findMatchingIdentifiedBoard(board)
      const item = matchingIdentifiedBoard
        ? new BoardsListQuickPickItem(matchingIdentifiedBoard)
        : new BoardQuickPickItem(board)
      setBoardButtons(item, pinnedBoards, recentBoards)
      quickItems.push(item)
    }
  }

  const attachedItems: vscode.QuickPickItem[] = []
  for (const item of boardsList.boards) {
    if (!(await isBoardSelectionAllowed(item, options))) {
      continue
    }
    if (filteredSearchResultBoards) {
      const searchResultItemIndex = filteredSearchResultBoards.findIndex(
        (other) => boardIdentifierEquals(other, item.board)
      )
      if (searchResultItemIndex < 0) {
        continue
      }
      filteredSearchResultBoards.splice(searchResultItemIndex, 1)
      const qpItem = new BoardsListQuickPickItem(item)
      setBoardButtons(qpItem, pinnedBoards, recentBoards)
      attachedItems.push(qpItem)
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

  if (filteredSearchResultBoards) {
    const searchOnlyBoards = filteredSearchResultBoards.filter(
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
    if (isApiBoardListItem(board)) {
      const release = board.platform?.release
      if (release) {
        const name = String(release.name ?? '')
        const nameDeprecated = /^\s*\[deprecated/i.test(name)
        this.isDeprecatedPlatform = nameDeprecated
      }
    }
  }
}

class BoardsListQuickPickItem extends BoardQuickPickItem {
  constructor(
    readonly item: BoardsListItemWithBoard & { port?: PortIdentifier }
  ) {
    super(item.board)
    if (item.port) {
      this.description = `on ${item.port.address}`
    }
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
