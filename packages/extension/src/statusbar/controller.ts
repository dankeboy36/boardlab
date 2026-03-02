import { basename } from 'node:path'

import { createPortKey } from 'boards-list'
import { FQBN } from 'fqbn'
import * as vscode from 'vscode'

import type { BoardLabContextImpl } from '../boardlabContext'
import { deriveOnboardingState } from '../onboarding/state'
import { extractPlatformInfo } from '../platformMissing'
import { platformIdFromFqbn } from '../platformUtils'
import {
  deriveStatusBarModel,
  type StatusBarModelContext,
  type StatusBarModelItem,
} from './model'
import type { CliHealthService } from '../onboarding/cliHealthService'
import type { OnboardingIntentService } from '../onboarding/intentService'
import type { RuntimeStateService } from './runtimeStateService'

function toAlignment(alignment?: 'left' | 'right'): vscode.StatusBarAlignment {
  return alignment === 'right'
    ? vscode.StatusBarAlignment.Right
    : vscode.StatusBarAlignment.Left
}

function boardNameFromDetectedBoards(
  boards: readonly unknown[] | undefined,
  fqbn: string | undefined
): string | undefined {
  if (!boards?.length) {
    return undefined
  }
  const namedBoards = boards.flatMap((board) => {
    const name = (board as { name?: unknown })?.name
    if (typeof name !== 'string' || !name.trim()) {
      return []
    }
    const candidateFqbn = (board as { fqbn?: unknown })?.fqbn
    return [
      {
        name: name.trim(),
        fqbn:
          typeof candidateFqbn === 'string' && candidateFqbn.trim()
            ? candidateFqbn.trim()
            : undefined,
      },
    ]
  })
  if (!namedBoards.length) {
    return undefined
  }
  if (fqbn) {
    const matched = namedBoards.find((board) =>
      boardFqbnEquals(board.fqbn, fqbn)
    )
    if (matched) {
      return matched.name
    }
  }
  return namedBoards.length === 1 ? namedBoards[0]?.name : undefined
}

function boardFqbnEquals(left: string | undefined, right: string): boolean {
  if (!left) {
    return false
  }
  try {
    return new FQBN(left).sanitize().equals(new FQBN(right).sanitize())
  } catch {
    return left.trim() === right.trim()
  }
}

function derivedBoardLabelFromDetectedPorts(
  boardlabContext: BoardLabContextImpl,
  fqbn: string | undefined,
  selectedPort: { protocol: string; address: string } | undefined
): string | undefined {
  const detectedPorts = Object.values(boardlabContext.boardsListWatcher.detectedPorts)
  if (!detectedPorts.length) {
    return undefined
  }
  if (selectedPort) {
    const exactMatch =
      boardlabContext.boardsListWatcher.detectedPorts[createPortKey(selectedPort)]
    const exactLabel = boardNameFromDetectedBoards(exactMatch?.boards, fqbn)
    if (exactLabel) {
      return exactLabel
    }

    const selectedAddress = normalizePortAddress(selectedPort.address)
    if (selectedAddress) {
      const addressMatch = detectedPorts.find(
        ({ port }) => normalizePortAddress(port?.address) === selectedAddress
      )
      const addressLabel = boardNameFromDetectedBoards(addressMatch?.boards, fqbn)
      if (addressLabel) {
        return addressLabel
      }
    }
  }

  const labels = detectedPorts
    .map((detectedPort) => boardNameFromDetectedBoards(detectedPort.boards, fqbn))
    .filter((label): label is string => Boolean(label))
  return labels.length === 1 ? labels[0] : undefined
}

function boardLabel(
  boardlabContext: BoardLabContextImpl,
  board: unknown,
  selectedPort: { protocol: string; address: string } | undefined
): string | undefined {
  if (!board || typeof board !== 'object') {
    return undefined
  }
  const name = (board as { name?: unknown }).name
  const fqbn = (board as { fqbn?: unknown }).fqbn
  const trimmedName = typeof name === 'string' && name.trim() ? name.trim() : undefined
  const trimmedFqbn =
    typeof fqbn === 'string' && fqbn.trim() ? fqbn.trim() : undefined
  if (trimmedName && (!trimmedFqbn || trimmedName !== trimmedFqbn)) {
    return trimmedName
  }
  const detectedLabel = derivedBoardLabelFromDetectedPorts(
    boardlabContext,
    trimmedFqbn,
    selectedPort
  )
  if (detectedLabel) {
    return detectedLabel
  }
  if (trimmedName) {
    return trimmedName
  }
  if (trimmedFqbn) {
    return trimmedFqbn
  }
  return undefined
}

function boardFqbn(board: unknown): string | undefined {
  if (!board || typeof board !== 'object') {
    return undefined
  }
  const fqbn = (board as { fqbn?: unknown }).fqbn
  if (typeof fqbn === 'string' && fqbn.trim()) {
    return fqbn.trim()
  }
  return undefined
}

function formatPlatformInstallLabel(name: string, id: string): string {
  const trimmedName = name.trim()
  const trimmedId = id.trim()
  if (trimmedName && trimmedId && trimmedName !== trimmedId) {
    return `${trimmedName} (${trimmedId}) platform`
  }
  return `${trimmedName || trimmedId} platform`
}

async function derivePlatformInstallCandidate(
  boardlabContext: BoardLabContextImpl,
  board: unknown
): Promise<{
  canInstall: boolean
  label?: string
  args?: readonly unknown[]
}> {
  if (!board || typeof board !== 'object') {
    return { canInstall: false }
  }
  const platform = extractPlatformInfo(board as any)
  const fqbn = (board as { fqbn?: unknown }).fqbn
  const platformId =
    (typeof platform?.id === 'string' && platform.id.trim()) ||
    (typeof fqbn === 'string' ? platformIdFromFqbn(fqbn) : undefined)

  if (!platformId) {
    return { canInstall: false }
  }
  const quick = await boardlabContext.platformsManager
    .lookupPlatformQuick(platformId)
    .catch(() => undefined)
  const platformName =
    (typeof platform?.name === 'string' && platform.name.trim()) ||
    quick?.label ||
    platformId
  const version =
    (typeof platform?.version === 'string' && platform.version.trim()) ||
    quick?.availableVersions[0] ||
    quick?.installedVersion
  const label = formatPlatformInstallLabel(platformName, platformId)
  return {
    canInstall: true,
    label,
    args: version
      ? [
          {
            id: platformId,
            name: platformName,
            availableVersions: [version],
          },
        ]
      : undefined,
  }
}

function normalizePortAddress(address: string | undefined): string | undefined {
  const trimmed = address?.trim()
  return trimmed ? trimmed.toLowerCase() : undefined
}

function workspaceOpenedSketchesCount(
  boardlabContext: BoardLabContextImpl
): number {
  const uniqueSketchPaths = new Set<string>()
  for (const sketch of boardlabContext.openedSketches) {
    const sketchPath = sketch?.sketchPath
    if (!sketchPath) {
      continue
    }
    if (!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(sketchPath))) {
      continue
    }
    uniqueSketchPaths.add(sketchPath)
  }
  return uniqueSketchPaths.size
}

function isSelectedPortDetected(
  boardlabContext: BoardLabContextImpl,
  selectedPort: { protocol: string; address: string } | undefined
): boolean | undefined {
  if (!selectedPort) {
    return undefined
  }

  const exactMatch = Boolean(
    boardlabContext.boardsListWatcher.detectedPorts[createPortKey(selectedPort)]
  )
  if (exactMatch) {
    return true
  }

  if (boardlabContext.monitorManager.isPortDetected(selectedPort)) {
    return true
  }

  const selectedAddress = normalizePortAddress(selectedPort.address)
  if (!selectedAddress) {
    return false
  }

  return Object.values(boardlabContext.boardsListWatcher.detectedPorts).some(
    ({ port }) => normalizePortAddress(port?.address) === selectedAddress
  )
}

interface OnboardingStatusBarControllerParams {
  readonly boardlabContext: BoardLabContextImpl
  readonly cliHealthService: CliHealthService
  readonly intentService: OnboardingIntentService
  readonly runtimeStateService: RuntimeStateService
}

export class OnboardingStatusBarController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[]
  private readonly itemsById = new Map<string, vscode.StatusBarItem>()
  private readonly itemLayoutById = new Map<
    string,
    Pick<StatusBarModelItem, 'alignment' | 'priority'>
  >()
  private readonly statusBarIdPrefix = 'boardlab.onboardingStatusBar'
  private updateToken = 0

  constructor(private readonly params: OnboardingStatusBarControllerParams) {
    const {
      boardlabContext,
      cliHealthService,
      intentService,
      runtimeStateService,
    } = params
    this.disposables = [
      boardlabContext.onDidChangeCurrentSketch(() => this.refresh()),
      boardlabContext.onDidChangeSketch(() => this.refresh()),
      boardlabContext.onDidChangeSketchFolders(() => this.refresh()),
      boardlabContext.boardsListWatcher.onDidChangeDetectedPorts(() =>
        this.refresh()
      ),
      boardlabContext.platformsManager.onDidUpdate(() => this.refresh()),
      cliHealthService.onDidChangeCliStatus(() => this.refresh()),
      intentService.onDidChangeIntent(() => this.refresh()),
      runtimeStateService.onDidChangeRuntimeState(() => this.refresh()),
    ]
    this.refresh()
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose()
    for (const item of this.itemsById.values()) {
      item.dispose()
    }
    this.itemsById.clear()
    this.itemLayoutById.clear()
  }

  private refresh(): void {
    const token = ++this.updateToken
    void this.refreshInternal(token).catch((error) =>
      console.warn('Failed to refresh onboarding status bar', error)
    )
  }

  private async refreshInternal(token: number): Promise<void> {
    const {
      boardlabContext,
      cliHealthService,
      intentService,
      runtimeStateService,
    } = this.params

    const state = deriveOnboardingState({
      cliStatus: cliHealthService.cliStatus,
      arduinoContext: boardlabContext,
      intent: intentService.intent,
    })

    const currentSketch = boardlabContext.currentSketch
    const selectedPort =
      currentSketch?.port?.protocol && currentSketch.port.address
        ? {
            protocol: currentSketch.port.protocol,
            address: currentSketch.port.address,
          }
        : undefined
    const portDetected = isSelectedPortDetected(boardlabContext, selectedPort)
    const candidate = await derivePlatformInstallCandidate(
      boardlabContext,
      currentSketch?.board
    )
    const context: StatusBarModelContext = {
      currentSketchName: currentSketch
        ? basename(currentSketch.sketchPath)
        : undefined,
      openedSketchesCount: workspaceOpenedSketchesCount(boardlabContext),
      boardLabel: boardLabel(boardlabContext, currentSketch?.board, selectedPort),
      boardFqbn: boardFqbn(currentSketch?.board),
      portAddress: selectedPort?.address,
      portDetected,
      canInstallPlatform: candidate.canInstall,
      platformInstallLabel: candidate.label,
      platformInstallArgs: candidate.args,
      runtime: runtimeStateService.runtimeState,
    }

    const model = deriveStatusBarModel(state, context)
    if (token !== this.updateToken) {
      return
    }
    this.render(model)
  }

  private render(model: StatusBarModelItem[]): void {
    const seen = new Set<string>()
    for (const itemModel of model) {
      seen.add(itemModel.id)
      const item = this.upsertItem(itemModel)
      item.text = itemModel.text
      item.tooltip = itemModel.tooltip
      if (itemModel.command && itemModel.args?.length) {
        item.command = {
          command: itemModel.command,
          title: itemModel.text,
          arguments: itemModel.args as unknown[],
        }
      } else {
        item.command = itemModel.command
      }
      item.show()
    }

    for (const [id, item] of this.itemsById.entries()) {
      if (seen.has(id)) {
        continue
      }
      item.dispose()
      this.itemsById.delete(id)
      this.itemLayoutById.delete(id)
    }
  }

  private upsertItem(item: StatusBarModelItem): vscode.StatusBarItem {
    const existing = this.itemsById.get(item.id)
    const nextLayout = {
      alignment: item.alignment,
      priority: item.priority,
    }
    const currentLayout = this.itemLayoutById.get(item.id)
    if (
      existing &&
      currentLayout?.alignment === nextLayout.alignment &&
      currentLayout?.priority === nextLayout.priority
    ) {
      return existing
    }
    existing?.dispose()
    const created = vscode.window.createStatusBarItem(
      `${this.statusBarIdPrefix}.${item.id}`,
      toAlignment(item.alignment),
      item.priority
    )
    this.itemsById.set(item.id, created)
    this.itemLayoutById.set(item.id, nextLayout)
    return created
  }
}
