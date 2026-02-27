import { promises as fs } from 'node:fs'
import * as path from 'node:path'

import * as vscode from 'vscode'

import type { BoardLabContextImpl } from '../boardlabContext'
import { copySketchFolder, renameMainSketchFile } from './sketchImport'
import { defaultSketchFolderName, validateSketchFolderName } from './sketchName'
import type { Resource as SketchResource, Sketch } from './types'
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
  confirm?: boolean
}

export interface CloneSketchArgs {
  resource?: SketchResource
  confirm?: boolean
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

export async function openSketch(
  boardlabContext: BoardLabContextImpl,
  input: SketchResource | AddSketchFolderArgs | undefined
): Promise<void> {
  const shouldConfirm = resolveConfirmFlag(input)
  const args = await normalizeAddSketchArgs(boardlabContext, input)
  if (!args) {
    return
  }

  const { folderUri, mainFileUri, openOnly } = args
  const resolvedMainFile = await resolveMainSketchFileUri(
    folderUri,
    mainFileUri
  )
  if (!resolvedMainFile) {
    vscode.window.showErrorMessage(
      `No main sketch file found in ${folderUri.fsPath}.`
    )
    return
  }

  const existing = getWorkspaceFolderByUri(folderUri)
  const needsWorkspaceAdd = !existing && !openOnly
  if (shouldConfirm) {
    const confirmAction = needsWorkspaceAdd ? 'Add' : 'Open'
    const message = needsWorkspaceAdd
      ? `Add sketch "${path.basename(folderUri.fsPath)}" to this workspace and open it?`
      : `Open sketch "${path.basename(folderUri.fsPath)}"?`
    const confirmed = await promptUser(message, confirmAction)
    if (!confirmed) {
      return
    }
  }
  if (existing || openOnly) {
    await openSketchDocument(resolvedMainFile)
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

  await boardlabContext.sketchbooks.refresh({ showLoading: false })
  await openSketchDocument(resolvedMainFile)
}

export async function openSketchInNewWindow(
  boardlabContext: BoardLabContextImpl,
  input: SketchResource | AddSketchFolderArgs | undefined
): Promise<void> {
  const args = await normalizeAddSketchArgs(boardlabContext, input)
  if (!args) {
    return
  }

  const { folderUri, mainFileUri } = args
  const resolvedMainFile = await resolveMainSketchFileUri(
    folderUri,
    mainFileUri
  )
  if (!resolvedMainFile) {
    vscode.window.showErrorMessage(
      `No main sketch file found in ${folderUri.fsPath}.`
    )
    return
  }

  await vscode.commands.executeCommand('vscode.openFolder', folderUri, true)
}

export async function cloneSketch(
  boardlabContext: BoardLabContextImpl,
  input: SketchResource | CloneSketchArgs | undefined
): Promise<void> {
  const shouldConfirm = resolveConfirmFlag(input)
  const resource = isCloneSketchArgs(input) ? input.resource : input
  const args = await normalizeImportArgs(boardlabContext, resource)
  if (!args) {
    return
  }

  await importSketchFolderToWorkspace(
    boardlabContext,
    args.folderUri,
    args.mainFileUri,
    shouldConfirm
  )
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

  if (sketchbookPath) {
    items.push({
      label: 'Create in Sketchbook',
      description: path.join(sketchbookPath, '<sketch name>'),
      destination: sketchbookPath,
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
  return promptSketchFolderName({
    title: 'Create Sketch',
    destinationFolder,
    initialValue: defaultSketchFolderName,
    promptLabel: 'Create sketch in',
  })
}

async function promptSketchFolderName({
  title,
  destinationFolder,
  initialValue,
  promptLabel,
}: {
  title: string
  destinationFolder: string
  initialValue: string
  promptLabel: string
}): Promise<string | undefined> {
  return new Promise((resolve) => {
    const input = vscode.window.createInputBox()
    let resolved = false
    let validationToken = 0
    let validationTimer: NodeJS.Timeout | undefined
    let disposed = false
    input.title = title
    input.placeholder = 'Sketch folder name'
    input.value = initialValue
    input.prompt = `${promptLabel} ${path.join(destinationFolder, input.value)}`
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
        const targetPath = path.join(destinationFolder, value || initialValue)
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
      const label = value || initialValue
      input.prompt = `${promptLabel} ${path.join(destinationFolder, label)}`
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
  const refreshPromise = boardlabContext.sketchbooks.refresh({
    showLoading: false,
  })
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
    await openSketch(boardlabContext, {
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
  boardlabContext: BoardLabContextImpl,
  input: SketchResource | AddSketchFolderArgs | undefined
): Promise<AddSketchFolderArgs | undefined> {
  if (!input) {
    return promptAddSketchFolder(boardlabContext)
  }

  if ('folderUri' in input) {
    const folderUri = input.folderUri.with({ scheme: 'file' })
    const mainFileUri = input.mainFileUri?.with({ scheme: 'file' })
    return {
      folderUri,
      mainFileUri,
      openOnly: input.openOnly ?? false,
      confirm: input.confirm,
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

async function normalizeImportArgs(
  boardlabContext: BoardLabContextImpl,
  input: SketchResource | undefined
): Promise<Pick<AddSketchFolderArgs, 'folderUri' | 'mainFileUri'> | undefined> {
  if (!input) {
    return promptSketchbookImport(boardlabContext)
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

async function promptSketchbookImport(
  boardlabContext: BoardLabContextImpl
): Promise<Pick<AddSketchFolderArgs, 'folderUri' | 'mainFileUri'> | undefined> {
  return pickSketchFolderSource(boardlabContext, {
    placeHolder: 'Select a sketch to clone into the workspace',
    browseLabel: 'Choose folder...',
  })
}

async function importSketchFolderToWorkspace(
  boardlabContext: BoardLabContextImpl,
  folderUri: vscode.Uri,
  mainFileUri?: vscode.Uri,
  confirm = false
): Promise<
  | {
      destinationFolder: string
      mainSketchPath?: string
    }
  | undefined
> {
  const sourceFolder = folderUri.fsPath
  if (isPathInWorkspace(sourceFolder)) {
    if (confirm) {
      const confirmed = await promptUser(
        'Sketch is already in this workspace. Open it?',
        'Open'
      )
      if (!confirmed) {
        return
      }
    }
    const resolvedMainFile =
      mainFileUri ?? guessMainSketchUri(vscode.Uri.file(sourceFolder))
    await openSketchDocument(resolvedMainFile)
    return {
      destinationFolder: sourceFolder,
      mainSketchPath: resolvedMainFile.fsPath,
    }
  }

  const destinationRoot = await pickWorkspaceImportRoot()
  if (!destinationRoot) {
    return
  }

  const sourceName = path.basename(sourceFolder)
  let targetName = sourceName
  let destinationFolder = path.join(destinationRoot, targetName)

  if (await pathExists(destinationFolder)) {
    const resolved = await promptSketchFolderName({
      title: 'Import Sketch',
      destinationFolder: destinationRoot,
      initialValue: sourceName,
      promptLabel: 'Import sketch into',
    })
    if (!resolved) {
      return
    }
    targetName = resolved
    destinationFolder = path.join(destinationRoot, targetName)
  }

  if (confirm) {
    const confirmed = await promptUser(
      `Clone sketch "${sourceName}" to "${destinationFolder}"?`,
      'Clone'
    )
    if (!confirmed) {
      return
    }
  }

  try {
    const stat = await fs.stat(destinationRoot)
    if (!stat.isDirectory()) {
      vscode.window.showErrorMessage(
        `Destination is not a folder: ${destinationRoot}`
      )
      return
    }
  } catch {
    vscode.window.showErrorMessage(
      `Destination folder not found: ${destinationRoot}`
    )
    return
  }

  try {
    await copySketchFolder(sourceFolder, destinationFolder)
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to import sketch into ${destinationFolder}.`
    )
    console.warn('Failed to import sketch', error)
    return
  }

  const preferredExtension = mainFileUri
    ? path.extname(mainFileUri.fsPath)
    : undefined
  const mainSketchPath = await renameMainSketchFile(
    destinationFolder,
    sourceName,
    targetName,
    preferredExtension
  )

  const refreshPromise = boardlabContext.sketchbooks.refresh({
    showLoading: false,
  })
  await refreshPromise

  if (mainSketchPath) {
    await openSketchDocument(vscode.Uri.file(mainSketchPath))
  }
  return {
    destinationFolder,
    mainSketchPath: mainSketchPath ?? undefined,
  }
}

async function promptAddSketchFolder(
  boardlabContext: BoardLabContextImpl
): Promise<AddSketchFolderArgs | undefined> {
  return pickSketchFolderSource(boardlabContext, {
    placeHolder: 'Select a sketch to open in this workspace',
    browseLabel: 'Choose folder...',
  })
}

async function pickSketchFolderSource(
  boardlabContext: BoardLabContextImpl,
  options: { placeHolder: string; browseLabel: string }
): Promise<Pick<AddSketchFolderArgs, 'folderUri' | 'mainFileUri'> | undefined> {
  await boardlabContext.sketchbooks.refresh({ showLoading: false })
  const sketchbook = boardlabContext.sketchbooks.userSketchbook
  const sketchbookPath = sketchbook?.uri.fsPath
  const items: Array<
    vscode.QuickPickItem & { sketch?: Sketch; action?: 'browse' }
  > = []

  if (sketchbook?.sketches.length) {
    items.push(
      ...sketchbook.sketches.map((sketch) => ({
        label: path.basename(sketch.uri.fsPath),
        description: sketchbookPath
          ? path.relative(sketchbookPath, sketch.uri.fsPath)
          : sketch.uri.fsPath,
        sketch,
      }))
    )
  }

  items.push({
    label: options.browseLabel,
    description: 'Pick another folder',
    action: 'browse',
  })

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: options.placeHolder,
  })
  if (!picked) {
    return undefined
  }

  if (picked.action === 'browse') {
    const chosen = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: options.browseLabel,
      title: 'Select Sketch',
    })
    if (!chosen?.length) {
      return undefined
    }
    const folderUri = chosen[0]
    return {
      folderUri,
      mainFileUri: await resolveMainSketchFileUri(folderUri),
    }
  }

  if (picked.sketch) {
    const folderUri = picked.sketch.uri.with({ scheme: 'file' })
    return {
      folderUri,
      mainFileUri:
        picked.sketch.mainSketchFileUri?.with({ scheme: 'file' }) ??
        guessMainSketchUri(folderUri),
    }
  }

  return undefined
}

async function pickWorkspaceImportRoot(): Promise<string | undefined> {
  const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).filter(
    (folder) => folder.uri.scheme === 'file'
  )
  if (!workspaceFolders.length) {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Import here',
      title: 'Select destination folder',
    })
    return picked?.[0]?.fsPath
  }
  if (workspaceFolders.length === 1) {
    return workspaceFolders[0].uri.fsPath
  }
  const items = workspaceFolders.map((folder) => ({
    label: folder.name,
    description: folder.uri.fsPath,
    folder,
  }))
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select destination folder',
  })
  return picked?.folder.uri.fsPath
}

function guessMainSketchUri(folderUri: vscode.Uri): vscode.Uri {
  const name = path.basename(folderUri.fsPath)
  return vscode.Uri.joinPath(folderUri, `${name}.ino`)
}

async function resolveMainSketchFileUri(
  folderUri: vscode.Uri,
  mainFileUri?: vscode.Uri
): Promise<vscode.Uri | undefined> {
  if (mainFileUri) {
    try {
      await fs.stat(mainFileUri.fsPath)
      return mainFileUri
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return undefined
      }
      throw error
    }
  }
  const mainFilePath = await findMainSketchFile(folderUri.fsPath)
  return mainFilePath ? vscode.Uri.file(mainFilePath) : undefined
}

async function findMainSketchFile(
  folderPath: string
): Promise<string | undefined> {
  const folderName = path.basename(folderPath)
  const candidates = [path.join(folderPath, `${folderName}.ino`)]
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate)
      if (stat.isFile()) {
        return candidate
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        throw error
      }
    }
  }
  return undefined
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

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath)
    return true
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

function isCloneSketchArgs(
  input: SketchResource | CloneSketchArgs | undefined
): input is CloneSketchArgs {
  if (!input || typeof input !== 'object') {
    return false
  }
  if (isSketchbookSketch(input) || isSketchbookFolder(input)) {
    return false
  }
  return 'resource' in input || 'confirm' in input
}

function resolveConfirmFlag(
  input: SketchResource | AddSketchFolderArgs | CloneSketchArgs | undefined
): boolean {
  if (!input || typeof input !== 'object') {
    return false
  }
  if ('confirm' in input && typeof input.confirm === 'boolean') {
    return input.confirm
  }
  return isSketchbookSketch(input) || isSketchbookFolder(input)
}

async function promptUser(
  message: string,
  confirmAction: string
): Promise<boolean> {
  const picked = await vscode.window.showInformationMessage(
    message,
    { modal: true },
    confirmAction
  )
  return picked === confirmAction
}
