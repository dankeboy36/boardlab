import * as vscode from 'vscode'

import type { LibrariesManager, PlatformsManager } from '../resourcesManager'
import { buildClearPlatformVersionsEdit } from './quickFixes'

const CLEAR_PLATFORMS_CODE = 'boardlab.profiles.clearPlatformVersions'
const MISSING_PLATFORM_CODE = 'missingPlatform'
const MISSING_PLATFORM_VERSION_CODE = 'missingPlatformVersion'
const MISSING_PLATFORM_INDEX_CODE = 'missingPlatformIndexUrl'
const MISSING_LIBRARY_CODE = 'missingLibrary'
const INVALID_PLATFORM_VERSION_CODE = 'invalidPlatformVersion'
const INVALID_LIBRARY_VERSION_CODE = 'invalidLibraryVersion'
const INVALID_LIBRARY_DIRECTIVE_CODE = 'invalidLibraryDirective'

export type ProfilesQuickFixPlan =
  | {
      kind: 'edit'
      title: string
      edit: vscode.WorkspaceEdit
    }
  | {
      kind: 'command'
      title: string
      command: string
      args?: any[]
    }

export async function computeProfilesQuickFixPlans(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic,
  librariesManager: LibrariesManager,
  platformsManager: PlatformsManager
): Promise<ProfilesQuickFixPlan[]> {
  const plans: ProfilesQuickFixPlan[] = []
  const rawCode = diagnostic.code
  const code = typeof rawCode === 'string' ? rawCode.trim() : undefined
  if (!code) return plans

  if (code.startsWith(CLEAR_PLATFORMS_CODE)) {
    const profileName =
      code.length > CLEAR_PLATFORMS_CODE.length + 1
        ? code.slice(CLEAR_PLATFORMS_CODE.length + 1)
        : undefined
    const edit = await buildClearPlatformVersionsEdit(
      document,
      profileName ?? ''
    )
    if (!edit) return plans
    plans.push({
      kind: 'edit',
      title: 'Clear platform versions in profile',
      edit,
    })
    return plans
  }

  if (code === MISSING_PLATFORM_CODE) {
    const match = diagnostic.message.match(
      /Platform '(.+?)' \[(.+?)\] is not installed/
    )
    if (!match) return plans
    const label = match[1]
    const id = match[2]
    const title = `Install platform '${label}'`
    plans.push({
      kind: 'command',
      title,
      command: 'boardlab.profiles.installPlatform',
      args: [{ id }],
    })
    return plans
  }

  if (code === MISSING_PLATFORM_VERSION_CODE) {
    const mismatchMatch = diagnostic.message.match(
      /Platform '(.+?)' \[(.+?)\] installed '(.+?)' but profile requires '(.+?)'/
    )
    const missingMatch = diagnostic.message.match(
      /Platform '(.+?)' \[(.+?)\] version '(.+?)' is not installed/
    )
    let label: string | undefined
    let id: string | undefined
    let installed: string | undefined
    let requested: string | undefined
    if (mismatchMatch) {
      label = mismatchMatch[1]
      id = mismatchMatch[2]
      installed = mismatchMatch[3]
      requested = mismatchMatch[4]
    } else if (missingMatch) {
      label = missingMatch[1]
      id = missingMatch[2]
      requested = missingMatch[3]
    }
    if (!label || !id || !requested) return plans

    const installTitle = `Install platform '${label}' (${requested})`
    plans.push({
      kind: 'command',
      title: installTitle,
      command: 'boardlab.profiles.installPlatform',
      args: [{ id, version: requested }],
    })

    if (installed && installed !== requested) {
      const switchTitle = `Use installed platform version '${label}' (${installed}) in profile`
      const newValue = `${id} (${installed})`
      const edit = new vscode.WorkspaceEdit()
      edit.replace(document.uri, diagnostic.range, newValue)
      plans.push({
        kind: 'edit',
        title: switchTitle,
        edit,
      })
    }
    return plans
  }

  if (code === MISSING_PLATFORM_INDEX_CODE) {
    const urlMatch = diagnostic.message.match(/platform_index_url:\s*(\S+)/)
    const url = urlMatch ? urlMatch[1] : undefined
    if (!url) return plans
    const title = 'Add platform index URL to Arduino CLI config'
    plans.push({
      kind: 'command',
      title,
      command: 'boardlab.addAdditionalPackageIndexUrlToArduinoCliConfig',
      args: [{ url }],
    })
    return plans
  }

  if (code === MISSING_LIBRARY_CODE) {
    const headerMatch = diagnostic.message.match(/Library '(.+?)'/)
    if (!headerMatch) return plans
    const label = headerMatch[1]
    const name = label
    let version: string | undefined
    let installed: string | undefined
    const missingMatch = diagnostic.message.match(
      /version '(.+?)' is not installed/
    )
    const requiresMatch = diagnostic.message.match(/profile requires '(.+?)'/)
    const mismatchMatch = diagnostic.message.match(
      /installed '(.+?)' but profile requires '(.+?)'/
    )
    if (mismatchMatch) {
      installed = mismatchMatch[1]
      version = mismatchMatch[2]
    } else if (missingMatch) {
      version = missingMatch[1]
    } else if (requiresMatch) {
      version = requiresMatch[1]
    }
    if (missingMatch) {
      version = missingMatch[1]
    } else if (requiresMatch) {
      version = requiresMatch[1]
    }

    const title = version
      ? `Install library '${label}' (${version})`
      : `Install library '${label}'`
    plans.push({
      kind: 'command',
      title,
      command: 'boardlab.profiles.installLibrary',
      args: [{ id: name, version }],
    })

    if (installed && version && installed !== version) {
      const switchTitle = `Use installed library '${label}' (${installed}) in profile'`
      const newValue = `${label} (${installed})`
      const edit = new vscode.WorkspaceEdit()
      edit.replace(document.uri, diagnostic.range, newValue)
      plans.push({
        kind: 'edit',
        title: switchTitle,
        edit,
      })
    }
    return plans
  }

  if (code === INVALID_PLATFORM_VERSION_CODE) {
    const match = diagnostic.message.match(
      /Platform '(.+?)' has no release '(.+?)'/
    )
    if (!match) return plans
    const id = match[1]
    let quickInfo
    try {
      quickInfo = await platformsManager.lookupPlatformQuick(id)
    } catch {
      quickInfo = undefined
    }
    const available = quickInfo?.availableVersions ?? []
    const installed = quickInfo?.installedVersion
    const label = quickInfo?.label ?? id
    if (!available.length) return plans

    if (installed) {
      const switchTitle = `Use installed platform '${label}' (${installed}) in profile`
      const newValue = `${id} (${installed})`
      const edit = new vscode.WorkspaceEdit()
      edit.replace(document.uri, diagnostic.range, newValue)
      plans.push({
        kind: 'edit',
        title: switchTitle,
        edit,
      })
    }

    const latest = available[0]
    if (latest && latest !== installed) {
      const latestTitle = `Use latest platform '${label}' (${latest}) in profile`
      const newValue = `${id} (${latest})`
      const edit = new vscode.WorkspaceEdit()
      edit.replace(document.uri, diagnostic.range, newValue)
      plans.push({
        kind: 'edit',
        title: latestTitle,
        edit,
      })
    }

    const pickTitle = `Select a version for platform '${label}'`
    plans.push({
      kind: 'command',
      title: pickTitle,
      command: 'boardlab.profiles.selectPlatformVersionForProfile',
      args: [
        {
          uri: document.uri.toString(),
          range: diagnostic.range,
          platform: id,
        },
      ],
    })
    return plans
  }

  if (code === INVALID_LIBRARY_VERSION_CODE) {
    const headerMatch = diagnostic.message.match(/Library '(.+?)'/)
    const versionMatch = diagnostic.message.match(/has no release '(.+?)'/)
    if (!headerMatch || !versionMatch) return plans
    const name = headerMatch[1]

    let quickInfo
    try {
      quickInfo = await librariesManager.lookupLibraryQuick(name)
    } catch {
      quickInfo = undefined
    }
    const available = quickInfo?.availableVersions ?? []
    const installed = quickInfo?.installedVersion
    const label = quickInfo?.label ?? name
    if (!available.length) return plans

    if (installed) {
      const switchTitle = `Use installed library '${label}' (${installed}) in profile`
      const newValue = `${label} (${installed})`
      const edit = new vscode.WorkspaceEdit()
      edit.replace(document.uri, diagnostic.range, newValue)
      plans.push({
        kind: 'edit',
        title: switchTitle,
        edit,
      })
    }

    const latest = available[0]
    if (latest && latest !== installed) {
      const latestTitle = `Use latest library '${label}' (${latest}) in profile`
      const newValue = `${label} (${latest})`
      const edit = new vscode.WorkspaceEdit()
      edit.replace(document.uri, diagnostic.range, newValue)
      plans.push({
        kind: 'edit',
        title: latestTitle,
        edit,
      })
    }

    const pickTitle = `Select a version for library '${label}'`
    plans.push({
      kind: 'command',
      title: pickTitle,
      command: 'boardlab.profiles.selectLibraryVersionForProfile',
      args: [
        {
          uri: document.uri.toString(),
          range: diagnostic.range,
          library: name,
        },
      ],
    })
    return plans
  }

  if (code === INVALID_LIBRARY_DIRECTIVE_CODE) {
    const invalidMatch = diagnostic.message.match(
      /^Invalid library directive: (.+)$/
    )
    if (!invalidMatch) return plans
    const rawName = invalidMatch[1].trim()

    let quickInfo
    try {
      quickInfo = await librariesManager.lookupLibraryQuick(rawName)
    } catch {
      quickInfo = undefined
    }
    const available = quickInfo?.availableVersions ?? []
    const installed = quickInfo?.installedVersion
    const label = quickInfo?.label ?? rawName
    if (!available.length) return plans

    if (installed) {
      const switchTitle = `Use installed library '${label}' (${installed}) in profile`
      const newValue = `${label} (${installed})`
      const edit = new vscode.WorkspaceEdit()
      edit.replace(document.uri, diagnostic.range, newValue)
      plans.push({
        kind: 'edit',
        title: switchTitle,
        edit,
      })
    }

    const latest = available[0]
    if (latest && latest !== installed) {
      const latestTitle = `Use latest library '${label}' (${latest}) in profile`
      const newValue = `${label} (${latest})`
      const edit = new vscode.WorkspaceEdit()
      edit.replace(document.uri, diagnostic.range, newValue)
      plans.push({
        kind: 'edit',
        title: latestTitle,
        edit,
      })
    }

    const pickTitle = `Select a version for library '${label}'`
    plans.push({
      kind: 'command',
      title: pickTitle,
      command: 'boardlab.profiles.selectLibraryVersionForProfile',
      args: [
        {
          uri: document.uri.toString(),
          range: diagnostic.range,
          library: rawName,
        },
      ],
    })
    return plans
  }

  return plans
}

export class ProfilesCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix]

  constructor(
    private readonly librariesManager: LibrariesManager,
    private readonly platformsManager: PlatformsManager
  ) {}

  async provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext
  ): Promise<(vscode.CodeAction | vscode.Command)[]> {
    const actions: vscode.CodeAction[] = []

    for (const diagnostic of context.diagnostics) {
      const rawCode = diagnostic.code
      const code = typeof rawCode === 'string' ? rawCode.trim() : undefined
      const plans = await computeProfilesQuickFixPlans(
        document,
        diagnostic,
        this.librariesManager,
        this.platformsManager
      )
      for (const plan of plans) {
        if (plan.kind === 'edit') {
          const action = new vscode.CodeAction(
            plan.title,
            vscode.CodeActionKind.QuickFix
          )
          action.edit = plan.edit
          action.diagnostics = [diagnostic]
          if (code?.startsWith(CLEAR_PLATFORMS_CODE)) {
            action.isPreferred = true
          }
          actions.push(action)
        } else {
          const action = new vscode.CodeAction(
            plan.title,
            vscode.CodeActionKind.QuickFix
          )
          action.command = {
            command: plan.command,
            title: plan.title,
            arguments: plan.args,
          }
          action.diagnostics = [diagnostic]
          actions.push(action)
        }
      }
    }

    return actions
  }
}
