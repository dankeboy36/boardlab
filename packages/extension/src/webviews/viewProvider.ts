import * as vscode from 'vscode'
import type { Messenger } from 'vscode-messenger'

import {
  notifyExamplesToolbarAction,
  notifyMonitorLineEndingChanged,
  notifyMonitorThemeChanged,
  notifyMonitorToolbarAction,
  notifyPlotterLineEndingChanged,
  notifyPlotterToolbarAction,
  type ExamplesToolbarAction,
  type LineEnding,
  type MonitorToolbarAction,
  type PlotterToolbarAction,
} from '@boardlab/protocol'

import { getWebviewBuildRoot, getWebviewHtmlResources } from './webviewAssets'

abstract class WebviewViewProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly extensionMode: vscode.ExtensionMode,
    protected readonly messenger: Messenger,
    private readonly type:
      | 'platforms'
      | 'libraries'
      | 'monitor'
      | 'plotter'
      | 'examples'
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext<unknown>,
    token: vscode.CancellationToken
  ): void {
    const webview = webviewView.webview
    const buildRootSegments = this.getBuildRootSegments()
    webview.options = {
      // Enable JavaScript in the webview
      enableScripts: true,
      // Restrict the webview to only load resources from the compiled extension and webview build output
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'out'),
        vscode.Uri.joinPath(this.extensionUri, ...buildRootSegments),
      ],
    }
    const initialState = context.state
    webview.html = this.getWebviewContent(
      webview,
      this.extensionUri,
      buildRootSegments,
      initialState
    )
    this.messenger.registerWebviewView(webviewView)
    this.handleResolved(webviewView)
  }

  // Subclasses can override to observe resolution events.
  protected handleResolved(_view: vscode.WebviewView): void {}

  private getWebviewContent(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    buildRootSegments: readonly string[],
    initialState: unknown
  ): string {
    const { stylesUri, scriptUri, codiconFontUri, nonce } =
      getWebviewHtmlResources(webview, extensionUri, buildRootSegments)

    const stateScript = initialState
      ? `window.__INITIAL_VSCODE_STATE__ = ${JSON.stringify(initialState).replace(/</g, '\\u003c')};`
      : ''

    // Tip: Install the es6-string-html VS Code extension to enable code highlighting below
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
            window.__BOARDLAB_WEBVIEW_TYPE__ = '${this.type}';
            ${stateScript}
          </script>
          <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
        </body>
      </html>
    `
  }

  private getBuildRootSegments(): string[] {
    return getWebviewBuildRoot(this.type, this.extensionMode)
  }
}

export class PlatformsManagerViewProvider extends WebviewViewProvider {
  private currentView: vscode.WebviewView | undefined
  private readonly onDidResolveEmitter =
    new vscode.EventEmitter<vscode.WebviewView>()

  readonly onDidResolve = this.onDidResolveEmitter.event

  constructor(
    extensionUri: vscode.Uri,
    extensionMode: vscode.ExtensionMode,
    messenger: Messenger
  ) {
    super(extensionUri, extensionMode, messenger, 'platforms')
  }

  get isResolved(): boolean {
    return Boolean(this.currentView)
  }

  protected override handleResolved(view: vscode.WebviewView): void {
    this.currentView = view
    this.onDidResolveEmitter.fire(view)
    view.onDidDispose(() => {
      this.currentView = undefined
    })
  }
}

export class LibrariesManagerViewProvider extends WebviewViewProvider {
  private currentView: vscode.WebviewView | undefined
  private readonly onDidResolveEmitter =
    new vscode.EventEmitter<vscode.WebviewView>()

  readonly onDidResolve = this.onDidResolveEmitter.event

  constructor(
    extensionUri: vscode.Uri,
    extensionMode: vscode.ExtensionMode,
    messenger: Messenger
  ) {
    super(extensionUri, extensionMode, messenger, 'libraries')
  }

  get isResolved(): boolean {
    return Boolean(this.currentView)
  }

  protected override handleResolved(view: vscode.WebviewView): void {
    this.currentView = view
    this.onDidResolveEmitter.fire(view)
    view.onDidDispose(() => {
      this.currentView = undefined
    })
  }
}

export class ExamplesViewProvider extends WebviewViewProvider {
  private currentView: vscode.WebviewView | undefined
  private readonly onDidResolveEmitter =
    new vscode.EventEmitter<vscode.WebviewView>()

  readonly onDidResolve = this.onDidResolveEmitter.event

  constructor(
    extensionUri: vscode.Uri,
    extensionMode: vscode.ExtensionMode,
    messenger: Messenger
  ) {
    super(extensionUri, extensionMode, messenger, 'examples')
  }

  get isResolved(): boolean {
    return Boolean(this.currentView)
  }

  protected override handleResolved(view: vscode.WebviewView): void {
    this.currentView = view
    this.onDidResolveEmitter.fire(view)
    view.onDidDispose(() => {
      this.currentView = undefined
    })
  }

  async sendToolbarAction(action: ExamplesToolbarAction): Promise<void> {
    if (!this.messenger) {
      return
    }
    if (!this.currentView) {
      return
    }
    try {
      this.messenger.sendNotification(
        notifyExamplesToolbarAction,
        { type: 'webview', webviewType: 'boardlabExamples' },
        { action }
      )
    } catch (error) {
      console.error('Failed to send examples toolbar action', action, error)
    }
  }
}

export class MonitorViewProvider extends WebviewViewProvider {
  private currentView: vscode.WebviewView | undefined
  private readonly onDidResolveEmitter =
    new vscode.EventEmitter<vscode.WebviewView>()

  readonly onDidResolve = this.onDidResolveEmitter.event

  constructor(
    extensionUri: vscode.Uri,
    extensionMode: vscode.ExtensionMode,
    messenger: Messenger
  ) {
    super(extensionUri, extensionMode, messenger, 'monitor')
  }

  get isResolved(): boolean {
    return Boolean(this.currentView)
  }

  protected override handleResolved(view: vscode.WebviewView): void {
    this.currentView = view
    this.onDidResolveEmitter.fire(view)
    view.onDidDispose(() => {
      this.currentView = undefined
    })
    this.pushLineEnding()
    this.pushTheme()
  }

  async reveal(preserveFocus = false): Promise<void> {
    if (!this.currentView) {
      await vscode.commands.executeCommand(
        'workbench.view.extension.boardlabMonitor'
      )
      if (!this.currentView) {
        await new Promise<void>((resolve) => {
          const disposable = this.onDidResolve((view) => {
            disposable.dispose()
            view.show?.(!preserveFocus)
            resolve()
          })
        })
        return
      }
    }
    this.currentView?.show?.(!preserveFocus)
  }

  async sendToolbarAction(action: MonitorToolbarAction): Promise<void> {
    if (!this.messenger) {
      return
    }
    if (!this.currentView) {
      await this.reveal(true)
    }
    if (!this.currentView) {
      return
    }
    try {
      this.messenger.sendNotification(
        notifyMonitorToolbarAction,
        { type: 'webview', webviewType: 'boardlab.monitor' },
        { action }
      )
    } catch (error) {
      console.error('Failed to send monitor toolbar action', action, error)
    }
  }

  pushLineEnding(): void {
    const config = vscode.workspace.getConfiguration('boardlab.monitor')
    const lineEnding = config.get<LineEnding>('lineEnding', 'crlf')
    if (!this.messenger || !this.currentView) {
      return
    }
    try {
      this.messenger.sendNotification(
        notifyMonitorLineEndingChanged,
        { type: 'webview', webviewType: 'boardlab.monitor' },
        { lineEnding }
      )
    } catch (error) {
      console.error('Failed to send monitor line ending', error)
    }
  }

  pushTheme(): void {
    if (!this.messenger || !this.currentView) {
      return
    }
    try {
      this.messenger.sendNotification(
        notifyMonitorThemeChanged,
        { type: 'webview', webviewType: 'boardlab.monitor' },
        undefined
      )
    } catch (error) {
      console.error('Failed to send monitor theme change', error)
    }
  }
}

export class PlotterViewProvider extends WebviewViewProvider {
  private currentView: vscode.WebviewView | undefined
  private readonly onDidResolveEmitter =
    new vscode.EventEmitter<vscode.WebviewView>()

  readonly onDidResolve = this.onDidResolveEmitter.event

  constructor(
    extensionUri: vscode.Uri,
    extensionMode: vscode.ExtensionMode,
    messenger: Messenger
  ) {
    super(extensionUri, extensionMode, messenger, 'plotter')
  }

  get isResolved(): boolean {
    return Boolean(this.currentView)
  }

  protected override handleResolved(view: vscode.WebviewView): void {
    this.currentView = view
    this.onDidResolveEmitter.fire(view)
    view.onDidDispose(() => {
      this.currentView = undefined
    })
    this.pushLineEnding()
  }

  async reveal(preserveFocus = false): Promise<void> {
    if (!this.currentView) {
      await vscode.commands.executeCommand(
        'workbench.view.extension.boardlabPlotter'
      )
      if (!this.currentView) {
        await new Promise<void>((resolve) => {
          const disposable = this.onDidResolve((view) => {
            disposable.dispose()
            view.show?.(!preserveFocus)
            resolve()
          })
        })
        return
      }
    }
    this.currentView?.show?.(!preserveFocus)
  }

  async sendToolbarAction(action: PlotterToolbarAction): Promise<void> {
    if (!this.messenger) {
      return
    }
    if (!this.currentView) {
      await this.reveal(true)
    }
    if (!this.currentView) {
      return
    }
    try {
      this.messenger.sendNotification(
        notifyPlotterToolbarAction,
        { type: 'webview', webviewType: 'boardlab.plotter' },
        { action }
      )
    } catch (error) {
      console.error('Failed to send plotter toolbar action', action, error)
    }
  }

  pushLineEnding(): void {
    const config = vscode.workspace.getConfiguration('boardlab.monitor')
    const lineEnding = config.get<LineEnding>('lineEnding', 'crlf')
    if (!this.messenger || !this.currentView) {
      return
    }
    try {
      this.messenger.sendNotification(
        notifyPlotterLineEndingChanged,
        { type: 'webview', webviewType: 'boardlab.plotter' },
        { lineEnding }
      )
    } catch (error) {
      console.error('Failed to send monitor line ending', error)
    }
  }
}
