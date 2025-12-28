import * as vscode from 'vscode'

import { BoardLabContextImpl } from './boardlabContext'
import {
  formatPlatformMissingTooltip,
  isPlatformRequirement,
  resolvePlatformMissingState,
  type PlatformMissingState,
} from './platformMissing'
import { platformIdFromFqbn } from './platformUtils'

const STATUS_TEXT = '$(warning) Platform missing'

type ActionItem = vscode.QuickPickItem & {
  action: 'install' | 'change-board' | 'learn-more'
}

export class PlatformMissingStatusBar implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem
  private readonly disposables: vscode.Disposable[]
  private updateToken = 0
  private currentState: PlatformMissingState | undefined

  constructor(private readonly boardlabContext: BoardLabContextImpl) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      'boardlab.platformMissingStatusBar',
      vscode.StatusBarAlignment.Left,
      101
    )
    this.statusBarItem.color = new vscode.ThemeColor(
      'statusBarItem.warningForeground'
    )
    this.statusBarItem.backgroundColor = new vscode.ThemeColor(
      'statusBarItem.warningBackground'
    )
    this.statusBarItem.command = 'boardlab.platformMissingActions'
    this.statusBarItem.text = STATUS_TEXT

    this.disposables = [
      this.statusBarItem,
      vscode.commands.registerCommand('boardlab.platformMissingActions', () =>
        this.handleAction()
      ),
      boardlabContext.onDidChangeSketch(() => this.refresh()),
      boardlabContext.onDidChangeCurrentSketch(() => this.refresh()),
      boardlabContext.platformsManager.onDidInstall(() => this.refresh()),
      boardlabContext.platformsManager.onDidUninstall(() => this.refresh()),
    ]

    this.refresh()
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose()
  }

  private async refresh(): Promise<void> {
    const token = ++this.updateToken
    const board = this.boardlabContext.currentSketch?.board
    let nextState = await resolvePlatformMissingState(board, (fqbn) =>
      this.boardlabContext.getBoardDetails(fqbn)
    )
    if (token !== this.updateToken) {
      return
    }
    nextState = await this.resolvePlatformInfo(nextState)
    if (token !== this.updateToken) {
      return
    }

    this.currentState = nextState
    if (!nextState) {
      this.statusBarItem.hide()
      return
    }

    this.statusBarItem.tooltip = formatPlatformMissingTooltip(nextState)
    this.statusBarItem.show()
  }

  private async handleAction(): Promise<void> {
    const state = this.currentState
    if (!state) {
      return
    }

    const items: ActionItem[] = []
    const requirement = isPlatformRequirement(state.platform)
      ? state.platform
      : undefined

    if (requirement) {
      items.push({
        label: `Install ${requirement.name}`,
        description: requirement.id,
        action: 'install',
      })
    }

    items.push({
      label: 'Change Board',
      action: 'change-board',
    })

    items.push({
      label: 'Learn More',
      description: 'Open Boards Manager',
      action: 'learn-more',
    })

    const selection = await vscode.window.showQuickPick(items, {
      placeHolder: 'Resolve missing platform',
    })

    if (!selection) {
      return
    }

    if (selection.action === 'install' && requirement) {
      await this.boardlabContext.platformsManager.install({
        id: requirement.id,
        name: requirement.name,
        version: requirement.version,
      })
      return
    }

    if (selection.action === 'change-board') {
      await this.boardlabContext.selectBoard()
      return
    }

    if (selection.action === 'learn-more') {
      await vscode.commands.executeCommand(
        'workbench.view.extension.boardlabPlatforms'
      )
    }
  }

  private async resolvePlatformInfo(
    state: PlatformMissingState | undefined
  ): Promise<PlatformMissingState | undefined> {
    if (!state?.fqbn) {
      return state
    }

    const existing = state.platform
    const platformId = existing?.id ?? platformIdFromFqbn(state.fqbn)
    if (!platformId) {
      return state
    }

    if (existing?.id && existing?.name && existing?.version) {
      return state
    }

    const quick = await this.boardlabContext.platformsManager
      .lookupPlatformQuick(platformId)
      .catch(() => undefined)
    const platform = {
      id: platformId,
      name: existing?.name ?? quick?.label,
      version:
        existing?.version ??
        quick?.availableVersions?.[0] ??
        quick?.installedVersion,
    }
    return { ...state, platform }
  }
}
