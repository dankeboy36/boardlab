import * as vscode from 'vscode'

export function getWebviewBuildRoot(
  type: string,
  extensionMode: vscode.ExtensionMode
): string[] {
  if (extensionMode !== vscode.ExtensionMode.Production) {
    return ['packages', 'webviews', type, 'out']
  }
  return ['dist', 'webviews', type]
}

export function getWebviewHtmlResources(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  buildRoot: readonly string[]
): {
  stylesUri: vscode.Uri
  scriptUri: vscode.Uri
  codiconFontUri: vscode.Uri
  nonce: string
} {
  const stylesUri = getWebviewUri(webview, extensionUri, [
    ...buildRoot,
    'static',
    'css',
    'main.css',
  ])
  const scriptUri = getWebviewUri(webview, extensionUri, [
    ...buildRoot,
    'static',
    'js',
    'main.js',
  ])
  const codiconFontUri = getWebviewUri(webview, extensionUri, [
    ...buildRoot,
    'static',
    'media',
    'codicon.ttf',
  ])
  return { stylesUri, scriptUri, codiconFontUri, nonce: getNonce() }
}

function getWebviewUri(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  segments: readonly string[]
): vscode.Uri {
  return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...segments))
}

function getNonce(): string {
  let text = ''
  const possible =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length))
  }
  return text
}
