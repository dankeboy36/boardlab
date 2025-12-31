import type { Event, IDisposable } from '@c4312/evt'
import type { CancellationToken } from 'vscode-messenger-common'

import type { Installable, Version } from './installable'

export interface Resource extends Installable {
  /**
   * When the resource is a library, the `id` and the `name` are the same. Use
   * `id` to compare resources, and `name` for the UI.
   */
  readonly id: string
  readonly name: string
  readonly summary: string
  readonly description?: string
  readonly author: string
  readonly types: readonly string[]
  readonly website?: string
}

export interface InstallResourceParams {
  readonly id: string
  // UI only
  readonly name: string
  readonly version: Version
}

export interface UninstallResourceParams {
  readonly id: string
  // UI only
  readonly name: string
}

export type SearchFilterParams = Record<string, string>

export interface SearchResourceParams<F extends SearchFilterParams> {
  readonly query: string
  readonly filter?: F
}

export interface ResourcesServer<
  T extends Resource = Resource,
  F extends SearchFilterParams = SearchFilterParams,
> {
  install(params: InstallResourceParams): Promise<void>
  uninstall(params: UninstallResourceParams): Promise<void>
  search(
    params: SearchResourceParams<F>,
    token: CancellationToken
  ): Promise<T[]>
  busyResources(): Promise<string[]>
}

export interface InstallEventParams {
  readonly id: string
  readonly version: string
}
export interface UninstallEventParams {
  readonly id: string
}
export interface ErrorEventParams {
  readonly message: string
}

export interface ResourcesClient {
  readonly onWillInstall: Event<InstallEventParams>
  readonly onDidInstall: Event<InstallEventParams>
  readonly onDidErrorInstall: Event<InstallEventParams & ErrorEventParams>
  readonly onWillUninstall: Event<UninstallEventParams>
  readonly onDidUninstall: Event<UninstallEventParams>
  readonly onDidErrorUninstall: Event<UninstallEventParams & ErrorEventParams>
  readonly onDidUpdateIndex: Event<void>
}

export type Resources<
  T extends Resource = Resource,
  F extends SearchFilterParams = SearchFilterParams,
> = ResourcesServer<T, F> & ResourcesClient & IDisposable
