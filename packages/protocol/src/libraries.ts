import type { NotificationType, RequestType } from 'vscode-messenger-common'

import type {
  ErrorEventParams,
  InstallEventParams,
  InstallResourceParams,
  Resource,
  Resources,
  SearchFilterParams,
  SearchResourceParams,
  UninstallResourceParams,
} from './resources'

export interface Library extends Resource {
  readonly category: string
  readonly installPath?: string
  readonly includes?: readonly string[]
  readonly examplePaths?: readonly string[]
}

export const busyLibraries: RequestType<void, string[]> = {
  method: 'busy-libraries',
}
export const searchLibrary: RequestType<
  SearchResourceParams<SearchFilterParams>,
  Library[]
> = {
  method: 'search-libraries',
}
export const installLibrary: RequestType<InstallResourceParams, void> = {
  method: 'install-libraries',
}
export const uninstallLibrary: RequestType<UninstallResourceParams, void> = {
  method: 'uninstall-libraries',
}
export const willInstallLibrary: NotificationType<InstallEventParams> = {
  method: 'will-install-libraries',
}
export const didInstallLibrary: NotificationType<InstallEventParams> = {
  method: 'did-install-libraries',
}
export const didErrorInstallLibrary: NotificationType<
  InstallEventParams & ErrorEventParams
> = {
  method: 'did-error-install-libraries',
}
export const willUninstallLibrary: NotificationType<InstallEventParams> = {
  method: 'will-uninstall-libraries',
}
export const didUninstallLibrary: NotificationType<InstallEventParams> = {
  method: 'did-uninstall-libraries',
}
export const didErrorUninstallLibrary: NotificationType<
  InstallEventParams & ErrorEventParams
> = {
  method: 'did-error-uninstall-libraries',
}

export const LibraryFilterTypeLiterals = [
  'All',
  'Updatable',
  'Installed',
  'Arduino',
  'Partner',
  'Recommended',
  'Contributed',
  'Retired',
] as const
export type LibraryFilterType = (typeof LibraryFilterTypeLiterals)[number]

export const LibraryFilterTopicLiterals = [
  'All',
  'Communication',
  'Data Processing',
  'Data Storage',
  'Device Control',
  'Display',
  'Other',
  'Sensors',
  'Signal Input/Output',
  'Timing',
  'Uncategorized',
] as const
export type LibraryFilterTopic = (typeof LibraryFilterTopicLiterals)[number]

export type LibrarySearchFilter = Record<'type', LibraryFilterType> &
  Record<'topic', LibraryFilterTopic>

export type Libraries = Resources<Library, LibrarySearchFilter>

// Webview filter control (Libraries)
// - Extension -> Webview: notify current filter (e.g., from menu selection)
// - Webview -> Extension: request to set VS Code context keys reflecting the filter

export interface LibrariesFilterChangeParams {
  readonly type?: LibraryFilterType | ''
  readonly topic?: LibraryFilterTopic | ''
}

export const notifyLibrariesFilterChanged: NotificationType<LibrariesFilterChangeParams> =
  {
    method: 'notify-libraries-filter-changed',
  }

export const setLibrariesFilterContext: RequestType<
  LibrariesFilterChangeParams,
  void
> = {
  method: 'set-libraries-filter-context',
}

export const didUpdateLibrariesIndex: NotificationType<void> = {
  method: 'did-update-libraries-index',
}
