import type { DetectedPorts } from 'boards-list'
import type { NotificationType, RequestType } from 'vscode-messenger-common'

export interface ProfilesDocumentParams {
  readonly uri: string
}

export interface ProfileDescriptor {
  readonly name: string
  readonly fqbn?: string
  readonly programmer?: string
  readonly port?: string
  readonly protocol?: string
  readonly note?: string
  readonly portConfig?: Readonly<Record<string, string | number | boolean>>
  readonly platforms: readonly ProfilePlatformDescriptor[]
  readonly libraries: readonly ProfileLibraryDescriptor[]
}

export interface ProfilePlatformDescriptor {
  readonly platform: string
  readonly platformIndexUrl?: string
  readonly version?: string
}

export interface ProfileLibraryDescriptor {
  readonly library: string
  readonly version?: string
}

export interface BoardDescriptor {
  readonly fqbn: string
  readonly label?: string
  readonly configOptions: readonly BoardConfigOptionDescriptor[]
  readonly defaultProgrammerId?: string
  readonly programmers: readonly BoardProgrammerDescriptor[]
  readonly platformMissing?: boolean
  readonly recommendedPlatforms?: readonly ProfilePlatformDescriptor[]
  readonly recommendedLibraries?: readonly ProfileLibraryDescriptor[]
}

export interface BoardProgrammerDescriptor {
  readonly id: string
  readonly label: string
  readonly isDefault: boolean
}

export interface BoardConfigOptionDescriptor {
  readonly option: string
  readonly optionLabel: string
  readonly selectedValue?: string
  readonly selectedValueLabel?: string
  readonly defaultValue?: string
  readonly defaultValueLabel?: string
  readonly values: readonly BoardConfigOptionValueDescriptor[]
}

export interface BoardConfigOptionValueDescriptor {
  readonly value: string
  readonly valueLabel: string
  readonly isSelected: boolean
  readonly isDefault: boolean
}

export interface ProfilesDocumentState {
  readonly profiles: readonly ProfileDescriptor[]
  readonly selectedProfile?: string
  readonly hasDocument: boolean
}

// --- Diagnostics for profiles document (extension-provided) ---
export type DiagnosticSeverity = 'error' | 'warning' | 'information' | 'hint'

export interface ProfileDiagnostic {
  readonly message: string
  readonly severity: DiagnosticSeverity
  readonly range?: {
    readonly start: { line: number; character: number }
    readonly end: { line: number; character: number }
  }
}

export interface ProfilesListDiagnosticsParams extends ProfilesDocumentParams {
  /** If set, return diagnostics scoped to this profile's subtree. */
  readonly profile?: string
}

export const profilesListDiagnostics: RequestType<
  ProfilesListDiagnosticsParams,
  readonly ProfileDiagnostic[]
> = {
  method: 'boardlab.profiles.diagnostics.list',
}

export interface ProfilesRevealRangeParams extends ProfilesDocumentParams {
  readonly range: {
    readonly start: { line: number; character: number }
    readonly end: { line: number; character: number }
  }
}

export const profilesRevealRange: RequestType<ProfilesRevealRangeParams, void> =
  {
    method: 'boardlab.profiles.revealRange',
  }

// --- Quick fixes (webview + text editor) ---

export type ProfilesQuickFixDescriptor =
  | {
      readonly kind: 'edit'
      readonly title: string
      /** Opaque identifier for the fix; extension keeps the full plan. */
      readonly fixId: string
    }
  | {
      readonly kind: 'command'
      readonly title: string
      readonly command: string
      readonly args?: any[]
      readonly fixId: string
    }

export interface ProfilesListQuickFixesParams extends ProfilesDocumentParams {
  /** Optional profile name; if omitted, use the active profile's subtree. */
  readonly profile?: string
  /** Range of the diagnostic the quick fixes are requested for. */
  readonly range: {
    readonly start: { line: number; character: number }
    readonly end: { line: number; character: number }
  }
}

export const profilesListQuickFixes: RequestType<
  ProfilesListQuickFixesParams,
  readonly ProfilesQuickFixDescriptor[]
> = {
  method: 'boardlab.profiles.quickFixes.list',
}

export interface ProfilesApplyQuickFixByIdParams
  extends ProfilesDocumentParams {
  /** Identifier returned by profilesListQuickFixes. */
  readonly fixId: string
}

export const profilesApplyQuickFixById: RequestType<
  ProfilesApplyQuickFixByIdParams,
  ProfilesDocumentState
> = {
  method: 'boardlab.profiles.quickFixes.apply',
}

// --- Quick fixes ---
// --- Active profile (extension-local, not persisted to file) ---
export interface ProfilesGetActiveParams extends ProfilesDocumentParams {}
export interface ProfilesSetActiveParams extends ProfilesDocumentParams {
  /** Name of the profile to set active; omit/undefined to clear */
  readonly name?: string
}

export interface CreateProfileParams extends ProfilesDocumentParams {
  readonly profile: ProfileDescriptor
  readonly makeDefault?: boolean
}

export interface UpdateProfileParams extends ProfilesDocumentParams {
  readonly name: string
  readonly patch: Partial<ProfileDescriptor>
}

export interface DeleteProfileParams extends ProfilesDocumentParams {
  readonly name: string
  /** Must be false to bypass user prompt before deletion */
  readonly promptUser?: boolean
}

export interface SelectProfileParams extends ProfilesDocumentParams {
  readonly name?: string
}

// Rename a profile key within the document
export interface ProfilesRenameProfileParams extends ProfilesDocumentParams {
  readonly from: string
  readonly to: string
}

export interface ModifyLibraryParams extends ProfilesDocumentParams {
  readonly profile: string
  readonly library: ProfileLibraryDescriptor
}

export interface ModifyPlatformParams extends ProfilesDocumentParams {
  readonly profile: string
  readonly platform: ProfilePlatformDescriptor
}

export interface ProfilesResolveBoardDetailsParams
  extends ProfilesDocumentParams {
  readonly profile: string
}

export interface ProfilesPickBoardParams extends ProfilesDocumentParams {
  readonly profile: string
}

export interface ProfilesSelectBoardConfigOptionParams
  extends ProfilesDocumentParams {
  readonly profile: string
  readonly option: string
}

export interface ProfilesResetBoardConfigOptionParams
  extends ProfilesDocumentParams {
  readonly profile: string
  readonly option: string
}

export interface ProfilesSelectProgrammerParams extends ProfilesDocumentParams {
  readonly profile: string
  readonly programmerId?: string | null
}

export interface ProfilesSelectPortParams extends ProfilesDocumentParams {
  readonly profile: string
  readonly clear?: boolean
}

// Port configuration (monitor) additions
export interface ProfilesAddPortConfigParams extends ProfilesDocumentParams {
  readonly profile: string
  /** Existing keys to exclude from pick list */
  readonly excludeKeys?: readonly string[]
}

export interface ProfilesPickPortConfigForCreationParams
  extends ProfilesDocumentParams {
  readonly protocol: string
  readonly fqbn?: string
}

export interface PickPortConfigForCreationResult {
  readonly key: string
  readonly value: string
}

export interface ProfilesRemovePortConfigParams extends ProfilesDocumentParams {
  readonly profile: string
  readonly key: string
}

export interface ProfilesPickPortConfigValueParams
  extends ProfilesDocumentParams {
  readonly profile: string
  readonly key: string
}

export interface ProfilesPickPortConfigValueForCreationParams
  extends ProfilesDocumentParams {
  readonly protocol: string
  readonly fqbn?: string
  readonly key: string
}

export interface ProfilesCreateProfileInteractiveParams
  extends ProfilesDocumentParams {}

export const listProfiles: RequestType<
  ProfilesDocumentParams,
  ProfilesDocumentState
> = {
  method: 'boardlab.profiles.list',
}

export const createProfile: RequestType<
  CreateProfileParams,
  ProfilesDocumentState
> = {
  method: 'boardlab.profiles.create',
}

export const updateProfile: RequestType<
  UpdateProfileParams,
  ProfilesDocumentState
> = {
  method: 'boardlab.profiles.update',
}

export const deleteProfile: RequestType<
  DeleteProfileParams,
  ProfilesDocumentState
> = {
  method: 'boardlab.profiles.delete',
}

export const selectProfile: RequestType<
  SelectProfileParams,
  ProfilesDocumentState
> = {
  method: 'boardlab.profiles.select',
}

export const addLibrary: RequestType<
  ModifyLibraryParams,
  ProfilesDocumentState
> = {
  method: 'boardlab.profiles.library.add',
}

export const removeLibrary: RequestType<
  ModifyLibraryParams,
  ProfilesDocumentState
> = {
  method: 'boardlab.profiles.library.remove',
}

export const addPlatform: RequestType<
  ModifyPlatformParams,
  ProfilesDocumentState
> = {
  method: 'boardlab.profiles.platform.add',
}

export const removePlatform: RequestType<
  ModifyPlatformParams,
  ProfilesDocumentState
> = {
  method: 'boardlab.profiles.platform.remove',
}

export const profilesResolveBoardDetails: RequestType<
  ProfilesResolveBoardDetailsParams,
  BoardDescriptor | undefined
> = {
  method: 'boardlab.profiles.board.resolve',
}

export const profilesPickBoard: RequestType<
  ProfilesPickBoardParams,
  ProfilesDocumentState
> = {
  method: 'boardlab.profiles.board.pick',
}

// Draft (creation) pickers that do not mutate the document
export interface ProfilesPickPlatformForCreationParams
  extends ProfilesDocumentParams {}
export interface ProfilesPickLibraryForCreationParams
  extends ProfilesDocumentParams {}
export interface ProfilesPickPlatformVersionForCreationParams
  extends ProfilesDocumentParams {
  readonly platform: string // vendor:arch
}
export interface ProfilesPickLibraryVersionForCreationParams
  extends ProfilesDocumentParams {
  readonly library: string
}

export const profilesPickPlatformForCreation: RequestType<
  ProfilesPickPlatformForCreationParams,
  ProfilePlatformDescriptor | undefined
> = {
  method: 'boardlab.profiles.platform.pickForCreation',
}
export const profilesPickLibraryForCreation: RequestType<
  ProfilesPickLibraryForCreationParams,
  ProfileLibraryDescriptor | undefined
> = {
  method: 'boardlab.profiles.library.pickForCreation',
}
export const profilesPickPlatformVersionForCreation: RequestType<
  ProfilesPickPlatformVersionForCreationParams,
  string | undefined
> = {
  method: 'boardlab.profiles.platform.pickVersionForCreation',
}
export const profilesPickLibraryVersionForCreation: RequestType<
  ProfilesPickLibraryVersionForCreationParams,
  string | undefined
> = {
  method: 'boardlab.profiles.library.pickVersionForCreation',
}

export const profilesSelectBoardConfigOption: RequestType<
  ProfilesSelectBoardConfigOptionParams,
  ProfilesDocumentState
> = {
  method: 'boardlab.profiles.board.config.select',
}

export const profilesResetBoardConfigOption: RequestType<
  ProfilesResetBoardConfigOptionParams,
  ProfilesDocumentState
> = {
  method: 'boardlab.profiles.board.config.reset',
}

export const profilesAddPortConfig: RequestType<
  ProfilesAddPortConfigParams,
  ProfilesDocumentState
> = {
  method: 'boardlab.profiles.port.config.add',
}

export const profilesPickPortConfigForCreation: RequestType<
  ProfilesPickPortConfigForCreationParams,
  PickPortConfigForCreationResult | undefined
> = {
  method: 'boardlab.profiles.port.config.pickForCreation',
}

export const profilesRemovePortConfig: RequestType<
  ProfilesRemovePortConfigParams,
  ProfilesDocumentState
> = {
  method: 'boardlab.profiles.port.config.remove',
}

export const profilesPickPortConfigValue: RequestType<
  ProfilesPickPortConfigValueParams,
  ProfilesDocumentState
> = {
  method: 'boardlab.profiles.port.config.pickValue',
}

export const profilesPickPortConfigValueForCreation: RequestType<
  ProfilesPickPortConfigValueForCreationParams,
  string | undefined
> = {
  method: 'boardlab.profiles.port.config.pickValueForCreation',
}

// Resolve human-friendly labels for port config keys (by profile)
export interface ProfilesResolvePortConfigLabelsParams
  extends ProfilesDocumentParams {
  readonly profile: string
}
export type PortConfigLabels = Readonly<Record<string, string>>

export const profilesResolvePortConfigLabels: RequestType<
  ProfilesResolvePortConfigLabelsParams,
  PortConfigLabels
> = {
  method: 'boardlab.profiles.port.config.resolveLabels',
}

export const profilesSelectProgrammer: RequestType<
  ProfilesSelectProgrammerParams,
  ProfilesDocumentState
> = {
  method: 'boardlab.profiles.programmer.select',
}

export const profilesSelectPort: RequestType<
  ProfilesSelectPortParams,
  ProfilesDocumentState
> = {
  method: 'boardlab.profiles.port.select',
}

export const profilesCreateProfileInteractive: RequestType<
  ProfilesCreateProfileInteractiveParams,
  ProfilesDocumentState
> = {
  method: 'boardlab.profiles.createInteractive',
}

export interface ProfilesPickPlatformParams extends ProfilesDocumentParams {
  readonly profile: string
  /** Vendor:arch IDs to exclude from pick list */
  readonly exclude?: readonly string[]
}

export interface ProfilesPickLibraryParams extends ProfilesDocumentParams {
  readonly profile: string
  /** Library names to exclude from pick list */
  readonly exclude?: readonly string[]
}

export const profilesPickPlatform: RequestType<
  ProfilesPickPlatformParams,
  ProfilesDocumentState
> = {
  method: 'boardlab.profiles.platform.pick',
}

export const profilesPickLibrary: RequestType<
  ProfilesPickLibraryParams,
  ProfilesDocumentState
> = {
  method: 'boardlab.profiles.library.pick',
}

export const profilesRenameProfile: RequestType<
  ProfilesRenameProfileParams,
  ProfilesDocumentState
> = {
  method: 'boardlab.profiles.rename',
}

// Pick and update version for existing entries
export interface ProfilesPickLibraryVersionParams
  extends ProfilesDocumentParams {
  readonly profile: string
  readonly library: string
}

export interface ProfilesPickPlatformVersionParams
  extends ProfilesDocumentParams {
  readonly profile: string
  readonly platform: string // vendor:arch
}

// Pick or clear a platform index URL for an existing platform entry
export interface ProfilesPickPlatformIndexUrlParams
  extends ProfilesDocumentParams {
  readonly profile: string
  readonly platform: string // vendor:arch
  readonly clear?: boolean
}

export const profilesPickLibraryVersion: RequestType<
  ProfilesPickLibraryVersionParams,
  ProfilesDocumentState
> = {
  method: 'boardlab.profiles.library.pickVersion',
}

// --- Draft (creation) config/programmer/port pickers ---
export interface ProfilesPickBoardConfigOptionForCreationParams
  extends ProfilesDocumentParams {
  readonly fqbn: string
  readonly option: string
}
export interface ProfilesResetBoardConfigOptionForCreationParams
  extends ProfilesDocumentParams {
  readonly fqbn: string
  readonly option: string
}
export interface ProfilesPickProgrammerForCreationParams
  extends ProfilesDocumentParams {
  readonly fqbn: string
}
export interface ProfilesPickPortForCreationParams
  extends ProfilesDocumentParams {}

export interface PickBoardConfigForCreationResult {
  readonly fqbn: string
  readonly descriptor?: BoardDescriptor
}
export interface PickProgrammerForCreationResult {
  readonly programmerId?: string | null
}
export interface PickPortForCreationResult {
  readonly port?: string
  readonly protocol?: string
}

export const profilesPickBoardConfigOptionForCreation: RequestType<
  ProfilesPickBoardConfigOptionForCreationParams,
  PickBoardConfigForCreationResult | undefined
> = {
  method: 'boardlab.profiles.board.config.pickForCreation',
}

export const profilesResetBoardConfigOptionForCreation: RequestType<
  ProfilesResetBoardConfigOptionForCreationParams,
  PickBoardConfigForCreationResult | undefined
> = {
  method: 'boardlab.profiles.board.config.resetForCreation',
}

export const profilesPickProgrammerForCreation: RequestType<
  ProfilesPickProgrammerForCreationParams,
  PickProgrammerForCreationResult | undefined
> = {
  method: 'boardlab.profiles.programmer.pickForCreation',
}

export const profilesPickPortForCreation: RequestType<
  ProfilesPickPortForCreationParams,
  PickPortForCreationResult | undefined
> = {
  method: 'boardlab.profiles.port.pickForCreation',
}

export const profilesPickPlatformVersion: RequestType<
  ProfilesPickPlatformVersionParams,
  ProfilesDocumentState
> = {
  method: 'boardlab.profiles.platform.pickVersion',
}

export const profilesPickPlatformIndexUrl: RequestType<
  ProfilesPickPlatformIndexUrlParams,
  ProfilesDocumentState
> = {
  method: 'boardlab.profiles.platform.pickIndexUrl',
}

// Resolve human-friendly platform name for a platform id (vendor:arch)
export interface ProfilesResolvePlatformNameParams
  extends ProfilesDocumentParams {
  readonly platform: string
}
export interface PlatformNameInfo {
  readonly id: string
  readonly name?: string
}
export const profilesResolvePlatformName: RequestType<
  ProfilesResolvePlatformNameParams,
  PlatformNameInfo | undefined
> = {
  method: 'boardlab.profiles.platform.resolveName',
}

export interface PickBoardForCreationParams extends ProfilesDocumentParams {}

export const pickBoardForCreation: RequestType<
  PickBoardForCreationParams,
  BoardDescriptor | undefined
> = {
  method: 'boardlab.profiles.board.pickForCreation',
}

export const notifyProfilesChanged: NotificationType<ProfilesDocumentState> = {
  method: 'boardlab.profiles.changed',
}

// --- Profiles detected ports (from boards list watcher) ---
export const profilesRequestDetectedPorts: RequestType<void, DetectedPorts> = {
  method: 'boardlab.profiles.detectedPorts',
}

export const notifyProfilesDetectedPortsChanged: NotificationType<DetectedPorts> =
  {
    method: 'boardlab.profiles.detectedPorts.changed',
  }

// Request/notify active profile
export const profilesGetActiveProfile: RequestType<
  ProfilesGetActiveParams,
  string | undefined
> = {
  method: 'boardlab.profiles.active.get',
}

export const profilesSetActiveProfile: RequestType<
  ProfilesSetActiveParams,
  void
> = {
  method: 'boardlab.profiles.active.set',
}

export const notifyProfilesActiveProfileChanged: NotificationType<
  Readonly<{ uri: string; name?: string }>
> = {
  method: 'boardlab.profiles.active.changed',
}
