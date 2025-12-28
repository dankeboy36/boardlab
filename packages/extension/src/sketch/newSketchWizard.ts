import { promises as fs } from 'node:fs'
import * as path from 'node:path'

import * as vscode from 'vscode'

import type { BoardLabContextImpl } from '../boardlabContext'
import { defaultSketchFolderName, validateSketchFolderName } from './sketchName'
import type { Resource as SketchResource } from './types'
import {
  isFolder as isSketchbookFolder,
  isSketch as isSketchbookSketch,
} from './types'

export interface NewSketchParams {
  destinationFolder?: string
  sketchName?: string
}

export interface AddSketchFolderArgs {
  folderUri: vscode.Uri
  mainFileUri?: vscode.Uri
  openOnly?: boolean
}

export async function openNewSketchWizard(
  boardlabContext: BoardLabContextImpl,
  params: NewSketchParams = {}
): Promise<void> {
  const destinationFolder = await resolveSketchDestination(
    boardlabContext,
    params.destinationFolder
  )
  if (!destinationFolder) {
    return
  }

  const sketchName =
    params.sketchName ?? (await promptSketchName(destinationFolder))
  if (!sketchName) {
    return
  }

  await createSketch(boardlabContext, destinationFolder, sketchName)
}

export async function addSketchFolderToWorkspace(
  input: SketchResource | AddSketchFolderArgs | undefined
): Promise<void> {
  const args = await normalizeAddSketchArgs(input)
  if (!args) {
    vscode.window.showWarningMessage('Unable to determine sketch folder.')
    return
  }

  const { folderUri, mainFileUri, openOnly } = args
  const existing = getWorkspaceFolderByUri(folderUri)
  const targetFile = mainFileUri ?? guessMainSketchUri(folderUri)

  if (existing || openOnly) {
    await openSketchDocument(targetFile)
    return
  }

  const startIndex = vscode.workspace.workspaceFolders?.length ?? 0
  const added = vscode.workspace.updateWorkspaceFolders(startIndex, null, {
    uri: folderUri,
  })

  if (!added) {
    vscode.window.showErrorMessage(
      `Failed to add "${path.basename(folderUri.fsPath)}" to the workspace.`
    )
    return
  }

  await openSketchDocument(targetFile)
}

async function resolveSketchDestination(
  boardlabContext: BoardLabContextImpl,
  destinationFolder?: string
): Promise<string | undefined> {
  if (destinationFolder) {
    return path.resolve(destinationFolder)
  }

  const sketchbookPath =
    boardlabContext.cliContext.cliConfig.data?.userDirPath ?? undefined
  const workspaceFolders = vscode.workspace.workspaceFolders ?? []

  const items: Array<
    vscode.QuickPickItem & {
      destination?: string
      action?: 'browse'
    }
  > = []

  if (sketchbookPath) {
    items.push({
      label: 'Create in Sketchbook',
      description: path.join(sketchbookPath, '<sketch name>'),
      destination: sketchbookPath,
    })
  }

  for (const folder of workspaceFolders) {
    if (folder.uri.scheme !== 'file') {
      continue
    }
    items.push({
      label: `Create in Workspace: ${folder.name}`,
      description: path.join(folder.uri.fsPath, '<sketch name>'),
      destination: folder.uri.fsPath,
    })
  }

  items.push({
    label: 'Choose Folder...',
    description: 'Select another folder',
    action: 'browse',
  })

  const selection = await vscode.window.showQuickPick(items, {
    placeHolder: 'Choose where to create the sketch',
  })
  if (!selection) {
    return undefined
  }

  if (selection.action === 'browse') {
    const chosen = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Select Folder',
    })
    if (!chosen?.length) {
      return undefined
    }
    return chosen[0].fsPath
  }

  return selection.destination
}

async function promptSketchName(
  destinationFolder: string
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const input = vscode.window.createInputBox()
    let resolved = false
    let validationToken = 0
    let validationTimer: NodeJS.Timeout | undefined
    let disposed = false
    input.title = 'New Sketch'
    input.placeholder = 'Sketch folder name'
    input.value = defaultSketchFolderName
    input.prompt = `Create sketch in ${path.join(
      destinationFolder,
      input.value
    )}`
    input.validationMessage = validateSketchFolderName(input.value)

    const scheduleExistenceValidation = (value: string) => {
      if (validationTimer) {
        clearTimeout(validationTimer)
      }
      const currentToken = ++validationToken
      validationTimer = setTimeout(async () => {
        if (disposed || currentToken !== validationToken) {
          return
        }
        if (validateSketchFolderName(value)) {
          return
        }
        const targetPath = path.join(
          destinationFolder,
          value || defaultSketchFolderName
        )
        try {
          await fs.stat(targetPath)
          if (!disposed && currentToken === validationToken) {
            input.validationMessage = `Sketch folder already exists: ${targetPath}`
          }
        } catch (error: any) {
          if (error?.code === 'ENOENT') {
            if (!disposed && currentToken === validationToken) {
              input.validationMessage = validateSketchFolderName(value)
            }
            return
          }
          if (!disposed && currentToken === validationToken) {
            input.validationMessage = `Unable to validate sketch folder: ${targetPath}`
          }
        }
      }, 200)
    }

    input.onDidChangeValue((value) => {
      const label = value || defaultSketchFolderName
      input.prompt = `Create sketch in ${path.join(destinationFolder, label)}`
      input.validationMessage = validateSketchFolderName(value)
      if (!input.validationMessage) {
        scheduleExistenceValidation(value)
      }
    })

    input.onDidAccept(async () => {
      const value = input.value.trim()
      const validation = validateSketchFolderName(value)
      if (validation) {
        input.validationMessage = validation
        return
      }
      const targetPath = path.join(destinationFolder, value)
      try {
        await fs.stat(targetPath)
        input.validationMessage = `Sketch folder already exists: ${targetPath}`
        return
      } catch (error: any) {
        if (error?.code !== 'ENOENT') {
          input.validationMessage = `Unable to validate sketch folder: ${targetPath}`
          return
        }
      }
      resolved = true
      input.hide()
      resolve(value)
    })

    input.onDidHide(() => {
      disposed = true
      if (validationTimer) {
        clearTimeout(validationTimer)
      }
      input.dispose()
      if (!resolved) {
        resolve(undefined)
      }
    })

    input.show()
  })
}

async function createSketch(
  boardlabContext: BoardLabContextImpl,
  destinationFolder: string,
  sketchName: string
): Promise<void> {
  const validation = validateSketchFolderName(sketchName)
  if (validation) {
    vscode.window.showErrorMessage(validation)
    return
  }

  const baseFolder = path.resolve(destinationFolder)
  const targetFolder = path.join(baseFolder, sketchName)
  const inoPath = path.join(targetFolder, `${sketchName}.ino`)

  try {
    const stat = await fs.stat(baseFolder)
    if (!stat.isDirectory()) {
      vscode.window.showErrorMessage(
        `Destination is not a folder: ${baseFolder}`
      )
      return
    }
  } catch {
    vscode.window.showErrorMessage(
      `Destination folder not found: ${baseFolder}`
    )
    return
  }

  try {
    await fs.mkdir(targetFolder, { recursive: false })
  } catch (error: any) {
    if (error?.code === 'EEXIST') {
      vscode.window.showErrorMessage(
        `Sketch folder already exists: ${targetFolder}`
      )
      return
    }
    vscode.window.showErrorMessage(
      `Failed to create sketch folder: ${targetFolder}`
    )
    return
  }

  const content = await resolveSketchBlueprintContent()
  try {
    await fs.writeFile(inoPath, content, { flag: 'wx' })
  } catch (error: any) {
    if (error?.code === 'EEXIST') {
      vscode.window.showErrorMessage(`Sketch file already exists: ${inoPath}`)
    } else {
      vscode.window.showErrorMessage(`Failed to create sketch file: ${inoPath}`)
    }
    return
  }

  const inWorkspace = isPathInWorkspace(targetFolder)
  const refreshPromise = boardlabContext.sketchbooks.refresh()
  if (inWorkspace) {
    await refreshPromise
    await openSketchDocument(vscode.Uri.file(inoPath))
  }

  const promptActions: string[] = ['Open in New Window']
  if (!inWorkspace) {
    promptActions.push('Add to Workspace')
  }
  const picked = await vscode.window.showInformationMessage(
    `Sketch created at ${targetFolder}.`,
    ...promptActions
  )

  if (picked === 'Open in New Window') {
    await vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.file(targetFolder),
      true
    )
    return
  }

  if (picked === 'Add to Workspace') {
    await addSketchFolderToWorkspace({
      folderUri: vscode.Uri.file(targetFolder),
      mainFileUri: vscode.Uri.file(inoPath),
    })
  }
}

async function resolveSketchBlueprintContent(): Promise<string> {
  const defaultContent =
    'void setup() {\n  // put your setup code here, to run once:\n\n}\n\nvoid loop() {\n  // put your main code here, to run repeatedly:\n\n}\n'
  const config = vscode.workspace.getConfiguration('boardlab.sketch')
  const blueprintPath = config.get<string>('inoBlueprint')

  if (!blueprintPath) {
    return defaultContent
  }

  if (!path.isAbsolute(blueprintPath)) {
    return defaultContent
  }

  try {
    const content = await fs.readFile(blueprintPath, 'utf8')
    return content || defaultContent
  } catch (error) {
    console.warn(`Failed to read sketch blueprint at ${blueprintPath}`, error)
    return defaultContent
  }
}

function isPathInWorkspace(targetPath: string): boolean {
  return (vscode.workspace.workspaceFolders ?? []).some((folder) => {
    if (folder.uri.scheme !== 'file') {
      return false
    }
    const relative = path.relative(folder.uri.fsPath, targetPath)
    return (
      relative === '' ||
      (!relative.startsWith('..') && !path.isAbsolute(relative))
    )
  })
}

async function normalizeAddSketchArgs(
  input: SketchResource | AddSketchFolderArgs | undefined
): Promise<AddSketchFolderArgs | undefined> {
  if (!input) {
    return undefined
  }

  if ('folderUri' in input) {
    const folderUri = input.folderUri.with({ scheme: 'file' })
    const mainFileUri = input.mainFileUri?.with({ scheme: 'file' })
    return {
      folderUri,
      mainFileUri,
      openOnly: input.openOnly ?? false,
    }
  }

  if (isSketchbookSketch(input)) {
    const folderUri = input.uri.with({ scheme: 'file' })
    return {
      folderUri,
      mainFileUri:
        input.mainSketchFileUri?.with({ scheme: 'file' }) ??
        guessMainSketchUri(folderUri),
    }
  }

  if (isSketchbookFolder(input)) {
    const folderUri = input.uri.with({ scheme: 'file' })
    return {
      folderUri,
      mainFileUri: guessMainSketchUri(folderUri),
    }
  }

  return undefined
}

function guessMainSketchUri(folderUri: vscode.Uri): vscode.Uri {
  const name = path.basename(folderUri.fsPath)
  return vscode.Uri.joinPath(folderUri, `${name}.ino`)
}

async function openSketchDocument(uri: vscode.Uri): Promise<void> {
  try {
    const document = await vscode.workspace.openTextDocument(uri)
    await vscode.window.showTextDocument(document, { preview: false })
  } catch (error) {
    console.warn('Failed to open sketch document', error)
    vscode.window.showWarningMessage(
      `Sketch folder added, but failed to open "${uri.fsPath}".`
    )
  }
}

function getWorkspaceFolderByUri(
  folderUri: vscode.Uri
): vscode.WorkspaceFolder | undefined {
  const targetPath = folderUri.with({ scheme: 'file' }).fsPath
  return (vscode.workspace.workspaceFolders ?? []).find(
    (folder) => folder.uri.fsPath === targetPath
  )
}
