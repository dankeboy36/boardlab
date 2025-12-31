import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import * as vscode from 'vscode'

const CANDIDATES = [
  'README.md',
  'README.markdown',
  'README.mdown',
  'README.adoc',
  'README.asciidoc',
  'README.txt',
  'Readme.md',
  'ReadMe.md',
  'readme.md',
  'readme.markdown',
  'readme.mdown',
  'readme.adoc',
  'readme.asciidoc',
  'readme.txt',
]

export async function showLibraryReadme(
  libraryName: string,
  installDir: string
): Promise<void> {
  const file = await findReadme(installDir)
  if (!file) {
    vscode.window.showWarningMessage(
      `Could not find a README for ${libraryName} in ${installDir}`
    )
    return
  }

  const uri = vscode.Uri.file(file)
  const lower = file.toLowerCase()
  try {
    if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
      await vscode.commands.executeCommand('markdown.showPreview', uri)
    } else {
      const document = await vscode.workspace.openTextDocument(uri)
      await vscode.window.showTextDocument(document, {
        preview: true,
        preserveFocus: false,
      })
    }
  } catch (error) {
    vscode.window.showWarningMessage(
      `Failed to open README for ${libraryName}: ${String(error)}`
    )
  }
}

async function findReadme(root: string): Promise<string | undefined> {
  for (const candidate of CANDIDATES) {
    const abs = path.join(root, candidate)
    try {
      const stat = await fs.stat(abs)
      if (stat.isFile()) {
        return abs
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('Failed to check README candidate', abs, error)
      }
    }
  }
  return undefined
}
