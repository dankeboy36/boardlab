import { basename, relative } from 'path'

import * as vscode from 'vscode'

import {
  matchesQuickPickConstraints,
  type QuickPickConstraints,
} from '../quickPickConstraints'
import {
  InmemoryRecentItems,
  RecentItems,
  disposeAll,
  noopRecentItems,
} from '../utils'
import { Sketchbooks } from './sketchbooks'
import { Sketch } from './types'

/** `items` are main sketch file URI strings. */
export class InmemoryRecentSketches extends InmemoryRecentItems<string> {}

export interface SketchPickOptions extends QuickPickConstraints<Sketch> {}

export async function pickSketch(
  sketchbooks: Sketchbooks,
  pinnedItems: RecentItems<string> = noopRecentItems(),
  recentItems: RecentItems<string> = noopRecentItems(),
  options: SketchPickOptions = {}
): Promise<Sketch | undefined> {
  const toDispose: vscode.Disposable[] = []
  const input = vscode.window.createQuickPick()
  let updateToken = 0
  const updateInput = (): void => {
    const currentToken = ++updateToken
    ;(async () => {
      input.busy = true
      try {
        const items = await toSketchQuickPickItem(
          sketchbooks,
          pinnedItems.items,
          recentItems.items,
          options
        )
        if (currentToken !== updateToken) {
          return
        }
        input.items = items
      } finally {
        if (currentToken === updateToken) {
          input.busy = false
        }
      }
    })()
  }
  // https://github.com/microsoft/vscode/issues/73904#issuecomment-680298036

  ;(input as any).sortByLabel = false
  input.matchOnDescription = true
  input.placeholder = 'Select a sketch'
  input.busy = true
  input.show()
  try {
    const selected = await new Promise<Sketch | undefined>((resolve) => {
      updateInput()
      toDispose.push(
        input.onDidChangeSelection((items) => {
          ;(async () => {
            const item = items[0]
            if (item instanceof SketchQuickPickItem) {
              resolve(item.sketch)
              input.hide()
              return
            }
            if (item instanceof CreateSketchQuickPickItem) {
              vscode.commands.executeCommand('boardlab.openNewSketchWizard')
              resolve(undefined)
              input.hide()
              return
            }
            if (item instanceof OpenSketchQuickPickItem) {
              vscode.commands.executeCommand('boardlab.openSketch')
              resolve(undefined)
              input.hide()
              return
            }
            if (item instanceof CloneSketchQuickPickItem) {
              vscode.commands.executeCommand('boardlab.cloneSketch')
              resolve(undefined)
              input.hide()
            }
          })()
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

async function toSketchQuickPickItem(
  sketchbooks: Sketchbooks,
  _pinnedSketches: string[],
  _recentSketches: string[],
  options: SketchPickOptions
): Promise<vscode.QuickPickItem[]> {
  const quickItems: vscode.QuickPickItem[] = []
  for (const [uri, sketchbook] of sketchbooks.all().entries()) {
    const sketchbookUri = vscode.Uri.parse(uri)
    if (!vscode.workspace.getWorkspaceFolder(sketchbookUri)) {
      continue
    }
    const sketchbookPath = sketchbookUri.fsPath
    const filteredSketches: Sketch[] = []
    for (const sketch of sketchbook.sketches) {
      if (await matchesQuickPickConstraints(sketch, options)) {
        filteredSketches.push(sketch)
      }
    }
    if (!filteredSketches.length) {
      continue
    }
    quickItems.push({
      kind: vscode.QuickPickItemKind.Separator,
      label: basename(sketchbookPath),
    })
    quickItems.push(
      ...filteredSketches.map(
        (sketch) => new SketchQuickPickItem(sketch, sketchbookPath)
      )
    )
  }
  if (!quickItems.length) {
    return [
      new CreateSketchQuickPickItem(),
      new OpenSketchQuickPickItem(),
      new CloneSketchQuickPickItem(),
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
  label = 'Create Sketch...'
  description = 'Create new sketch'
  detail =
    'Create a new sketch. In the next step, choose workspace, sketchbook, or another folder.'
}

class OpenSketchQuickPickItem implements vscode.QuickPickItem {
  label = 'Open Sketch...'
  description = 'Add existing sketch folder'
  detail = 'Open an existing sketch by adding its folder to this workspace.'
}

class CloneSketchQuickPickItem implements vscode.QuickPickItem {
  label = 'Clone Sketch...'
  description = 'Copy into workspace'
  detail = 'Clone a sketch into this workspace. The original remains unchanged.'
}
