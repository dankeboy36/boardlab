import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import * as vscode from 'vscode'

import { EXAMPLE_SCHEME } from './exampleFs'
import type { ExampleMeta } from './examplesIndex'

type ExampleResolver = (id: string) => ExampleMeta | undefined

export function registerExampleCommands(
  ctx: vscode.ExtensionContext,
  locateExampleById: ExampleResolver
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      'boardlab.examples.openPreview',
      async (uri: vscode.Uri) => {
        await vscode.window.showTextDocument(uri, {
          preview: true,
          preserveFocus: false,
        })
        vscode.window.setStatusBarMessage(
          'Read-only preview • Use Import to edit',
          3000
        )
      }
    ),

    vscode.commands.registerCommand(
      'boardlab.examples.importToWorkspace',
      async (target?: vscode.Uri) => {
        const context = resolveContext(target, locateExampleById)
        if (!context) {
          return
        }
        const { meta, exampleRelPath } = context
        const examplePath = path.join(meta.rootPath, exampleRelPath)

        const destinationParent = await pickDestinationFolder()
        if (!destinationParent) {
          return
        }

        await copyDir(examplePath, destinationParent.fsPath)
        const importedPath = path.join(
          destinationParent.fsPath,
          path.basename(examplePath)
        )
        const choice = await vscode.window.showInformationMessage(
          'Example imported.',
          'Open Folder'
        )
        if (choice === 'Open Folder') {
          await vscode.commands.executeCommand(
            'vscode.openFolder',
            vscode.Uri.file(importedPath),
            { forceNewWindow: false }
          )
        }
      }
    ),

    vscode.commands.registerCommand(
      'boardlab.examples.openTemp',
      async (target?: vscode.Uri) => {
        const context = resolveContext(target, locateExampleById)
        if (!context) {
          return
        }
        const { meta, exampleRelPath } = context
        const examplePath = path.join(meta.rootPath, exampleRelPath)

        const tmpDir = await fsp.mkdtemp(
          path.join(os.tmpdir(), 'arduino-example-')
        )
        const dst = path.join(tmpDir, path.basename(examplePath))
        await copyDir(examplePath, dst)
        await vscode.commands.executeCommand(
          'vscode.openFolder',
          vscode.Uri.file(dst),
          { forceNewWindow: true }
        )
      }
    )
  )
}

interface ExampleContext {
  readonly meta: ExampleMeta
  readonly exampleRelPath: string
}

function resolveContext(
  input: vscode.Uri | undefined,
  locateExampleById: ExampleResolver
): ExampleContext | undefined {
  if (!input || input.scheme !== EXAMPLE_SCHEME) {
    vscode.window.showWarningMessage('Example command requires a selection.')
    return undefined
  }

  const { exampleId, relPath } = parseExampleUri(input)
  const meta = locateExampleById(exampleId)
  if (!meta) {
    vscode.window.showWarningMessage('Cannot resolve example metadata.')
    return undefined
  }

  const example = findExampleRoot(meta, relPath)
  if (!example) {
    vscode.window.showWarningMessage('Unable to resolve example sketch root.')
    return undefined
  }

  return { meta, exampleRelPath: example }
}

function findExampleRoot(
  meta: ExampleMeta,
  relPath: string
): string | undefined {
  const normalized = normalizeRelPath(relPath)
  if (!normalized) {
    return undefined
  }

  const sorted = [...meta.entries].sort(
    (a, b) => b.relPath.length - a.relPath.length
  )
  for (const entry of sorted) {
    if (
      normalized === entry.relPath ||
      normalized.startsWith(`${entry.relPath}/`)
    ) {
      return entry.relPath
    }
  }
  return undefined
}

async function copyDir(src: string, dstParent: string): Promise<void> {
  await fsp.mkdir(dstParent, { recursive: true })
  const name = path.basename(src)
  const destination = path.join(dstParent, name)
  await fsp.mkdir(destination, { recursive: true })
  const entries = await fsp.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const s = path.join(src, entry.name)
    const d = path.join(destination, entry.name)
    if (entry.isDirectory()) {
      await copyDir(s, destination)
    } else if (entry.isSymbolicLink()) {
      const target = await fsp.readlink(s)
      await fsp.symlink(target, d)
    } else {
      await fsp.copyFile(s, d)
    }
  }
}

async function pickDestinationFolder(): Promise<vscode.Uri | undefined> {
  const folder = (
    await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Import here',
      title: 'Select destination folder',
    })
  )?.[0]
  return folder
}

function parseExampleUri(uri: vscode.Uri): {
  exampleId: string
  relPath: string
} {
  const parts = uri.path.replace(/^\/+/, '').split('/')
  const exampleId = parts.shift() ?? ''
  const relPath = parts.join('/')
  return { exampleId, relPath }
}

function normalizeRelPath(relPath: string): string {
  return relPath.split(/[\\/]/).filter(Boolean).join('/')
}
