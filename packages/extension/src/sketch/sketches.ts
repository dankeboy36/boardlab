import { basename, relative } from 'path'

import * as vscode from 'vscode'

import {
  matchesQuickPickConstraints,
  type QuickPickConstraints,
} from '../quickPickConstraints'
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
            if (item instanceof QuickInputNoopLabel) {
              return
            }
            if (item instanceof SketchQuickPickItem) {
              resolve(item.sketch)
              input.hide()
              return
            }
            if (item instanceof CreateSketchQuickPickItem) {
              vscode.commands.executeCommand('boardlab.openNewSketchWizard')
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
  let hasAnySketch = false
  for (const [uri, sketchbook] of sketchbooks.all().entries()) {
    const sketchbookUri = vscode.Uri.parse(uri)
    if (!vscode.workspace.getWorkspaceFolder(sketchbookUri)) {
      continue
    }
    const sketchbookPath = sketchbookUri.fsPath
    if (sketchbook.sketches.length) {
      hasAnySketch = true
    }
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
      new QuickInputNoopLabel(
        hasAnySketch ? 'No matching sketches' : 'No sketches found in workspace'
      ),
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
