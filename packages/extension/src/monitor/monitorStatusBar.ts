import { createPortKey, type PortIdentifier } from 'boards-list'
import * as vscode from 'vscode'

import { BoardLabContextImpl } from '../boardlabContext'
import { portProtocolIcon } from '../ports'
import {
  getTaskStatus,
  onDidChangeTaskStates,
  type TaskKind,
} from '../taskTracker'

type MonitorActionItem = vscode.QuickPickItem & {
  action: 'open-monitor' | 'open-plotter' | 'disconnect'
}

export class MonitorStatusBar implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem
  private readonly disposables: vscode.Disposable[]

  constructor(private readonly boardlabContext: BoardLabContextImpl) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      'boardlab.monitorStatusBar',
      vscode.StatusBarAlignment.Left,
      100.5
    )
    this.statusBarItem.command = 'boardlab.monitor.statusActions'

    this.disposables = [
      this.statusBarItem,
      vscode.commands.registerCommand('boardlab.monitor.statusActions', () =>
        this.handleStatusActions()
      ),
      boardlabContext.onDidChangeCurrentSketch(() => this.refresh()),
      boardlabContext.onDidChangeSketch(() => this.refresh()),
      boardlabContext.monitorManager.onDidChangeRunningMonitors(() =>
        this.refresh()
      ),
      boardlabContext.monitorManager.onDidChangeMonitorState(() =>
        this.refresh()
      ),
      onDidChangeTaskStates(() => this.refresh()),
    ]

    this.refresh()
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose()
  }

  private refresh(): void {
    const port = this.currentPort()
    if (!port) {
      this.statusBarItem.hide()
      return
    }

    const portKey = createPortKey(port)
    const running = this.boardlabContext.monitorManager
      .getRunningMonitors()
      .some(({ port: runningPort }) => createPortKey(runningPort) === portKey)
    const state = this.boardlabContext.monitorManager.getMonitorState(port)

    if (!running && state === 'disconnected') {
      this.statusBarItem.hide()
      return
    }

    const isSuspended = state === 'suspended' || this.isUploadActive(portKey)
    const icon = isSuspended ? '$(sync~spin)' : '$(pulse)'
    const portLabel = this.formatPortLabel(port)

    this.statusBarItem.text = portLabel
      ? `${icon} Monitor - ${portLabel}`
      : `${icon} Monitor`
    this.statusBarItem.tooltip = isSuspended
      ? 'Monitor suspended on current port (upload in progress).'
      : 'Monitor running on current port.'
    this.statusBarItem.show()
  }

  private currentPort(): PortIdentifier | undefined {
    const port = this.boardlabContext.currentSketch?.port
    if (!port?.protocol || !port.address) {
      return undefined
    }
    return { protocol: port.protocol, address: port.address }
  }

  private formatPortLabel(port: PortIdentifier): string {
    return `${portProtocolIcon(port)} ${port.address}`
  }

  private isUploadActive(portKey: string): boolean {
    const sketchPath = this.boardlabContext.currentSketch?.sketchPath
    const suspendingKinds: TaskKind[] = [
      'upload',
      'upload-using-programmer',
      'burn-bootloader',
    ]
    return suspendingKinds.some(
      (kind) => getTaskStatus(kind, sketchPath, portKey) === 'running'
    )
  }

  private async handleStatusActions(): Promise<void> {
    const port = this.currentPort()
    if (!port) {
      return
    }

    const items: MonitorActionItem[] = [
      {
        label: 'Open Monitor',
        action: 'open-monitor',
      },
      {
        label: 'Open Plotter',
        action: 'open-plotter',
      },
      {
        label: 'Disconnect Monitor',
        description: 'Close the monitor connection for this port',
        action: 'disconnect',
      },
    ]

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `Monitor actions for ${port.address}`,
    })
    if (!picked) {
      return
    }

    if (picked.action === 'open-monitor') {
      await vscode.commands.executeCommand('boardlab.monitor.focus')
      return
    }
    if (picked.action === 'open-plotter') {
      await vscode.commands.executeCommand('boardlab.plotter.focus')
      return
    }
    if (picked.action === 'disconnect') {
      await this.disconnectMonitor(port)
    }
  }

  private async disconnectMonitor(port: PortIdentifier): Promise<void> {
    const state = this.boardlabContext.monitorManager.getMonitorState(port)
    if (state === 'disconnected') {
      vscode.window.showInformationMessage('No running monitor to disconnect.')
      return
    }
    const paused = await this.boardlabContext.monitorManager.pauseMonitor(port)
    if (!paused) {
      vscode.window.showErrorMessage('Failed to disconnect the monitor.')
      return
    }
    vscode.window.showInformationMessage(
      'Monitor paused. Full disconnect will be added in a follow-up.'
    )
  }
}
