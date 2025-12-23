import * as fs from 'node:fs/promises'

import * as vscode from 'vscode'

import type { ExampleLocator } from './examplesIndex'

export const EXAMPLE_SCHEME = 'ardunno-example'

export function buildExampleUri(
  exampleId: string,
  relPath: string
): vscode.Uri {
  const normalized = relPath.replace(/^[\\/]+/, '').replace(/\\/g, '/')
  return vscode.Uri.from({
    scheme: EXAMPLE_SCHEME,
    path: `/${exampleId}/${normalized}`,
  })
}

export class ArdunnoExampleFs implements vscode.FileSystemProvider {
  private readonly _onDidChangeFile = new vscode.EventEmitter<
    vscode.FileChangeEvent[]
  >()

  constructor(private readonly locator: ExampleLocator) {}

  readonly onDidChangeFile = this._onDidChangeFile.event

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {})
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    await this.ensureLocatorReady()
    const abs = this.resolve(uri)
    const s = await fs.stat(abs)
    return {
      type: s.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File,
      ctime: s.ctimeMs,
      mtime: s.mtimeMs,
      size: s.size,
      permissions: vscode.FilePermission.Readonly,
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    await this.ensureLocatorReady()
    const abs = this.resolve(uri)
    const dirents = await fs.readdir(abs, { withFileTypes: true })
    return dirents.map((dirent) => [
      dirent.name,
      dirent.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File,
    ])
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    await this.ensureLocatorReady()
    const abs = this.resolve(uri)
    return fs.readFile(abs)
  }

  createDirectory(): never {
    throw vscode.FileSystemError.NoPermissions('Read-only')
  }

  writeFile(): never {
    throw vscode.FileSystemError.NoPermissions('Read-only')
  }

  delete(): never {
    throw vscode.FileSystemError.NoPermissions('Read-only')
  }

  rename(): never {
    throw vscode.FileSystemError.NoPermissions('Read-only')
  }

  copy?(): never {
    throw vscode.FileSystemError.NoPermissions('Read-only')
  }

  private async ensureLocatorReady(): Promise<void> {
    if (typeof this.locator.ready === 'function') {
      await this.locator.ready()
    }
  }

  private resolve(uri: vscode.Uri): string {
    const { exampleId, relPath } = parseExampleUri(uri)
    const abs = this.locator.resolveAbsolutePath(exampleId, relPath)
    if (!abs) {
      throw vscode.FileSystemError.FileNotFound(uri)
    }
    return abs
  }
}

function parseExampleUri(uri: vscode.Uri): {
  exampleId: string
  relPath: string
} {
  if (uri.scheme !== EXAMPLE_SCHEME) {
    throw vscode.FileSystemError.FileNotFound(uri)
  }
  const parts = uri.path.replace(/^\/+/, '').split('/')
  const exampleId = parts.shift() ?? ''
  const relPath = parts.join('/')
  return { exampleId, relPath }
}
