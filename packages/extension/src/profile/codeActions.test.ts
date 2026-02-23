import * as vscode from 'vscode'
import { describe, expect, it } from 'vitest'

import { ProfilesCodeActionProvider } from './codeActions'

describe('ProfilesCodeActionProvider', () => {
  it('returns a single quick fix for missingPlatform diagnostics', async () => {
    const provider = new ProfilesCodeActionProvider(
      createLibrariesManager(),
      createPlatformsManager()
    )
    const document = createDocument()
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, 1),
      "Platform 'Test Platform' [test:arch] is not installed",
      vscode.DiagnosticSeverity.Warning
    )
    diagnostic.code = 'missingPlatform'

    const actions = await provider.provideCodeActions(
      document,
      new vscode.Range(0, 0, 0, 1),
      {
        diagnostics: [diagnostic],
        only: undefined,
        triggerKind: 1,
      } as unknown as vscode.CodeActionContext
    )

    expect(actions).toHaveLength(1)
    expect((actions[0] as vscode.CodeAction).title).toBe(
      "Install platform 'Test Platform'"
    )
  })

  it('does not duplicate multi-action invalidLibraryVersion quick fixes', async () => {
    const provider = new ProfilesCodeActionProvider(
      createLibrariesManager({
        lookupLibraryQuick: async () => ({
          label: 'DemoLib',
          availableVersions: ['2.0.0'],
          installedVersion: '2.0.0',
        }),
      }),
      createPlatformsManager()
    )
    const document = createDocument()
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, 1),
      "Library 'DemoLib' has no release '1.0.0'",
      vscode.DiagnosticSeverity.Error
    )
    diagnostic.code = 'invalidLibraryVersion'

    const actions = await provider.provideCodeActions(
      document,
      new vscode.Range(0, 0, 0, 1),
      {
        diagnostics: [diagnostic],
        only: undefined,
        triggerKind: 1,
      } as unknown as vscode.CodeActionContext
    )
    const titles = actions.map((action) => (action as vscode.CodeAction).title)

    expect(actions).toHaveLength(2)
    expect(new Set(titles).size).toBe(2)
    expect(titles).toEqual([
      "Use installed library 'DemoLib' (2.0.0) in profile",
      "Select a version for library 'DemoLib'",
    ])
  })
})

function createDocument(): vscode.TextDocument {
  return {
    uri: vscode.Uri.file('/workspace/sketch.yaml'),
  } as vscode.TextDocument
}

function createPlatformsManager(
  overrides: {
    lookupPlatformQuick?: (id: string) => Promise<
      | {
          label?: string
          availableVersions: string[]
          installedVersion?: string
        }
      | undefined
    >
  } = {}
): any {
  return {
    lookupPlatformQuick: async () => undefined,
    ...overrides,
  }
}

function createLibrariesManager(
  overrides: {
    lookupLibraryQuick?: (name: string) => Promise<
      | {
          label?: string
          availableVersions: string[]
          installedVersion?: string
        }
      | undefined
    >
  } = {}
): any {
  return {
    lookupLibraryQuick: async () => undefined,
    ...overrides,
  }
}
