import { type PortIdentifier } from 'boards-list'
import * as vscode from 'vscode'
import { Messenger } from 'vscode-messenger'
import type {
  NotificationType,
  RequestType,
  WebviewIdMessageParticipant,
} from 'vscode-messenger-common'

import {
  notifyMonitorLineEndingChanged,
  notifyMonitorTerminalSettingsChanged,
  notifyMonitorEditorStatus,
  notifyMonitorThemeChanged,
  notifyMonitorToolbarAction,
  notifyPlotterLineEndingChanged,
  notifyPlotterEditorStatus,
  notifyPlotterToolbarAction,
  requestMonitorEditorContent,
  requestPlotterEditorContent,
  type LineEnding,
  type MonitorEditorContent,
  type MonitorEditorStatus,
  type MonitorEditorStatusNotification,
  type MonitorSelectionNotification,
  type MonitorTerminalSettings,
  type MonitorToolbarAction,
  type PlotterToolbarAction,
} from '@boardlab/protocol'

import type { MonitorRuntimeState } from '../monitor/monitorManager'
import {
  MonitorResource,
  MonitorResourceStore,
} from '../monitor/monitorResources'
import type { MonitorSelectionCoordinator } from '../monitor/monitorSelections'
import { getMonitorDisplayName, parseMonitorUri } from '../monitor/monitorUri'
import {
  getWebviewBuildRoot,
  getWebviewHtmlResources,
} from '../webviews/webviewAssets'

type MonitorDocumentSelection = MonitorSelectionNotification | undefined

abstract class MonitorBaseDocument implements vscode.CustomDocument {
  protected readonly disposables: vscode.Disposable[] = []
  private readonly onDidChangeStateEmitter =
    new vscode.EventEmitter<MonitorRuntimeState>()

  private disposed = false

  readonly onDidChangeState = this.onDidChangeStateEmitter.event

  constructor(
    readonly uri: vscode.Uri,
    readonly port: PortIdentifier,
    protected readonly query: ReadonlyMap<string, string>,
    private readonly resourceStore: MonitorResourceStore
  ) {
    const resource = this.resourceStore.acquire(port)
    this.currentState = resource.state
    this.disposables.push(
      resource.onDidChangeState((state) => {
        this.currentState = state
        this.onDidChangeStateEmitter.fire(state)
      })
    )
    this.disposables.push(
      new vscode.Disposable(() => {
        this.resourceStore.release(this.port)
      })
    )
    this.resource = resource
  }

  protected readonly resource: MonitorResource
  private currentState: MonitorRuntimeState

  get state(): MonitorRuntimeState {
    return this.currentState
  }

  /**
   * Called when the editor webview is ready. Ensures the monitor state reflects
   * an active connection even before streaming starts.
   */
  markConnected(): void {
    if (
      this.currentState === 'disconnected' &&
      this.resource.isPortDetected()
    ) {
      this.resource.setState('connected')
    }
  }

  isPortDetected(): boolean {
    return this.resource.isPortDetected()
  }

  /**
   * Ensure the underlying monitor is running. Called when a panel becomes
   * visible.
   */
  ensureRunning(): void {
    this.resource.resume().catch((error) => {
      console.error('Failed to ensure monitor running', error)
    })
  }

  abstract readonly title: string
  abstract readonly typeLabel: string

  abstract getSelection(): MonitorDocumentSelection

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    while (this.disposables.length) {
      try {
        this.disposables.pop()?.dispose()
      } catch (error) {
        console.error('Failed to dispose monitor document resource', error)
      }
    }
    this.onDidChangeStateEmitter.dispose()
  }
}

export class MonitorDocument extends MonitorBaseDocument {
  override getSelection(): MonitorDocumentSelection {
    const baud = this.query.get('baud')
    if (baud) {
      return {
        port: this.port,
        baudrate: baud,
      }
    }
    return { port: this.port }
  }

  get baudrate(): string | undefined {
    return this.query.get('baud')
  }

  override get title(): string {
    return getMonitorDisplayName(this.port)
  }

  override get typeLabel(): string {
    return 'Monitor'
  }
}

export class PlotterDocument extends MonitorBaseDocument {
  override getSelection(): MonitorDocumentSelection {
    // Plotter shares the same selection semantics as the monitor.
    const baud = this.query.get('baud')
    if (baud) {
      return {
        port: this.port,
        baudrate: baud,
      }
    }
    return { port: this.port }
  }

  override get title(): string {
    return getMonitorDisplayName(this.port)
  }

  override get typeLabel(): string {
    return 'Plotter'
  }
}

interface EditorPanelBinding<TDocument extends MonitorBaseDocument> {
  readonly panel: vscode.WebviewPanel
  readonly participant: WebviewIdMessageParticipant
  readonly document: TDocument
  readonly disposables: vscode.Disposable[]
  editorStatus?: MonitorEditorStatus
}

abstract class MonitorBaseEditorProvider<
    TDocument extends MonitorBaseDocument,
    TToolbar extends MonitorToolbarAction | PlotterToolbarAction,
  >
  implements vscode.CustomReadonlyEditorProvider<TDocument>, vscode.Disposable
{
  private readonly panelBindings = new Map<
    vscode.WebviewPanel,
    EditorPanelBinding<TDocument>
  >()

  private readonly documentBindings = new Map<
    TDocument,
    Set<EditorPanelBinding<TDocument>>
  >()

  private readonly disposables: vscode.Disposable[] = []

  protected constructor(
    protected readonly extensionUri: vscode.Uri,
    private readonly extensionMode: vscode.ExtensionMode,
    protected readonly messenger: Messenger,
    protected readonly resourceStore: MonitorResourceStore,
    protected readonly selectionCoordinator: MonitorSelectionCoordinator,
    private readonly webviewAssetType: 'monitor' | 'plotter',
    private readonly onPanelDisposed:
      | ((participant: WebviewIdMessageParticipant) => void)
      | undefined,
    private readonly stateConfig: {
      readonly titlePrefix: string
      readonly viewType: string
      readonly lineEndingSection: string
      readonly iconPath: { light: vscode.Uri; dark: vscode.Uri }
      readonly notifyToolbarAction: NotificationType<{ action: TToolbar }>
      readonly notifyLineEndingChanged: NotificationType<{
        lineEnding: LineEnding
      }>
      readonly notifyEditorStatus: NotificationType<MonitorEditorStatusNotification>
      readonly requestEditorContent: RequestType<void, MonitorEditorContent>
    }
  ) {}

  dispose(): void {
    while (this.disposables.length) {
      this.disposables.pop()?.dispose()
    }
    this.panelBindings.clear()
    this.documentBindings.clear()
  }

  abstract createDocument(
    uri: vscode.Uri,
    port: PortIdentifier,
    query: ReadonlyMap<string, string>
  ): TDocument

  openCustomDocument(
    uri: vscode.Uri,
    _openContext: { readonly backupId?: string },
    _token: vscode.CancellationToken
  ): TDocument {
    const { port, query } = parseMonitorUri(uri)
    return this.createDocument(uri, port, query)
  }

  async resolveCustomEditor(
    document: TDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const html = this.renderWebviewHtml(panel.webview, {
      resource: {
        uri: document.uri.toString(),
        port: document.port,
        title: document.title,
        state: document.state,
      },
    })
    panel.iconPath = this.stateConfig.iconPath
    const participant = this.messenger.registerWebviewPanel(panel)
    this.configureWebview(panel)
    panel.webview.html = html

    const binding: EditorPanelBinding<TDocument> = {
      panel,
      participant,
      document,
      disposables: [],
    }
    this.panelBindings.set(panel, binding)
    let set = this.documentBindings.get(document)
    if (!set) {
      set = new Set()
      this.documentBindings.set(document, set)
    }
    set.add(binding)

    const stateDisposable = document.onDidChangeState((state) => {
      this.updatePanelPresentation(panel, document, binding, state)
    })
    const selectionDisposable = this.selectionCoordinator.registerTarget(
      participant,
      () => document.getSelection()
    )
    const editorStatusDisposable = this.messenger.onNotification(
      this.stateConfig.notifyEditorStatus,
      ({ status }) => {
        binding.editorStatus = status
        this.updatePanelPresentation(panel, document, binding, document.state)
      },
      { sender: participant }
    )

    const panelDisposable = panel.onDidDispose(() => {
      this.detachPanel(panel)
      selectionDisposable.dispose()
      stateDisposable.dispose()
    })

    binding.disposables.push(
      panelDisposable,
      stateDisposable,
      selectionDisposable,
      editorStatusDisposable
    )

    panel.onDidChangeViewState(() => {
      if (panel.active) {
        this.activeDocument = document
        document.ensureRunning()
      }
    })

    if (panel.active || !this.activeDocument) {
      this.activeDocument = document
    }

    document.markConnected()
    document.ensureRunning()
    this.updatePanelPresentation(panel, document, binding, document.state)
    this.pushLineEnding(document)
    await this.selectionCoordinator.pushSelection(participant)
  }

  getActiveDocument(): TDocument | undefined {
    if (this.activeDocument) {
      return this.activeDocument
    }
    for (const binding of this.panelBindings.values()) {
      if (binding.panel.active) {
        this.activeDocument = binding.document
        return binding.document
      }
    }
    if (this.panelBindings.size === 1) {
      const first = this.panelBindings.values().next().value
      if (first) {
        this.activeDocument = first.document
        return first.document
      }
    }
    return undefined
  }

  protected forEachBinding(
    document: TDocument | undefined,
    callback: (binding: EditorPanelBinding<TDocument>) => void
  ): void {
    if (document) {
      const set = this.documentBindings.get(document)
      if (!set) {
        return
      }
      set.forEach(callback)
    } else {
      this.panelBindings.forEach(callback)
    }
  }

  async sendToolbarAction(action: TToolbar, target?: TDocument): Promise<void> {
    const bindings = target
      ? Array.from(this.documentBindings.get(target) ?? [])
      : Array.from(this.panelBindings.values())
    await Promise.all(
      bindings.map(async (binding) => {
        try {
          await this.messenger.sendNotification(
            this.stateConfig.notifyToolbarAction,
            binding.participant,
            { action }
          )
        } catch (error) {
          console.error('Failed to send toolbar action', {
            action,
            viewType: this.stateConfig.viewType,
            error,
          })
        }
      })
    )
  }

  async requestEditorContent(
    target: TDocument
  ): Promise<MonitorEditorContent | undefined> {
    const binding = this.pickBinding(target)
    if (!binding) {
      return undefined
    }
    try {
      return await this.messenger.sendRequest(
        this.stateConfig.requestEditorContent,
        binding.participant,
        undefined
      )
    } catch (error) {
      console.error('Failed to request editor content', {
        viewType: this.stateConfig.viewType,
        error,
      })
      return undefined
    }
  }

  pushLineEnding(target?: TDocument): void {
    const config = vscode.workspace.getConfiguration(
      this.stateConfig.lineEndingSection
    )
    const lineEnding = config.get<LineEnding>('lineEnding', 'crlf')
    this.forEachBinding(target, (binding) => {
      try {
        this.messenger.sendNotification(
          this.stateConfig.notifyLineEndingChanged,
          binding.participant,
          { lineEnding }
        )
      } catch (error) {
        console.error('Failed to push line ending', {
          lineEnding,
          viewType: this.stateConfig.viewType,
          error,
        })
      }
    })
  }

  pushTerminalSettings(target?: TDocument): void {
    const config = vscode.workspace.getConfiguration('boardlab.monitor')
    const terminalSettings: MonitorTerminalSettings = {
      cursorStyle: config.get('cursorStyle', 'block'),
      cursorInactiveStyle: config.get('cursorInactiveStyle', 'outline'),
      cursorBlink: config.get('cursorBlink', false),
      scrollback: config.get('scrollback', 1000),
      fontSize: config.get('fontSize', 12),
    }
    this.forEachBinding(target, (binding) => {
      try {
        this.messenger.sendNotification(
          notifyMonitorTerminalSettingsChanged,
          binding.participant,
          terminalSettings
        )
      } catch (error) {
        console.error('Failed to push monitor terminal settings', {
          viewType: this.stateConfig.viewType,
          error,
        })
      }
    })
  }

  private activeDocument: TDocument | undefined

  private detachPanel(panel: vscode.WebviewPanel): void {
    const binding = this.panelBindings.get(panel)
    if (!binding) {
      return
    }
    this.onPanelDisposed?.(binding.participant)
    binding.disposables.forEach((disposable) => {
      try {
        disposable.dispose()
      } catch (error) {
        console.error('Failed to dispose panel binding disposable', error)
      }
    })
    this.panelBindings.delete(panel)
    const set = this.documentBindings.get(binding.document)
    if (set) {
      set.delete(binding)
      if (!set.size) {
        this.documentBindings.delete(binding.document)
      }
    }
    if (this.activeDocument === binding.document) {
      this.activeDocument = undefined
    }
  }

  private pickBinding(
    document: TDocument
  ): EditorPanelBinding<TDocument> | undefined {
    const bindings = Array.from(this.documentBindings.get(document) ?? [])
    if (!bindings.length) {
      return undefined
    }
    return bindings.find((binding) => binding.panel.active) ?? bindings[0]
  }

  private configureWebview(panel: vscode.WebviewPanel): void {
    const buildRootSegments = getWebviewBuildRoot(
      this.webviewAssetType,
      this.extensionMode
    )
    panel.webview.options = {
      enableScripts: true,
      enableCommandUris: false,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'out'),
        vscode.Uri.joinPath(this.extensionUri, ...buildRootSegments),
      ],
    }
  }

  private renderWebviewHtml(
    webview: vscode.Webview,
    initialState: unknown
  ): string {
    const buildRootSegments = getWebviewBuildRoot(
      this.webviewAssetType,
      this.extensionMode
    )
    const { stylesUri, scriptUri, codiconFontUri, nonce } =
      getWebviewHtmlResources(webview, this.extensionUri, buildRootSegments)
    const stateScript = initialState
      ? `window.__INITIAL_VSCODE_STATE__ = ${JSON.stringify(initialState).replace(/</g, '\\u003c')};`
      : ''
    const webviewInstanceId = `${this.webviewAssetType}-${Date.now().toString(
      36
    )}-${Math.random().toString(36).slice(2, 8)}`

    return /* html */ `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
          <meta name="theme-color" content="#000000">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}'; connect-src ${webview.cspSource} https: http: ws: wss:;">
          <link rel="stylesheet" type="text/css" href="${stylesUri}">
          <style nonce="${nonce}">
            @font-face {
              font-family: "codicon";
              font-display: block;
              src: url("${codiconFontUri}") format("truetype");
            }
          </style>
        </head>
        <body>
          <noscript>You need to enable JavaScript to run this app.</noscript>
          <div id="root"></div>
          <script nonce="${nonce}">
            window.__CSP_NONCE__ = '${nonce}';
            window.__BOARDLAB_WEBVIEW_ID__ = '${webviewInstanceId}';
            window.__BOARDLAB_WEBVIEW_TYPE__ = '${this.webviewAssetType}';
            ${stateScript}
          </script>
          <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
        </body>
      </html>
    `
  }

  private updatePanelPresentation(
    panel: vscode.WebviewPanel,
    document: TDocument,
    binding: EditorPanelBinding<TDocument>,
    state: MonitorRuntimeState
  ): void {
    const resolved =
      binding.editorStatus ??
      this.mapMonitorStateToEditorStatus(document, state)
    const stateLabel = resolved.charAt(0).toUpperCase() + resolved.slice(1)
    panel.title = `${document.title} — ${stateLabel}`
  }

  private mapMonitorStateToEditorStatus(
    document: TDocument,
    state: MonitorRuntimeState
  ): MonitorEditorStatus {
    switch (state) {
      case 'running':
        return 'running'
      case 'suspended':
        return 'suspended'
      case 'connected':
        return document.isPortDetected() ? 'idle' : 'disconnected'
      case 'disconnected':
      default:
        return 'disconnected'
    }
  }
}

export class MonitorEditors extends MonitorBaseEditorProvider<
  MonitorDocument,
  MonitorToolbarAction
> {
  constructor(
    extensionUri: vscode.Uri,
    extensionMode: vscode.ExtensionMode,
    messenger: Messenger,
    resourceStore: MonitorResourceStore,
    selectionCoordinator: MonitorSelectionCoordinator,
    onPanelDisposed?: (participant: WebviewIdMessageParticipant) => void
  ) {
    super(
      extensionUri,
      extensionMode,
      messenger,
      resourceStore,
      selectionCoordinator,
      'monitor',
      onPanelDisposed,
      {
        titlePrefix: 'Monitor',
        viewType: 'boardlab.monitorEditor',
        lineEndingSection: 'boardlab.monitor',
        iconPath: {
          light: vscode.Uri.joinPath(
            extensionUri,
            'resources',
            'icons',
            'monitor-light.svg'
          ),
          dark: vscode.Uri.joinPath(
            extensionUri,
            'resources',
            'icons',
            'monitor-dark.svg'
          ),
        },
        notifyToolbarAction: notifyMonitorToolbarAction,
        notifyLineEndingChanged: notifyMonitorLineEndingChanged,
        notifyEditorStatus: notifyMonitorEditorStatus,
        requestEditorContent: requestMonitorEditorContent,
      }
    )
  }

  override createDocument(
    uri: vscode.Uri,
    port: PortIdentifier,
    query: ReadonlyMap<string, string>
  ): MonitorDocument {
    return new MonitorDocument(uri, port, query, this.resourceStore)
  }

  override async resolveCustomEditor(
    document: MonitorDocument,
    panel: vscode.WebviewPanel,
    token: vscode.CancellationToken
  ): Promise<void> {
    await super.resolveCustomEditor(document, panel, token)
    this.pushTerminalSettings(document)
  }

  pushTheme(): void {
    this.forEachBinding(undefined, (binding) => {
      try {
        this.messenger.sendNotification(
          notifyMonitorThemeChanged,
          binding.participant,
          undefined
        )
      } catch (error) {
        console.error('Failed to push monitor theme change', error)
      }
    })
  }
}

export class PlotterEditors extends MonitorBaseEditorProvider<
  PlotterDocument,
  PlotterToolbarAction
> {
  constructor(
    extensionUri: vscode.Uri,
    extensionMode: vscode.ExtensionMode,
    messenger: Messenger,
    resourceStore: MonitorResourceStore,
    selectionCoordinator: MonitorSelectionCoordinator,
    onPanelDisposed?: (participant: WebviewIdMessageParticipant) => void
  ) {
    super(
      extensionUri,
      extensionMode,
      messenger,
      resourceStore,
      selectionCoordinator,
      'plotter',
      onPanelDisposed,
      {
        titlePrefix: 'Plotter',
        viewType: 'boardlab.plotterEditor',
        lineEndingSection: 'boardlab.monitor',
        iconPath: {
          light: vscode.Uri.joinPath(
            extensionUri,
            'resources',
            'icons',
            'plotter-light.svg'
          ),
          dark: vscode.Uri.joinPath(
            extensionUri,
            'resources',
            'icons',
            'plotter-dark.svg'
          ),
        },
        notifyToolbarAction: notifyPlotterToolbarAction,
        notifyLineEndingChanged: notifyPlotterLineEndingChanged,
        notifyEditorStatus: notifyPlotterEditorStatus,
        requestEditorContent: requestPlotterEditorContent,
      }
    )
  }

  override createDocument(
    uri: vscode.Uri,
    port: PortIdentifier,
    query: ReadonlyMap<string, string>
  ): PlotterDocument {
    return new PlotterDocument(uri, port, query, this.resourceStore)
  }
}
