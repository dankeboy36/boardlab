import {
  notifyMonitorLineEndingChanged,
  notifyMonitorThemeChanged,
  notifyMonitorToolbarAction,
  notifyPlotterLineEndingChanged,
  notifyPlotterToolbarAction,
  type LineEnding,
  type MonitorSelectionNotification,
  type MonitorToolbarAction,
  type PlotterToolbarAction,
} from '@boardlab/protocol'
import { type PortIdentifier } from 'boards-list'
import * as vscode from 'vscode'
import { Messenger } from 'vscode-messenger'
import type {
  NotificationType,
  WebviewIdMessageParticipant,
} from 'vscode-messenger-common'

import type { MonitorRuntimeState } from '../monitor/monitorManager'
import {
  MonitorResource,
  MonitorResourceStore,
} from '../monitor/monitorResources'
import type { MonitorSelectionCoordinator } from '../monitor/monitorSelections'
import { getMonitorDisplayName, parseMonitorUri } from '../monitor/monitorUri'

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
    if (this.currentState === 'disconnected') {
      this.resource.setState('connected')
    }
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
    protected readonly messenger: Messenger,
    protected readonly resourceStore: MonitorResourceStore,
    protected readonly selectionCoordinator: MonitorSelectionCoordinator,
    private readonly webviewAssetType: 'monitor' | 'plotter',
    private readonly stateConfig: {
      readonly titlePrefix: string
      readonly viewType: string
      readonly lineEndingSection: string
      readonly notifyToolbarAction: NotificationType<{ action: TToolbar }>
      readonly notifyLineEndingChanged: NotificationType<{
        lineEnding: LineEnding
      }>
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
    // VS Code currently ignores custom icons set from custom editors.
    // See https://github.com/microsoft/vscode/issues/105028.
    const participant = this.messenger.registerWebviewPanel(panel)
    this.configureWebview(panel)
    panel.webview.html = html

    const stateDisposable = document.onDidChangeState((state) => {
      this.updatePanelPresentation(panel, document, state)
    })
    const selectionDisposable = this.selectionCoordinator.registerTarget(
      participant,
      () => document.getSelection()
    )

    const panelDisposable = panel.onDidDispose(() => {
      this.detachPanel(panel)
      selectionDisposable.dispose()
      stateDisposable.dispose()
    })

    const binding: EditorPanelBinding<TDocument> = {
      panel,
      participant,
      document,
      disposables: [panelDisposable, stateDisposable, selectionDisposable],
    }
    this.panelBindings.set(panel, binding)
    let set = this.documentBindings.get(document)
    if (!set) {
      set = new Set()
      this.documentBindings.set(document, set)
    }
    set.add(binding)

    panel.onDidChangeViewState(() => {
      if (panel.active) {
        this.activeDocument = document
        document.ensureRunning()
      }
    })

    document.markConnected()
    document.ensureRunning()
    this.updatePanelPresentation(panel, document, document.state)
    this.pushLineEnding(document)
    await this.selectionCoordinator.pushSelection(participant)
  }

  getActiveDocument(): TDocument | undefined {
    return this.activeDocument
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

  private activeDocument: TDocument | undefined

  private detachPanel(panel: vscode.WebviewPanel): void {
    const binding = this.panelBindings.get(panel)
    if (!binding) {
      return
    }
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

  private configureWebview(panel: vscode.WebviewPanel): void {
    const buildRootSegments = [
      'packages',
      'webviews',
      this.webviewAssetType,
      'out',
    ]
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
    const nonce = getNonce()
    const buildRootSegments = [
      'packages',
      'webviews',
      this.webviewAssetType,
      'out',
    ]
    const stylesUri = getWebviewResourceUri(webview, this.extensionUri, [
      ...buildRootSegments,
      'static',
      'css',
      'main.css',
    ])
    const scriptUri = getWebviewResourceUri(webview, this.extensionUri, [
      ...buildRootSegments,
      'static',
      'js',
      'main.js',
    ])
    const codiconFontUri = getWebviewResourceUri(webview, this.extensionUri, [
      ...buildRootSegments,
      'static',
      'media',
      'codicon.ttf',
    ])
    const stateScript = initialState
      ? `window.__INITIAL_VSCODE_STATE__ = ${JSON.stringify(initialState).replace(/</g, '\\u003c')};`
      : ''

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
            window.__ARDUNNO_WEBVIEW_TYPE__ = '${this.webviewAssetType}';
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
    state: MonitorRuntimeState
  ): void {
    const stateLabel = state.charAt(0).toUpperCase() + state.slice(1)
    panel.title = `${this.stateConfig.titlePrefix}: ${document.title} — ${stateLabel}`
  }
}

export class MonitorEditors extends MonitorBaseEditorProvider<
  MonitorDocument,
  MonitorToolbarAction
> {
  constructor(
    extensionUri: vscode.Uri,
    messenger: Messenger,
    resourceStore: MonitorResourceStore,
    selectionCoordinator: MonitorSelectionCoordinator
  ) {
    super(
      extensionUri,
      messenger,
      resourceStore,
      selectionCoordinator,
      'monitor',
      {
        titlePrefix: 'Monitor',
        viewType: 'boardlab.monitorEditor',
        lineEndingSection: 'boardlab.monitor',
        notifyToolbarAction: notifyMonitorToolbarAction,
        notifyLineEndingChanged: notifyMonitorLineEndingChanged,
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
    messenger: Messenger,
    resourceStore: MonitorResourceStore,
    selectionCoordinator: MonitorSelectionCoordinator
  ) {
    super(
      extensionUri,
      messenger,
      resourceStore,
      selectionCoordinator,
      'plotter',
      {
        titlePrefix: 'Plotter',
        viewType: 'boardlab.plotterEditor',
        lineEndingSection: 'boardlab.monitor',
        notifyToolbarAction: notifyPlotterToolbarAction,
        notifyLineEndingChanged: notifyPlotterLineEndingChanged,
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

function getWebviewResourceUri(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  segments: string[]
): vscode.Uri {
  return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...segments))
}

function getNonce(): string {
  const possible =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let nonce = ''
  for (let i = 0; i < 32; i++) {
    nonce += possible.charAt(Math.floor(Math.random() * possible.length))
  }
  return nonce
}
