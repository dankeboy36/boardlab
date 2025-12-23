import type { NotificationType, RequestType } from 'vscode-messenger-common'

import type { Board } from './boards'
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

export interface Platform extends Resource {
  readonly id: string
  readonly boards: readonly Board[]
  readonly deprecated?: boolean
}

export const busyPlatforms: RequestType<void, string[]> = {
  method: 'busy-platforms',
}
export const searchPlatform: RequestType<
  SearchResourceParams<SearchFilterParams>,
  Platform[]
> = {
  method: 'search-platform',
}
export const installPlatform: RequestType<InstallResourceParams, void> = {
  method: 'install-platform',
}
export const uninstallPlatform: RequestType<UninstallResourceParams, void> = {
  method: 'uninstall-platform',
}
export const willInstallPlatform: NotificationType<InstallEventParams> = {
  method: 'will-install-platform',
}
export const didInstallPlatform: NotificationType<InstallEventParams> = {
  method: 'did-install-platform',
}
export const didErrorInstallPlatform: NotificationType<
  InstallEventParams & ErrorEventParams
> = {
  method: 'did-error-install-platform',
}
export const willUninstallPlatform: NotificationType<InstallEventParams> = {
  method: 'will-uninstall-platform',
}
export const didUninstallPlatform: NotificationType<InstallEventParams> = {
  method: 'did-uninstall-platform',
}
export const didErrorUninstallPlatform: NotificationType<
  InstallEventParams & ErrorEventParams
> = {
  method: 'did-error-uninstall-platform',
}

export const PlatformFilterTypeLiterals = [
  'All',
  'Updatable',
  'Arduino',
  'Contributed',
  'Arduino Certified',
  'Partner',
  'Arduino@Heart',
] as const
export type PlatformFilterType = (typeof PlatformFilterTypeLiterals)[number]

export type PlatformSearchFilter = Record<'type', PlatformFilterType>

export type Platforms = Resources<Platform, PlatformSearchFilter>

// Webview filter control (Platforms)
export interface PlatformsFilterChangeParams {
  readonly type?: PlatformFilterType | ''
}

export const notifyPlatformsFilterChanged: NotificationType<PlatformsFilterChangeParams> =
  {
    method: 'notify-platforms-filter-changed',
  }

export const setPlatformsFilterContext: RequestType<
  PlatformsFilterChangeParams,
  void
> = {
  method: 'set-platforms-filter-context',
}

export const didUpdatePlatformIndex: NotificationType<void> = {
  method: 'did-update-platform-index',
}
