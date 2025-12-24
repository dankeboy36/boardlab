import { randomUUID } from 'node:crypto'
import { TextEncoder } from 'node:util'

import {
  addLibrary,
  addPlatform,
  profilesAddPortConfig as addPortConfigRequest,
  createProfile,
  profilesCreateProfileInteractive as createProfileInteractiveRequest,
  deleteProfile,
  listProfiles,
  notifyProfilesActiveProfileChanged,
  notifyProfilesChanged,
  notifyProfilesDetectedPortsChanged,
  pickBoardForCreation,
  profilesPickBoard as pickBoardRequest,
  profilesApplyQuickFixById,
  profilesGetActiveProfile,
  profilesListDiagnostics,
  profilesListQuickFixes,
  profilesPickBoardConfigOptionForCreation,
  profilesPickLibrary,
  profilesPickLibraryForCreation,
  profilesPickLibraryVersion,
  profilesPickLibraryVersionForCreation,
  profilesPickPlatform,
  profilesPickPlatformForCreation,
  profilesPickPlatformIndexUrl,
  profilesPickPlatformVersion,
  profilesPickPlatformVersionForCreation,
  profilesPickPortConfigForCreation,
  profilesPickPortConfigValue,
  profilesPickPortConfigValueForCreation,
  profilesPickPortForCreation,
  profilesPickProgrammerForCreation,
  profilesRenameProfile,
  profilesRequestDetectedPorts,
  profilesResetBoardConfigOptionForCreation,
  profilesResolvePlatformName,
  profilesResolvePortConfigLabels,
  profilesRevealRange,
  profilesSetActiveProfile,
  removeLibrary,
  removePlatform,
  profilesRemovePortConfig as removePortConfigRequest,
  profilesResetBoardConfigOption as resetBoardConfigOptionRequest,
  profilesResolveBoardDetails as resolveBoardDetailsRequest,
  profilesSelectBoardConfigOption as selectBoardConfigOptionRequest,
  profilesSelectPort as selectPortRequest,
  selectProfile,
  profilesSelectProgrammer as selectProgrammerRequest,
  updateProfile,
  type BoardConfigOptionDescriptor,
  type BoardDescriptor,
  type CreateProfileParams,
  type DeleteProfileParams,
  type ModifyLibraryParams,
  type ModifyPlatformParams,
  type PickBoardConfigForCreationResult,
  type PickBoardForCreationParams,
  type PickPortConfigForCreationResult,
  type PickPortForCreationResult,
  type PickProgrammerForCreationResult,
  type PlatformNameInfo,
  type PortConfigLabels,
  type ProfileDescriptor,
  type ProfileLibraryDescriptor,
  type ProfilePlatformDescriptor,
  type ProfilesAddPortConfigParams,
  type ProfilesApplyQuickFixByIdParams,
  type ProfilesCreateProfileInteractiveParams,
  type ProfilesDocumentParams,
  type ProfilesDocumentState,
  type ProfilesListDiagnosticsParams,
  type ProfilesListQuickFixesParams,
  type ProfilesPickBoardConfigOptionForCreationParams,
  type ProfilesPickBoardParams,
  type ProfilesPickLibraryForCreationParams,
  type ProfilesPickLibraryParams,
  type ProfilesPickLibraryVersionForCreationParams,
  type ProfilesPickLibraryVersionParams,
  type ProfilesPickPlatformForCreationParams,
  type ProfilesPickPlatformIndexUrlParams,
  type ProfilesPickPlatformParams,
  type ProfilesPickPlatformVersionForCreationParams,
  type ProfilesPickPlatformVersionParams,
  type ProfilesPickPortConfigForCreationParams,
  type ProfilesPickPortConfigValueForCreationParams,
  type ProfilesPickPortConfigValueParams,
  type ProfilesPickPortForCreationParams,
  type ProfilesPickProgrammerForCreationParams,
  type ProfilesQuickFixDescriptor,
  type ProfilesRemovePortConfigParams,
  type ProfilesRenameProfileParams,
  type ProfilesResetBoardConfigOptionForCreationParams,
  type ProfilesResetBoardConfigOptionParams,
  type ProfilesResolveBoardDetailsParams,
  type ProfilesResolvePlatformNameParams,
  type ProfilesResolvePortConfigLabelsParams,
  type ProfilesRevealRangeParams,
  type ProfilesSelectBoardConfigOptionParams,
  type ProfilesSelectPortParams,
  type ProfilesSelectProgrammerParams,
  type ProfilesSetActiveParams,
  type ProfileDiagnostic as ProtocolProfileDiagnostic,
  type SelectProfileParams,
  type UpdateProfileParams,
} from '@boardlab/protocol'
import { MonitorPortSettingDescriptor } from 'ardunno-cli/api'
import { isBoardIdentifier, type Port } from 'boards-list'
import { FQBN } from 'fqbn'
import * as vscode from 'vscode'
import type {
  BoardDetails as ApiBoardDetails,
  ConfigOption as ApiConfigOption,
  ConfigValue as ApiConfigValue,
} from 'vscode-arduino-api'
import { Messenger } from 'vscode-messenger'
import type { WebviewIdMessageParticipant } from 'vscode-messenger-common'
import { parse, parseDocument, stringify } from 'yaml'

import type { BoardLabContextImpl } from '../boardlabContext'
import { ensureBoardDetails, PlatformNotInstalledError } from '../boards'
import { collectCliDiagnostics } from '../profile/cliDiagnostics'
import {
  computeProfilesQuickFixPlans,
  type ProfilesQuickFixPlan,
} from '../profile/codeActions'
import { findPairByPath, validateProfilesYAML } from '../profile/validation'
import { disposeAll, QuickInputNoopLabel } from '../utils'
import {
  getWebviewBuildRoot,
  getWebviewHtmlResources,
} from '../webviews/webviewAssets'

interface ProfilesEditorBinding {
  readonly document: vscode.TextDocument
  readonly panel: vscode.WebviewPanel
  readonly participant: WebviewIdMessageParticipant
}

type MutableProfilesDocument = Record<string, unknown> & {
  profiles?: Record<string, MutableProfile | undefined>
  default_profile?: string
  default_fqbn?: string
  default_protocol?: string
  default_port?: string
  default_programmer?: string
}

type MutableProfile = Record<string, unknown> & {
  fqbn?: string
  notes?: string
  programmer?: string
  port?: string
  protocol?: string
  port_config?: Record<string, string | number | boolean>
  platforms?: MutablePlatform[]
  libraries?: MutableLibrary[]
}

type MutablePlatform = Record<string, unknown> & {
  platform?: string
  platform_index_url?: string
}

type MutableLibrary = Record<string, unknown> & {
  library?: string
}

function parseProfilesText(text: string): MutableProfilesDocument {
  if (!text.trim()) {
    return {}
  }
  try {
    const parsedValue = parse(text)
    if (!parsedValue || typeof parsedValue !== 'object') {
      return {}
    }
    const document = parsedValue as MutableProfilesDocument
    if (document.profiles && typeof document.profiles !== 'object') {
      document.profiles = undefined
    }
    return document
  } catch (error) {
    console.error('Failed to parse profiles document', error)
    return {}
  }
}

function splitPlatformIdVersion(value: string): {
  id: string
  version?: string
} {
  const trimmed = value.trim()
  // Match: vendor:arch (version) or just vendor:arch
  const match = trimmed.match(/^([^()]+?)\s*(?:\(([^)]+)\))?\s*$/)
  if (match) {
    const id = match[1].trim()
    const version = match[2]?.trim()
    return { id, version }
  }
  return { id: trimmed }
}

function combinePlatformIdVersion(id: string, version?: string): string {
  return version && version.trim().length ? `${id} (${version.trim()})` : id
}

function splitLibraryNameVersion(value: string): {
  name: string
  version?: string
} {
  const trimmed = value.trim()
  const match = trimmed.match(/^([^()]+?)\s*(?:\(([^)]+)\))?\s*$/)
  if (match) {
    const name = match[1].trim()
    const version = match[2]?.trim()
    return { name, version }
  }
  return { name: trimmed }
}

function combineLibraryNameVersion(name: string, version?: string): string {
  return version && version.trim().length ? `${name} (${version.trim()})` : name
}

function toProfileDescriptor(
  name: string,
  profile: MutableProfile | undefined
): ProfileDescriptor {
  const fqbn =
    profile && typeof profile.fqbn === 'string' ? profile.fqbn : undefined
  const programmer =
    profile && typeof profile.programmer === 'string'
      ? profile.programmer
      : undefined
  const port =
    profile && typeof profile.port === 'string' ? profile.port : undefined
  const protocol =
    profile && typeof profile.protocol === 'string'
      ? profile.protocol
      : undefined
  let portConfig: Readonly<Record<string, string>> | undefined
  if (
    profile &&
    profile.port_config &&
    typeof profile.port_config === 'object'
  ) {
    const entries: [string, string][] = []
    for (const [key, value] of Object.entries(profile.port_config)) {
      if (key && typeof value === 'string') {
        entries.push([key, value])
      }
    }
    if (entries.length) {
      portConfig = Object.fromEntries(entries)
    }
  }
  const platforms: ProfilePlatformDescriptor[] = []
  if (profile && Array.isArray(profile.platforms)) {
    for (const item of profile.platforms as Array<unknown>) {
      if (typeof item === 'string') {
        const { id, version } = splitPlatformIdVersion(item)
        platforms.push({ platform: id, version })
        continue
      }
      if (item && typeof item === 'object') {
        const obj = item as { platform?: unknown; platform_index_url?: unknown }
        const platformField =
          typeof obj.platform === 'string' ? obj.platform : undefined
        if (platformField) {
          const { id, version } = splitPlatformIdVersion(platformField)
          const platformIndexUrl =
            typeof obj.platform_index_url === 'string'
              ? obj.platform_index_url
              : undefined
          platforms.push({ platform: id, version, platformIndexUrl })
        }
      }
    }
  }
  const libraries: ProfileLibraryDescriptor[] = []
  if (profile && Array.isArray(profile.libraries)) {
    for (const item of profile.libraries as Array<unknown>) {
      if (typeof item === 'string') {
        const { name, version } = splitLibraryNameVersion(item)
        libraries.push({ library: name, version })
        continue
      }
      if (item && typeof item === 'object') {
        const obj = item as { library?: unknown }
        const id = typeof obj.library === 'string' ? obj.library : undefined
        if (id) {
          libraries.push({ library: id })
        }
      }
    }
  }
  return {
    name,
    fqbn,
    programmer,
    port,
    protocol,
    note:
      profile &&
      typeof profile.notes === 'string' &&
      profile.notes.trim().length
        ? profile.notes
        : undefined,
    portConfig,
    platforms,
    libraries,
  }
}

function createMutableProfile(descriptor: ProfileDescriptor): MutableProfile {
  const profile: MutableProfile = {}
  if (descriptor.fqbn) {
    profile.fqbn = descriptor.fqbn
  }
  if (descriptor.programmer) {
    profile.programmer = descriptor.programmer
  }
  if (descriptor.port) {
    profile.port = descriptor.port
  }
  if (descriptor.protocol) {
    profile.protocol = descriptor.protocol
  }
  if (descriptor.note && descriptor.note.trim().length) {
    profile.notes = descriptor.note
  }
  if (descriptor.portConfig) {
    profile.port_config = { ...descriptor.portConfig }
  }
  if (descriptor.platforms.length) {
    // store platforms as mapping objects per spec; embed version in platform string
    profile.platforms = descriptor.platforms.map((platform) => ({
      platform: combinePlatformIdVersion(platform.platform, platform.version),
      platform_index_url: platform.platformIndexUrl,
    }))
  }
  if (descriptor.libraries.length) {
    // store as scalar list: Name (version)
    profile.libraries = descriptor.libraries.map((l) =>
      combineLibraryNameVersion(l.library, l.version)
    ) as any
  }
  return profile
}

export class ProfilesEditorProvider
  implements vscode.CustomTextEditorProvider, vscode.Disposable
{
  private readonly disposables: vscode.Disposable[] = []
  private readonly bindingsByPanel = new Map<
    vscode.WebviewPanel,
    ProfilesEditorBinding
  >()

  private readonly bindingsByUri = new Map<string, Set<ProfilesEditorBinding>>()

  private readonly documentByUri = new Map<string, vscode.TextDocument>()
  private lastActiveDocument: vscode.TextDocument | undefined
  private readonly diagnostics: vscode.DiagnosticCollection
  private readonly boardDetailsCache = new Map<string, ApiBoardDetails>()
  private readonly quickFixPlansById = new Map<string, ProfilesQuickFixPlan>()

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly messenger: Messenger,
    private readonly boardlabContext: BoardLabContextImpl,
    diagnostics?: vscode.DiagnosticCollection
  ) {
    this.diagnostics =
      diagnostics ??
      vscode.languages.createDiagnosticCollection('boardlabProfiles')
    this.disposables.push(this.diagnostics)
    this.disposables.push(
      messenger.onRequest(listProfiles, async (params) =>
        this.handleListProfiles(params)
      ),
      messenger.onRequest(profilesGetActiveProfile, async (params) =>
        this.handleGetActiveProfile(params)
      ),
      messenger.onRequest(createProfile, async (params) =>
        this.handleCreateProfile(params)
      ),
      messenger.onRequest(updateProfile, async (params) =>
        this.handleUpdateProfile(params)
      ),
      messenger.onRequest(deleteProfile, async (params) =>
        this.handleDeleteProfile(params)
      ),
      messenger.onRequest(selectProfile, async (params) =>
        this.handleSelectProfile(params)
      ),
      messenger.onRequest(addLibrary, async (params) =>
        this.handleAddLibrary(params)
      ),
      messenger.onRequest(removeLibrary, async (params) =>
        this.handleRemoveLibrary(params)
      ),
      messenger.onRequest(addPlatform, async (params) =>
        this.handleAddPlatform(params)
      ),
      messenger.onRequest(profilesPickPlatform, async (params) =>
        this.handlePickPlatform(params)
      ),
      messenger.onRequest(
        profilesPickPlatformForCreation,
        async (_params: ProfilesPickPlatformForCreationParams) =>
          this.handlePickPlatformForCreation()
      ),
      messenger.onRequest(profilesPickPlatformVersion, async (params) =>
        this.handlePickPlatformVersion(params)
      ),
      messenger.onRequest(
        profilesResolvePlatformName,
        async (
          params: ProfilesResolvePlatformNameParams
        ): Promise<PlatformNameInfo | undefined> =>
          this.handleResolvePlatformName(params)
      ),
      messenger.onRequest(
        profilesPickPlatformIndexUrl,
        async (params: ProfilesPickPlatformIndexUrlParams) =>
          this.handlePickPlatformIndexUrl(params)
      ),
      messenger.onRequest(
        profilesPickPlatformVersionForCreation,
        async (params: ProfilesPickPlatformVersionForCreationParams) =>
          this.handlePickPlatformVersionForCreation(params)
      ),
      messenger.onRequest(removePlatform, async (params) =>
        this.handleRemovePlatform(params)
      ),
      messenger.onRequest(profilesPickLibrary, async (params) =>
        this.handlePickLibrary(params)
      ),
      messenger.onRequest(profilesRenameProfile, async (params) =>
        this.handleRenameProfile(params)
      ),
      messenger.onRequest(
        profilesPickLibraryForCreation,
        async (_params: ProfilesPickLibraryForCreationParams) =>
          this.handlePickLibraryForCreation()
      ),
      messenger.onRequest(profilesPickLibraryVersion, async (params) =>
        this.handlePickLibraryVersion(params)
      ),
      messenger.onRequest(
        profilesPickLibraryVersionForCreation,
        async (params: ProfilesPickLibraryVersionForCreationParams) =>
          this.handlePickLibraryVersionForCreation(params)
      ),
      messenger.onRequest(resolveBoardDetailsRequest, async (params) =>
        this.handleResolveBoardDetails(params)
      ),
      messenger.onRequest(pickBoardRequest, async (params) =>
        this.handlePickBoard(params)
      ),
      messenger.onRequest(pickBoardForCreation, async (params) =>
        this.handlePickBoardForCreation(params)
      ),
      messenger.onRequest(selectBoardConfigOptionRequest, async (params) =>
        this.handleSelectBoardConfigOption(params)
      ),
      messenger.onRequest(
        profilesPickBoardConfigOptionForCreation,
        async (params: ProfilesPickBoardConfigOptionForCreationParams) =>
          this.handlePickBoardConfigOptionForCreation(params)
      ),
      messenger.onRequest(resetBoardConfigOptionRequest, async (params) =>
        this.handleResetBoardConfigOption(params)
      ),
      messenger.onRequest(
        profilesResetBoardConfigOptionForCreation,
        async (params: ProfilesResetBoardConfigOptionForCreationParams) =>
          this.handleResetBoardConfigOptionForCreation(params)
      ),
      messenger.onRequest(selectProgrammerRequest, async (params) =>
        this.handleSelectProgrammer(params)
      ),
      messenger.onRequest(
        profilesPickProgrammerForCreation,
        async (params: ProfilesPickProgrammerForCreationParams) =>
          this.handlePickProgrammerForCreation(params)
      ),
      messenger.onRequest(selectPortRequest, async (params) =>
        this.handleSelectPort(params)
      ),
      messenger.onRequest(addPortConfigRequest, async (params) =>
        this.handleAddPortConfig(params)
      ),
      messenger.onRequest(removePortConfigRequest, async (params) =>
        this.handleRemovePortConfig(params)
      ),
      messenger.onRequest(
        profilesPickPortConfigForCreation,
        async (params: ProfilesPickPortConfigForCreationParams) =>
          this.handlePickPortConfigForCreation(params)
      ),
      messenger.onRequest(
        profilesPickPortConfigValueForCreation,
        async (params: ProfilesPickPortConfigValueForCreationParams) =>
          this.handlePickPortConfigValueForCreation(params)
      ),
      messenger.onRequest(
        profilesPickPortConfigValue,
        async (params: ProfilesPickPortConfigValueParams) =>
          this.handlePickPortConfigValue(params)
      ),
      messenger.onRequest(
        profilesResolvePortConfigLabels,
        async (
          params: ProfilesResolvePortConfigLabelsParams
        ): Promise<PortConfigLabels> =>
          this.handleResolvePortConfigLabels(params)
      ),
      messenger.onRequest(
        profilesPickPortForCreation,
        async (_params: ProfilesPickPortForCreationParams) =>
          this.handlePickPortForCreation()
      ),
      messenger.onRequest(
        profilesRequestDetectedPorts,
        async () => this.boardlabContext.boardsListWatcher.detectedPorts
      ),
      messenger.onRequest(
        profilesListQuickFixes,
        async (params: ProfilesListQuickFixesParams) =>
          this.handleListQuickFixes(params)
      ),
      messenger.onRequest(
        profilesApplyQuickFixById,
        async (params: ProfilesApplyQuickFixByIdParams) =>
          this.handleApplyQuickFixById(params)
      ),
      messenger.onRequest(
        profilesListDiagnostics,
        async (params: ProfilesListDiagnosticsParams) =>
          this.handleListDiagnostics(params)
      ),
      messenger.onRequest(
        profilesRevealRange,
        async (params: ProfilesRevealRangeParams) =>
          this.handleRevealRange(params)
      ),
      messenger.onRequest(createProfileInteractiveRequest, async (params) =>
        this.handleCreateProfileInteractive(params)
      ),
      messenger.onRequest(profilesSetActiveProfile, async (params) =>
        this.handleSetActiveProfile(params)
      )
    )

    this.disposables.push(
      this.boardlabContext.boardsListWatcher.onDidChangeDetectedPorts((ports) =>
        this.broadcastDetectedPorts(ports)
      ),
      vscode.workspace.onDidChangeTextDocument((event) => {
        const uriKey = event.document.uri.toString()
        if (!this.bindingsByUri.has(uriKey)) {
          return
        }
        this.publishState(event.document)
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        const uriKey = document.uri.toString()
        if (!this.bindingsByUri.has(uriKey)) {
          this.documentByUri.delete(uriKey)
          this.diagnostics.delete(document.uri)
        }
      })
    )
  }

  dispose(): void {
    while (this.disposables.length) {
      try {
        this.disposables.pop()?.dispose()
      } catch (error) {
        console.error('Failed to dispose profiles editor resource', error)
      }
    }
    this.bindingsByPanel.clear()
    this.bindingsByUri.clear()
    this.documentByUri.clear()
  }

  private async handleGetActiveProfile(
    params: ProfilesDocumentParams
  ): Promise<string | undefined> {
    try {
      const name = this.boardlabContext.getActiveProfileForUri(params.uri)
      if (!name) return undefined
      // Validate against current document; treat missing as undefined
      const document = await this.ensureDocument(params.uri)
      if (!document) return undefined
      const parsed = parseProfilesText(document.getText())
      const container = parsed?.profiles ?? {}
      return container && typeof container[name] !== 'undefined'
        ? name
        : undefined
    } catch {
      return undefined
    }
  }

  private async handleSetActiveProfile(
    params: ProfilesSetActiveParams
  ): Promise<void> {
    const uri = params.uri
    const name = params.name ?? undefined
    await this.boardlabContext.setActiveProfileForUri(uri, name)
    try {
      this.broadcastActiveProfileChange(uri, name)
    } catch (err) {
      console.warn('Failed to broadcast active profile change', err)
    }
  }

  private broadcastActiveProfileChange(uri: string, name?: string): void {
    const bindings = this.bindingsByUri.get(uri)
    if (!bindings || !bindings.size) return
    bindings.forEach((binding) => {
      try {
        this.messenger.sendNotification(
          notifyProfilesActiveProfileChanged,
          binding.participant,
          { uri, name }
        )
      } catch (err) {
        console.error('Failed to send active profile changed notification', err)
      }
    })
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const webview = panel.webview
    const uriKey = document.uri.toString()

    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(
          this.extensionUri,
          'packages',
          'webviews',
          'profiles',
          'out'
        ),
        vscode.Uri.joinPath(this.extensionUri, 'out'),
      ],
    }

    const initialState = this.computeDocumentState(document)
    const html = this.renderHtml(webview, document, initialState)

    const participant = this.messenger.registerWebviewPanel(panel)

    const binding: ProfilesEditorBinding = {
      document,
      panel,
      participant,
    }
    this.bindingsByPanel.set(panel, binding)
    let bindingsForUri = this.bindingsByUri.get(uriKey)
    if (!bindingsForUri) {
      bindingsForUri = new Set()
      this.bindingsByUri.set(uriKey, bindingsForUri)
    }
    bindingsForUri.add(binding)
    this.documentByUri.set(uriKey, document)
    this.updateDiagnostics(document, document.getText(), initialState.profiles)

    panel.webview.html = html

    panel.onDidDispose(() => {
      this.disposePanel(panel)
    })

    panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.active) {
        this.lastActiveDocument = document
      }
    })
  }

  private disposePanel(panel: vscode.WebviewPanel): void {
    const binding = this.bindingsByPanel.get(panel)
    if (!binding) {
      return
    }
    const uriKey = binding.document.uri.toString()
    this.bindingsByPanel.delete(panel)
    const bindingsForUri = this.bindingsByUri.get(uriKey)
    if (bindingsForUri) {
      bindingsForUri.delete(binding)
      if (!bindingsForUri.size) {
        this.bindingsByUri.delete(uriKey)
        this.documentByUri.delete(uriKey)
      }
    }
  }

  /** Returns true if a custom Profiles editor is currently open for the URI. */
  public isOpenForUri(uri: vscode.Uri | string): boolean {
    const key = typeof uri === 'string' ? uri : uri.toString()
    return this.bindingsByUri.has(key)
  }

  private broadcastDetectedPorts(
    ports: import('boards-list').DetectedPorts
  ): void {
    // Push to all open profiles webviews
    for (const binding of this.bindingsByPanel.values()) {
      try {
        this.messenger.sendNotification(
          notifyProfilesDetectedPortsChanged,
          binding.participant,
          ports
        )
      } catch (error) {
        console.error('Failed to push detected ports to profiles view', error)
      }
    }
  }

  private renderHtml(
    webview: vscode.Webview,
    document: vscode.TextDocument,
    state: ProfilesDocumentState
  ): string {
    const buildRoot = getWebviewBuildRoot('profiles')
    const { stylesUri, scriptUri, codiconFontUri, nonce } =
      getWebviewHtmlResources(webview, this.extensionUri, buildRoot)
    const bootstrap = {
      uri: document.uri.toString(),
      snapshot: state,
    }
    const bootstrapScript = `window.__INITIAL_VSCODE_STATE__ = ${JSON.stringify(bootstrap).replace(/</g, '\\u003c')};`
    return /* html */ `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width,initial-scale=1">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; style-src ${webview.cspSource} 'nonce-${nonce}'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}'; connect-src ${webview.cspSource} https: http: ws: wss:;">
          <link rel="stylesheet" type="text/css" href="${stylesUri}">
          <style nonce="${nonce}">
            @font-face {
              font-family: "codicon";
              font-display: block;
              src: url("${codiconFontUri}") format("truetype");
            }
          </style>
        </head>
        <body>
          <div id="root"></div>
          <script nonce="${nonce}">
            window.__CSP_NONCE__ = '${nonce}';
            ${bootstrapScript}
          </script>
          <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
        </body>
      </html>
    `
  }

  private getExistingDocument(uri: string): vscode.TextDocument | undefined {
    const existing = this.documentByUri.get(uri)
    if (existing) {
      return existing
    }
    const match = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.toString() === uri
    )
    if (match) {
      this.documentByUri.set(uri, match)
      return match
    }
    return undefined
  }

  private async ensureDocument(
    uri: string,
    options: { createIfMissing?: boolean } = {}
  ): Promise<vscode.TextDocument | undefined> {
    const existing = this.getExistingDocument(uri)
    if (existing) {
      return existing
    }

    const targetUri = vscode.Uri.parse(uri)
    try {
      const document = await vscode.workspace.openTextDocument(targetUri)
      this.documentByUri.set(uri, document)
      return document
    } catch (error) {
      const shouldCreate =
        Boolean(options.createIfMissing) &&
        (error instanceof vscode.FileSystemError ||
          String(error).includes('Unable to resolve nonexistent file'))

      if (!shouldCreate) {
        if (error) {
          console.warn('Failed to open profiles document', {
            uri,
            error,
          })
        }
        return undefined
      }

      try {
        await vscode.workspace.fs.writeFile(
          targetUri,
          new TextEncoder().encode('')
        )
        const document = await vscode.workspace.openTextDocument(targetUri)
        this.documentByUri.set(uri, document)
        return document
      } catch (createError) {
        console.error('Failed to create profiles document', {
          uri,
          error: createError,
        })
        return undefined
      }
    }
  }

  private computeDocumentState(
    document: vscode.TextDocument
  ): ProfilesDocumentState {
    const text = document.getText()
    const profiles = parseProfilesText(text)
    const entries = profiles.profiles ?? {}
    const descriptors = Object.entries(entries).map(([name, profile]) =>
      toProfileDescriptor(name, profile)
    )
    const defaultProfileName =
      typeof profiles.default_profile === 'string'
        ? profiles.default_profile
        : undefined
    const selectedProfile =
      defaultProfileName &&
      Object.prototype.hasOwnProperty.call(entries, defaultProfileName)
        ? defaultProfileName
        : undefined
    return {
      profiles: descriptors,
      selectedProfile,
      hasDocument: Boolean(text.trim()),
    }
  }

  private updateDiagnostics(
    document: vscode.TextDocument,
    text: string,
    _descriptors: readonly ProfileDescriptor[]
  ): void {
    const diagnostics = validateProfilesYAML(text, document)
    // Enrich with CLI diagnostics to match plain-text validation behavior
    collectCliDiagnostics(this.boardlabContext, document, text)
      .then((cli) => {
        const all = cli && cli.length ? [...diagnostics, ...cli] : diagnostics
        this.diagnostics.set(document.uri, all)
      })
      .catch(() => this.diagnostics.set(document.uri, diagnostics))
  }

  private async handleListDiagnostics(
    params: ProfilesListDiagnosticsParams
  ): Promise<readonly ProtocolProfileDiagnostic[]> {
    const document = await this.ensureDocument(params.uri)
    if (!document) return []
    const text = document.getText()
    // Compute AST diagnostics immediately and enrich with CLI diagnostics to
    // avoid reliance on background DiagnosticCollection timing.
    const ast = validateProfilesYAML(text, document)
    let cli: vscode.Diagnostic[] = []
    try {
      cli = await collectCliDiagnostics(this.boardlabContext, document, text)
    } catch {}
    const all = [...ast, ...cli]
    const wantProfile = params.profile?.trim()
    if (!wantProfile) {
      return all.map((d) => this.toProtocolDiagnostic(d))
    }
    // Scope diagnostics to the selected profile subtree by offset
    const ydoc = parseDocument(text, { logLevel: 'silent' as any }) as any
    const container = findPairByPath(ydoc, ['profiles'])?.value
    const items = Array.isArray(container?.items) ? container.items : []
    const profilePair = items.find(
      (p: any) => String(p?.key?.value ?? '') === wantProfile
    )
    if (!profilePair || !profilePair.value?.range) {
      return []
    }
    const [start, , end] = profilePair.value.range as [number, number, number]
    const startOffset = typeof start === 'number' ? start : 0
    const endOffset = typeof end === 'number' ? end : startOffset
    const filtered = all.filter((d) => {
      if (!d.range) {
        return false
      }
      const diagStart = document.offsetAt(d.range.start)
      const diagEnd = document.offsetAt(d.range.end)
      return diagStart >= startOffset && diagEnd <= endOffset
    })
    return filtered.map((d) => this.toProtocolDiagnostic(d))
  }

  private async handleListQuickFixes(
    params: ProfilesListQuickFixesParams
  ): Promise<readonly ProfilesQuickFixDescriptor[]> {
    const document = await this.ensureDocument(params.uri)
    if (!document) return []

    const text = document.getText()
    const astDiagnostics = validateProfilesYAML(text, document)
    let cliDiagnostics: vscode.Diagnostic[] = []
    try {
      cliDiagnostics = await collectCliDiagnostics(
        this.boardlabContext,
        document,
        text
      )
    } catch {
      cliDiagnostics = []
    }
    const allDiagnostics = [...astDiagnostics, ...cliDiagnostics]

    const targetRange = new vscode.Range(
      params.range.start.line,
      params.range.start.character,
      params.range.end.line,
      params.range.end.character
    )

    const diagnosticsAtRange = allDiagnostics.filter(
      (d) => d.range && d.range.intersection(targetRange)
    )

    this.quickFixPlansById.clear()
    const descriptors: ProfilesQuickFixDescriptor[] = []

    for (const diagnostic of diagnosticsAtRange) {
      const plans = await computeProfilesQuickFixPlans(
        document,
        diagnostic,
        this.boardlabContext.librariesManager,
        this.boardlabContext.platformsManager
      )
      if (!plans.length) continue

      plans.forEach((plan, index) => {
        const fixId = `${document.uri.toString()}:${diagnostic.range.start.line}:${diagnostic.range.start.character}:${index}:${randomUUID()}`
        this.quickFixPlansById.set(fixId, plan)
        if (plan.kind === 'edit') {
          descriptors.push({
            kind: 'edit',
            title: plan.title,
            fixId,
          })
        } else {
          descriptors.push({
            kind: 'command',
            title: plan.title,
            command: plan.command,
            args: plan.args,
            fixId,
          })
        }
      })
    }

    return descriptors
  }

  private async handleApplyQuickFixById(
    params: ProfilesApplyQuickFixByIdParams
  ): Promise<ProfilesDocumentState> {
    const document = await this.ensureDocument(params.uri, {
      createIfMissing: true,
    })
    if (!document) {
      return {
        profiles: [],
        selectedProfile: undefined,
        hasDocument: false,
      }
    }

    const plan = this.quickFixPlansById.get(params.fixId)
    if (!plan) {
      const state = this.computeDocumentState(document)
      this.publishState(document, state)
      return state
    }

    try {
      if (plan.kind === 'edit') {
        await vscode.workspace.applyEdit(plan.edit)
      } else {
        await vscode.commands.executeCommand(plan.command, ...(plan.args ?? []))
      }
    } catch (err) {
      console.error('Profiles: failed to apply quick fix by id', err)
    }

    const state = this.computeDocumentState(document)
    this.publishState(document, state)
    return state
  }

  private toProtocolDiagnostic(
    d: vscode.Diagnostic
  ): ProtocolProfileDiagnostic {
    const severityMap: Record<number, ProtocolProfileDiagnostic['severity']> = {
      [vscode.DiagnosticSeverity.Error]: 'error',
      [vscode.DiagnosticSeverity.Warning]: 'warning',
      [vscode.DiagnosticSeverity.Information]: 'information',
      [vscode.DiagnosticSeverity.Hint]: 'hint',
    }
    return {
      message: d.message,
      severity: severityMap[d.severity] ?? 'information',
      range: {
        start: {
          line: d.range.start.line,
          character: d.range.start.character,
        },
        end: { line: d.range.end.line, character: d.range.end.character },
      },
    }
  }

  private async handleRevealRange(
    params: ProfilesRevealRangeParams
  ): Promise<void> {
    const document = await this.ensureDocument(params.uri)
    if (!document) return
    try {
      const editor = await vscode.window.showTextDocument(document, {
        preview: false,
        selection: new vscode.Range(
          new vscode.Position(
            params.range.start.line,
            params.range.start.character
          ),
          new vscode.Position(params.range.end.line, params.range.end.character)
        ),
      })
      // Center the selection
      editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenter)
    } catch (err) {
      console.warn('Failed to reveal range in profiles document', err)
    }
  }

  private ensureProfilesContainer(
    profiles: MutableProfilesDocument
  ): Record<string, MutableProfile | undefined> {
    if (!profiles.profiles || typeof profiles.profiles !== 'object') {
      profiles.profiles = {}
    }
    return profiles.profiles
  }

  private getMutableProfileStrict(
    profiles: MutableProfilesDocument,
    profileName: string
  ): MutableProfile {
    const container = this.ensureProfilesContainer(profiles)
    const candidate = container[profileName]
    if (!candidate || typeof candidate !== 'object') {
      throw new Error(`Profile "${profileName}" not found`)
    }
    return candidate
  }

  private invalidateBoardCache(fqbn: string | undefined): void {
    if (!fqbn) {
      return
    }
    this.boardDetailsCache.delete(fqbn)
    try {
      const sanitized = new FQBN(fqbn).sanitize().toString()
      this.boardDetailsCache.delete(sanitized)
    } catch (error) {
      console.warn('Failed to sanitize FQBN while invalidating cache', {
        fqbn,
        error,
      })
    }
  }

  private async fetchBoardDetailsForFqbn(
    fqbn: string
  ): Promise<ApiBoardDetails | undefined> {
    let sanitizedFqbn = fqbn
    try {
      sanitizedFqbn = new FQBN(fqbn).toString(true)
    } catch (error) {
      console.warn('Failed to sanitize FQBN when fetching board details', {
        fqbn,
        error,
      })
    }
    const cached = this.boardDetailsCache.get(sanitizedFqbn)
    if (cached) {
      return cached
    }
    try {
      const { arduino } = await this.boardlabContext.client
      const details = await ensureBoardDetails(sanitizedFqbn, arduino)
      if (details) {
        this.boardDetailsCache.set(sanitizedFqbn, details)
      }
      return details
    } catch (err) {
      if (err instanceof PlatformNotInstalledError) {
        throw err
      }
      return undefined
    }
  }

  private async tryResolveBoardDescriptor(
    fqbn: string
  ): Promise<BoardDescriptor | undefined> {
    try {
      const details = await this.fetchBoardDetailsForFqbn(fqbn)
      if (!details) {
        return this.createFallbackBoardDescriptor(fqbn)
      }
      return this.toBoardDescriptor(fqbn, details)
    } catch (error) {
      if (error instanceof PlatformNotInstalledError) {
        return this.createFallbackBoardDescriptor(fqbn)
      }
      throw error
    }
  }

  private toBoardDescriptor(
    fqbn: string,
    details: ApiBoardDetails
  ): BoardDescriptor {
    const configOptions = this.toBoardConfigOptions(fqbn, details)
    const programmers: BoardDescriptor['programmers'] = (
      details.programmers ?? []
    ).map((programmer) => ({
      id: programmer.id,
      label: programmer.name,
      isDefault: programmer.id === details.defaultProgrammerId,
    }))
    let recommendedPlatforms: ProfilePlatformDescriptor[] = []
    try {
      const parsed = new FQBN(fqbn)
      recommendedPlatforms = [{ platform: `${parsed.vendor}:${parsed.arch}` }]
    } catch {}
    const recommendedLibraries: ProfileLibraryDescriptor[] = [
      { library: 'ArduinoBuiltins' },
    ]
    return {
      fqbn,
      label: details.name,
      configOptions,
      defaultProgrammerId: details.defaultProgrammerId,
      programmers,
      platformMissing: false,
      recommendedPlatforms,
      recommendedLibraries,
    }
  }

  private toBoardConfigOptions(
    fqbn: string,
    details: ApiBoardDetails
  ): readonly BoardConfigOptionDescriptor[] {
    let parsed: FQBN | undefined
    try {
      parsed = new FQBN(fqbn)
    } catch {
      parsed = undefined
    }
    const explicitSelections = parsed?.options ?? {}
    const defaultSelections = new Map<string, string>()
    for (const option of details.configOptions ?? []) {
      const selected = option.values.find((value) => value.selected)
      if (selected) {
        defaultSelections.set(option.option, selected.value)
      }
    }
    return (details.configOptions ?? []).map((option: ApiConfigOption) => {
      const values = option.values.map((value: ApiConfigValue) => {
        const isExplicit =
          explicitSelections[option.option] === value.value ||
          (explicitSelections[option.option] === undefined && value.selected)
        const isDefault = defaultSelections.get(option.option) === value.value
        return {
          value: value.value,
          valueLabel: value.valueLabel,
          isSelected: isExplicit,
          isDefault,
        }
      })
      const selectedEntry = values.find((value) => value.isSelected)
      const defaultEntry = values.find((value) => value.isDefault)
      return {
        option: option.option,
        optionLabel: option.optionLabel,
        selectedValue: selectedEntry?.value,
        selectedValueLabel: selectedEntry?.valueLabel,
        defaultValue: defaultEntry?.value,
        defaultValueLabel: defaultEntry?.valueLabel,
        values,
      }
    })
  }

  private createFallbackBoardDescriptor(fqbn: string): BoardDescriptor {
    let parsedOptions: Record<string, string> = {}
    try {
      parsedOptions = new FQBN(fqbn).options ?? {}
    } catch (error) {
      console.warn('Failed to parse FQBN for fallback descriptor', {
        fqbn,
        error,
      })
    }
    const configOptions: BoardConfigOptionDescriptor[] = Object.entries(
      parsedOptions
    ).map(([option, value]) => {
      const valueString = String(value)
      return {
        option,
        optionLabel: option,
        selectedValue: valueString,
        selectedValueLabel: valueString,
        defaultValue: undefined,
        defaultValueLabel: undefined,
        values: [
          {
            value: valueString,
            valueLabel: valueString,
            isSelected: true,
            isDefault: false,
          },
        ],
      }
    })
    let sanitizedLabel = fqbn
    try {
      sanitizedLabel = new FQBN(fqbn).sanitize().toString()
    } catch {}
    let recommendedPlatforms: ProfilePlatformDescriptor[] = []
    try {
      const parsed = new FQBN(fqbn)
      recommendedPlatforms = [{ platform: `${parsed.vendor}:${parsed.arch}` }]
    } catch {}
    return {
      fqbn,
      label: sanitizedLabel,
      configOptions,
      defaultProgrammerId: undefined,
      programmers: [],
      platformMissing: true,
      recommendedPlatforms,
      recommendedLibraries: [{ library: 'ArduinoBuiltins' }],
    }
  }

  private removeConfigOptionFromFqbn(fqbn: string, option: string): string {
    const parsed = new FQBN(fqbn)
    const { options = {} } = parsed
    const entries = Object.entries(options)
    if (!entries.some(([key]) => key === option)) {
      return fqbn
    }
    let updated = parsed.sanitize()
    for (const [key, value] of entries) {
      if (key === option) {
        continue
      }
      updated = updated.setConfigOption(key, value)
    }
    return updated.toString()
  }

  private async handleListProfiles(
    params: ProfilesDocumentParams
  ): Promise<ProfilesDocumentState> {
    const document = await this.ensureDocument(params.uri)
    if (!document) {
      return {
        profiles: [],
        selectedProfile: undefined,
        hasDocument: false,
      }
    }
    const state = this.computeDocumentState(document)
    this.updateDiagnostics(document, document.getText(), state.profiles)
    return state
  }

  private async handleCreateProfile(
    params: CreateProfileParams
  ): Promise<ProfilesDocumentState> {
    return this.updateDocument(params.uri, (_document, profiles) => {
      const container =
        profiles.profiles ||
        (profiles.profiles = {} as Record<string, MutableProfile | undefined>)
      container[params.profile.name] = createMutableProfile(params.profile)
      if (params.makeDefault) {
        profiles.default_profile = params.profile.name
      }
    })
  }

  private async handleUpdateProfile(
    params: UpdateProfileParams
  ): Promise<ProfilesDocumentState> {
    return this.updateDocument(params.uri, (_document, profiles) => {
      const container = profiles.profiles
      if (!container) {
        throw new Error('No profiles available to update')
      }
      const current = container[params.name]
      if (!current) {
        throw new Error(`Profile "${params.name}" not found`)
      }
      const patch = params.patch
      if (Object.prototype.hasOwnProperty.call(patch, 'fqbn')) {
        const previousFqbn =
          typeof current.fqbn === 'string' ? current.fqbn : undefined
        if (patch.fqbn) {
          current.fqbn = patch.fqbn
        } else {
          delete current.fqbn
        }
        this.invalidateBoardCache(previousFqbn)
        this.invalidateBoardCache(patch.fqbn)
      }
      if (patch.platforms) {
        current.platforms = patch.platforms.map((platform) => ({
          platform: combinePlatformIdVersion(
            platform.platform,
            platform.version
          ),
          platform_index_url: platform.platformIndexUrl,
        }))
      }
      if (patch.libraries) {
        current.libraries = patch.libraries.map((l) =>
          combineLibraryNameVersion(l.library, l.version)
        ) as any
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'programmer')) {
        if (patch.programmer) {
          current.programmer = patch.programmer
        } else {
          delete current.programmer
        }
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'port')) {
        if (patch.port) {
          current.port = patch.port
        } else {
          delete current.port
        }
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'protocol')) {
        if (patch.protocol) {
          current.protocol = patch.protocol
        } else {
          delete current.protocol
        }
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'note')) {
        const next = (patch as any).note as string | undefined
        if (next && next.trim().length) {
          current.notes = next
        } else {
          delete current.notes
        }
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'portConfig')) {
        if (patch.portConfig) {
          current.port_config = { ...patch.portConfig }
        } else {
          delete current.port_config
        }
      }
    })
  }

  private async handleDeleteProfile(
    params: DeleteProfileParams
  ): Promise<ProfilesDocumentState> {
    if (params.promptUser !== false) {
      const answer = await vscode.window.showInformationMessage(
        'Delete Profile',
        {
          modal: true,
          detail: `Are you sure you want to delete the ${params.name} profile?`,
        },
        'OK'
      )
      if (answer !== 'OK') {
        const document = await this.ensureDocument(params.uri)
        if (!document) {
          return {
            profiles: [],
            selectedProfile: undefined,
            hasDocument: false,
          }
        }
        return this.computeDocumentState(document)
      }
    }
    return this.updateDocument(params.uri, (_document, profiles) => {
      const container = profiles.profiles
      if (!container || !(params.name in container)) {
        throw new Error(`Profile "${params.name}" not found`)
      }
      delete container[params.name]
      if (profiles.default_profile === params.name) {
        delete profiles.default_profile
      }
    })
  }

  // minimal wrappers for context-menu commands
  async deleteProfileByCommand(params: DeleteProfileParams): Promise<void> {
    try {
      await this.handleDeleteProfile(params)
    } catch (err) {
      console.error('Profiles: deleteProfileByCommand failed', err)
    }
  }

  async selectProfileByCommand(params: SelectProfileParams): Promise<void> {
    try {
      await this.handleSelectProfile(params)
    } catch (err) {
      console.error('Profiles: selectProfileByCommand failed', err)
    }
  }

  async setActiveProfileByCommand(
    params: ProfilesSetActiveParams
  ): Promise<void> {
    try {
      await this.handleSetActiveProfile(params)
    } catch (err) {
      console.error('Profiles: setActiveProfileByCommand failed', err)
    }
  }

  private async handleSelectProfile(
    params: SelectProfileParams
  ): Promise<ProfilesDocumentState> {
    return this.updateDocument(params.uri, (_document, profiles) => {
      if (params.name) {
        profiles.default_profile = params.name
      } else {
        delete profiles.default_profile
      }
    })
  }

  private async handleAddLibrary(
    params: ModifyLibraryParams
  ): Promise<ProfilesDocumentState> {
    return this.updateDocument(params.uri, (_document, profiles) => {
      const container = profiles.profiles
      if (!container) {
        throw new Error('No profiles available')
      }
      const profile = container[params.profile]
      if (!profile) {
        throw new Error(`Profile "${params.profile}" not found`)
      }
      const libraryId = params.library.library
      if (!libraryId) {
        throw new Error('Library id is required')
      }
      const libraries = (profile.libraries || (profile.libraries = [])) as any[]
      const exists = libraries.some((entry) =>
        typeof entry === 'string'
          ? entry === libraryId
          : entry?.library === libraryId
      )
      if (!exists) {
        libraries.push(libraryId)
      }
    })
  }

  private async handlePickLibrary(
    params: ProfilesPickLibraryParams
  ): Promise<ProfilesDocumentState> {
    const toDispose: vscode.Disposable[] = []
    const input = vscode.window.createQuickPick<
      vscode.QuickPickItem & { value?: string }
    >()
    ;(input as any).sortByLabel = false
    ;(input as any).matchOnLabel = false
    input.matchOnDescription = false
    input.matchOnDetail = false
    input.placeholder = 'Search libraries by name or author'
    input.busy = false
    input.items = [new QuickInputNoopLabel('Type to search libraries…') as any]
    input.show()
    try {
      const selected = await new Promise<string | undefined>((resolve) => {
        const abort = new AbortController()
        const search = async (query: string) => {
          const trimmed = query.trim()
          if (!trimmed) {
            input.items = [
              new QuickInputNoopLabel('Type to search libraries…') as any,
            ]
            return
          }
          input.busy = true
          try {
            const client = await this.boardlabContext.client
            const results = await client.arduino.searchLibrary(
              { omitReleasesDetails: true, searchArgs: trimmed },
              abort.signal
            )
            // Case-sensitive name matching to allow distinct names that differ by case
            // For example, Debounce and debounce (hello Ubi :wave:)
            const exclude = new Set(params.exclude ?? [])
            const filtered = results.filter((lib) => !exclude.has(lib.name))
            input.items =
              filtered.length > 0
                ? filtered.map((lib) => ({
                    label: lib.name,
                    description: lib.latest?.author
                      ? `by ${lib.latest.author}`
                      : undefined,
                    detail: lib.latest?.sentence,
                    value: lib.name,
                    alwaysShow: true,
                  }))
                : [
                    new QuickInputNoopLabel(
                      `No results for "${trimmed}"`
                    ) as any,
                  ]
          } catch (err) {
            input.items = [
              new QuickInputNoopLabel('Search failed; try again.') as any,
            ]
          } finally {
            input.busy = false
          }
        }
        toDispose.push(
          input.onDidChangeValue((value) => search(value)),
          input.onDidHide(() => {
            resolve(undefined)
            input.dispose()
          }),
          input.onDidChangeSelection((items) => {
            const item = items[0]
            if (!item || item instanceof QuickInputNoopLabel) {
              return
            }
            resolve((item as any).value ?? item.label)
            input.hide()
          })
        )
      })
      if (!selected) {
        const document = await this.ensureDocument(params.uri)
        if (!document) {
          return {
            profiles: [],
            selectedProfile: undefined,
            hasDocument: false,
          }
        }
        return this.computeDocumentState(document)
      }
      // Resolve available versions for the selected library
      let versions: string[] = []
      try {
        const client = await this.boardlabContext.client
        const results = await client.arduino.searchLibrary(
          { searchArgs: selected },
          undefined
        )
        const match = results.find((l) => l.name === selected)
        if (match && (match as any).releases) {
          versions = Object.keys((match as any).releases)
            .filter(Boolean)
            .sort((a, b) => (a === b ? 0 : a < b ? 1 : -1))
        }
      } catch {}

      let chosenVersion: string | undefined = versions[0]
      if (versions.length) {
        const items: (vscode.QuickPickItem & { value?: string })[] =
          versions.map((v, i) => ({
            label: v,
            description: i === 0 ? 'Latest' : undefined,
            value: v,
          }))
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select library version',
        })
        chosenVersion = picked?.value || versions[0]
      }

      const library: ProfileLibraryDescriptor = {
        library: selected,
        version: chosenVersion,
      }
      return this.updateDocument(params.uri, (_document, profiles) => {
        const container = profiles.profiles
        if (!container) {
          throw new Error('No profiles available')
        }
        const profile = container[params.profile]
        if (!profile) {
          throw new Error(`Profile "${params.profile}" not found`)
        }
        const libraries = (profile.libraries ||
          (profile.libraries = [])) as any[]
        const idx = libraries.findIndex((entry) => {
          if (typeof entry === 'string') {
            const { name } = splitLibraryNameVersion(entry)
            return name === library.library
          }
          return entry?.library === library.library
        })
        const combined = combineLibraryNameVersion(
          library.library,
          library.version
        )
        if (idx >= 0) {
          libraries[idx] = combined
        } else {
          libraries.push(combined)
        }
      })
    } finally {
      disposeAll(...toDispose)
    }
  }

  private async handlePickLibraryForCreation(
    _params?: ProfilesPickLibraryForCreationParams
  ): Promise<ProfileLibraryDescriptor | undefined> {
    const toDispose: vscode.Disposable[] = []
    const input = vscode.window.createQuickPick<
      vscode.QuickPickItem & { value?: string }
    >()
    ;(input as any).sortByLabel = false
    ;(input as any).matchOnLabel = false
    input.matchOnDescription = false
    input.matchOnDetail = false
    input.placeholder = 'Search libraries by name'
    input.busy = false
    input.items = [new QuickInputNoopLabel('Type to search libraries…') as any]
    input.show()
    try {
      const selected = await new Promise<string | undefined>((resolve) => {
        const abort = new AbortController()
        const search = async (query: string) => {
          const trimmed = query.trim()
          if (!trimmed) {
            input.items = [
              new QuickInputNoopLabel('Type to search libraries…') as any,
            ]
            return
          }
          input.busy = true
          try {
            const client = await this.boardlabContext.client
            const results = await client.arduino.searchLibrary(
              { searchArgs: trimmed, omitReleasesDetails: true },
              abort.signal
            )
            input.items =
              results.length > 0
                ? results.map((lib) => ({
                    label: lib.name,
                    description: lib.latest?.author
                      ? `by ${lib.latest.author}`
                      : undefined,
                    detail: lib.latest?.sentence,
                    value: lib.name,
                    alwaysShow: true,
                  }))
                : [
                    new QuickInputNoopLabel(
                      `No results for "${trimmed}"`
                    ) as any,
                  ]
          } catch {
            input.items = [
              new QuickInputNoopLabel('Search failed; try again.') as any,
            ]
          } finally {
            input.busy = false
          }
        }
        toDispose.push(
          input.onDidChangeValue((value) => search(value)),
          input.onDidHide(() => {
            resolve(undefined)
            input.dispose()
          }),
          input.onDidChangeSelection((items) => {
            const item = items[0]
            if (!item || item instanceof QuickInputNoopLabel) return
            resolve((item as any).value ?? item.label)
            input.hide()
          })
        )
      })
      if (!selected) return undefined

      // versions
      let versions: string[] = []
      try {
        const client = await this.boardlabContext.client
        const results = await client.arduino.searchLibrary(
          { searchArgs: selected },
          undefined
        )
        const match = results.find((l) => l.name === selected)
        if (match && (match as any).releases) {
          versions = Object.keys((match as any).releases)
            .filter(Boolean)
            .sort((a, b) => (a === b ? 0 : a < b ? 1 : -1))
        }
      } catch {}
      let chosenVersion: string | undefined = versions[0]
      if (versions.length) {
        const items: (vscode.QuickPickItem & { value?: string })[] =
          versions.map((v, i) => ({
            label: v,
            description: i === 0 ? 'Latest' : undefined,
            value: v,
          }))
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select library version',
        })
        chosenVersion = picked?.value || versions[0]
      }
      return { library: selected, version: chosenVersion }
    } finally {
      disposeAll(...toDispose)
    }
  }

  private async handlePickLibraryVersion(
    params: ProfilesPickLibraryVersionParams
  ): Promise<ProfilesDocumentState> {
    // Query available versions for the library and update the entry
    let versions: string[] = []
    try {
      const client = await this.boardlabContext.client
      const results = await client.arduino.searchLibrary(
        { searchArgs: params.library },
        undefined
      )
      const match = results.find((l) => l.name === params.library)
      if (match && (match as any).releases) {
        versions = Object.keys((match as any).releases)
          .filter(Boolean)
          .sort((a, b) => (a === b ? 0 : a < b ? 1 : -1))
      }
    } catch {}

    if (!versions.length) {
      // No versions; just return current state
      const document = await this.ensureDocument(params.uri)
      if (!document) {
        return { profiles: [], selectedProfile: undefined, hasDocument: false }
      }
      return this.computeDocumentState(document)
    }

    const items: (vscode.QuickPickItem & { value?: string })[] = versions.map(
      (v, i) => ({
        label: v,
        description: i === 0 ? 'Latest' : undefined,
        value: v,
      })
    )
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select library version',
    })
    // If user cancelled, do not change the library entry
    if (!picked) {
      const document = await this.ensureDocument(params.uri)
      if (!document) {
        return { profiles: [], selectedProfile: undefined, hasDocument: false }
      }
      return this.computeDocumentState(document)
    }
    const chosenVersion = picked.value

    return this.updateDocument(params.uri, (_document, profiles) => {
      const container = profiles.profiles
      if (!container) {
        throw new Error('No profiles available')
      }
      const profile = container[params.profile]
      if (!profile) {
        throw new Error(`Profile "${params.profile}" not found`)
      }
      const libraries = (profile.libraries || (profile.libraries = [])) as any[]
      const idx = libraries.findIndex((entry) => {
        if (typeof entry === 'string') {
          const { name } = splitLibraryNameVersion(entry)
          return name === params.library
        }
        return entry?.library === params.library
      })
      const combined = combineLibraryNameVersion(params.library, chosenVersion)
      if (idx >= 0) {
        libraries[idx] = combined
      } else {
        libraries.push(combined)
      }
    })
  }

  private async handleRemoveLibrary(
    params: ModifyLibraryParams
  ): Promise<ProfilesDocumentState> {
    return this.updateDocument(params.uri, (_document, profiles) => {
      const container = profiles.profiles
      if (!container) {
        throw new Error('No profiles available')
      }
      const profile = container[params.profile]
      if (!profile || !profile.libraries) {
        throw new Error(`Profile "${params.profile}" has no libraries`)
      }
      const targetName = params.library.library
      const targetVersion = params.library.version?.trim()
      profile.libraries = profile.libraries.filter((entry) => {
        let name: string | undefined
        let version: string | undefined
        if (typeof entry === 'string') {
          const parsed = splitLibraryNameVersion(entry)
          name = parsed.name
          version = parsed.version
        } else if (entry && typeof entry === 'object') {
          name = entry.library
          version = entry.version as string
        }
        if (name !== targetName) return true
        // Same name: if a version is specified, only remove that version; otherwise remove only unversioned entry
        if (targetVersion && targetVersion.length) {
          return version !== targetVersion
        }
        return !!version // keep versioned entries when removing unversioned
      })
    })
  }

  private async handleRenameProfile(
    params: ProfilesRenameProfileParams
  ): Promise<ProfilesDocumentState> {
    const to = params.to.trim()
    const from = params.from.trim()
    if (!to || !from || to === from) {
      const document = await this.ensureDocument(params.uri)
      if (!document) {
        return { profiles: [], selectedProfile: undefined, hasDocument: false }
      }
      return this.computeDocumentState(document)
    }
    return this.updateDocument(params.uri, (_document, profiles) => {
      const container = this.ensureProfilesContainer(profiles)
      if (!container[from]) {
        throw new Error(`Profile "${from}" not found`)
      }
      if (container[to]) {
        throw new Error(`Profile "${to}" already exists`)
      }
      container[to] = container[from]
      delete container[from]
      if (profiles.default_profile === from) {
        profiles.default_profile = to
      }
    })
  }

  private async handleAddPlatform(
    params: ModifyPlatformParams
  ): Promise<ProfilesDocumentState> {
    return this.updateDocument(params.uri, (_document, profiles) => {
      const container = profiles.profiles
      if (!container) {
        throw new Error('No profiles available')
      }
      const profile = container[params.profile]
      if (!profile) {
        throw new Error(`Profile "${params.profile}" not found`)
      }
      const platformId = params.platform.platform
      if (!platformId) {
        throw new Error('Platform id is required')
      }
      const platforms = (profile.platforms || (profile.platforms = [])) as any[]
      const exists = platforms.some((entry) => {
        const value = typeof entry === 'string' ? entry : entry?.platform
        if (typeof value !== 'string') return false
        const { id } = splitPlatformIdVersion(value)
        return id === platformId
      })
      if (!exists) {
        const platformStr = combinePlatformIdVersion(
          platformId,
          params.platform.version
        )
        const entry: any = { platform: platformStr }
        if (params.platform.platformIndexUrl) {
          entry.platform_index_url = params.platform.platformIndexUrl
        }
        platforms.push(entry)
      }
    })
  }

  private async handlePickPlatform(
    params: ProfilesPickPlatformParams
  ): Promise<ProfilesDocumentState> {
    const toDispose: vscode.Disposable[] = []
    const input = vscode.window.createQuickPick<
      vscode.QuickPickItem & { value?: string }
    >()
    ;(input as any).matchOnLabel = false
    ;(input as any).sortByLabel = false
    input.matchOnDescription = true
    input.matchOnDetail = true
    input.placeholder = 'Search platforms by id or name (vendor:arch)'
    input.busy = false
    input.items = [new QuickInputNoopLabel('Type to search platforms…') as any]
    input.show()
    try {
      const selected = await new Promise<string | undefined>((resolve) => {
        const abort = new AbortController()
        const search = async (query: string) => {
          const trimmed = query.trim()
          if (!trimmed) {
            input.items = [
              new QuickInputNoopLabel('Type to search platforms…') as any,
            ]
            return
          }
          input.busy = true
          try {
            const client = await this.boardlabContext.client
            const results = await client.arduino.searchPlatform(
              { searchArgs: trimmed },
              abort.signal
            )
            // Case-sensitive platform id exclusion
            const exclude = new Set(params.exclude ?? [])
            const items = results
              .filter(
                (s) =>
                  Boolean(s.metadata) &&
                  Object.keys(s.releases).length &&
                  !exclude.has(s.metadata!.id || '')
              )
              .map((s) => {
                const id = s.metadata!.id
                const name =
                  s.releases[s.installedVersion || s.latestVersion!]?.name
                const maintainer = s.metadata!.maintainer
                return {
                  label: id,
                  description: maintainer || '',
                  detail: name || '',
                  value: id,
                  alwaysShow: true,
                }
              })
            input.items =
              items.length > 0
                ? items
                : [
                    new QuickInputNoopLabel(
                      `No results for "${trimmed}"`
                    ) as any,
                  ]
          } catch (err) {
            input.items = [
              new QuickInputNoopLabel('Search failed; try again.') as any,
            ]
          } finally {
            input.busy = false
          }
        }
        toDispose.push(
          input.onDidChangeValue((value) => search(value)),
          input.onDidHide(() => {
            resolve(undefined)
            input.dispose()
          }),
          input.onDidChangeSelection((items) => {
            const item = items[0]
            if (!item || item instanceof QuickInputNoopLabel) {
              return
            }
            resolve((item as any).value ?? item.label)
            input.hide()
          })
        )
      })
      if (!selected) {
        const document = await this.ensureDocument(params.uri)
        if (!document) {
          return {
            profiles: [],
            selectedProfile: undefined,
            hasDocument: false,
          }
        }
        return this.computeDocumentState(document)
      }
      // Resolve available versions and optional index URL
      let latest: string | undefined
      let versions: string[] = []
      try {
        const client = await this.boardlabContext.client
        const results = await client.arduino.searchPlatform(
          { searchArgs: selected },
          undefined
        )
        const match = results.find((s) => s.metadata?.id === selected)
        if (match) {
          versions = Object.keys(match.releases || {})
            .filter(Boolean)
            .sort((a, b) => (a === b ? 0 : a < b ? 1 : -1))
          latest = match.latestVersion || versions[0]
        }
      } catch {}

      let chosenVersion: string | undefined = latest
      if (versions.length) {
        const items: (vscode.QuickPickItem & { value?: string })[] = []
        if (latest) {
          items.push({ label: latest, description: 'Latest', value: latest })
        }
        for (const v of versions) {
          if (v !== latest) items.push({ label: v, value: v })
        }
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select platform version',
        })
        chosenVersion = picked?.value || latest
      }

      const vendor = selected.split(':')[0]
      let platformIndexUrl: string | undefined
      if (vendor && vendor !== 'arduino') {
        platformIndexUrl = await vscode.window.showInputBox({
          prompt: 'Third-party platform index URL (optional)',
          placeHolder: 'https://example.com/package_vendor_index.json',
          ignoreFocusOut: true,
        })
        if (platformIndexUrl) platformIndexUrl = platformIndexUrl.trim()
      }

      const platform: ProfilePlatformDescriptor = {
        platform: selected,
        version: chosenVersion,
        platformIndexUrl,
      }
      return this.updateDocument(params.uri, (_document, profiles) => {
        const container = profiles.profiles
        if (!container) {
          throw new Error('No profiles available')
        }
        const profile = container[params.profile]
        if (!profile) {
          throw new Error(`Profile "${params.profile}" not found`)
        }
        const platforms = (profile.platforms ||
          (profile.platforms = [])) as any[]
        const exists = platforms.some((entry) => {
          const value = typeof entry === 'string' ? entry : entry?.platform
          if (typeof value !== 'string') return false
          const { id } = splitPlatformIdVersion(value)
          return id === platform.platform
        })
        if (!exists) {
          const platformStr = combinePlatformIdVersion(
            platform.platform,
            platform.version
          )
          const entry: any = { platform: platformStr }
          if (platform.platformIndexUrl) {
            entry.platform_index_url = platform.platformIndexUrl
          }
          platforms.push(entry)
        }
      })
    } finally {
      disposeAll(...toDispose)
    }
  }

  private async handlePickPlatformForCreation(
    _params?: ProfilesPickPlatformForCreationParams
  ): Promise<ProfilePlatformDescriptor | undefined> {
    const toDispose: vscode.Disposable[] = []
    const input = vscode.window.createQuickPick<
      vscode.QuickPickItem & { value?: string }
    >()
    ;(input as any).matchOnLabel = false
    ;(input as any).sortByLabel = false
    input.matchOnDescription = true
    input.matchOnDetail = true
    input.placeholder = 'Search platforms by id or name (vendor:arch)'
    input.busy = false
    input.items = [new QuickInputNoopLabel('Type to search platforms…') as any]
    input.show()
    try {
      const selected = await new Promise<string | undefined>((resolve) => {
        const abort = new AbortController()
        const search = async (query: string) => {
          const trimmed = query.trim()
          if (!trimmed) {
            input.items = [
              new QuickInputNoopLabel('Type to search platforms…') as any,
            ]
            return
          }
          input.busy = true
          try {
            const client = await this.boardlabContext.client
            const results = await client.arduino.searchPlatform(
              { searchArgs: trimmed },
              abort.signal
            )
            const items = results
              .filter(
                (s) => Boolean(s.metadata) && Object.keys(s.releases).length
              )
              .map((s) => {
                const id = s.metadata!.id
                const name =
                  s.releases[s.installedVersion || s.latestVersion!]?.name
                const maintainer = s.metadata!.maintainer
                return {
                  label: id,
                  description: maintainer || '',
                  detail: name || '',
                  value: id,
                  // https://github.com/microsoft/vscode/issues/90521#issuecomment-589829788
                  alwaysShow: true,
                }
              })
            input.items = items.length
              ? items
              : ([
                  new QuickInputNoopLabel(`No results for "${trimmed}"`) as any,
                ] as any)
          } catch {
            input.items = [
              new QuickInputNoopLabel('Search failed; try again.') as any,
            ]
          } finally {
            input.busy = false
          }
        }
        toDispose.push(
          input.onDidChangeValue((value) => search(value)),
          input.onDidHide(() => {
            resolve(undefined)
            input.dispose()
          }),
          input.onDidChangeSelection((items) => {
            const item = items[0]
            if (!item || item instanceof QuickInputNoopLabel) return
            resolve((item as any).value ?? item.label)
            input.hide()
          })
        )
      })
      if (!selected) return undefined

      // versions
      let latest: string | undefined
      let versions: string[] = []
      try {
        const client = await this.boardlabContext.client
        const results = await client.arduino.searchPlatform(
          { searchArgs: selected },
          undefined
        )
        const match = results.find((s) => s.metadata?.id === selected)
        if (match) {
          versions = Object.keys(match.releases || {})
            .filter(Boolean)
            .sort((a, b) => (a === b ? 0 : a < b ? 1 : -1))
          latest = match.latestVersion || versions[0]
        }
      } catch {}
      let chosenVersion: string | undefined = latest
      if (versions.length) {
        const items: (vscode.QuickPickItem & { value?: string })[] = []
        if (latest) {
          items.push({ label: latest, description: 'Latest', value: latest })
        }
        for (const v of versions) {
          if (v !== latest) items.push({ label: v, value: v })
        }
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select platform version',
        })
        chosenVersion = picked?.value || latest
      }

      let platformIndexUrl: string | undefined
      const vendor = selected.split(':')[0]
      if (vendor && vendor !== 'arduino') {
        platformIndexUrl = await vscode.window.showInputBox({
          prompt: 'Third-party platform index URL (optional)',
          placeHolder: 'https://example.com/package_vendor_index.json',
          ignoreFocusOut: true,
        })
        if (platformIndexUrl) platformIndexUrl = platformIndexUrl.trim()
      }
      return {
        platform: selected,
        version: chosenVersion,
        platformIndexUrl,
      }
    } finally {
      disposeAll(...toDispose)
    }
  }

  private async handlePickLibraryVersionForCreation(
    params: ProfilesPickLibraryVersionForCreationParams
  ): Promise<string | undefined> {
    let versions: string[] = []
    try {
      const client = await this.boardlabContext.client
      const results = await client.arduino.searchLibrary(
        { searchArgs: params.library },
        undefined
      )
      const match = results.find((l) => l.name === params.library)
      if (match && (match as any).releases) {
        versions = Object.keys((match as any).releases)
          .filter(Boolean)
          .sort((a, b) => (a === b ? 0 : a < b ? 1 : -1))
      }
    } catch {}
    if (!versions.length) return undefined
    const items: (vscode.QuickPickItem & { value?: string })[] = versions.map(
      (v, i) => ({
        label: v,
        description: i === 0 ? 'Latest' : undefined,
        value: v,
      })
    )
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select library version',
    })
    return picked?.value || versions[0]
  }

  private async handlePickPlatformVersionForCreation(
    params: ProfilesPickPlatformVersionForCreationParams
  ): Promise<string | undefined> {
    let latest: string | undefined
    let versions: string[] = []
    try {
      const client = await this.boardlabContext.client
      const results = await client.arduino.searchPlatform(
        { searchArgs: params.platform },
        undefined
      )
      const match = results.find((s) => s.metadata?.id === params.platform)
      if (match) {
        versions = Object.keys(match.releases || {})
          .filter(Boolean)
          .sort((a, b) => (a === b ? 0 : a < b ? 1 : -1))
        latest = match.latestVersion || versions[0]
      }
    } catch {}
    if (!versions.length) return undefined
    const items: (vscode.QuickPickItem & { value?: string })[] = []
    if (latest) {
      items.push({ label: latest, description: 'Latest', value: latest })
    }
    for (const v of versions) {
      if (v !== latest) items.push({ label: v, value: v })
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select platform version',
    })
    return picked?.value
  }

  private async handlePickPlatformVersion(
    params: ProfilesPickPlatformVersionParams
  ): Promise<ProfilesDocumentState> {
    let latest: string | undefined
    let versions: string[] = []
    try {
      const client = await this.boardlabContext.client
      const results = await client.arduino.searchPlatform(
        { searchArgs: params.platform },
        undefined
      )
      const match = results.find((s) => s.metadata?.id === params.platform)
      if (match) {
        versions = Object.keys(match.releases || {})
          .filter(Boolean)
          .sort((a, b) => (a === b ? 0 : a < b ? 1 : -1)) // TODO: sort by semver + handle invalid semver
        latest = match.latestVersion || versions[0]
      }
    } catch {}

    if (!versions.length) {
      const document = await this.ensureDocument(params.uri)
      if (!document) {
        return { profiles: [], selectedProfile: undefined, hasDocument: false }
      }
      return this.computeDocumentState(document)
    }

    const items: (vscode.QuickPickItem & { value?: string })[] = []
    if (latest) {
      items.push({ label: latest, description: 'Latest', value: latest })
    }
    for (const v of versions) {
      if (v !== latest) items.push({ label: v, value: v })
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select platform version',
    })
    // If user cancelled, do not change the platform entry
    if (!picked) {
      const document = await this.ensureDocument(params.uri)
      if (!document) {
        return { profiles: [], selectedProfile: undefined, hasDocument: false }
      }
      return this.computeDocumentState(document)
    }
    const chosenVersion = picked.value

    return this.updateDocument(params.uri, (_document, profiles) => {
      const container = profiles.profiles
      if (!container) {
        throw new Error('No profiles available')
      }
      const profile = container[params.profile]
      if (!profile) {
        throw new Error(`Profile "${params.profile}" not found`)
      }
      const platforms = (profile.platforms || (profile.platforms = [])) as any[]
      const idx = platforms.findIndex((entry) => {
        const value = typeof entry === 'string' ? entry : entry?.platform
        if (typeof value !== 'string') return false
        const { id } = splitPlatformIdVersion(value)
        return id === params.platform
      })
      const combined = combinePlatformIdVersion(params.platform, chosenVersion)
      if (idx >= 0) {
        const existing = platforms[idx]
        const entry: any =
          typeof existing === 'string'
            ? { platform: combined }
            : { ...existing, platform: combined }
        platforms[idx] = entry
      } else {
        platforms.push({ platform: combined })
      }
    })
  }

  private async handleResolvePlatformName(
    params: ProfilesResolvePlatformNameParams
  ): Promise<PlatformNameInfo | undefined> {
    try {
      const platform =
        await this.boardlabContext.platformsManager.lookupPlatformQuick(
          params.platform
        )
      return { id: params.platform, name: platform?.label }
    } catch (error) {
      console.warn('Failed to resolve platform name', {
        platform: params.platform,
        error,
      })
      return { id: params.platform }
    }
  }

  /**
   * Refresh diagnostics (AST + CLI) for all open profiles documents. Used when
   * external state changes, such as platform/library installs or index
   * updates.
   */
  async refreshDiagnosticsForOpenDocuments(): Promise<void> {
    const docs = Array.from(this.documentByUri.values())
    for (const document of docs) {
      try {
        const state = this.computeDocumentState(document)
        this.updateDiagnostics(document, document.getText(), state.profiles)
      } catch (error) {
        console.warn('Failed to refresh profiles diagnostics', {
          uri: document.uri.toString(),
          error,
        })
      }
    }
  }

  private async handlePickPlatformIndexUrl(
    params: ProfilesPickPlatformIndexUrlParams
  ): Promise<ProfilesDocumentState> {
    const document = await this.ensureDocument(params.uri)
    if (!document) {
      return { profiles: [], selectedProfile: undefined, hasDocument: false }
    }
    if (params.clear) {
      return this.updateDocument(params.uri, (_doc, profiles) => {
        const profile = this.getMutableProfileStrict(profiles, params.profile)
        const platforms = (profile.platforms ||= []) as any[]
        const idx = platforms.findIndex((entry) => {
          const value = typeof entry === 'string' ? entry : entry?.platform
          if (typeof value !== 'string') return false
          const { id } = splitPlatformIdVersion(value)
          return id === params.platform
        })
        if (idx >= 0) {
          const existing = platforms[idx]
          const entry: any =
            typeof existing === 'string'
              ? { platform: existing }
              : { ...existing }
          if (entry.platform_index_url !== undefined) {
            delete entry.platform_index_url
            platforms[idx] = entry
          }
        }
      })
    }

    // Otherwise prompt the user for a URL
    const profilesDoc = parseProfilesText(document.getText())
    const profile = this.getMutableProfileStrict(profilesDoc, params.profile)
    const platforms = (profile.platforms ||= []) as any[]
    const idx = platforms.findIndex((entry) => {
      const value = typeof entry === 'string' ? entry : entry?.platform
      if (typeof value !== 'string') return false
      const { id } = splitPlatformIdVersion(value)
      return id === params.platform
    })
    const current = (() => {
      if (idx < 0) return undefined
      const entry = platforms[idx]
      return typeof entry === 'string' ? undefined : entry?.platform_index_url
    })()

    const picked = await vscode.window.showInputBox({
      title: `Platform package index URL for ${params.platform}`,
      prompt: 'Enter an additional platform package index URL (http/https).',
      value: current ?? '',
      placeHolder: 'https://example.com/package_index.json',
      validateInput: (value) => {
        const trimmed = value.trim()
        if (!trimmed) return 'URL is required'
        try {
          const url = new URL(trimmed)
          if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return 'Only http/https URLs are supported'
          }
          return null
        } catch {
          return 'Invalid URL'
        }
      },
    })
    if (picked === undefined) {
      // cancelled
      return this.computeDocumentState(document)
    }

    const nextUrl = picked.trim()
    return this.updateDocument(params.uri, (_doc, profiles) => {
      const target = this.getMutableProfileStrict(profiles, params.profile)
      const plats = (target.platforms ||= []) as any[]
      const idx2 = plats.findIndex((entry) => {
        const value = typeof entry === 'string' ? entry : entry?.platform
        if (typeof value !== 'string') return false
        const { id } = splitPlatformIdVersion(value)
        return id === params.platform
      })
      if (idx2 < 0) return
      const existing = plats[idx2]
      const entry: any =
        typeof existing === 'string' ? { platform: existing } : { ...existing }
      // nextUrl is guaranteed non-empty by validation
      entry.platform_index_url = nextUrl
      plats[idx2] = entry
    })
  }

  private async handleRemovePlatform(
    params: ModifyPlatformParams
  ): Promise<ProfilesDocumentState> {
    return this.updateDocument(params.uri, (_document, profiles) => {
      const container = profiles.profiles
      if (!container) {
        throw new Error('No profiles available')
      }
      const profile = container[params.profile]
      if (!profile || !profile.platforms) {
        throw new Error(`Profile "${params.profile}" has no platforms`)
      }
      const targetId = params.platform.platform
      const targetVer = params.platform.version
      profile.platforms = (profile.platforms as any[]).filter((entry) => {
        const value = typeof entry === 'string' ? entry : entry?.platform
        if (typeof value !== 'string') return true
        const { id, version } = splitPlatformIdVersion(value)
        if (targetVer && version) {
          return !(id === targetId && version === targetVer)
        }
        return id !== targetId
      }) as any
    })
  }

  private async handleResolveBoardDetails(
    params: ProfilesResolveBoardDetailsParams
  ): Promise<BoardDescriptor | undefined> {
    try {
      const document = await this.ensureDocument(params.uri)
      if (!document) {
        return undefined
      }
      const profiles = parseProfilesText(document.getText())
      const container = profiles.profiles
      const profile = container ? container[params.profile] : undefined
      const fqbn =
        profile && typeof profile.fqbn === 'string' ? profile.fqbn : undefined
      if (!fqbn) {
        return undefined
      }
      return await this.tryResolveBoardDescriptor(fqbn)
    } catch (error) {
      console.error('Failed to resolve board details', { params, error })
      return undefined
    }
  }

  private async handlePickBoard(
    params: ProfilesPickBoardParams
  ): Promise<ProfilesDocumentState> {
    const document = await this.ensureDocument(params.uri, {
      createIfMissing: true,
    })
    if (!document) {
      vscode.window.showErrorMessage(
        'Unable to create or open sketch.yaml for this profile.'
      )
      return { profiles: [], selectedProfile: undefined, hasDocument: false }
    }
    const picked = await this.boardlabContext.pickBoard()
    if (!picked) {
      return this.computeDocumentState(document)
    }
    let fqbn: string | undefined
    if (isBoardIdentifier(picked)) {
      fqbn = picked.fqbn
    } else if (picked.board?.fqbn) {
      fqbn = picked.board.fqbn
    }
    if (!fqbn) {
      vscode.window.showWarningMessage(
        'The selected board does not provide an FQBN.'
      )
      return this.computeDocumentState(document)
    }
    let sanitizedFqbn = fqbn
    try {
      sanitizedFqbn = new FQBN(fqbn).toString()
    } catch (error) {
      console.warn('Invalid FQBN returned from board picker', {
        fqbn,
        error,
      })
    }
    return this.updateDocument(params.uri, (_doc, profiles) => {
      const profile = this.getMutableProfileStrict(profiles, params.profile)
      const previousFqbn =
        typeof profile.fqbn === 'string' ? profile.fqbn : undefined
      profile.fqbn = sanitizedFqbn
      delete profile.programmer
      delete profile.port
      delete profile.protocol
      delete profile.port_config
      this.invalidateBoardCache(previousFqbn)
      this.invalidateBoardCache(sanitizedFqbn)
    })
  }

  private async handlePickBoardForCreation(
    _params: PickBoardForCreationParams
  ): Promise<BoardDescriptor | undefined> {
    const picked = await this.boardlabContext.pickBoard()
    if (!picked) {
      return undefined
    }
    let fqbn: string | undefined
    if (isBoardIdentifier(picked)) {
      fqbn = picked.fqbn
    } else if (picked.board?.fqbn) {
      fqbn = picked.board.fqbn
    }
    if (!fqbn) {
      vscode.window.showWarningMessage(
        'The selected board does not provide an FQBN.'
      )
      return undefined
    }
    try {
      return await this.tryResolveBoardDescriptor(fqbn)
    } catch (error) {
      console.error('Failed to resolve board descriptor for creation', {
        fqbn,
        error,
      })
      return this.createFallbackBoardDescriptor(fqbn)
    }
  }

  private async handleSelectBoardConfigOption(
    params: ProfilesSelectBoardConfigOptionParams
  ): Promise<ProfilesDocumentState> {
    const document = await this.ensureDocument(params.uri, {
      createIfMissing: true,
    })
    if (!document) {
      throw new Error('Unable to load profiles document for board options.')
    }
    const profiles = parseProfilesText(document.getText())
    const container = profiles.profiles
    const profile = container ? container[params.profile] : undefined
    const fqbn =
      profile && typeof profile.fqbn === 'string' ? profile.fqbn : undefined
    if (!fqbn) {
      await vscode.window.showWarningMessage(
        'Select a board before configuring options.'
      )
      return this.computeDocumentState(document)
    }
    const descriptor = await this.tryResolveBoardDescriptor(fqbn)
    if (!descriptor) {
      await vscode.window.showWarningMessage(
        'Board details are not available. Ensure the board platform is installed.'
      )
      return this.computeDocumentState(document)
    }
    const optionDescriptor = descriptor.configOptions.find(
      (option) => option.option === params.option
    )
    if (!optionDescriptor) {
      await vscode.window.showWarningMessage(
        `Configuration option "${params.option}" is not available for this board.`
      )
      return this.computeDocumentState(document)
    }
    const items = optionDescriptor.values.map((value) => ({
      label: `${value.isSelected ? '$(check) ' : ''}${value.valueLabel}`,
      description: value.isDefault ? 'Default' : undefined,
      value: value.value,
    }))
    const selection = await vscode.window.showQuickPick(items, {
      placeHolder: `Select ${optionDescriptor.optionLabel}`,
      matchOnDetail: true,
      matchOnDescription: true,
    })
    if (!selection) {
      return this.computeDocumentState(document)
    }
    return this.updateDocument(params.uri, (_doc, profilesDoc) => {
      const mutableProfile = this.getMutableProfileStrict(
        profilesDoc,
        params.profile
      )
      const previousFqbn =
        typeof mutableProfile.fqbn === 'string'
          ? mutableProfile.fqbn
          : undefined
      if (!previousFqbn) {
        throw new Error('Board is not configured for this profile.')
      }
      let updatedFqbn: string
      try {
        updatedFqbn = new FQBN(previousFqbn)
          .setConfigOption(params.option, selection.value)
          .toString()
      } catch (error) {
        throw new Error(
          `Failed to update board configuration option "${params.option}": ${error instanceof Error ? error.message : String(error)}`
        )
      }
      mutableProfile.fqbn = updatedFqbn
      this.invalidateBoardCache(previousFqbn)
      this.invalidateBoardCache(updatedFqbn)
    })
  }

  private async handlePickBoardConfigOptionForCreation(
    params: ProfilesPickBoardConfigOptionForCreationParams
  ): Promise<PickBoardConfigForCreationResult | undefined> {
    const descriptor = await this.tryResolveBoardDescriptor(params.fqbn)
    if (!descriptor) {
      await vscode.window.showWarningMessage(
        'Board details are not available. Ensure the board platform is installed.'
      )
      return undefined
    }
    const optionDescriptor = descriptor.configOptions.find(
      (opt) => opt.option === params.option
    )
    if (!optionDescriptor) {
      await vscode.window.showWarningMessage(
        `Configuration option "${params.option}" is not available for this board.`
      )
      return undefined
    }
    const items = optionDescriptor.values.map((value) => ({
      label: `${value.isSelected ? '$(check) ' : ''}${value.valueLabel}`,
      description: value.isDefault ? 'Default' : undefined,
      value: value.value,
    }))
    const selection = await vscode.window.showQuickPick(items, {
      placeHolder: `Select ${optionDescriptor.optionLabel}`,
      matchOnDetail: true,
      matchOnDescription: true,
    })
    if (!selection) return undefined
    let updatedFqbn = params.fqbn
    try {
      updatedFqbn = new FQBN(params.fqbn)
        .setConfigOption(params.option, selection.value)
        .toString()
    } catch (error) {
      await vscode.window.showErrorMessage(
        `Failed to update option: ${error instanceof Error ? error.message : String(error)}`
      )
      return undefined
    }
    const updatedDescriptor = await this.tryResolveBoardDescriptor(updatedFqbn)
    return { fqbn: updatedFqbn, descriptor: updatedDescriptor }
  }

  private async handleResetBoardConfigOption(
    params: ProfilesResetBoardConfigOptionParams
  ): Promise<ProfilesDocumentState> {
    return this.updateDocument(params.uri, (_doc, profiles) => {
      const profile = this.getMutableProfileStrict(profiles, params.profile)
      const previousFqbn =
        typeof profile.fqbn === 'string' ? profile.fqbn : undefined
      if (!previousFqbn) {
        throw new Error('Board is not configured for this profile.')
      }
      const updatedFqbn = this.removeConfigOptionFromFqbn(
        previousFqbn,
        params.option
      )
      profile.fqbn = updatedFqbn
      this.invalidateBoardCache(previousFqbn)
      this.invalidateBoardCache(updatedFqbn)
    })
  }

  private async handleResetBoardConfigOptionForCreation(
    params: ProfilesResetBoardConfigOptionForCreationParams
  ): Promise<PickBoardConfigForCreationResult | undefined> {
    const previousFqbn = params.fqbn
    let updatedFqbn = previousFqbn
    try {
      updatedFqbn = this.removeConfigOptionFromFqbn(previousFqbn, params.option)
    } catch (error) {
      await vscode.window.showErrorMessage(
        `Failed to reset option: ${error instanceof Error ? error.message : String(error)}`
      )
      return undefined
    }
    const updatedDescriptor = await this.tryResolveBoardDescriptor(updatedFqbn)
    return { fqbn: updatedFqbn, descriptor: updatedDescriptor }
  }

  private async handleSelectProgrammer(
    params: ProfilesSelectProgrammerParams
  ): Promise<ProfilesDocumentState> {
    const document = await this.ensureDocument(params.uri, {
      createIfMissing: true,
    })
    if (!document) {
      vscode.window.showErrorMessage(
        'Unable to open sketch.yaml to update the programmer.'
      )
      return { profiles: [], selectedProfile: undefined, hasDocument: false }
    }
    const profiles = parseProfilesText(document.getText())
    const container = profiles.profiles
    const profile = container ? container[params.profile] : undefined
    const fqbn =
      profile && typeof profile.fqbn === 'string' ? profile.fqbn : undefined
    if (!fqbn) {
      await vscode.window.showWarningMessage(
        'Select a board before choosing a programmer.'
      )
      return this.computeDocumentState(document)
    }
    const descriptor = await this.tryResolveBoardDescriptor(fqbn)
    if (!descriptor) {
      await vscode.window.showWarningMessage(
        'Programmer information is not available. Ensure the board platform is installed.'
      )
      return this.computeDocumentState(document)
    }
    if (!descriptor.programmers.length) {
      await vscode.window.showInformationMessage(
        'The selected board does not define any programmers.'
      )
      return this.computeDocumentState(document)
    }
    if (params.programmerId !== undefined) {
      const targetId = params.programmerId ?? undefined
      return this.updateDocument(params.uri, (_doc, profilesDoc) => {
        const mutableProfile = this.getMutableProfileStrict(
          profilesDoc,
          params.profile
        )
        if (targetId) {
          mutableProfile.programmer = targetId
        } else {
          delete mutableProfile.programmer
        }
      })
    }
    const currentProgrammer =
      profile && typeof profile.programmer === 'string'
        ? profile.programmer
        : undefined
    const items: Array<
      vscode.QuickPickItem & { programmerId?: string | null }
    > = [
      {
        label: 'Use default programmer',
        description: descriptor.defaultProgrammerId
          ? descriptor.defaultProgrammerId
          : undefined,
        programmerId: null,
      },
    ]
    for (const programmer of descriptor.programmers) {
      items.push({
        label: `${programmer.isDefault ? '$(star-full) ' : ''}${programmer.label}`,
        description: programmer.id,
        programmerId: programmer.id,
        picked: programmer.id === currentProgrammer,
      })
    }
    const selection = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select programmer',
      matchOnDescription: true,
    })
    if (!selection) {
      return this.computeDocumentState(document)
    }
    const programmerId =
      selection.programmerId === null ? undefined : selection.programmerId
    return this.updateDocument(params.uri, (_doc, profilesDoc) => {
      const mutableProfile = this.getMutableProfileStrict(
        profilesDoc,
        params.profile
      )
      if (!programmerId) {
        delete mutableProfile.programmer
      } else {
        mutableProfile.programmer = programmerId
      }
    })
  }

  private async handlePickProgrammerForCreation(
    params: ProfilesPickProgrammerForCreationParams
  ): Promise<PickProgrammerForCreationResult | undefined> {
    const descriptor = await this.tryResolveBoardDescriptor(params.fqbn)
    if (!descriptor) {
      await vscode.window.showWarningMessage(
        'Programmer information is not available. Ensure the board platform is installed.'
      )
      return undefined
    }
    if (!descriptor.programmers.length) {
      await vscode.window.showInformationMessage(
        'The selected board does not define any programmers.'
      )
      return undefined
    }
    const items: Array<
      vscode.QuickPickItem & { programmerId?: string | null }
    > = [
      {
        label: 'Use default programmer',
        description: descriptor.defaultProgrammerId
          ? descriptor.defaultProgrammerId
          : undefined,
        programmerId: null,
      },
    ]
    for (const programmer of descriptor.programmers) {
      items.push({
        label: `${programmer.isDefault ? '$(star-full) ' : ''}${programmer.label}`,
        description: programmer.id,
        programmerId: programmer.id,
      })
    }
    const selection = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select programmer',
    })
    if (!selection) return undefined
    return { programmerId: selection.programmerId }
  }

  private async handleSelectPort(
    params: ProfilesSelectPortParams
  ): Promise<ProfilesDocumentState> {
    if (params.clear) {
      return this.updateDocument(params.uri, (_doc, profiles) => {
        const profile = this.getMutableProfileStrict(profiles, params.profile)
        delete profile.port
        delete profile.protocol
      })
    }
    const document = await this.ensureDocument(params.uri, {
      createIfMissing: true,
    })
    if (!document) {
      vscode.window.showErrorMessage(
        'Unable to open sketch.yaml to update the port.'
      )
      return { profiles: [], selectedProfile: undefined, hasDocument: false }
    }
    const port = await this.boardlabContext.pickPort()
    if (!port) {
      return this.computeDocumentState(document)
    }
    const typedPort = port as Port
    const address = typedPort.address ?? ''
    const protocol = typedPort.protocol
    if (!address) {
      await vscode.window.showWarningMessage(
        'The selected port does not provide an address.'
      )
      return this.computeDocumentState(document)
    }
    return this.updateDocument(params.uri, (_doc, profiles) => {
      const profile = this.getMutableProfileStrict(profiles, params.profile)
      profile.port = address
      if (protocol) {
        profile.protocol = protocol
      } else {
        delete profile.protocol
      }
    })
  }

  private async getPortSettingsForProtocol(
    protocol: string,
    fqbn?: string
  ): Promise<MonitorPortSettingDescriptor[]> {
    return this.boardlabContext.getPortSettingsForProtocol(protocol, fqbn)
  }

  private async handleAddPortConfig(
    params: ProfilesAddPortConfigParams
  ): Promise<ProfilesDocumentState> {
    const document = await this.ensureDocument(params.uri)
    if (!document) {
      return { profiles: [], selectedProfile: undefined, hasDocument: false }
    }
    const text = document.getText()
    const profilesDoc = parseProfilesText(text)
    const mutable = this.getMutableProfileStrict(profilesDoc, params.profile)
    const protocol =
      typeof mutable.protocol === 'string' ? mutable.protocol : undefined
    const fqbn = typeof mutable.fqbn === 'string' ? mutable.fqbn : undefined
    if (!protocol) {
      await vscode.window.showInformationMessage(
        'No protocol is set for the selected port.'
      )
      return this.computeDocumentState(document)
    }
    // Enumerate settings and prompt for selection
    let settings: MonitorPortSettingDescriptor[] = []
    try {
      settings = await this.getPortSettingsForProtocol(protocol, fqbn)
    } catch (err) {
      console.warn('Failed to enumerate port settings', err)
      settings = []
    }
    if (!settings.length) {
      await vscode.window.showWarningMessage(
        `No configurable settings available for protocol "${protocol}".`
      )
      return this.computeDocumentState(document)
    }
    const exclude = new Set(params.excludeKeys ?? [])
    const pickSettingItems = settings
      .filter((s) => !exclude.has(s.settingId))
      .map((s) => ({
        label: s.label || s.settingId,
        description: s.settingId,
        setting: s,
      }))
    const pickedSetting = await vscode.window.showQuickPick(pickSettingItems, {
      placeHolder: 'Select a port setting to configure',
      matchOnDescription: true,
      matchOnDetail: true,
    })
    if (!pickedSetting) {
      return this.computeDocumentState(document)
    }
    const setting = pickedSetting.setting
    const values = (setting.enumValues || []).map((v) => ({
      label: v,
      description: v === setting.value ? 'Default' : undefined,
      value: v,
      picked: v === setting.value,
      iconPath: setting.value === v ? new vscode.ThemeIcon('check') : undefined,
    }))
    if (!values.length) {
      await vscode.window.showWarningMessage(
        'This setting has no selectable values.'
      )
      return this.computeDocumentState(document)
    }
    const pickedValue = await vscode.window.showQuickPick(values, {
      placeHolder: `Select value for ${setting.label || setting.settingId}`,
    })
    if (!pickedValue) {
      return this.computeDocumentState(document)
    }
    const key = setting.settingId
    const value = pickedValue.value
    // Update document
    return this.updateDocument(params.uri, (_doc, profiles) => {
      const target = this.getMutableProfileStrict(profiles, params.profile)
      const cfg = (target.port_config ||= {})
      ;(cfg as any)[key] = value
    })
  }

  private async handlePickPortConfigForCreation(
    params: ProfilesPickPortConfigForCreationParams
  ): Promise<PickPortConfigForCreationResult | undefined> {
    const protocol = params.protocol
    if (!protocol) return undefined
    let settings: MonitorPortSettingDescriptor[] = []
    try {
      settings = await this.getPortSettingsForProtocol(protocol, params.fqbn)
    } catch (err) {
      console.warn('Failed to enumerate port settings', err)
      settings = []
    }
    if (!settings.length) return undefined
    const pickedSetting = await vscode.window.showQuickPick(
      settings.map((s) => ({
        label: s.label || s.settingId,
        description: s.settingId,
        detail: s.value ? `Default: ${s.value}` : undefined,
        setting: s,
      })),
      {
        placeHolder: 'Select a port setting to configure',
        matchOnDescription: true,
        matchOnDetail: true,
      }
    )
    if (!pickedSetting) return undefined
    const setting = pickedSetting.setting
    const values = (setting.enumValues || []).map((v) => ({
      label: v,
      description: v === setting.value ? 'Default' : undefined,
      value: v,
      picked: v === setting.value,
    }))
    const pickedValue = await vscode.window.showQuickPick(values, {
      placeHolder: `Select value for ${setting.label || setting.settingId}`,
    })
    if (!pickedValue) return undefined
    return { key: setting.settingId, value: pickedValue.value }
  }

  private async handlePickPortConfigValueForCreation(
    params: ProfilesPickPortConfigValueForCreationParams
  ): Promise<string | undefined> {
    const protocol = params.protocol
    if (!protocol) return undefined
    let settings: MonitorPortSettingDescriptor[] = []
    try {
      settings = await this.getPortSettingsForProtocol(protocol, params.fqbn)
    } catch (err) {
      console.warn('Failed to enumerate port settings', err)
      settings = []
    }
    const setting = settings.find((s) => s.settingId === params.key)
    if (!setting) return undefined
    const values = (setting.enumValues || []).map((v) => ({
      label: v,
      description: v === setting.value ? 'Default' : undefined,
      value: v,
      picked: v === setting.value,
    }))
    const picked = await vscode.window.showQuickPick(values, {
      placeHolder: `Select value for ${setting.label || setting.settingId}`,
    })
    return picked?.value
  }

  private async handlePickPortConfigValue(
    params: ProfilesPickPortConfigValueParams
  ): Promise<ProfilesDocumentState> {
    const document = await this.ensureDocument(params.uri)
    if (!document) {
      return { profiles: [], selectedProfile: undefined, hasDocument: false }
    }
    const profilesDoc = parseProfilesText(document.getText())
    const profile = this.getMutableProfileStrict(profilesDoc, params.profile)
    const protocol =
      typeof profile.protocol === 'string' ? profile.protocol : ''
    const fqbn = typeof profile.fqbn === 'string' ? profile.fqbn : undefined
    if (!protocol) {
      await vscode.window.showInformationMessage(
        'No protocol is set for the selected port.'
      )
      return this.computeDocumentState(document)
    }
    let settings: MonitorPortSettingDescriptor[] = []
    try {
      settings = await this.getPortSettingsForProtocol(protocol, fqbn)
    } catch (err) {
      console.warn('Failed to enumerate port settings', err)
      settings = []
    }
    const descriptor = settings.find((s) => s.settingId === params.key)
    if (!descriptor) {
      await vscode.window.showWarningMessage(
        `Setting "${params.key}" is not available for protocol "${protocol}".`
      )
      return this.computeDocumentState(document)
    }
    const currentValue = profile.port_config?.[params.key]
    const values = (descriptor.enumValues || []).map((v) => ({
      label: v,
      description: v === descriptor.value ? '(default)' : undefined,
      value: v,
      picked: currentValue ? currentValue === v : descriptor.value === v,
      iconPath: currentValue === v ? new vscode.ThemeIcon('check') : undefined,
    }))
    const picked = await vscode.window.showQuickPick(values, {
      matchOnDescription: true,
      placeHolder: `Select value for ${descriptor.label || descriptor.settingId}`,
    })
    const chosen = picked?.value
    if (!chosen) {
      return this.computeDocumentState(document)
    }
    return this.updateDocument(params.uri, (_doc, profiles) => {
      const target = this.getMutableProfileStrict(profiles, params.profile)
      const cfg = (target.port_config ||= {})
      ;(cfg as any)[params.key] = chosen
    })
  }

  private async handleResolvePortConfigLabels(
    params: ProfilesResolvePortConfigLabelsParams
  ): Promise<PortConfigLabels> {
    const document = await this.ensureDocument(params.uri)
    if (!document) {
      return {}
    }
    const profilesDoc = parseProfilesText(document.getText())
    const profile = this.getMutableProfileStrict(profilesDoc, params.profile)
    const protocol =
      typeof profile.protocol === 'string' ? profile.protocol : undefined
    const fqbn = typeof profile.fqbn === 'string' ? profile.fqbn : undefined
    if (!protocol) return {}
    let settings: MonitorPortSettingDescriptor[] = []
    try {
      settings = await this.getPortSettingsForProtocol(protocol, fqbn)
    } catch (err) {
      console.warn('Failed to enumerate port settings', err)
      settings = []
    }
    const labels: Record<string, string> = {}
    for (const s of settings) {
      const key = s.settingId
      const label = s.label || s.settingId
      if (key) labels[key] = label
    }
    return labels
  }

  private async handleRemovePortConfig(
    params: ProfilesRemovePortConfigParams
  ): Promise<ProfilesDocumentState> {
    return this.updateDocument(params.uri, (_doc, profiles) => {
      const target = this.getMutableProfileStrict(profiles, params.profile)
      const cfg = target.port_config
      if (cfg && Object.prototype.hasOwnProperty.call(cfg, params.key)) {
        delete cfg[params.key]
        // If no remaining keys, omit the node entirely to avoid serializing empty mappings
        if (Object.keys(cfg).length === 0) {
          delete target.port_config
        }
      }
    })
  }

  private async handlePickPortForCreation(
    _params?: ProfilesPickPortForCreationParams
  ): Promise<PickPortForCreationResult | undefined> {
    const port = await this.boardlabContext.pickPort()
    if (!port) return undefined
    return { port: port.address, protocol: port.protocol as any }
  }

  private async handleCreateProfileInteractive(
    params: ProfilesCreateProfileInteractiveParams
  ): Promise<ProfilesDocumentState> {
    const suggested = await vscode.window.showInputBox({
      prompt: 'Enter a new profile name',
      placeHolder: 'wifi-profile',
      validateInput: (value) => {
        const trimmed = value.trim()
        if (!trimmed) {
          return 'Profile name is required.'
        }
        if (!/^[A-Za-z0-9_.-]+$/.test(trimmed)) {
          return 'Allowed characters: letters, numbers, ".", "_" and "-".'
        }
        return undefined
      },
    })
    if (!suggested) {
      const document = await this.ensureDocument(params.uri)
      if (!document) {
        return { profiles: [], selectedProfile: undefined, hasDocument: false }
      }
      return this.computeDocumentState(document)
    }
    const name = suggested.trim()
    const document = await this.ensureDocument(params.uri, {
      createIfMissing: true,
    })
    if (!document) {
      vscode.window.showErrorMessage(
        'Unable to create sketch.yaml for the new profile.'
      )
      return { profiles: [], selectedProfile: undefined, hasDocument: false }
    }
    const profiles = parseProfilesText(document.getText())
    const container = this.ensureProfilesContainer(profiles)
    if (container[name]) {
      await vscode.window.showWarningMessage(
        `Profile "${name}" already exists.`
      )
      return this.computeDocumentState(document)
    }
    const shouldMakeDefault = !Object.keys(container).length
    return this.updateDocument(params.uri, (_doc, profilesDoc) => {
      const targetContainer = this.ensureProfilesContainer(profilesDoc)
      if (targetContainer[name]) {
        throw new Error(`Profile "${name}" already exists`)
      }
      targetContainer[name] = {}
      if (shouldMakeDefault) {
        profilesDoc.default_profile = name
      }
    })
  }

  private async updateDocument(
    uri: string,
    mutator: (
      document: vscode.TextDocument,
      profiles: MutableProfilesDocument
    ) => void
  ): Promise<ProfilesDocumentState> {
    const document = await this.ensureDocument(uri, {
      createIfMissing: true,
    })
    if (!document) {
      throw new Error(`Unable to open profiles document at ${uri}`)
    }
    const originalText = document.getText()
    const profiles = parseProfilesText(originalText)
    mutator(document, profiles)
    const updatedText = stringify(profiles)
    if (updatedText !== originalText) {
      const edit = new vscode.WorkspaceEdit()
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(originalText.length)
      )
      edit.replace(document.uri, fullRange, updatedText)
      const applied = await vscode.workspace.applyEdit(edit)
      if (!applied) {
        throw new Error('Failed to apply profiles update')
      }
    }
    const state = this.computeDocumentState(document)
    this.publishState(document, state)
    return state
  }

  private publishState(
    document: vscode.TextDocument,
    state?: ProfilesDocumentState
  ): void {
    const uriKey = document.uri.toString()
    const bindings = this.bindingsByUri.get(uriKey)
    if (!bindings || !bindings.size) {
      return
    }
    const snapshot = state ?? this.computeDocumentState(document)
    this.updateDiagnostics(document, document.getText(), snapshot.profiles)
    bindings.forEach((binding) => {
      try {
        this.messenger.sendNotification(
          notifyProfilesChanged,
          binding.participant,
          snapshot
        )
      } catch (error) {
        console.error('Failed to push profiles state', {
          uri: uriKey,
          error,
        })
      }
    })
  }

  // Open the backing YAML in a text editor. If `uriString` is omitted,
  // falls back to the last active profiles editor document.
  async openRaw(uriString?: string): Promise<void> {
    let targetUri: vscode.Uri | undefined
    if (uriString && typeof uriString === 'string') {
      try {
        targetUri = vscode.Uri.parse(uriString)
      } catch (err) {
        console.warn('profiles.openTextEditor: invalid uri string', uriString)
      }
    }
    if (!targetUri) {
      const doc = this.lastActiveDocument
      if (!doc) {
        vscode.window.showInformationMessage(
          'No profiles document context available.'
        )
        return
      }
      targetUri = doc.uri
    }
    try {
      const textDoc = await vscode.workspace.openTextDocument(targetUri)
      await vscode.window.showTextDocument(textDoc, { preview: false })
    } catch (err) {
      console.error('Failed to open raw profiles document', err)
    }
  }

  // Backward compatible wrapper
  async openRawForActiveEditor(): Promise<void> {
    return this.openRaw()
  }
}
