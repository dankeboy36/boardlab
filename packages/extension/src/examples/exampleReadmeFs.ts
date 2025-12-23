import * as vscode from 'vscode'

import {
  renderBuiltinSketchReadme,
  sanitizeForPath,
  type BuiltinReadmeRenderContext,
} from './showBuiltinSketchReadme'

export const EXAMPLE_README_SCHEME = 'arduino-example-md'

type ReadmeRequest = BuiltinReadmeRequest

interface BuiltinReadmeRequest {
  readonly kind: 'builtin'
  readonly title: string
  readonly sketchFolder: string
  readonly tag: string
  readonly examplesRoot?: string
  readonly textFileName?: string
  readonly schematicFileName?: string
  readonly layoutFileName?: string
  readonly source?: string
  readonly exampleId?: string
  readonly exampleRelPath?: string
}

interface CacheEntry {
  readonly data: Uint8Array
  readonly ctime: number
  readonly mtime: number
}

export class ExampleReadmeFs
  implements vscode.FileSystemProvider, vscode.Disposable
{
  private readonly cache = new Map<string, CacheEntry>()
  private readonly changeEmitter = new vscode.EventEmitter<
    vscode.FileChangeEvent[]
  >()

  readonly onDidChangeFile = this.changeEmitter.event

  dispose(): void {
    this.cache.clear()
    this.changeEmitter.dispose()
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {})
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const entry = await this.ensureCached(uri)
    return {
      type: vscode.FileType.File,
      ctime: entry.ctime,
      mtime: entry.mtime,
      size: entry.data.byteLength,
    }
  }

  readDirectory(): [string, vscode.FileType][] {
    return []
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const entry = await this.ensureCached(uri)
    return entry.data
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

  /** Wipe any cached entry for the given URI. Useful if the source files change. */
  invalidate(uri: vscode.Uri): void {
    const key = this.cacheKey(uri)
    if (this.cache.delete(key)) {
      this.changeEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }])
    }
  }

  private cacheKey(uri: vscode.Uri): string {
    return uri.toString()
  }

  private async ensureCached(uri: vscode.Uri): Promise<CacheEntry> {
    const key = this.cacheKey(uri)
    const existing = this.cache.get(key)
    if (existing) {
      return existing
    }
    const rendered = await this.render(uri)
    this.cache.set(key, rendered)
    return rendered
  }

  private async render(uri: vscode.Uri): Promise<CacheEntry> {
    const request = parseReadmeRequest(uri)
    if (!request) {
      throw vscode.FileSystemError.FileNotFound(uri)
    }
    const markdown = await this.renderRequest(request)
    const data = Buffer.from(markdown, 'utf8')
    const now = Date.now()
    return { data, ctime: now, mtime: now }
  }

  private async renderRequest(request: ReadmeRequest): Promise<string> {
    switch (request.kind) {
      case 'builtin':
        return renderBuiltinSketchReadme(toBuiltinContext(request))
      default:
        throw vscode.FileSystemError.FileNotFound(
          `Unsupported readme kind: ${(request as { kind?: string }).kind ?? 'unknown'}`
        )
    }
  }
}

function parseReadmeRequest(uri: vscode.Uri): ReadmeRequest | undefined {
  if (!uri.query) {
    return undefined
  }
  try {
    const decoded = JSON.parse(decodeURIComponent(uri.query))
    if (
      decoded &&
      decoded.kind === 'builtin' &&
      typeof decoded.title === 'string'
    ) {
      return decoded as BuiltinReadmeRequest
    }
  } catch (error) {
    console.warn(
      'Failed to parse example readme URI metadata',
      uri.toString(),
      error
    )
  }
  return undefined
}

function toBuiltinContext(
  request: BuiltinReadmeRequest
): BuiltinReadmeRenderContext {
  return {
    title: request.title,
    sketchFolder: vscode.Uri.parse(request.sketchFolder),
    tag: request.tag,
    examplesRoot: request.examplesRoot
      ? vscode.Uri.parse(request.examplesRoot)
      : undefined,
    textFileName: request.textFileName,
    schematicFileName: request.schematicFileName,
    layoutFileName: request.layoutFileName,
    source: request.source,
    exampleId: request.exampleId,
    exampleRelPath: request.exampleRelPath,
  }
}

export function registerExampleReadmeFs(
  context: vscode.ExtensionContext
): ExampleReadmeFs {
  const provider = new ExampleReadmeFs()
  context.subscriptions.push(
    provider,
    vscode.workspace.registerFileSystemProvider(
      EXAMPLE_README_SCHEME,
      provider,
      {
        isReadonly: true,
      }
    )
  )
  return provider
}

export function buildBuiltinReadmeUri(
  request: BuiltinReadmeRequest
): vscode.Uri {
  const fileName = `${sanitizeForPath(request.title || 'Example')}.md`
  return vscode.Uri.from({
    scheme: EXAMPLE_README_SCHEME,
    path: `/${fileName}`,
    query: encodeURIComponent(JSON.stringify(request)),
  })
}

export function createBuiltinReadmeRequest(params: {
  sketchFolder: vscode.Uri
  tag: string
  title: string
  examplesRoot?: vscode.Uri
  textFileName?: string
  schematicFileName?: string
  layoutFileName?: string
  source?: string
  exampleId?: string
  exampleRelPath?: string
}): BuiltinReadmeRequest {
  return {
    kind: 'builtin',
    title: params.title,
    sketchFolder: params.sketchFolder.toString(),
    tag: params.tag,
    examplesRoot: params.examplesRoot?.toString(),
    textFileName: params.textFileName,
    schematicFileName: params.schematicFileName,
    layoutFileName: params.layoutFileName,
    source: params.source,
    exampleId: params.exampleId,
    exampleRelPath: params.exampleRelPath,
  }
}
