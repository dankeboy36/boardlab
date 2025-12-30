import { Dirent, promises as fs } from 'node:fs'
import * as path from 'node:path'
import { URL } from 'node:url'

import { LibraryLocation, type InstalledLibrary } from 'ardunno-cli/api'
import {
  sketchbookTree,
  type Folder as SketchTreeFolder,
  type SketchbookTree,
} from 'ardunno-sketch'
import * as vscode from 'vscode'

import type {
  ExampleFolderNode,
  ExampleResourceNode,
  ExampleSketchNode,
  ExampleSource,
  ExampleTreeNode,
} from '@boardlab/protocol'

import type { BoardLabContext } from '../boardlabContext'
import { isBoardDetails } from '../boards'
import { disposeAll } from '../utils'

export type ExampleId = string

export interface ExampleEntry {
  readonly relPath: string
  readonly segments: readonly string[]
  readonly fsSegments: readonly string[]
  readonly absPath: string
}

export interface ExampleMeta {
  readonly id: ExampleId
  readonly label: string
  readonly source: ExampleSource
  readonly rootPath: string
  readonly entries: readonly ExampleEntry[]
  readonly fqbnFilters?: readonly string[]
}

export interface ExampleLocator {
  resolveAbsolutePath(id: ExampleId, relPath: string): string | undefined
  ready?(): Promise<void>
}

type ExampleCache = Map<ExampleId, ExampleMeta>

const EXAMPLES_DIR_RE = /^examples?$/i

interface BuiltinLibraryDefinition {
  readonly label: string
  readonly rootPath: string
  readonly entries: readonly ExampleEntry[]
}

export class ExamplesIndex implements ExampleLocator, vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = []
  private readonly cache: ExampleCache = new Map()
  private lastFqbn?: string
  private loading?: Promise<void>
  private builtinLibrariesPromise?: Promise<readonly BuiltinLibraryDefinition[]>
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChange = this._onDidChange.event

  constructor(private readonly context: BoardLabContext) {
    this.lastFqbn = getCurrentFqbn(context)

    this.disposables.push(
      context.onDidChangeCurrentSketch(() => {
        if (this.updateFqbn(getCurrentFqbn(context))) {
          this.refresh()
        }
      }),
      context.onDidChangeSketch((event) => {
        if (event.changedProperties.includes('board')) {
          if (this.updateFqbn(getCurrentFqbn(context))) {
            this.refresh()
          }
        }
      }),
      context.librariesManager.onDidInstall(() => this.refresh()),
      context.librariesManager.onDidUninstall(() => this.refresh()),
      context.platformsManager.onDidInstall(() => this.refresh()),
      context.platformsManager.onDidUninstall(() => this.refresh())
    )
  }

  dispose(): void {
    disposeAll(...this.disposables, this._onDidChange)
  }

  async ready(): Promise<void> {
    await this.ensureLoaded()
  }

  list(): ExampleMeta[] {
    return Array.from(this.cache.values()).sort((a, b) =>
      a.label.localeCompare(b.label)
    )
  }

  get(id: ExampleId): ExampleMeta | undefined {
    return this.cache.get(id)
  }

  async resolveTree(meta: ExampleMeta): Promise<ExampleTreeNode[]> {
    await this.ensureLoaded()
    return buildExampleTree(meta)
  }

  resolveAbsolutePath(exampleId: string, relPath: string): string | undefined {
    const meta = this.cache.get(exampleId)
    if (!meta) {
      return undefined
    }
    const normalized = normalizeRelPath(relPath)
    if (!normalized) {
      return meta.rootPath
    }
    const match = findBestEntry(meta, normalized)
    if (match) {
      const suffix = normalized.slice(match.relPath.length).replace(/^\/+/, '')
      return suffix
        ? path.join(match.absPath, ...suffix.split('/'))
        : match.absPath
    }
    return path.join(meta.rootPath, ...normalized.split('/'))
  }

  async refresh(): Promise<void> {
    this.loading = this.load()
    await this.loading
    this._onDidChange.fire()
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loading && !this.cache.size) {
      await this.context.whenCurrentSketchReady
      this.updateFqbn(getCurrentFqbn(this.context))
      this.loading = this.load()
    }
    await this.loading
  }

  private async load(): Promise<void> {
    try {
      const fqbn = this.lastFqbn
      const usedIds = new Set<string>()
      const builtinMetas = await this.buildBuiltinExamples(usedIds)
      const libraryMetas = await this.buildLibraryExamples(fqbn, usedIds)
      const metas = [...builtinMetas, ...libraryMetas]
      this.cache.clear()
      for (const meta of metas) {
        this.cache.set(meta.id, meta)
      }
    } catch (error) {
      console.error('Failed to load Arduino examples index', error)
      this.cache.clear()
    } finally {
      this.loading = undefined
    }
  }

  private updateFqbn(next?: string): boolean {
    if (this.lastFqbn === next) {
      return false
    }
    this.lastFqbn = next
    return true
  }

  private async buildBuiltinExamples(
    usedIds: Set<string>
  ): Promise<ExampleMeta[]> {
    const libraries = await this.ensureBuiltinLibraries()
    if (!libraries.length) {
      return []
    }
    const metas: ExampleMeta[] = []
    for (const library of libraries) {
      const id = uniqueId(`builtin:${library.label}`, usedIds)
      usedIds.add(id)
      metas.push({
        id,
        label: library.label,
        source: 'builtin',
        rootPath: library.rootPath,
        entries: library.entries,
      })
    }
    return metas
  }

  private async ensureBuiltinLibraries(): Promise<
    readonly BuiltinLibraryDefinition[]
  > {
    if (!this.builtinLibrariesPromise) {
      this.builtinLibrariesPromise = this.discoverBuiltinLibraries()
    }
    return this.builtinLibrariesPromise
  }

  private async discoverBuiltinLibraries(): Promise<
    readonly BuiltinLibraryDefinition[]
  > {
    const baseUri = vscode.Uri.joinPath(
      this.context.extensionUri,
      'resources',
      'arduino-examples'
    )
    let tree: SketchbookTree
    try {
      tree = await sketchbookTree(baseUri.fsPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('Failed to scan built-in examples', error)
      }
      return []
    }

    if (typeof tree.root === 'string') {
      console.warn(
        'Unexpected built-in examples layout; expected categorized folders.'
      )
      return []
    }

    const entries = this.collectBuiltinEntries(
      baseUri.fsPath,
      tree.root as SketchTreeFolder
    )
    if (!entries.length) {
      return []
    }

    return [
      {
        label: 'Built-in Examples',
        rootPath: baseUri.fsPath,
        entries,
      },
    ]
  }

  private async buildLibraryExamples(
    fqbn: string | undefined,
    usedIds: Set<string>
  ): Promise<ExampleMeta[]> {
    const client = await this.context.client

    const installed = await (fqbn
      ? client.arduino.listLibraries({
          fqbn,
          // https://github.com/arduino/arduino-ide/pull/303#issuecomment-815556447
          all: true,
        })
      : client.arduino.listLibraries({}))

    const metas: ExampleMeta[] = []

    for (const entry of installed) {
      const lib = entry.library
      if (!lib) continue
      if (!lib.examples || !lib.examples.length) continue
      if (!lib.installDir) continue
      const examples = await this.normalizeExamples(lib)
      if (!examples.length) continue

      const location = lib.location ?? LibraryLocation.LIBRARY_LOCATION_USER
      const source: ExampleSource =
        location === LibraryLocation.LIBRARY_LOCATION_PLATFORM_BUILTIN ||
        location ===
          LibraryLocation.LIBRARY_LOCATION_REFERENCED_PLATFORM_BUILTIN
          ? 'platform'
          : 'library'

      if (
        source === 'platform' &&
        fqbn &&
        lib.compatibleWith &&
        lib.compatibleWith[fqbn] === false
      ) {
        continue
      }

      const label = lib.name || path.basename(lib.installDir)
      const id = uniqueId(`${source}:${label}`, usedIds)
      usedIds.add(id)

      const filters =
        lib.compatibleWith && Object.keys(lib.compatibleWith).length
          ? (Object.entries(lib.compatibleWith)
              .filter(([, compatible]) => compatible)
              .map(([key]) => key) as readonly string[])
          : undefined

      metas.push({
        id,
        label,
        source,
        rootPath: lib.installDir,
        entries: examples,
        fqbnFilters: filters,
      })
    }

    metas.sort((a, b) => a.label.localeCompare(b.label))
    return metas
  }

  private collectBuiltinEntries(
    basePath: string,
    folder: SketchTreeFolder
  ): ExampleEntry[] {
    const entries: ExampleEntry[] = []
    this.collectBuiltinSketches(basePath, folder, [], entries)
    entries.sort((a, b) => a.relPath.localeCompare(b.relPath))
    return entries
  }

  private collectBuiltinSketches(
    basePath: string,
    folder: SketchTreeFolder,
    parentSegments: string[],
    entries: ExampleEntry[]
  ): void {
    for (const [name, value] of Object.entries(folder)) {
      if (typeof value === 'string') {
        const fsSegments = [...parentSegments, name]
        entries.push({
          relPath: fsSegments.join('/'),
          segments: fsSegments,
          fsSegments,
          absPath: path.join(basePath, ...fsSegments),
        })
        continue
      }
      this.collectBuiltinSketches(
        basePath,
        value as SketchTreeFolder,
        [...parentSegments, name],
        entries
      )
    }
  }

  private async normalizeExamples(
    lib: InstalledLibrary['library']
  ): Promise<ExampleEntry[]> {
    const installDir = lib?.installDir
    if (!installDir || !lib?.examples) {
      return []
    }

    const normalized: ExampleEntry[] = []
    const seen = new Set<string>()

    for (const raw of lib.examples) {
      const absPath = toFsPath(raw)
      if (!absPath) continue
      const stat = await fs.lstat(absPath).catch(() => undefined)
      if (!stat) {
        continue
      }
      const dirPath = stat.isDirectory() ? absPath : path.dirname(absPath)
      const rel = path.relative(installDir, dirPath)
      if (!rel || rel.startsWith('..')) {
        continue
      }
      const fsSegments = rel.split(path.sep).filter(Boolean)
      if (!fsSegments.length) continue

      const displaySegments = [...fsSegments]
      while (
        displaySegments.length &&
        EXAMPLES_DIR_RE.test(displaySegments[0])
      ) {
        displaySegments.shift()
      }
      if (!displaySegments.length) {
        displaySegments.push(fsSegments[fsSegments.length - 1])
      }

      const normalizedRel = displaySegments.join('/')
      if (!normalizedRel || seen.has(normalizedRel)) continue
      seen.add(normalizedRel)
      normalized.push({
        relPath: normalizedRel,
        segments: displaySegments,
        fsSegments,
        absPath: dirPath,
      })
    }

    normalized.sort((a, b) => a.relPath.localeCompare(b.relPath))
    return normalized
  }
}

type MutableExampleTreeNode =
  | MutableFolderNode
  | MutableSketchNode
  | ExampleResourceNode

interface MutableFolderNode {
  kind: 'folder'
  name: string
  relPath: string
  children: MutableExampleTreeNode[]
}

interface MutableSketchNode {
  kind: 'sketch'
  name: string
  relPath: string
  children: MutableExampleTreeNode[]
}

async function buildExampleTree(meta: ExampleMeta): Promise<ExampleTreeNode[]> {
  const rootNodes: MutableExampleTreeNode[] = []
  const folderMap = new Map<string, MutableFolderNode>()
  const sketchMap = new Map<string, MutableSketchNode>()

  for (const entry of meta.entries) {
    const segments = entry.segments
    if (!segments.length) {
      continue
    }

    const sketchRelPath = normalizeRelPath(entry.relPath)
    if (!sketchRelPath) {
      continue
    }

    let parentChildren = rootNodes
    let currentRel = ''
    const folderSegments = segments.slice(0, -1)
    for (const segment of folderSegments) {
      currentRel = joinPosix(currentRel, segment)
      let folder = folderMap.get(currentRel)
      if (!folder) {
        folder = {
          kind: 'folder',
          name: segment,
          relPath: currentRel,
          children: [],
        }
        folderMap.set(currentRel, folder)
        parentChildren.push(folder)
      }
      parentChildren = folder.children
    }

    let sketch = sketchMap.get(sketchRelPath)
    if (!sketch) {
      const sketchName =
        segments[segments.length - 1] ?? path.basename(entry.absPath)
      const children = await readSketchTree(entry.absPath, sketchRelPath)
      sketch = {
        kind: 'sketch',
        name: sketchName,
        relPath: sketchRelPath,
        children,
      }
      sketchMap.set(sketchRelPath, sketch)
      parentChildren.push(sketch)
    }
  }

  sortMutableNodes(rootNodes)
  return rootNodes.map(convertMutableNode)
}

async function readSketchTree(
  absDir: string,
  baseRel: string
): Promise<MutableExampleTreeNode[]> {
  const nodes: MutableExampleTreeNode[] = []
  let dirEntries: Dirent[] = []
  try {
    dirEntries = await fs.readdir(absDir, { withFileTypes: true })
  } catch (error) {
    console.warn('Failed to read example directory', absDir, error)
    return nodes
  }

  for (const entry of dirEntries) {
    const abs = path.join(absDir, entry.name)
    const rel = joinPosix(baseRel, entry.name)

    if (entry.isDirectory()) {
      const children = await readSketchTree(abs, rel)
      nodes.push({
        kind: 'folder',
        name: entry.name,
        relPath: rel,
        children,
      })
      continue
    }

    try {
      const stat = await fs.stat(abs)
      const resource: ExampleResourceNode = {
        kind: 'resource',
        name: entry.name,
        relPath: rel,
        size: stat.size,
      }
      nodes.push(resource)
    } catch (error) {
      console.warn('Failed to stat example file', abs, error)
    }
  }

  sortMutableNodes(nodes)
  return nodes
}

function sortMutableNodes(nodes: MutableExampleTreeNode[]): void {
  nodes.sort((a, b) => {
    const ranking = nodeRank(a) - nodeRank(b)
    if (ranking !== 0) {
      return ranking
    }
    return a.name.localeCompare(b.name)
  })

  for (const node of nodes) {
    if (node.kind === 'folder' || node.kind === 'sketch') {
      sortMutableNodes(node.children)
    }
  }
}

function nodeRank(node: MutableExampleTreeNode): number {
  switch (node.kind) {
    case 'folder':
      return 0
    case 'sketch':
      return 1
    default:
      return 2
  }
}

function convertMutableNode(node: MutableExampleTreeNode): ExampleTreeNode {
  if (node.kind === 'resource') {
    return node
  }
  const children = node.children.map(convertMutableNode)
  if (node.kind === 'sketch') {
    const sketch: ExampleSketchNode = {
      kind: 'sketch',
      name: node.name,
      relPath: node.relPath,
      children,
    }
    return sketch
  }
  const folder: ExampleFolderNode = {
    kind: 'folder',
    name: node.name,
    relPath: node.relPath,
    children,
  }
  return folder
}

function findBestEntry(
  meta: ExampleMeta,
  relPath: string
): ExampleEntry | undefined {
  let best: ExampleEntry | undefined
  for (const entry of meta.entries) {
    if (relPath === entry.relPath || relPath.startsWith(`${entry.relPath}/`)) {
      if (!best || entry.relPath.length > best.relPath.length) {
        best = entry
      }
    }
  }
  return best
}

function joinPosix(base: string, segment: string): string {
  return base ? `${base}/${segment}` : segment
}

function normalizeRelPath(relPath: string): string {
  return relPath.split(/[\\/]/).filter(Boolean).join('/')
}

function toFsPath(value: string): string | undefined {
  if (!value) return undefined
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      return vscode.Uri.parse(value).fsPath
    }
    if (value.startsWith('file:\\\\')) {
      return new URL(value).pathname
    }
    return value
  } catch {
    return undefined
  }
}

function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    return base
  }
  let index = 1
  let candidate = `${base}#${index}`
  while (used.has(candidate)) {
    index += 1
    candidate = `${base}#${index}`
  }
  return candidate
}

function getCurrentFqbn(context: BoardLabContext): string | undefined {
  const board = context.currentSketch?.board
  if (!board) {
    return undefined
  }
  if (isBoardDetails(board) && board.fqbn) {
    return board.fqbn
  }
  if ('fqbn' in board && board.fqbn) {
    return board.fqbn
  }
  return undefined
}
