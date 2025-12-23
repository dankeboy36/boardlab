import {
  Platform as ApiPlatform,
  ErrorEventParams,
  InstallEventParams,
  InstallResourceParams,
  PlatformSearchFilter,
  Library as ProtocolLibrary,
  Resource,
  Resources,
  SearchFilterParams,
  SearchResourceParams,
  UninstallEventParams,
  UninstallResourceParams,
  Version,
  busyLibraries,
  busyPlatforms,
  didErrorInstallLibrary,
  didErrorInstallPlatform,
  didErrorUninstallLibrary,
  didErrorUninstallPlatform,
  didInstallLibrary,
  didInstallPlatform,
  didUninstallLibrary,
  didUninstallPlatform,
  didUpdateLibrariesIndex,
  didUpdatePlatformIndex,
  installLibrary,
  installPlatform,
  searchLibrary,
  searchPlatform,
  uninstallLibrary,
  uninstallPlatform,
  willInstallLibrary,
  willInstallPlatform,
  willUninstallLibrary,
  willUninstallPlatform,
} from '@boardlab/protocol'
import type {
  Library,
  LibraryInstallResponse,
  LibraryUninstallResponse,
  PlatformInstallResponse,
  PlatformUninstallResponse,
} from 'ardunno-cli'
import defer from 'p-defer'
import { compareLoose } from 'semver'
import * as vscode from 'vscode'
import { Messenger } from 'vscode-messenger'
import type {
  CancellationToken,
  MessageParticipant,
} from 'vscode-messenger-common'

import type { BoardLabContext } from './boardlabContext'
import type { Arduino } from './cli/arduino'
import { disposeAll } from './utils'

interface ResourceManagerToolbarParam {
  readonly webviewId: string
  readonly webviewSection: 'toolbar' // TODO: string type?
  readonly args: [Resource, Version]
  readonly canInstallLatest?: boolean
  readonly canInstallSelected?: boolean
  readonly canUpdate?: boolean
  readonly canRemove?: boolean
}

abstract class ResourcesManager<
  T extends Resource = Resource,
  F extends SearchFilterParams = SearchFilterParams,
> implements Resources
{
  // Generic quick cache for validation lookups
  protected _quickCache: Map<string, QuickResource> | undefined

  private readonly onWillInstallEmitter =
    new vscode.EventEmitter<InstallEventParams>()

  private readonly onDidInstallEmitter =
    new vscode.EventEmitter<InstallEventParams>()

  private readonly onDidErrorInstallEmitter = new vscode.EventEmitter<
    InstallEventParams & ErrorEventParams
  >()

  private readonly onWillUninstallEmitter =
    new vscode.EventEmitter<UninstallEventParams>()

  private readonly onDidUninstallEmitter =
    new vscode.EventEmitter<UninstallEventParams>()

  private readonly onDidErrorUninstallEmitter = new vscode.EventEmitter<
    UninstallEventParams & ErrorEventParams
  >()

  private readonly onDidUpdateIndexEmitter = new vscode.EventEmitter<void>()

  // Emits an event on install/uninstall success/error + index update
  private readonly onDidUpdateEmitter = new vscode.EventEmitter<void>()

  protected readonly toDispose: vscode.Disposable[] = [
    this.onWillInstallEmitter,
    this.onDidInstallEmitter,
    this.onDidErrorInstallEmitter,
    this.onWillUninstallEmitter,
    this.onDidUninstallEmitter,
    this.onDidErrorUninstallEmitter,
    this.onDidUpdateIndexEmitter,
    this.onDidUpdateEmitter,
  ]

  readonly onWillInstall = this.onWillInstallEmitter.event
  readonly onDidInstall = this.onDidInstallEmitter.event
  readonly onDidErrorInstall = this.onDidErrorInstallEmitter.event
  readonly onWillUninstall = this.onWillUninstallEmitter.event
  readonly onDidUninstall = this.onDidUninstallEmitter.event
  readonly onDidErrorUninstall = this.onDidErrorUninstallEmitter.event
  readonly onDidUpdateIndex = this.onDidUpdateIndexEmitter.event
  readonly onDidUpdate = this.onDidUpdateEmitter.event

  readonly _busyResources = new Set<string>()

  constructor(
    protected readonly boardlabContext: BoardLabContext,
    protected readonly webviewType?: string
  ) {
    this.toDispose.push(
      this.onDidInstall(() => this.onDidUpdateEmitter.fire()),
      this.onDidErrorInstall(() => this.onDidUpdateEmitter.fire()),
      this.onDidUninstall(() => this.onDidUpdateEmitter.fire()),
      this.onDidErrorUninstall(() => this.onDidUpdateEmitter.fire()),
      this.onDidUpdateIndex(() => this.onDidUpdateEmitter.fire())
    )
  }

  /** Invalidate generic quick cache on any mutating or index update events. */
  protected wireQuickCacheInvalidation(): void {
    const invalidate = () => (this._quickCache = undefined)
    this.toDispose.push(
      this.onDidInstall(invalidate),
      this.onDidUninstall(invalidate),
      this.onDidErrorInstall(invalidate),
      this.onDidErrorUninstall(invalidate),
      this.onDidUpdateIndex(invalidate)
    )
  }

  /**
   * Update a quick cache entry. Clones availableVersions to avoid readonly
   * issues.
   */
  protected setQuickCacheEntry(id: string, info: QuickResource): void {
    if (!this._quickCache) this._quickCache = new Map()
    this._quickCache.set(id, {
      availableVersions: [...info.availableVersions],
      installedVersion: info.installedVersion,
      label: info.label,
    })
  }

  /** Lookup from quick cache or load via fetcher, then cache. */
  async lookupQuick(
    id: string,
    fetcher: (
      arduino: BoardLabContext,
      signal?: AbortSignal
    ) => Promise<QuickResource | undefined>,
    signal?: AbortSignal
  ): Promise<QuickResource | undefined> {
    const cached = this._quickCache?.get(id)
    if (cached) return cached
    const loaded = await fetcher(this.boardlabContext, signal)
    if (loaded) this.setQuickCacheEntry(id, loaded)
    return loaded
  }

  async busyResources(): Promise<string[]> {
    return Array.from(this._busyResources)
  }

  protected async confirmInstall(
    params: InstallResourceParams
  ): Promise<InstallResourceParams | undefined> {
    return params
  }

  async install(params: InstallResourceParams): Promise<void> {
    const shouldProceed = await this.confirmInstall(params)
    if (!shouldProceed) {
      return
    }
    const arduino = await this.arduino()
    this.fireWillInstall(params)
    try {
      await modifyInstallation(
        (signal) => this.doInstall(params, arduino, signal),
        params.name
      )
      this.fireDidInstall(params)
    } catch (reason) {
      this.fireDidErrorInstall(params, reason)
      throw reason
    }
  }

  protected async confirmUninstall(
    _params: UninstallResourceParams
  ): Promise<boolean> {
    return true
  }

  async uninstall(params: UninstallResourceParams): Promise<void> {
    const shouldProceed = await this.confirmUninstall(params)
    if (!shouldProceed) {
      return
    }
    const arduino = await this.arduino()
    this.fireWillUninstall(params)
    try {
      await modifyInstallation(
        (signal) => this.doUninstall(params, arduino, signal),
        params.name
      )
      this.fireDidUninstall(params)
    } catch (reason) {
      this.fireDidErrorUninstall(params, reason)
      throw reason
    }
  }

  async search(
    params: SearchResourceParams<F>,
    token: CancellationToken
  ): Promise<T[]> {
    const run = async () => {
      const abortController = new AbortController()
      const { signal } = abortController
      const toDispose = token.onCancellationRequested(() =>
        abortController.abort()
      )
      try {
        const arduino = await this.arduino()
        const result = await this.doSearch(params, arduino, signal)
        return result
      } finally {
        toDispose.dispose()
      }
    }
    const viewId = this.webviewType
    if (!viewId) {
      return run()
    }
    return vscode.window.withProgress({ location: { viewId } }, run)
  }

  protected abstract doNotifyIndexUpdated(): void

  notifyIndexUpdated(): void {
    this.doNotifyIndexUpdated()
    this.onDidUpdateIndexEmitter.fire()
  }

  abstract doInstall(
    params: InstallResourceParams,
    arduino: Arduino,
    signal: AbortSignal
  ): AsyncIterable<InstallResponse>

  abstract doUninstall(
    params: UninstallResourceParams,
    arduino: Arduino,
    signal: AbortSignal
  ): AsyncIterable<UninstallResponse>

  abstract doSearch(
    params: SearchResourceParams<F>,
    arduino: Arduino,
    signal?: AbortSignal
  ): Promise<T[]>

  dispose() {
    disposeAll(...this.toDispose)
  }

  protected async arduino(): Promise<Arduino> {
    const client = await this.boardlabContext.client
    return client.arduino
  }

  private fireWillInstall(params: InstallResourceParams): void {
    const { id, version } = params
    this._busyResources.add(id)
    this.onWillInstallEmitter.fire({ id, version })
  }

  private fireDidInstall(params: InstallResourceParams): void {
    const { id, version } = params
    this._busyResources.delete(id)
    this.onDidInstallEmitter.fire({ id, version })
  }

  private fireDidErrorInstall(
    params: InstallResourceParams,
    reason: unknown
  ): void {
    const { id, version } = params
    const message = reason instanceof Error ? reason.message : String(reason)
    this._busyResources.delete(id)
    this.onDidErrorInstallEmitter.fire({ id, version, message })
  }

  private fireWillUninstall(params: UninstallResourceParams): void {
    const { id } = params
    this._busyResources.add(id)
    this.onWillUninstallEmitter.fire({ id })
  }

  private fireDidUninstall(params: UninstallResourceParams): void {
    const { id } = params
    this._busyResources.delete(id)
    this.onDidUninstallEmitter.fire({ id })
  }

  private fireDidErrorUninstall(
    params: UninstallResourceParams,
    reason: unknown
  ): void {
    const { id } = params
    const message = reason instanceof Error ? reason.message : String(reason)
    this._busyResources.delete(id)
    this.onDidErrorUninstallEmitter.fire({ id, message })
  }
}

export class LibrariesManager extends ResourcesManager {
  private _installedVersions: Map<string, string> | undefined
  constructor(
    boardlabContext: BoardLabContext,
    private readonly messenger?: Messenger,
    webviewType?: string
  ) {
    super(boardlabContext, webviewType)
    // Invalidate shared quick cache on install/uninstall/index updates
    this.wireQuickCacheInvalidation()
    const registerInstallCommand = (
      commandId: string,
      resolveVersion: (
        resource: Resource,
        selectedVersion: Version | undefined
      ) => Version | undefined
    ) =>
      vscode.commands.registerCommand(
        commandId,
        async (params: ResourceManagerToolbarParam | undefined) => {
          const [resource, selectedVersion] = (params?.args ?? []) as [
            Resource | undefined,
            Version | undefined,
          ]
          if (!resource) {
            return
          }
          const version = resolveVersion(resource, selectedVersion)
          if (!version) {
            return
          }
          const { id, name } = resource
          return this.install({ id, name, version })
        }
      )
    const registerUninstallCommand = (commandId: string) =>
      vscode.commands.registerCommand(
        commandId,
        async (params: ResourceManagerToolbarParam | undefined) => {
          const [resource] = (params?.args ?? []) as [
            Resource | undefined,
            Version | undefined,
          ]
          if (!resource) {
            return
          }
          const { id, name } = resource
          return this.uninstall({ id, name })
        }
      )
    this.toDispose.push(
      registerInstallCommand(
        'boardlab.installLibrary',
        (_resource, version) => version ?? _resource.availableVersions[0]
      ),
      registerInstallCommand(
        'boardlab.installLatestLibrary',
        (resource) => resource.availableVersions[0]
      ),
      registerInstallCommand(
        'boardlab.updateLibrary',
        (_resource, version) => version ?? _resource.availableVersions[0]
      ),
      registerUninstallCommand('boardlab.uninstallLibrary')
    )
    if (messenger) {
      this.toDispose.push(
        messenger.onRequest(installLibrary, (params) => this.install(params)),
        messenger.onRequest(uninstallLibrary, (params) =>
          this.uninstall(params)
        ),
        messenger.onRequest(searchLibrary, (params, _, token) =>
          this.search(params, token)
        ),
        messenger.onRequest(busyLibraries, () => this.busyResources())
      )
      // webviewType instead of webviewId because it's in a panel?
      if (webviewType) {
        const webview: MessageParticipant = { type: 'webview', webviewType }
        this.toDispose.push(
          this.onWillInstall((event) =>
            messenger.sendNotification(willInstallLibrary, webview, event)
          ),
          this.onDidInstall((event) =>
            messenger.sendNotification(didInstallLibrary, webview, event)
          ),
          this.onDidErrorInstall((event) =>
            messenger.sendNotification(didErrorInstallLibrary, webview, event)
          ),
          this.onWillUninstall((event) =>
            messenger.sendNotification(willUninstallLibrary, webview, event)
          ),
          this.onDidUninstall((event) =>
            messenger.sendNotification(didUninstallLibrary, webview, event)
          ),
          this.onDidErrorUninstall((event) =>
            messenger.sendNotification(didErrorUninstallLibrary, webview, event)
          )
        )
      }
    }
    // Invalidate quick caches when library state changes or indexes update
    const invalidateInstalled = () => (this._installedVersions = undefined)
    this.toDispose.push(
      this.onDidInstall(invalidateInstalled),
      this.onDidUninstall(invalidateInstalled),
      this.onDidErrorInstall(invalidateInstalled),
      this.onDidErrorUninstall(invalidateInstalled),
      this.onDidUpdateIndex(invalidateInstalled)
    )
  }

  override doNotifyIndexUpdated(): void {
    if (this.webviewType) {
      this.messenger?.sendNotification(didUpdateLibrariesIndex, {
        type: 'webview',
        webviewType: this.webviewType,
      })
    }
  }

  override doInstall(
    params: InstallResourceParams,
    arduino: Arduino,
    signal: AbortSignal
  ): AsyncIterable<InstallResponse> {
    const { id, version } = params
    // TODO: define extended type of InstallResourceParams for libs
    const noDeps = 'noDeps' in params && params.noDeps === true
    return arduino.installLibrary({ name: id, version, noDeps }, signal)
  }

  override doUninstall(
    params: UninstallResourceParams,
    arduino: Arduino,
    signal: AbortSignal
  ): AsyncIterable<UninstallResponse> {
    const { id } = params
    return arduino.uninstallLibrary({ name: id }, signal)
  }

  override async doSearch(
    params: SearchResourceParams<SearchFilterParams>,
    arduino: Arduino,
    signal?: AbortSignal | undefined
  ): Promise<ProtocolLibrary[]> {
    const [installedLibraries, searchResult] = await Promise.all([
      arduino.listLibraries({}, signal),
      arduino.searchLibrary(
        { omitReleasesDetails: true, searchArgs: params.query },
        signal
      ),
    ])
    // TODO: move to a field and update (or invalidate) on install/uninstall
    const cache = new Map<string, Library>()
    for (const { library } of installedLibraries) {
      if (library) {
        cache.set(library.name, library)
      }
    }
    // Update quick cache of installed versions (local map)
    this._installedVersions = new Map(
      Array.from(cache.entries()).map(([name, lib]) => [name, lib.version])
    )
    const libraries: ProtocolLibrary[] = []
    for (const library of searchResult) {
      if (!library.availableVersions.length) {
        continue
      }
      const { latest } = library
      if (!latest) {
        continue
      }
      const { name, availableVersions } = library
      const installedLibrary = cache.get(name)
      const available = availableVersions.sort(compareLoose).reverse()

      libraries.push({
        id: name,
        name,
        availableVersions: available,
        installedVersion: installedLibrary?.version,
        author: latest.author,
        category: latest.category,
        examplePaths: installedLibrary?.examples,
        includes: installedLibrary?.providesIncludes,
        installPath: installedLibrary?.installDir,
        summary: latest.sentence,
        description: latest.paragraph,
        types: latest.types,
        website: latest.website,
      })
      this.setQuickCacheEntry(name, {
        availableVersions: available,
        installedVersion: installedLibrary?.version,
        label: name,
      })
    }
    return libraries
  }

  /** Quick lookup for validation: available + installed version for a library. */
  async lookupLibraryQuick(
    name: string,
    signal?: AbortSignal
  ): Promise<QuickResource | undefined> {
    return this.lookupQuick(
      name,
      async (boardlabContext, s) => {
        if (!this._installedVersions) {
          const { arduino } = await boardlabContext.client
          const installed = await arduino.listLibraries({}, s)
          const map = new Map<string, string>()
          for (const { library } of installed) {
            if (library?.name && library?.version) {
              map.set(library.name, library.version)
            }
          }
          this._installedVersions = map
        }
        const { arduino } = await boardlabContext.client
        const results = await arduino.searchLibrary({ searchArgs: name }, s)
        const match = results.find((l: any) => l.name === name)
        if (!match) return undefined
        const installedVersion = this._installedVersions.get(name)
        return {
          availableVersions: Object.keys(match.releases ?? {})
            .sort(compareLoose)
            .reverse(),
          installedVersion,
          label: name,
        }
      },
      signal
    )
  }

  protected override async confirmInstall(
    params: InstallResourceParams
  ): Promise<InstallResourceParams | undefined> {
    const label = params.name || params.id
    const arduino = await this.arduino()
    const response = await arduino.resolveLibraryDependencies({
      name: params.id,
      version: params.version,
      doNotUpdateInstalledLibraries: true,
    })
    const dependencies = (response.dependencies ?? []).filter(
      (dep) => dep.name !== params.id
    )

    const missingDependencies = dependencies.filter(
      (dep) => !dep.versionInstalled
    )

    if (!missingDependencies.length) {
      const answer = await vscode.window.showInformationMessage(
        'Install Library',
        {
          modal: true,
          detail: `Do you want to install version ${params.version} of the '${label}' library?`,
        },
        'Install'
      )
      return answer === 'Install' ? params : undefined
    }

    const detailsLines: string[] = []
    if (missingDependencies.length === 1) {
      const dep = missingDependencies[0]
      detailsLines.push(
        `The library '${label}:${params.version}' needs another dependency currently not installed:`
      )
      detailsLines.push(`- ${dep.name} (${dep.versionRequired})`)
      detailsLines.push('', 'Would you like to install the missing dependency?')
    } else if (missingDependencies.length > 1) {
      detailsLines.push(
        `The library '${label}:${params.version}' needs some other dependencies currently not installed:`
      )
      for (const dep of missingDependencies) {
        detailsLines.push(`- ${dep.name} (${dep.versionRequired})`)
      }
      detailsLines.push(
        '',
        'Would you like to install all the missing dependencies?'
      )
    }

    const detail = detailsLines.join('\n')

    const answer = await vscode.window.showInformationMessage(
      'Install Library',
      {
        modal: true,
        detail,
      },
      'Install All',
      `Install ${params.name} only`
    )

    if (!answer) {
      return undefined
    }

    if (answer === 'Install All') {
      return params
    }

    return Object.assign(params, { noDep: true }) // It's a hack
  }

  protected override async confirmUninstall(
    params: UninstallResourceParams
  ): Promise<boolean> {
    const label = params.name || params.id
    const answer = await vscode.window.showInformationMessage(
      'Uninstall Library',
      {
        modal: true,
        detail: `Do you want to uninstall the '${label}' library?`,
      },
      'Uninstall'
    )
    return answer === 'Uninstall'
  }
}

export interface QuickResource {
  label: string
  installedVersion: string | undefined
  /** The first is the most recent */
  availableVersions: string[]
}

export class PlatformsManager extends ResourcesManager<
  ApiPlatform,
  SearchFilterParams
> {
  // Cached platform names (id -> human-readable label)
  private platformNamesLoading: Promise<void> | undefined
  private quickPlatformsCache: Map<string, QuickResource> | undefined

  constructor(
    boardlabContext: BoardLabContext,
    private readonly messenger?: Messenger,
    webviewType?: string
  ) {
    super(boardlabContext, webviewType)
    // Invalidate shared quick cache on install/uninstall/index updates
    this.wireQuickCacheInvalidation()
    const registerInstallCommand = (
      commandId: string,
      resolveVersion: (
        resource: Resource,
        selectedVersion: Version | undefined
      ) => Version | undefined
    ) =>
      vscode.commands.registerCommand(
        commandId,
        async (params: ResourceManagerToolbarParam | undefined) => {
          const [resource, selectedVersion] = (params?.args ?? []) as [
            Resource | undefined,
            Version | undefined,
          ]
          if (!resource) {
            return
          }
          const version = resolveVersion(resource, selectedVersion)
          if (!version) {
            return
          }
          const { id, name } = resource
          return this.install({ id, name, version })
        }
      )
    const registerUninstallCommand = (commandId: string) =>
      vscode.commands.registerCommand(
        commandId,
        async (params: ResourceManagerToolbarParam | undefined) => {
          const [resource] = (params?.args ?? []) as [
            Resource | undefined,
            Version | undefined,
          ]
          if (!resource) {
            return
          }
          const { id, name } = resource
          return this.uninstall({ id, name })
        }
      )
    this.toDispose.push(
      registerInstallCommand(
        'boardlab.installPlatform',
        (_resource, version) => version ?? _resource.availableVersions[0]
      ),
      registerInstallCommand(
        'boardlab.installLatestPlatform',
        (resource) => resource.availableVersions[0]
      ),
      registerInstallCommand(
        'boardlab.updatePlatform',
        (_resource, version) => version ?? _resource.availableVersions[0]
      ),
      registerUninstallCommand('boardlab.uninstallPlatform')
    )
    if (messenger) {
      this.toDispose.push(
        messenger.onRequest(installPlatform, (params: InstallResourceParams) =>
          this.install(params)
        ),
        messenger.onRequest(uninstallPlatform, (params) =>
          this.uninstall(params)
        ),
        messenger.onRequest(searchPlatform, (params, _, token) =>
          this.search(params, token)
        ),
        messenger.onRequest(busyPlatforms, () => this.busyResources())
      )
      // webviewType instead of webviewId because it's in a panel?
      if (webviewType) {
        const webview: MessageParticipant = { type: 'webview', webviewType }
        this.toDispose.push(
          this.onWillInstall((event) =>
            messenger.sendNotification(willInstallPlatform, webview, event)
          ),
          this.onDidInstall((event) =>
            messenger.sendNotification(didInstallPlatform, webview, event)
          ),
          this.onDidErrorInstall((event) =>
            messenger.sendNotification(didErrorInstallPlatform, webview, event)
          ),
          this.onWillUninstall((event) =>
            messenger.sendNotification(willUninstallPlatform, webview, event)
          ),
          this.onDidUninstall((event) =>
            messenger.sendNotification(didUninstallPlatform, webview, event)
          ),
          this.onDidErrorUninstall((event) =>
            messenger.sendNotification(
              didErrorUninstallPlatform,
              webview,
              event
            )
          )
        )
      }
    }

    // Invalidate platform quick cache when platforms change or indexes update
    const invalidatePlatformNames = () => {
      this.quickPlatformsCache = undefined
      this.platformNamesLoading = undefined
    }
    this.toDispose.push(
      this.onDidInstall(() => invalidatePlatformNames()),
      this.onDidUninstall(() => invalidatePlatformNames()),
      this.onDidErrorInstall(() => invalidatePlatformNames()),
      this.onDidErrorUninstall(() => invalidatePlatformNames()),
      this.onDidUpdateIndex(() => invalidatePlatformNames())
    )
  }

  /**
   * Ensure platform names cache is populated. Uses a single searchPlatform('')
   * call and is invalidated when platforms change or indexes update.
   */
  async ensureQuickPlatforms(): Promise<void> {
    if (this.quickPlatformsCache && !this.platformNamesLoading) {
      return
    }

    if (this.platformNamesLoading) {
      await this.platformNamesLoading
      return
    }

    this.quickPlatformsCache = new Map()
    const cache = this.quickPlatformsCache
    this.platformNamesLoading = (async () => {
      try {
        const arduino = await this.arduino()
        // Fetch all platforms once; empty searchArgs to get full list
        const platformSummaries = await arduino.searchPlatform({
          searchArgs: '',
        })
        for (const summary of platformSummaries) {
          const id = summary.metadata?.id
          if (!id) continue

          const installedVersion = summary.installedVersion
          const availableVersions = Object.keys(summary.releases ?? {})
            .sort(compareLoose)
            .reverse()

          const currentVersion = installedVersion || summary.latestVersion
          if (!currentVersion) {
            cache.set(id, {
              label: id,
              installedVersion,
              availableVersions,
            })
            continue
          }

          const currentRelease = summary.releases[currentVersion]
          if (!currentRelease) {
            cache.set(id, {
              label: id,
              installedVersion,
              availableVersions,
            })
            continue
          }

          const platformName = currentRelease.name
          cache.set(id, {
            label: platformName || id,
            installedVersion,
            availableVersions,
          })
        }
      } catch (error) {
        console.warn('Failed to load platform names', error)
      } finally {
        this.platformNamesLoading = undefined
      }
    })()

    await this.platformNamesLoading
  }

  getQuickPlatform(id: string): QuickResource | undefined {
    return this.quickPlatformsCache?.get(id)
  }

  override doInstall(
    params: InstallResourceParams,
    arduino: Arduino,
    signal: AbortSignal
  ): AsyncIterable<InstallResponse> {
    const { id, version } = params
    const [vendor, arch] = this.splitId(id)
    return arduino.installPlatform(
      { platformPackage: vendor, architecture: arch, version },
      signal
    )
  }

  override doUninstall(
    params: UninstallResourceParams,
    arduino: Arduino,
    signal: AbortSignal
  ): AsyncIterable<UninstallResponse> {
    const { id } = params
    const [vendor, arch] = this.splitId(id)
    return arduino.uninstallPlatform(
      { platformPackage: vendor, architecture: arch },
      signal
    )
  }

  override async doSearch(
    params: SearchResourceParams<PlatformSearchFilter>,
    arduino: Arduino,
    signal?: AbortSignal | undefined
  ): Promise<ApiPlatform[]> {
    const results = await arduino.searchPlatform(
      { searchArgs: params.query },
      signal
    )
    const platforms: ApiPlatform[] = []
    for (const summary of results) {
      if (!Object.keys(summary.releases).length) {
        continue
      }
      if (!summary.metadata) {
        continue
      }
      // installed or the latest
      const current =
        summary.releases[summary.installedVersion] ??
        summary.releases[summary.latestVersion]
      // the latest version can be null
      // https://github.com/arduino/arduino-cli/issues/2756
      if (!current) {
        continue
      }
      const platform: ApiPlatform = {
        boards: current.boards,
        id: summary.metadata.id,
        name: current.name,
        summary: `Board${current.boards.length === 1 ? '' : 's'} included in this package: ${current.boards
          .map(({ name }) => name)
          .sort((left, right) => left.localeCompare(right))
          .join(', ')}`,
        author: summary.metadata.maintainer,
        availableVersions: Object.keys(summary.releases)
          .sort(compareLoose)
          .reverse(),
        installedVersion: summary.installedVersion,
        types: current.types,
        website: summary.metadata.website,
        deprecated: current.deprecated,
      }
      platforms.push(platform)
      this.setQuickCacheEntry(platform.id, {
        availableVersions: platform.availableVersions.slice(),
        installedVersion: platform.installedVersion,
        label: current.name,
      })
    }
    const filter = platformTypePredicate(params.filter)
    const filteredPlatforms = platforms.filter(filter)
    return sortComponents(filteredPlatforms, platformsSortGroup)
  }

  override doNotifyIndexUpdated(): void {
    if (this.webviewType) {
      this.messenger?.sendNotification(didUpdatePlatformIndex, {
        type: 'webview',
        webviewType: this.webviewType,
      })
    }
  }

  private splitId(id: string): [vendor: string, arch: string] {
    const [vendor, arch] = id.split(':')
    return [vendor, arch]
  }

  /**
   * Quick lookup for validation: available + installed version for a platform
   * id.
   */
  async lookupPlatformQuick(
    id: string,
    signal?: AbortSignal
  ): Promise<QuickResource | undefined> {
    return this.lookupQuick(
      id,
      async () => {
        await this.ensureQuickPlatforms()
        return this.getQuickPlatform(id)
      },
      signal
    )
  }

  protected override async confirmInstall(
    params: InstallResourceParams
  ): Promise<InstallResourceParams | undefined> {
    const label = params.name || params.id
    const answer = await vscode.window.showInformationMessage(
      'Install Platform',
      {
        modal: true,
        detail: `Do you want to install version ${params.version} of the '${label}' platform?`,
      },
      'Install'
    )
    return answer === 'Install' ? params : undefined
  }

  protected override async confirmUninstall(
    params: UninstallResourceParams
  ): Promise<boolean> {
    const label = params.name || params.id
    const answer = await vscode.window.showInformationMessage(
      'Uninstall Platform',
      {
        modal: true,
        detail: `Do you want to uninstall the '${label}' platform?`,
      },
      'Uninstall'
    )
    return answer === 'Uninstall'
  }
}

function platformTypePredicate(
  filter: PlatformSearchFilter | undefined
): (platform: ApiPlatform) => boolean {
  if (!filter) {
    return () => true
  }
  const { type } = filter
  if (!type || type === 'All') {
    return () => true
  }
  switch (filter.type) {
    case 'Updatable':
      return isUpdatable
    case 'Arduino':
    case 'Partner':
    case 'Arduino@Heart':
    case 'Contributed':
    case 'Arduino Certified':
      return ({ types }: ApiPlatform) => types.includes(type)
    default:
      throw new Error(`Unhandled type: ${filter.type}`)
  }
}

export const isUpdatable = <T extends Resource = Resource>(
  item: T
): boolean => {
  const { installedVersion } = item
  if (!installedVersion) {
    return false
  }
  const latestVersion = item.availableVersions[0]
  if (!latestVersion) {
    return false
  }
  const result = compareLoose(latestVersion, installedVersion)
  return result > 0
}

function platformsSortGroup(platform: ApiPlatform): SortGroup {
  const types: string[] = []
  if (platform.types.includes('Arduino')) {
    types.push('Arduino')
  }
  if (platform.deprecated) {
    types.push('Retired')
  }
  return types.join('-') as SortGroup
}

type SortGroup = 'Arduino' | '' | 'Arduino-Retired' | 'Retired'
const sortGroupOrder: Record<SortGroup, number> = {
  Arduino: 0,
  '': 1,
  'Arduino-Retired': 2,
  Retired: 3,
}

function sortComponents<T extends Resource = Resource>(
  items: T[],
  group: (component: T) => SortGroup
): T[] {
  return items
    .map((item, index) => ({ ...item, index }))
    .sort((left, right) => {
      const leftGroup = group(left)
      const rightGroup = group(right)
      if (leftGroup === rightGroup) {
        return left.index - right.index
      }
      return sortGroupOrder[leftGroup] - sortGroupOrder[rightGroup]
    })
}

type InstallResponse = LibraryInstallResponse | PlatformInstallResponse
type UninstallResponse = LibraryUninstallResponse | PlatformUninstallResponse

async function modifyInstallation<
  R extends InstallResponse | UninstallResponse,
>(
  task: (signal: AbortSignal) => AsyncIterable<R>,
  title: string
): Promise<void> {
  // CLI's task/progress API can be improved.
  // https://github.com/arduino/arduino-cli/issues/2016
  const abortController = new AbortController()
  const toDispose: vscode.Disposable[] = []
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: true,
      },
      async (mainProgress, codeToken) => {
        if (codeToken.isCancellationRequested) {
          return
        }
        const { signal } = abortController
        toDispose.push(
          codeToken.onCancellationRequested(() => abortController.abort())
        )

        let downloadDeferred = defer()
        let downloadsQueue: Promise<unknown> = Promise.resolve()
        let reportDownloadProgress:
          | ((increment: number) => void)
          | undefined = () => {
          // NOOP
        }
        let lastTaskProgressMessage: string | undefined

        for await (const resp of task(signal)) {
          if (!resp.message) {
            continue
          }
          switch (resp.message.$case) {
            case 'progress': {
              const { progress } = resp.message
              if (!progress.message) {
                continue
              }
              switch (progress.message.$case) {
                case 'start': {
                  // A download progress uses the message of the previous task progress in the UI
                  const title = `${lastTaskProgressMessage ? `${lastTaskProgressMessage}: ` : ''}${
                    progress.message.start.label
                  }`
                  downloadsQueue = downloadsQueue.then(() =>
                    Promise.resolve(
                      vscode.window.withProgress(
                        {
                          location: vscode.ProgressLocation.Notification,
                          title,
                          cancellable: false,
                        },
                        (downloadProgress) => {
                          let lastPercent = 0
                          reportDownloadProgress = (percent: number): void => {
                            if (percent > lastPercent) {
                              const increment = percent - lastPercent
                              lastPercent = percent
                              downloadProgress.report({ increment })
                            }
                          }
                          return downloadDeferred.promise
                        }
                      )
                    )
                  )
                  break
                }
                case 'update': {
                  const { downloaded, totalSize } = progress.message.update
                  const percent = (downloaded / totalSize) * 100
                  reportDownloadProgress(percent)
                  break
                }
                case 'end': {
                  downloadDeferred.resolve()
                  downloadDeferred = defer()
                  break
                }
              }
              break
            }
            case 'taskProgress': {
              const { taskProgress } = resp.message
              const message = taskProgress.name || taskProgress.message
              if (message) {
                lastTaskProgressMessage = message
                mainProgress.report({ message })
              }
              break
            }
          }
        }
        await downloadsQueue
      }
    )
  } finally {
    disposeAll(...toDispose)
  }
}
