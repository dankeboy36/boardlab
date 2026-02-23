import path from 'node:path'
import fs from 'node:fs/promises'

import * as vscode from 'vscode'

import type { BoardLabContextImpl } from './boardlabContext'
import { terminalEOL } from './cli/arduino'
import { collectCliDiagnostics } from './profile/cliDiagnostics'
import { validateProfilesYAML } from './profile/validation'

export const boardlabProfileProblemMatcher = '$boardlab-profile' as const
export const validateSketchProfileTaskLabel =
  'BoardLab: Validate Sketch Profile'
export const validateSketchProfileCommand = 'validate-sketch-profile' as const

export interface ValidateSketchProfileTaskDefinition
  extends vscode.TaskDefinition {
  type: string
  command: typeof validateSketchProfileCommand
  sketchPath?: string
  hookTaskRunId?: string
}

export function isValidateSketchProfileTaskDefinition(
  arg: unknown,
  boardlabTaskType: string
): arg is ValidateSketchProfileTaskDefinition {
  return (
    (arg as ValidateSketchProfileTaskDefinition).type === boardlabTaskType &&
    (arg as ValidateSketchProfileTaskDefinition).command ===
      validateSketchProfileCommand &&
    ((arg as ValidateSketchProfileTaskDefinition).sketchPath === undefined ||
      typeof (arg as ValidateSketchProfileTaskDefinition).sketchPath ===
        'string') &&
    ((arg as ValidateSketchProfileTaskDefinition).hookTaskRunId === undefined ||
      typeof (arg as ValidateSketchProfileTaskDefinition).hookTaskRunId ===
        'string')
  )
}

export function createValidateSketchProfileTask(params: {
  definition: ValidateSketchProfileTaskDefinition
  boardlabTaskType: string
  boardlabContext: BoardLabContextImpl
  createValidationFailurePty: (message?: string) => vscode.Pseudoterminal
  recordCustomHookTaskExitCode: (
    taskRunId: string | undefined,
    code: number | undefined
  ) => void
  recordProfileValidationExitCode: (
    sketchPath: string,
    code: number | undefined
  ) => void
}): vscode.Task {
  return new vscode.Task(
    params.definition,
    vscode.TaskScope.Workspace,
    validateSketchProfileTaskLabel,
    params.boardlabTaskType,
    new vscode.CustomExecution(async (resolvedTask) => {
      const taskRunId =
        typeof resolvedTask.hookTaskRunId === 'string'
          ? resolvedTask.hookTaskRunId
          : undefined
      const sketchPath = await resolveValidationSketchPath(
        resolvedTask.sketchPath,
        params.boardlabContext
      )
      if (!sketchPath) {
        params.recordCustomHookTaskExitCode(taskRunId, 1)
        return params.createValidationFailurePty('No sketch selected.')
      }

      return createProfileValidationTaskPty({
        sketchPath,
        taskRunId,
        boardlabContext: params.boardlabContext,
        recordCustomHookTaskExitCode: params.recordCustomHookTaskExitCode,
        recordProfileValidationExitCode: params.recordProfileValidationExitCode,
      })
    }),
    boardlabProfileProblemMatcher
  )
}

async function resolveValidationSketchPath(
  sketchPath: string | undefined,
  boardlabContext: BoardLabContextImpl
): Promise<string | undefined> {
  if (typeof sketchPath === 'string') {
    const trimmed = sketchPath.trim()
    if (trimmed && !isUnresolvedTaskVariable(trimmed)) {
      return trimmed
    }
  }
  if (boardlabContext.currentSketch?.sketchPath) {
    return boardlabContext.currentSketch.sketchPath
  }
  const selectedSketch = await boardlabContext.selectSketch()
  return selectedSketch?.sketchPath
}

function createProfileValidationTaskPty(params: {
  sketchPath: string
  taskRunId?: string
  boardlabContext: BoardLabContextImpl
  recordCustomHookTaskExitCode: (
    taskRunId: string | undefined,
    code: number | undefined
  ) => void
  recordProfileValidationExitCode: (
    sketchPath: string,
    code: number | undefined
  ) => void
}): vscode.Pseudoterminal {
  const emitter = new vscode.EventEmitter<string>()
  const closeEmitter = new vscode.EventEmitter<void | number>()
  let closed = false

  const finalize = (code?: number) => {
    if (closed) {
      return
    }
    closed = true
    params.recordCustomHookTaskExitCode(params.taskRunId, code)
    params.recordProfileValidationExitCode(params.sketchPath, code)
    closeEmitter.fire(code)
    emitter.dispose()
    closeEmitter.dispose()
  }

  const writeLine = (line: string) => {
    if (closed) {
      return
    }
    emitter.fire(terminalEOL(`${line}\n`))
  }

  const runValidation = async () => {
    const sketchYamlPath = path.join(params.sketchPath, 'sketch.yaml')
    let doc: vscode.TextDocument
    try {
      await fs.access(sketchYamlPath)
      doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(sketchYamlPath)
      )
    } catch (error) {
      if (isMissingProfilesFileError(error)) {
        writeLine(
          `[profiles] ${sketchYamlPath} was not found. Skipping profile validation.`
        )
        finalize(0)
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      writeLine(`[profiles] Failed to open ${sketchYamlPath}: ${message}`)
      finalize(1)
      return
    }

    const diagnostics = await collectSketchProfileDiagnostics(
      params.boardlabContext,
      doc
    )
    if (closed) {
      return
    }

    if (!diagnostics.length) {
      writeLine(`[profiles] Validation passed for ${sketchYamlPath}.`)
      finalize(0)
      return
    }

    let errorCount = 0
    let warningCount = 0
    let infoCount = 0
    for (const diagnostic of diagnostics) {
      const severity = profileDiagnosticSeverity(diagnostic.severity)
      if (severity === 'error') {
        errorCount += 1
      } else if (severity === 'warning') {
        warningCount += 1
      } else {
        infoCount += 1
      }
      writeLine(formatProfileDiagnosticLine(doc.uri.fsPath, diagnostic))
    }

    writeLine(
      `[profiles] Validation found ${errorCount} error(s), ${warningCount} warning(s), and ${infoCount} info issue(s).`
    )
    if (errorCount > 0) {
      await focusProblemsView()
    }
    finalize(errorCount > 0 ? 1 : 0)
  }

  return {
    onDidWrite: emitter.event,
    onDidClose: closeEmitter.event,
    open: () => {
      runValidation().catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        writeLine(`[profiles] Validation failed unexpectedly: ${message}`)
        finalize(1)
      })
    },
    close: () => finalize(),
  }
}

async function focusProblemsView(): Promise<void> {
  try {
    await vscode.commands.executeCommand('workbench.actions.view.problems')
  } catch (error) {
    console.warn(
      'Failed to focus Problems view after profile validation',
      error
    )
  }
}

async function collectSketchProfileDiagnostics(
  boardlabContext: BoardLabContextImpl,
  doc: vscode.TextDocument
): Promise<vscode.Diagnostic[]> {
  const text = doc.getText()
  const astDiagnostics = validateProfilesYAML(text, doc)
  const cliDiagnostics = await collectCliDiagnostics(boardlabContext, doc, text)
  const allDiagnostics = [...astDiagnostics, ...cliDiagnostics]
  allDiagnostics.sort((left, right) => compareDiagnostics(doc, left, right))
  return allDiagnostics
}

function isUnresolvedTaskVariable(value: string): boolean {
  return /\$\{[^}]+\}/.test(value)
}

function profileDiagnosticSeverity(
  severity: vscode.DiagnosticSeverity | undefined
): 'error' | 'warning' | 'info' {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return 'error'
    case vscode.DiagnosticSeverity.Warning:
      return 'warning'
    default:
      return 'info'
  }
}

function formatProfileDiagnosticLine(
  filePath: string,
  diagnostic: vscode.Diagnostic
): string {
  const line = diagnostic.range.start.line + 1
  const column = diagnostic.range.start.character + 1
  const severity = profileDiagnosticSeverity(diagnostic.severity)
  const message = diagnostic.message.replace(/\r?\n/g, ' ')
  return `${filePath}:${line}:${column}: ${severity}: ${message}`
}

function compareDiagnostics(
  doc: vscode.TextDocument,
  left: vscode.Diagnostic,
  right: vscode.Diagnostic
): number {
  const leftSeverity = left.severity ?? vscode.DiagnosticSeverity.Information
  const rightSeverity = right.severity ?? vscode.DiagnosticSeverity.Information
  if (leftSeverity !== rightSeverity) {
    return leftSeverity - rightSeverity
  }
  const leftOffset = doc.offsetAt(left.range.start)
  const rightOffset = doc.offsetAt(right.range.start)
  if (leftOffset !== rightOffset) {
    return leftOffset - rightOffset
  }
  return left.message.localeCompare(right.message)
}

export function isMissingProfilesFileError(error: unknown): boolean {
  // Node.js
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
    return true
  }

  // VS Code error when opening missing resources as text document
  if (error instanceof Error && error.name === 'CodeExpectedError') {
    const text = `${error.message}\n${error.stack ?? ''}`.toLowerCase()
    if (text.includes('cannot open') || text.includes('nonexistent file')) {
      return true
    }
  }

  return false
}
