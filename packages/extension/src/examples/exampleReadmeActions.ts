import * as vscode from 'vscode'

import { EXAMPLE_SCHEME } from './exampleFs'
import { EXAMPLE_README_SCHEME } from './exampleReadmeFs'
import type { ExampleEntry, ExampleMeta } from './examplesIndex'

const EXAMPLE_MD_SCHEME = EXAMPLE_README_SCHEME

interface ExampleReadmeMeta {
  readonly sketchFolder?: string
  readonly examplesRoot?: string
  readonly tag?: string
  readonly exampleId?: string
  readonly relPath?: string
  readonly source?: ExampleMeta['source']
  readonly isBuiltin?: boolean
}

interface ResolvedExampleContext {
  readonly sketchUri: vscode.Uri
  readonly meta: ExampleReadmeMeta
}

interface ExampleSketchResolution {
  readonly uri: vscode.Uri
  readonly exampleMeta: ExampleMeta
  readonly entry: ExampleEntry
}

type ExampleResolver = (id: string) => ExampleMeta | undefined

const selector: vscode.DocumentSelector = [{ scheme: EXAMPLE_SCHEME }]

export function registerExampleReadmeActions(
  context: vscode.ExtensionContext,
  locateExampleById: ExampleResolver
): void {
  const resolve = (meta?: ExampleReadmeMeta) =>
    resolveExampleContext(meta, locateExampleById)

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'boardlab.cloneToSketchbook',
      async (meta?: ExampleReadmeMeta) => {
        const resolved = resolve(meta)
        if (!resolved) {
          vscode.window.showWarningMessage(
            'No example metadata available for cloning.'
          )
          return
        }
        await cloneToSketchbook(resolved)
      }
    ),
    vscode.commands.registerCommand(
      'boardlab.openContainingLibrary',
      async (meta?: ExampleReadmeMeta) => {
        const resolved = resolve(meta)
        if (!resolved) {
          vscode.window.showWarningMessage(
            'No example metadata available to locate the library.'
          )
          return
        }
        await openContainingLibrary(resolved)
      }
    ),
    vscode.languages.registerCodeLensProvider(
      selector,
      new ExampleLensProvider(locateExampleById)
    )
  )
}

class ExampleLensProvider implements vscode.CodeLensProvider {
  constructor(private readonly locateExampleById: ExampleResolver) {}

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (doc.uri.scheme !== EXAMPLE_SCHEME) {
      return []
    }
    const meta = metaFromExampleDocument(doc.uri, this.locateExampleById)
    if (!meta?.sketchFolder) {
      return []
    }

    const range = new vscode.Range(0, 0, 0, 0)
    const lenses = [
      new vscode.CodeLens(range, {
        title: '$(repo-clone) Clone sketch to Sketchbook',
        command: 'boardlab.cloneToSketchbook',
        arguments: [meta],
      }),
    ]

    const resolved = resolveExampleContext(meta, this.locateExampleById)
    if (resolved) {
      const inWorkspace = isFolderInWorkspace(resolved.sketchUri)
      lenses.push(
        new vscode.CodeLens(range, {
          title: inWorkspace
            ? '$(folder-opened) Open Sketch Folder in Workspace'
            : '$(folder-add) Add Sketch Folder to Workspace',
          command: 'boardlab.importSketchFromSketchbook',
          arguments: [
            {
              folderUri: resolved.sketchUri,
              mainFileUri: guessMainSketchUri(resolved.sketchUri),
              openOnly: inWorkspace,
            },
          ],
        })
      )
    }

    if (!isBuiltinMeta(meta)) {
      lenses.push(
        new vscode.CodeLens(range, {
          title: '$(library) Open Containing Library',
          command: 'boardlab.openContainingLibrary',
          arguments: [meta],
        })
      )
    }

    return lenses
  }
}

async function cloneToSketchbook(
  context: ResolvedExampleContext
): Promise<void> {
  const { sketchUri } = context
  const sketchName = basename(sketchUri)

  const sketchbookPath =
    vscode.workspace
      .getConfiguration('boardlab')
      .get<string>('sketchbookPath') ??
    process.env.ARDUINO_SKETCHBOOK ??
    defaultSketchbookPath()

  const sketchbook = vscode.Uri.file(sketchbookPath)
  const destination = vscode.Uri.joinPath(sketchbook, sketchName)

  if (await uriExists(destination)) {
    vscode.window.showWarningMessage(
      `Sketchbook already contains "${sketchName}".`
    )
    return
  }

  try {
    await copyFolder(sketchUri, destination)
    vscode.window.showInformationMessage(
      `Cloned "${sketchName}" to Sketchbook (${destination.fsPath}).`
    )
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to clone "${sketchName}": ${toErrorMessage(error)}`
    )
  }
}

async function openContainingLibrary(
  context: ResolvedExampleContext
): Promise<void> {
  if (isBuiltinMeta(context.meta)) {
    vscode.window.showInformationMessage(
      'Built-in examples are not part of a library.'
    )
    return
  }

  let current = context.sketchUri

  while (true) {
    const libraryProps = vscode.Uri.joinPath(current, 'library.properties')
    if (await uriExists(libraryProps)) {
      break
    }
    const parent = vscode.Uri.joinPath(current, '..')
    if (parent.path === current.path) {
      vscode.window.showWarningMessage('Containing library not found.')
      return
    }
    current = parent
  }

  const choice = await vscode.window.showQuickPick(
    ['Add Folder to Workspace', 'Open in New Window'],
    { placeHolder: 'Open library code' }
  )
  if (!choice) {
    return
  }
  if (choice === 'Add Folder to Workspace') {
    const start = vscode.workspace.workspaceFolders?.length ?? 0
    await vscode.workspace.updateWorkspaceFolders(start, 0, {
      uri: current,
      name: basename(current),
    })
  } else {
    await vscode.commands.executeCommand('vscode.openFolder', current, true)
  }
}

function resolveExampleContext(
  meta: ExampleReadmeMeta | undefined,
  locateExampleById: ExampleResolver
): ResolvedExampleContext | undefined {
  const sourceMeta = meta ?? metaFromActiveDocument(locateExampleById)
  if (!sourceMeta) {
    return undefined
  }

  if (sourceMeta.sketchFolder) {
    const sketchUri = vscode.Uri.parse(sourceMeta.sketchFolder)
    const builtin = resolveBuiltinFlag(sourceMeta)
    const finalMeta =
      typeof builtin === 'boolean'
        ? { ...sourceMeta, isBuiltin: builtin }
        : sourceMeta
    return { sketchUri, meta: finalMeta }
  }

  const resolved = resolveExampleSketch(
    sourceMeta.exampleId,
    sourceMeta.relPath,
    locateExampleById
  )

  if (!resolved) {
    return undefined
  }

  const hydratedMeta: ExampleReadmeMeta = {
    ...sourceMeta,
    exampleId: resolved.exampleMeta.id,
    relPath: resolved.entry.relPath,
    sketchFolder: resolved.uri.toString(),
    source: resolved.exampleMeta.source,
  }
  const builtin = resolveBuiltinFlag(
    hydratedMeta,
    resolved.exampleMeta.id,
    resolved.exampleMeta.source
  )
  const finalMeta =
    typeof builtin === 'boolean'
      ? { ...hydratedMeta, isBuiltin: builtin }
      : hydratedMeta

  return { sketchUri: resolved.uri, meta: finalMeta }
}

function metaFromActiveDocument(
  locateExampleById: ExampleResolver
): ExampleReadmeMeta | undefined {
  const activeDoc = vscode.window.activeTextEditor?.document
  if (!activeDoc) {
    return undefined
  }
  if (activeDoc.uri.scheme === EXAMPLE_MD_SCHEME) {
    return parseQuery(activeDoc.uri)
  }
  if (activeDoc.uri.scheme === EXAMPLE_SCHEME) {
    return metaFromExampleDocument(activeDoc.uri, locateExampleById)
  }
  return undefined
}

function metaFromExampleDocument(
  uri: vscode.Uri,
  locateExampleById: ExampleResolver
): ExampleReadmeMeta | undefined {
  const parsed = parseExampleDocumentUri(uri)
  if (!parsed?.exampleId) {
    return undefined
  }

  const resolved = resolveExampleSketch(
    parsed.exampleId,
    parsed.relPath,
    locateExampleById
  )
  if (!resolved) {
    return undefined
  }

  const baseMeta: ExampleReadmeMeta = {
    ...parsed,
    exampleId: resolved.exampleMeta.id,
    relPath: resolved.entry.relPath,
    sketchFolder: resolved.uri.toString(),
    source: resolved.exampleMeta.source,
  }
  const builtin = resolveBuiltinFlag(
    baseMeta,
    resolved.exampleMeta.id,
    resolved.exampleMeta.source
  )

  return typeof builtin === 'boolean'
    ? { ...baseMeta, isBuiltin: builtin }
    : baseMeta
}

function parseQuery(uri: vscode.Uri): ExampleReadmeMeta | undefined {
  try {
    const q = JSON.parse(decodeURIComponent(uri.query))
    if (typeof q?.sketchFolder === 'string') {
      let meta: ExampleReadmeMeta = {
        sketchFolder: q.sketchFolder,
        examplesRoot:
          typeof q.examplesRoot === 'string' ? q.examplesRoot : undefined,
        tag: typeof q.tag === 'string' ? q.tag : undefined,
        exampleId:
          typeof q.exampleId === 'string' ? (q.exampleId as string) : undefined,
        relPath: typeof q.relPath === 'string' ? q.relPath : undefined,
        source: typeof q.source === 'string' ? q.source : undefined,
      }
      const builtin =
        q.kind === 'builtin'
          ? true
          : typeof q.isBuiltin === 'boolean'
            ? Boolean(q.isBuiltin)
            : resolveBuiltinFlag(meta)
      if (typeof builtin === 'boolean') {
        meta = { ...meta, isBuiltin: builtin }
      }
      return meta
    }
  } catch {
    // ignore malformed query payloads
  }
  return undefined
}

function parseExampleDocumentUri(
  uri: vscode.Uri
): ExampleReadmeMeta | undefined {
  if (uri.scheme !== EXAMPLE_SCHEME) {
    return undefined
  }
  const segments = uri.path.replace(/^\/+/, '').split('/')
  const exampleId = segments.shift()
  if (!exampleId) {
    return undefined
  }
  return {
    exampleId,
    relPath: segments.join('/'),
  }
}

function resolveExampleSketch(
  exampleId: string | undefined,
  relPath: string | undefined,
  locateExampleById: ExampleResolver
): ExampleSketchResolution | undefined {
  if (!exampleId) {
    return undefined
  }
  const exampleMeta = locateExampleById(exampleId)
  if (!exampleMeta) {
    return undefined
  }
  const normalized = normalizeRelPath(relPath)
  if (!normalized) {
    return undefined
  }
  const entry = findExampleEntry(exampleMeta, normalized)
  if (!entry) {
    return undefined
  }
  return {
    uri: vscode.Uri.file(entry.absPath),
    exampleMeta,
    entry,
  }
}

function resolveBuiltinFlag(
  meta: ExampleReadmeMeta,
  fallbackId?: string,
  fallbackSource?: ExampleMeta['source']
): boolean | undefined {
  if (typeof meta.isBuiltin === 'boolean') {
    return meta.isBuiltin
  }
  const source = meta.source ?? fallbackSource
  if (typeof source === 'string') {
    return source === 'builtin'
  }
  const id = meta.exampleId ?? fallbackId
  if (id) {
    return isBuiltinExampleId(id)
  }
  return undefined
}

function isBuiltinMeta(
  meta: ExampleReadmeMeta,
  fallbackId?: string,
  fallbackSource?: ExampleMeta['source']
): boolean {
  return resolveBuiltinFlag(meta, fallbackId, fallbackSource) ?? false
}

function isBuiltinExampleId(exampleId: string): boolean {
  return exampleId.startsWith('builtin:')
}

function guessMainSketchUri(folderUri: vscode.Uri): vscode.Uri {
  const name = basename(folderUri)
  return vscode.Uri.joinPath(folderUri, `${name}.ino`)
}

function isFolderInWorkspace(folderUri: vscode.Uri): boolean {
  const target = folderUri.with({ scheme: 'file' }).fsPath
  return (vscode.workspace.workspaceFolders ?? []).some(
    (workspaceFolder) => workspaceFolder.uri.fsPath === target
  )
}

function findExampleEntry(
  meta: ExampleMeta,
  normalizedRelPath: string
): ExampleEntry | undefined {
  const sorted = [...meta.entries].sort(
    (a, b) => b.relPath.length - a.relPath.length
  )
  for (const entry of sorted) {
    if (
      normalizedRelPath === entry.relPath ||
      normalizedRelPath.startsWith(`${entry.relPath}/`)
    ) {
      return entry
    }
  }
  return undefined
}

function normalizeRelPath(relPath: string | undefined): string | undefined {
  if (!relPath) {
    return undefined
  }
  const normalized = relPath.split(/[\\/]/).filter(Boolean).join('/')
  return normalized || undefined
}

async function copyFolder(src: vscode.Uri, dst: vscode.Uri): Promise<void> {
  await vscode.workspace.fs.createDirectory(dst)
  const entries = await vscode.workspace.fs.readDirectory(src)
  for (const [name, fileType] of entries) {
    const from = vscode.Uri.joinPath(src, name)
    const to = vscode.Uri.joinPath(dst, name)
    if (fileType === vscode.FileType.Directory) {
      await copyFolder(from, to)
    } else if (
      fileType === vscode.FileType.File ||
      fileType === vscode.FileType.SymbolicLink ||
      fileType === vscode.FileType.Unknown
    ) {
      await vscode.workspace.fs.copy(from, to, { overwrite: true })
    }
  }
}

async function uriExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri)
    return true
  } catch (error: unknown) {
    if (isFileNotFound(error)) {
      return false
    }
    throw error
  }
}

function basename(uri: vscode.Uri): string {
  const trimmed = uri.path.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

function defaultSketchbookPath(): string {
  const home =
    process.platform === 'win32'
      ? (process.env.USERPROFILE ?? '')
      : (process.env.HOME ?? '')
  if (!home) {
    return 'Arduino'
  }
  if (process.platform === 'darwin') {
    return `${home}/Documents/Arduino`
  }
  if (process.platform === 'win32') {
    return `${home}\\Documents\\Arduino`
  }
  return `${home}/Arduino`
}

function isFileNotFound(error: unknown): boolean {
  if (error instanceof vscode.FileSystemError) {
    return error.code === 'FileNotFound'
  }
  if (
    typeof (error as { code?: string })?.code === 'string' &&
    /ENOENT|FileNotFound/i.test((error as { code?: string }).code!)
  ) {
    return true
  }
  if (
    typeof (error as { message?: string })?.message === 'string' &&
    /ENOENT|FileNotFound/i.test((error as { message?: string }).message!)
  ) {
    return true
  }
  return false
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  return 'Unknown error'
}
