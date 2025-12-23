import * as vscode from 'vscode'

import type { ArdunnoContextImpl } from '../ardunnoContext'
import { ProfilesEditorProvider } from '../editors/profilesEditor'
import { collectCliDiagnostics } from './cliDiagnostics'
import { validateProfilesYAML } from './validation'

function isSketchYaml(doc: vscode.TextDocument): boolean {
  try {
    const fsPath = doc.uri.fsPath || doc.fileName
    return !!fsPath && /(^|\/)sketch\.yaml$/i.test(fsPath)
  } catch {
    return false
  }
}

export function registerProfilesYamlValidation(
  context: vscode.ExtensionContext,
  profilesEditor: ProfilesEditorProvider,
  collection: vscode.DiagnosticCollection,
  ardunnoContext?: ArdunnoContextImpl
): vscode.Disposable {
  const validateDoc = (doc: vscode.TextDocument): void => {
    if (!isSketchYaml(doc)) return
    // If custom editor is open for this URI, let it manage diagnostics
    if (profilesEditor.isOpenForUri(doc.uri)) return
    const text = doc.getText()
    const baseDiagnostics = validateProfilesYAML(text, doc)
    collection.set(doc.uri, baseDiagnostics)
    if (ardunnoContext) {
      collectCliDiagnostics(ardunnoContext, doc, text).then(
        (cliDiags) => {
          if (!cliDiags) return
          collection.set(doc.uri, [...baseDiagnostics, ...cliDiags])
        },
        (err) => console.log(err)
      )
    }
  }

  const onOpen = vscode.workspace.onDidOpenTextDocument((doc) =>
    validateDoc(doc)
  )
  const onChange = vscode.workspace.onDidChangeTextDocument((e) =>
    validateDoc(e.document)
  )
  const onClose = vscode.workspace.onDidCloseTextDocument((doc) => {
    if (isSketchYaml(doc)) {
      collection.delete(doc.uri)
    }
  })

  // Validate any already-open text editors at activation
  for (const doc of vscode.workspace.textDocuments) {
    validateDoc(doc)
  }

  const disposable = vscode.Disposable.from(onOpen, onChange, onClose)
  context.subscriptions.push(disposable)
  return disposable
}
