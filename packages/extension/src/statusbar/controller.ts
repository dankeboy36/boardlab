import { basename } from 'node:path'

import { createPortKey } from 'boards-list'
import * as vscode from 'vscode'

import type { BoardLabContextImpl } from '../boardlabContext'
import { deriveOnboardingState } from '../onboarding/state'
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

function boardLabel(board: unknown): string | undefined {
  if (!board || typeof board !== 'object') {
    return undefined
  }
  const name = (board as { name?: unknown }).name
  if (typeof name === 'string' && name.trim()) {
    return name.trim()
  }
  const fqbn = (board as { fqbn?: unknown }).fqbn
  if (typeof fqbn === 'string' && fqbn.trim()) {
    return fqbn.trim()
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

function derivePlatformInstallCandidate(board: unknown): {
  canInstall: boolean
  label?: string
} {
  if (!board || typeof board !== 'object') {
    return { canInstall: false }
  }
  const platform = (board as { platform?: any }).platform
  const metadataId = platform?.metadata?.id
  const platformName = platform?.release?.name ?? platform?.name
  const fqbn = (board as { fqbn?: unknown }).fqbn
  const platformId =
    (typeof metadataId === 'string' && metadataId.trim()) ||
    (typeof fqbn === 'string' ? platformIdFromFqbn(fqbn) : undefined)

  if (!platformId) {
    return { canInstall: false }
  }
  const label =
    (typeof platformName === 'string' && platformName.trim()) ||
    platformId ||
    'platform'
  return {
    canInstall: true,
    label,
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
  }

  private refresh(): void {
    const token = ++this.updateToken
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
    const candidate = derivePlatformInstallCandidate(currentSketch?.board)
    const context: StatusBarModelContext = {
      currentSketchName: currentSketch
        ? basename(currentSketch.sketchPath)
        : undefined,
      openedSketchesCount: workspaceOpenedSketchesCount(boardlabContext),
      boardLabel: boardLabel(currentSketch?.board),
      boardFqbn: boardFqbn(currentSketch?.board),
      portAddress: selectedPort?.address,
      portDetected,
      canInstallPlatform: candidate.canInstall,
      platformInstallLabel: candidate.label,
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
    }
  }

  private upsertItem(item: StatusBarModelItem): vscode.StatusBarItem {
    const existing = this.itemsById.get(item.id)
    if (existing) {
      return existing
    }
    const created = vscode.window.createStatusBarItem(
      `${this.statusBarIdPrefix}.${item.id}`,
      toAlignment(item.alignment),
      item.priority
    )
    this.itemsById.set(item.id, created)
    return created
  }
}
