import { basename, relative } from 'path'

import * as vscode from 'vscode'

import {
  InmemoryRecentItems,
  QuickInputNoopLabel,
  RecentItems,
  disposeAll,
  noopRecentItems,
} from '../utils'
import { Sketchbooks } from './sketchbooks'
import { Sketch } from './types'

/** `items` are main sketch file URI strings. */
export class InmemoryRecentSketches extends InmemoryRecentItems<string> {}

export async function pickSketch(
  sketchbooks: Sketchbooks,
  pinnedItems: RecentItems<string> = noopRecentItems(),
  recentItems: RecentItems<string> = noopRecentItems()
): Promise<Sketch | undefined> {
  const toDispose: vscode.Disposable[] = []
  const input = vscode.window.createQuickPick()
  const updateInput = (): unknown =>
    (input.items = toSketchQuickPickItem(
      sketchbooks,
      pinnedItems.items,
      recentItems.items
    ))
  // https://github.com/microsoft/vscode/issues/73904#issuecomment-680298036

  ;(input as any).sortByLabel = false
  input.matchOnDescription = true
  input.placeholder = 'Select a sketch'
  input.busy = true
  input.show()
  try {
    const selected = await new Promise<Sketch | undefined>((resolve) => {
      updateInput()
      input.busy = false
      toDispose.push(
        input.onDidChangeSelection((items) => {
          const item = items[0]
          if (item instanceof QuickInputNoopLabel) {
            return
          }
          if (item instanceof SketchQuickPickItem) {
            resolve(item.sketch)
          }
          if (item instanceof CreateSketchQuickPickItem) {
            vscode.commands.executeCommand('boardlab.openNewSketchWizard')
            resolve(undefined)
          }
          input.hide()
        }),
        input.onDidHide(() => {
          resolve(undefined)
          input.dispose()
        }),
        sketchbooks.onDidChangeSketchFolders(updateInput),
        pinnedItems.onDidUpdate(updateInput),
        recentItems.onDidUpdate(updateInput)
      )
    })
    return selected
  } finally {
    disposeAll(...toDispose)
  }
}

function toSketchQuickPickItem(
  sketchbooks: Sketchbooks,
  pinnedSketches: string[],
  recentSketches: string[]
): vscode.QuickPickItem[] {
  const quickItems: vscode.QuickPickItem[] = []
  for (const [uri, sketchbook] of sketchbooks.all().entries()) {
    const sketchbookUri = vscode.Uri.parse(uri)
    if (!vscode.workspace.getWorkspaceFolder(sketchbookUri)) {
      continue
    }
    const sketchbookPath = sketchbookUri.fsPath
    if (sketchbook.sketches.length) {
      quickItems.push({
        kind: vscode.QuickPickItemKind.Separator,
        label: basename(sketchbookPath),
      })
    }
    quickItems.push(
      ...sketchbook.sketches.map(
        (sketch) => new SketchQuickPickItem(sketch, sketchbookPath)
      )
    )
  }
  if (!quickItems.length) {
    return [
      new CreateSketchQuickPickItem(),
      new QuickInputNoopLabel('No sketches found in workspace'),
    ]
  }
  return quickItems
}

class SketchQuickPickItem implements vscode.QuickPickItem {
  label: string
  description?: string

  constructor(
    readonly sketch: Sketch,
    sketchbookPath: string
  ) {
    const sketchPath = sketch.uri.fsPath
    this.label = basename(sketchPath)
    this.description = relative(sketchbookPath, sketchPath)
  }
}

class CreateSketchQuickPickItem implements vscode.QuickPickItem {
  label = '$(add) Create Sketch...'
  description = 'Create a sketch in the workspace'
}
