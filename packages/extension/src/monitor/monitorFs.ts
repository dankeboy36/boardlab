import * as vscode from 'vscode'

export class MonitorFileSystemProvider
  implements vscode.FileSystemProvider, vscode.Disposable
{
  private readonly onDidChangeEmitter = new vscode.EventEmitter<
    vscode.FileChangeEvent[]
  >()

  private disposed = false

  readonly onDidChangeFile = this.onDidChangeEmitter.event

  watch(
    _uri: vscode.Uri,
    _options: {
      readonly recursive: boolean
      readonly excludes: readonly string[]
    }
  ): vscode.Disposable {
    return new vscode.Disposable(() => {})
  }

  stat(_uri: vscode.Uri): vscode.FileStat {
    const now = Date.now()
    return {
      type: vscode.FileType.Unknown,
      ctime: now,
      mtime: now,
      size: 0,
    }
  }

  readDirectory(_uri: vscode.Uri): [string, vscode.FileType][] {
    return []
  }

  createDirectory(_uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(
      'Cannot create monitor resources'
    )
  }

  readFile(_uri: vscode.Uri): Uint8Array {
    return new Uint8Array()
  }

  writeFile(
    _uri: vscode.Uri,
    _content: Uint8Array,
    _options: { readonly create: boolean; readonly overwrite: boolean }
  ): never {
    throw vscode.FileSystemError.NoPermissions('Cannot write monitor resources')
  }

  delete(_uri: vscode.Uri, _options: { readonly recursive: boolean }): never {
    throw vscode.FileSystemError.NoPermissions(
      'Cannot delete monitor resources'
    )
  }

  rename(
    _oldUri: vscode.Uri,
    _newUri: vscode.Uri,
    _options: { readonly overwrite: boolean }
  ): never {
    throw vscode.FileSystemError.NoPermissions(
      'Cannot rename monitor resources'
    )
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.onDidChangeEmitter.dispose()
  }
}
