import type { Stats } from 'node:fs'
import * as fs from 'node:fs/promises'

import * as vscode from 'vscode'

export const SKETCHBOOK_SCHEME = 'boardlab-sketchbook'

class SketchbookReadonlyFsProvider implements vscode.FileSystemProvider {
  private readonly changeEmitter = new vscode.EventEmitter<
    vscode.FileChangeEvent[]
  >()

  readonly onDidChangeFile = this.changeEmitter.event

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {})
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    try {
      const stats = await fs.stat(toFsPath(uri))
      return toFileStat(stats)
    } catch (error) {
      throw mapError(error)
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    try {
      const entries = await fs.readdir(toFsPath(uri), { withFileTypes: true })
      return entries.map((entry) => [
        entry.name,
        entry.isDirectory()
          ? vscode.FileType.Directory
          : entry.isSymbolicLink()
            ? vscode.FileType.SymbolicLink
            : vscode.FileType.File,
      ])
    } catch (error) {
      throw mapError(error)
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    try {
      const buffer = await fs.readFile(toFsPath(uri))
      return buffer
    } catch (error) {
      throw mapError(error)
    }
  }

  // Readonly provider
  writeFile(): never {
    throw vscode.FileSystemError.NoPermissions('Read-only file system')
  }

  delete(): never {
    throw vscode.FileSystemError.NoPermissions('Read-only file system')
  }

  rename(): never {
    throw vscode.FileSystemError.NoPermissions('Read-only file system')
  }

  createDirectory(): never {
    throw vscode.FileSystemError.NoPermissions('Read-only file system')
  }
}

export function registerSketchbookReadonlyFs(
  context: vscode.ExtensionContext
): void {
  const provider = new SketchbookReadonlyFsProvider()
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SKETCHBOOK_SCHEME, provider, {
      isReadonly: true,
    })
  )
}

function toFsPath(uri: vscode.Uri): string {
  return uri.with({ scheme: 'file' }).fsPath
}

function toFileStat(stats: Stats): vscode.FileStat {
  return {
    type: stats.isDirectory()
      ? vscode.FileType.Directory
      : stats.isSymbolicLink()
        ? vscode.FileType.SymbolicLink
        : vscode.FileType.File,
    ctime: stats.ctimeMs,
    mtime: stats.mtimeMs,
    size: stats.size,
  }
}

function mapError(error: unknown): vscode.FileSystemError {
  const err = error as NodeJS.ErrnoException
  switch (err?.code) {
    case 'ENOENT':
      return vscode.FileSystemError.FileNotFound()
    case 'EEXIST':
      return vscode.FileSystemError.FileExists()
    case 'EPERM':
    case 'EACCES':
      return vscode.FileSystemError.NoPermissions()
    default:
      return vscode.FileSystemError.Unavailable(err?.message ?? 'Unavailable')
  }
}
