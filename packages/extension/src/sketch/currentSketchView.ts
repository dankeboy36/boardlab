import * as fs from 'node:fs'
import path from 'node:path'

import { createPortKey } from 'boards-list'
import { FQBN } from 'fqbn'
import vscode from 'vscode'
import { SketchFolder } from 'vscode-arduino-api'

import { BoardLabContextImpl } from '../boardlabContext'
import { getSelectedConfigValue, isBoardDetails } from '../boards'
import { portProtocolIcon } from '../ports'
import { type TaskKind } from '../taskTracker'
import { presentTaskStatus } from '../taskUiState'
import { HasSketchFolder } from './sketchbooks'
import { SketchFolderImpl } from './sketchFolder'

abstract class TreeItem extends vscode.TreeItem implements HasSketchFolder {
  parent?: TreeItem
  children?: TreeItem[]
  abstract readonly sketch: SketchFolder
}

export class CurrentSketchView implements vscode.Disposable {
  private _disposable: vscode.Disposable[]
  private readonly treeDataProvider: CurrentSketchViewDataProvider
  private readonly treeView: vscode.TreeView<vscode.TreeItem>

  constructor(boardlabContext: BoardLabContextImpl) {
    this._disposable = []
    this.treeDataProvider = new CurrentSketchViewDataProvider(boardlabContext)
    this.treeView = vscode.window.createTreeView('boardlab.currentSketch', {
      treeDataProvider: this.treeDataProvider,
      showCollapseAll: true,
    })
    const updateDescription = () => {
      const activeProfileName = boardlabContext.getActiveProfileForUri(
        boardlabContext.currentSketch
      )
      this.treeView.description = activeProfileName ?? ''
    }
    const updateTitle = () => {
      const sketchPath = boardlabContext.currentSketch?.sketchPath
      if (sketchPath) {
        this.treeView.title = `Current Sketch • ${path.basename(sketchPath)}`
        return
      }
      if (boardlabContext.sketchbooks.isLoading) {
        this.treeView.title = 'Current Sketch • Loading...'
        return
      }
      if (boardlabContext.sketchbooks.isEmpty) {
        this.treeView.title = 'Current Sketch • No sketches found'
        return
      }
      this.treeView.title = 'Current Sketch • No sketch selected'
    }

    this._disposable.push(
      this.treeView,
      this.treeDataProvider,
      boardlabContext.onDidChangeCurrentSketch(() => {
        updateTitle()
        updateDescription()
      }),
      boardlabContext.onDidChangeActiveProfile(() => {
        updateDescription()
      }),
      boardlabContext.sketchbooks.onDidRefresh(() => {
        updateTitle()
        updateDescription()
      })
    )

    updateTitle()
    updateDescription()
  }

  refresh(): void {
    this.treeDataProvider.refresh()
  }

  async revealCurrentSketch(): Promise<void> {
    try {
      const roots = this.treeDataProvider.getChildren()
      const target = roots?.[0]
      if (target) {
        await this.treeView.reveal(target, { expand: true })
      }
    } catch (error) {
      console.warn('Failed to reveal current sketch view item', error)
    }
  }

  dispose() {
    vscode.Disposable.from(...this._disposable).dispose()
    this._disposable = []
  }
}

class CurrentSketchViewDataProvider
  implements vscode.TreeDataProvider<TreeItem>
{
  private readonly _onDidChange: vscode.EventEmitter<void>
  private readonly toDispose: vscode.Disposable[]
  private profileWatcher: vscode.Disposable | undefined

  constructor(private readonly boardlabContext: BoardLabContextImpl) {
    this._onDidChange = new vscode.EventEmitter()
    this.toDispose = [
      this._onDidChange,
      boardlabContext.sketchbooks.onDidChangeResolvedSketches(() =>
        this._onDidChange.fire()
      ),
      boardlabContext.onDidChangeCurrentSketch(() => {
        this.updateProfileWatcher()
        this._onDidChange.fire()
      }),
      boardlabContext.onDidChangeSketch(() => this._onDidChange.fire()),
      boardlabContext.onDidChangeActiveProfile(() => this._onDidChange.fire()),
      vscode.workspace.onDidCreateFiles((event) =>
        this.onFilesChanged(event.files)
      ),
      vscode.workspace.onDidDeleteFiles((event) =>
        this.onFilesChanged(event.files)
      ),
      vscode.workspace.onDidRenameFiles((event) =>
        this.onFilesChanged(
          event.files.flatMap((entry) => [entry.oldUri, entry.newUri])
        )
      ),
    ]
    this.updateProfileWatcher()
  }

  get onDidChangeTreeData(): vscode.Event<void> {
    return this._onDidChange.event
  }

  refresh(): void {
    this._onDidChange.fire()
  }

  getTreeItem(element: vscode.TreeItem): TreeItem {
    if (element instanceof TreeItem) {
      return element
    }
    throw new Error(`Illegal argument: ${element}`)
  }

  getChildren(element?: TreeItem | undefined): TreeItem[] | undefined {
    if (!element) {
      const currentSketch = this.boardlabContext.currentSketch
      if (currentSketch) {
        const items: TreeItem[] = [
          new BoardTreeItem(currentSketch, currentSketch.board),
        ]

        const programmerDescription = createProgrammerItemDescription(
          currentSketch.selectedProgrammer,
          currentSketch.board
        )
        if (programmerDescription) {
          items.push(
            new ProgrammerItem(currentSketch, programmerDescription.description)
          )
        }
        items.push(new PortTreeItem(currentSketch, currentSketch.port))

        items.push(
          new BuildAndUploadTasksRootItem(currentSketch),
          new ToolsRootItem(
            currentSketch,
            this.boardlabContext.getActiveProfileForUri(currentSketch)
          ),
          new MaintenanceTasksRootItem(currentSketch)
        )
        return items
      }
    }
    return element?.children
  }

  getParent(element: TreeItem): TreeItem | undefined {
    return element.parent
  }

  dispose() {
    vscode.Disposable.from(...this.toDispose).dispose()
  }

  private updateProfileWatcher(): void {
    this.profileWatcher?.dispose()
    this.profileWatcher = undefined

    const currentSketch = this.boardlabContext.currentSketch
    if (!currentSketch) {
      return
    }

    const folderUri = vscode.Uri.file(currentSketch.sketchPath)
    const pattern = new vscode.RelativePattern(folderUri, 'sketch.yaml')
    const watcher = vscode.workspace.createFileSystemWatcher(pattern)
    this.profileWatcher = vscode.Disposable.from(
      watcher,
      watcher.onDidCreate(() => this._onDidChange.fire()),
      watcher.onDidDelete(() => this._onDidChange.fire()),
      watcher.onDidChange(() => this._onDidChange.fire())
    )
    this.toDispose.push(this.profileWatcher)
  }

  private onFilesChanged(uris: readonly vscode.Uri[]): void {
    const currentSketch = this.boardlabContext.currentSketch
    if (!currentSketch) {
      return
    }
    const sketchYamlPath = path.join(currentSketch.sketchPath, 'sketch.yaml')
    if (uris.some((uri) => uri.fsPath === sketchYamlPath)) {
      this._onDidChange.fire()
    }
  }
}

class PortTreeItem extends TreeItem {
  constructor(
    readonly sketch: SketchFolder,
    port: SketchFolder['port']
  ) {
    super(port?.address ? 'Port' : 'No port selected')
    this.iconPath = new vscode.ThemeIcon(
      port ? portProtocolIcon(port, false) : 'plug'
    )
    if (port?.address) {
      this.description = port.address
      if (port.protocol) {
        this.description += ` (${port.protocol})`
      }
    }
    this.contextValue = 'port'
  }
}

class ToolsRootItem extends TreeItem {
  readonly sketch: SketchFolder
  private readonly activeProfileName?: string

  constructor(sketch: SketchFolder, activeProfileName?: string) {
    super('Tools', vscode.TreeItemCollapsibleState.Expanded)
    this.sketch = sketch
    this.activeProfileName = activeProfileName
    this.iconPath = new vscode.ThemeIcon('tools')
    this.contextValue = 'toolsRoot'
    const children: TreeItem[] = [
      new TaskItem(
        sketch,
        'Open Monitor',
        'boardlab.openMonitor',
        'terminal',
        'Open the serial monitor for the selected port.',
        'tool'
      ),
      new TaskItem(
        sketch,
        'Open Plotter',
        'boardlab.plotter.focus',
        'graph-line',
        'Open the plotter for the selected port.',
        'tool'
      ),
    ]
    const profileExists = hasSketchProfile(sketch)
    const profileTask = new TaskItem(
      sketch,
      profileExists ? 'Open Profiles' : 'Create Profile',
      profileExists
        ? 'boardlab.profiles.openSketchProfile'
        : 'boardlab.profiles.createSketchProfile',
      'account',
      profileExists
        ? 'Open the sketch.yaml profile for this sketch.'
        : 'Create a sketch.yaml profile for this sketch.',
      'tool'
    )
    if (profileExists) {
      profileTask.contextValue = 'profileTool'
    }
    if (profileExists && this.activeProfileName) {
      profileTask.description = this.activeProfileName
    }
    children.push(profileTask)
    this.children = children
  }
}

class BuildAndUploadTasksRootItem extends TreeItem {
  readonly sketch: SketchFolder

  constructor(sketch: SketchFolder) {
    super('Build & Upload', vscode.TreeItemCollapsibleState.Expanded)
    this.sketch = sketch
    this.iconPath = new vscode.ThemeIcon('run-all')
    this.contextValue = 'buildTasksRoot'
    const children: TreeItem[] = [
      new TaskItem(
        sketch,
        'Compile',
        'boardlab.compile',
        'check',
        'Compile the current sketch.',
        'task'
      ),
      new TaskItem(
        sketch,
        'Upload',
        'boardlab.upload',
        'arrow-right',
        'Upload the current sketch to the selected board and port.',
        'task'
      ),
      new TaskItem(
        sketch,
        'Upload Using Programmer',
        'boardlab.uploadUsingProgrammer',
        'server-process',
        'Upload the current sketch using the selected programmer.',
        'task'
      ),
      new TaskItem(
        sketch,
        'Export Compiled Binary',
        'boardlab.exportBinary',
        'file-binary',
        'Build and export the compiled binary for this sketch.',
        'task'
      ),
    ]
    this.children = children
  }
}

class MaintenanceTasksRootItem extends TreeItem {
  readonly sketch: SketchFolder

  constructor(sketch: SketchFolder) {
    super('Maintenance', vscode.TreeItemCollapsibleState.Collapsed)
    this.sketch = sketch
    this.iconPath = new vscode.ThemeIcon('wrench')
    this.contextValue = 'maintenanceTasksRoot'
    const children: TreeItem[] = [
      new TaskItem(
        sketch,
        'Burn Bootloader',
        'boardlab.burnBootloader',
        'flame',
        'Burn the bootloader on the selected board.',
        'task'
      ),
      new TaskItem(
        sketch,
        'Get Board Info',
        'boardlab.getBoardInfo',
        'info',
        'Show detailed information about the selected board.',
        'task'
      ),
      new TaskItem(
        sketch,
        'Archive Sketch',
        'boardlab.archiveSketch',
        'file-zip',
        'Archive the current sketch folder.',
        'task'
      ),
    ]
    this.children = children
  }
}

class TaskItem extends TreeItem {
  readonly sketch: SketchFolder
  private readonly kind: 'tool' | 'task'
  private readonly taskKind?: TaskKind
  private readonly portKey?: string
  private readonly baseDescription?: string
  private readonly defaultIconId: string
  // For tools: remember the underlying command and arguments so a generic
  // handler can execute them from an inline action.
  readonly toolCommandId?: string
  readonly toolArgs?: Record<string, unknown>

  constructor(
    sketch: SketchFolder,
    label: string,
    commandId: string,
    icon: string,
    tooltip?: string,
    kind: 'tool' | 'task' = 'task'
  ) {
    super(label, vscode.TreeItemCollapsibleState.None)
    this.sketch = sketch
    this.kind = kind
    this.iconPath = new vscode.ThemeIcon(icon)
    this.defaultIconId = icon
    this.tooltip = tooltip
    this.baseDescription =
      typeof this.description === 'string' ? this.description : ''
    const args: Record<string, unknown> = {
      sketchPath: sketch.sketchPath,
    }
    const fqbn = sketch.configOptions || sketch.board?.fqbn
    if (fqbn) {
      args.fqbn = fqbn
    }
    if (sketch.port) {
      const portKey = createPortKey(sketch.port)
      args.port = portKey
      this.portKey = portKey
    }
    if (
      commandId === 'boardlab.uploadUsingProgrammer' ||
      commandId === 'boardlab.burnBootloader'
    ) {
      const selectedProgrammer = sketch.selectedProgrammer
      const programmerId =
        typeof selectedProgrammer === 'string'
          ? selectedProgrammer
          : selectedProgrammer?.id
      if (programmerId) {
        args.programmer = programmerId
      }
    }

    const taskKind = toTaskKind(commandId)
    this.taskKind = taskKind

    if (kind === 'tool' || !taskKind) {
      this.toolCommandId = commandId
      this.toolArgs = args
      this.contextValue = 'tool'
      return
    }

    // Task: wire via meta-command so we can enforce concurrency and track status.
    this.command = {
      command: 'boardlab.task.runFromTree',
      title: label,
      arguments: [
        {
          kind: taskKind,
          sketchPath: sketch.sketchPath,
          port: this.portKey,
          fqbn: args.fqbn,
          programmer: args.programmer,
          commandId,
        },
      ],
    }
    this.updateStatus()
  }

  updateStatus(): void {
    if (this.kind === 'tool' || !this.taskKind) {
      this.contextValue = 'tool'
      return
    }
    const ui = presentTaskStatus(
      this.taskKind,
      this.sketch.sketchPath,
      this.portKey,
      this.baseDescription
    )
    this.description = ui.description
    // Reset to base description before applying status-specific tweaks
    switch (ui.status) {
      case 'running':
        this.iconPath = new vscode.ThemeIcon(ui.statusIconId ?? 'sync~spin')
        this.contextValue = 'taskRunning'
        break
      case 'blocked':
        // Another task that shares this key (e.g. compile vs export-binary)
        // is already running. Treat this task as temporarily unavailable.
        this.iconPath = new vscode.ThemeIcon(ui.statusIconId ?? 'circle-slash')
        this.contextValue = 'taskBlocked'
        break
      case 'idle':
      default:
        this.iconPath = new vscode.ThemeIcon(this.defaultIconId)
        this.contextValue = 'taskIdle'
        break
    }
  }
}

function toTaskKind(commandId: string): TaskKind | undefined {
  switch (commandId) {
    case 'boardlab.compile':
      return 'compile'
    case 'boardlab.upload':
      return 'upload'
    case 'boardlab.uploadUsingProgrammer':
      return 'upload-using-programmer'
    case 'boardlab.exportBinary':
      return 'export-binary'
    case 'boardlab.burnBootloader':
      return 'burn-bootloader'
    case 'boardlab.getBoardInfo':
      return 'get-board-info'
    case 'boardlab.archiveSketch':
      return 'archive-sketch'
    default:
      return undefined
  }
}

function hasSketchProfile(sketch: SketchFolder): boolean {
  try {
    const sketchYamlPath = path.join(sketch.sketchPath, 'sketch.yaml')
    return fs.existsSync(sketchYamlPath)
  } catch {
    return false
  }
}

class BoardTreeItem extends TreeItem {
  constructor(
    readonly sketch: SketchFolder,
    board: SketchFolder['board']
  ) {
    super(board?.name ?? 'Board')
    if (!board?.name) {
      this.description = 'No board selected'
    } else if (board.fqbn) {
      this.description = new FQBN(board.fqbn).toString(true)
    }
    this.iconPath = new vscode.ThemeIcon('circuit-board')
    const children: TreeItem[] = []
    if (isBoardDetails(board)) {
      const { configOptions } = board
      if (configOptions.length) {
        const fqbn = sketch.configOptions ?? board.fqbn
        children.push(
          ...configOptions.map((configOption) => {
            const { option, optionLabel, values } = configOption
            const selectedValue = getSelectedConfigValue(option, values, fqbn)
            const valueLabel = selectedValue
              ? selectedValue.valueLabel
              : '(unknown)'
            const value = selectedValue?.value

            let defaultValue
            if (
              this.sketch instanceof SketchFolderImpl &&
              this.sketch.defaultConfigOptions
            ) {
              const defaultOptions =
                new FQBN(this.sketch.defaultConfigOptions).options ?? {}
              defaultValue = defaultOptions[option]
            }
            return new ConfigOptionItem(
              this,
              option,
              optionLabel,
              value,
              valueLabel,
              defaultValue
            )
          })
        )
      }
    }
    if (children?.length) {
      this.children = children
      this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded
    }
    this.contextValue = 'board'
  }
}

export class ConfigOptionItem extends TreeItem {
  readonly sketch: SketchFolder

  constructor(
    override parent: BoardTreeItem,
    readonly option: string,
    optionLabel: string,
    readonly value: string | undefined,
    valueLabel: string,
    readonly defaultConfigValue: string | undefined
  ) {
    super(optionLabel)
    this.sketch = parent.sketch
    this.description = valueLabel
    this.contextValue =
      defaultConfigValue && defaultConfigValue !== value
        ? 'dirtyConfigOption'
        : 'configOption'
    this.command = {
      command: 'boardlab.selectConfigOption',
      title: `Select Config Value for ${optionLabel}`,
      arguments: [this],
      tooltip: `Select Config Value for ${optionLabel}`,
    }
  }
}

class ProgrammerItem extends TreeItem {
  constructor(
    readonly sketch: SketchFolder,
    description: string
  ) {
    super('Programmer')
    this.description = description
    this.contextValue = 'programmer'
    this.iconPath = new vscode.ThemeIcon('server-process')
  }
}

export function createProgrammerItemDescription(
  selectedProgrammer: SketchFolder['selectedProgrammer'],
  board: SketchFolder['board']
): { description: string } | undefined {
  const selectedProgrammerName =
    typeof selectedProgrammer === 'string'
      ? selectedProgrammer
      : selectedProgrammer?.name

  if (!isBoardDetails(board)) {
    if (!selectedProgrammerName) {
      return undefined
    }
    return { description: `"${selectedProgrammerName}" (unresolved)` }
  }

  if (!selectedProgrammer && !board.programmers.length) {
    return undefined
  }

  if (!selectedProgrammer && board.programmers.length) {
    return { description: '(No programmer selected)' }
  }

  const selectedProgrammerId =
    typeof selectedProgrammer === 'string'
      ? selectedProgrammer
      : selectedProgrammer?.id
  const programmer = board.programmers.find(
    (p) => p.id === selectedProgrammerId
  )

  if (programmer) {
    return { description: `${programmer.name}` }
  }

  return { description: `${selectedProgrammerName} (unresolved)` }
}
