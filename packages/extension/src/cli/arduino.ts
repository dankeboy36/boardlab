import { performance } from 'node:perf_hooks'
import { TextDecoder } from 'node:util'

import { isAbortError } from 'abort-controller-x'
import type {
  ArchiveSketchRequest,
  ArchiveSketchResponse,
  ArduinoCoreServiceClient,
  BoardDetailsRequest,
  BoardDetailsResponse,
  BoardListItem,
  BoardSearchRequest,
  BuilderResult,
  BurnBootloaderRequest,
  BurnBootloaderResponse,
  CompileRequest,
  CompileResponse,
  Configuration,
  ConfigurationSaveRequest,
  EnumerateMonitorPortSettingsRequest,
  EnumerateMonitorPortSettingsResponse,
  InstalledLibrary,
  Instance,
  Library,
  LibraryInstallRequest,
  LibraryInstallResponse,
  LibraryListRequest,
  LibraryRelease,
  LibraryResolveDependenciesRequest,
  LibraryResolveDependenciesResponse,
  LibrarySearchRequest,
  LibraryUninstallRequest,
  LibraryUninstallResponse,
  MonitorPortConfiguration,
  MonitorPortSetting,
  Platform,
  PlatformInstallRequest,
  PlatformInstallResponse,
  PlatformSearchRequest,
  PlatformSummary,
  PlatformUninstallRequest,
  PlatformUninstallResponse,
  SearchedLibrary,
  SettingsSetValueRequest,
  UpdateIndexRequest,
  UpdateIndexResponse,
  UpdateLibrariesIndexRequest,
  UpdateLibrariesIndexResponse,
  UploadRequest,
  UploadResponse,
  UploadUsingProgrammerRequest,
  UploadUsingProgrammerResponse,
} from 'ardunno-cli/api'
import {
  BoardIdentifier,
  DetectedPorts,
  parsePortKey,
  PortIdentifier,
} from 'boards-list'
import defer from 'p-defer'
import { sort as sortSemver } from 'semver'
import * as vscode from 'vscode'

import { disposeAll, isServiceError } from '../utils'

export interface ProgressUpdate {
  message?: string | undefined
  increment?: number | undefined
}

export interface CompileProgressUpdate {
  percent: number
  message?: string
}

export interface Streamable<T = void> extends vscode.Disposable {
  onDidReceiveMessage: vscode.Event<string>
  /**
   * The error event usually wraps an error message (`string`) received from the
   * Arduino CLI, but can be an `Error` instance, a gRPC `Status` object, or an
   * unknown throwable.
   */
  onDidReceiveError: vscode.Event<unknown>
  onDidComplete: vscode.Event<T | undefined> // TODO: remove undefined
}

export interface Monitor extends Streamable {
  port: PortQName
  fqbn?: FQBN
  sendMessage(message: string): void
  updateConfiguration(settings: MonitorPortConfiguration): void
  onDidStart: vscode.Event<void>
  onDidChangeSettings: vscode.Event<MonitorPortSetting[]>
}

export interface Arduino extends vscode.Disposable {
  // #region lifecycle
  init(progress?: vscode.Progress<ProgressUpdate>): Promise<void>

  updatePackageIndex(
    req?: Partial<Omit<UpdateIndexRequest, 'instance'>>,
    signal?: AbortSignal
  ): AsyncIterable<UpdateIndexResponse>

  updateLibraryIndex(
    req: Partial<Omit<UpdateLibrariesIndexRequest, 'instance'>>,
    signal?: AbortSignal
  ): AsyncIterable<UpdateLibrariesIndexResponse>
  // #endregion

  // #region commands
  compile(req: Partial<Omit<CompileRequest, 'instance'>>): {
    pty: vscode.Pseudoterminal
    result: Promise<BuilderResult | undefined>
    progress: vscode.Event<CompileProgressUpdate>
  }

  // TODO: should be upload(req, {signal?, retry?})
  upload(
    req: Partial<Omit<UploadRequest, 'instance'>> & { retry?: number },
    signal?: AbortSignal
  ): {
    pty: vscode.Pseudoterminal
    result: Promise<PortIdentifier | undefined>
  }

  uploadUsingProgrammer(
    req: Partial<Omit<UploadUsingProgrammerRequest, 'instance'>> & {
      retry?: number
    },
    signal?: AbortSignal
  ): {
    pty: vscode.Pseudoterminal
    result: Promise<PortIdentifier | undefined>
  }

  burnBootloader(
    req: Partial<Omit<BurnBootloaderRequest, 'instance'>> & { retry?: number },
    signal?: AbortSignal
  ): {
    pty: vscode.Pseudoterminal
    result: Promise<PortIdentifier | undefined>
  }
  // #endregion

  // #region platforms
  searchPlatform(
    req: Partial<Omit<PlatformSearchRequest, 'instance'>>,
    signal?: AbortSignal
  ): Promise<PlatformSummary[]>

  installedPlatforms(
    req: Partial<Omit<PlatformSearchRequest, 'instance'>>,
    signal?: AbortSignal
  ): Promise<Platform[]>

  installPlatform(
    req: Partial<Omit<PlatformInstallRequest, 'instance'>>,
    signal?: AbortSignal
  ): AsyncIterable<PlatformInstallResponse>

  uninstallPlatform(
    req: Partial<Omit<PlatformUninstallRequest, 'instance'>>,
    signal?: AbortSignal
  ): AsyncIterable<PlatformUninstallResponse>
  // #endregion

  // #region libraries
  searchLibrary(
    req: Partial<Omit<LibrarySearchRequest, 'instance'>>,
    signal?: AbortSignal
  ): Promise<SearchedLibrary[]>

  listLibraries(
    req: Partial<Omit<LibraryListRequest, 'instance'>>,
    signal?: AbortSignal
  ): Promise<InstalledLibrary[]>

  libraryVersions(
    library: Library | (LibraryRelease & { name: string }),
    signal?: AbortSignal
  ): Promise<string[]>

  installLibrary(
    req: Partial<Omit<LibraryInstallRequest, 'instance'>>,
    signal?: AbortSignal
  ): AsyncIterable<LibraryInstallResponse>

  resolveLibraryDependencies(
    req: Partial<Omit<LibraryResolveDependenciesRequest, 'instance'>>,
    signal?: AbortSignal
  ): Promise<LibraryResolveDependenciesResponse>

  uninstallLibrary(
    req: Partial<Omit<LibraryUninstallRequest, 'instance'>>,
    signal?: AbortSignal
  ): AsyncIterable<LibraryUninstallResponse>
  // #endregion

  // #region boards
  searchBoard(
    req: Partial<Omit<BoardSearchRequest, 'instance'>>,
    signal?: AbortSignal
  ): Promise<BoardListItem[]>

  boardDetails(
    req: Partial<Omit<BoardDetailsRequest, 'instance'>>
  ): Promise<BoardDetailsResponse>
  // #endregion

  // #region cli configuration
  readConfiguration(signal?: AbortSignal): Promise<Configuration>

  setConfiguration(
    configuration: SettingsSetValueRequest,
    signal?: AbortSignal
  ): Promise<void>

  saveConfiguration(
    req: ConfigurationSaveRequest,
    signal?: AbortSignal
  ): Promise<void>
  // #endregion

  // #region port configs
  enumeratePortConfigs(
    req: Partial<Omit<EnumerateMonitorPortSettingsRequest, 'instance'>>,
    signal?: AbortSignal
  ): Promise<EnumerateMonitorPortSettingsResponse>
  // #endregion

  // #region sketches
  archiveSketch(
    req: Partial<ArchiveSketchRequest>,
    signal?: AbortSignal
  ): Promise<ArchiveSketchResponse>
  // #endregion
}

/** For example, `arduino:avr:core`. */
export type FQBN = string

/**
 * A port qualified name in the `protocol:address` format. For example,
 * `serial:COM1`.
 */
export type PortQName = string

const portKeyPrefix = 'arduino+'
const portKeySeparator = '://'
export function revivePort(portKey: PortQName): PortIdentifier | undefined {
  // https://github.com/dankeboy36/boards-list/issues/4
  if (portKey.startsWith(portKeyPrefix)) {
    const [protocol, address] = portKey
      .substring(portKeyPrefix.length)
      .split(portKeySeparator, 2)
    return protocol && address ? { protocol, address } : undefined
  }
  return parsePortKey(portKey)
}

export type InstalledBoardListItem = BoardIdentifier & {
  platform: PlatformSummary & { installedVersion: string }
}
export function hasInstalledPlatform(
  ref: BoardIdentifier & { platform?: PlatformSummary }
): ref is InstalledBoardListItem {
  return !!ref?.platform?.installedVersion // Empty string if not installed. otherwise, a semver.
}

export class ArduinoCli implements Arduino {
  // private readonly _onDidChangeDetectedPorts: vscode.EventEmitter<DetectedPorts>
  private readonly toDispose: vscode.Disposable[]
  private _detectedPorts: DetectedPorts
  private _monitorList: Monitor[]

  constructor(
    private readonly client: ArduinoCoreServiceClient,
    private readonly instance: Instance | undefined
  ) {
    // this._onDidChangeDetectedPorts = new vscode.EventEmitter()
    this.toDispose = []
    this._detectedPorts = {}
    this._monitorList = []
  }

  dispose(): void {
    disposeAll(...this.toDispose, ...this._monitorList)
  }

  async init(progress?: vscode.Progress<ProgressUpdate>): Promise<void> {
    // const mustRunPackageIndexUpdate = false
    // const mustRunLibraryIndexUpdate = false
    const abortController = new AbortController()
    const signal = abortController.signal
    progress?.report({ message: 'Initializing client...' })
    for await (const { message } of this.client.init(
      { instance: this.instance },
      { signal }
    )) {
      if (message?.$case === 'error') {
        const { error } = message
        console.error(
          'received error during client init',
          JSON.stringify(error)
        )
        // if (isPrimaryPackageIndexStatus(error)) {
        //   mustRunPackageIndexUpdate = true
        // }
        // if (isLibraryIndexStatus(error)) {
        //   mustRunLibraryIndexUpdate = true
        // }
      }
      // if (mustRunPackageIndexUpdate || mustRunLibraryIndexUpdate) {
      //   console.log(
      //     'received error. interrupting client init: ' +
      //       JSON.stringify(message)
      //   )
      //   abortController.abort()
      // }
      console.log(JSON.stringify(message))
    }
    progress?.report({ message: 'Client initialized successfully' })
  }

  updatePackageIndex(
    req: Partial<Omit<UpdateIndexRequest, 'instance'>> = {},
    signal?: AbortSignal
  ): AsyncIterable<UpdateIndexResponse> {
    return this.client.updateIndex(
      { instance: this.instance, ...req },
      { signal }
    )
  }

  updateLibraryIndex(
    req: Partial<Omit<UpdateLibrariesIndexRequest, 'instance'>>,
    signal?: AbortSignal
  ): AsyncIterable<UpdateLibrariesIndexResponse> {
    return this.client.updateLibrariesIndex(
      { instance: this.instance, ...req },
      { signal }
    )
  }

  compile(req: Partial<Omit<CompileRequest, 'instance'>>): {
    pty: vscode.Pseudoterminal
    result: Promise<BuilderResult | undefined>
    progress: vscode.Event<CompileProgressUpdate>
  } {
    const deferred = defer<BuilderResult | undefined>()
    const onDidProgressEmitter =
      new vscode.EventEmitter<CompileProgressUpdate>()
    const streamable = createStreamable<CompileResponse, BuilderResult>(
      (signal) =>
        this.client.compile({ ...req, instance: this.instance }, { signal }),
      (response, emitter) => {
        const msg = response.message
        if (!msg) {
          return
        }
        switch (msg.$case) {
          case 'result': {
            emitter.fire(msg.result)
            onDidProgressEmitter.fire({ percent: 100 })
            break
          }
          case 'progress': {
            const progress = msg.progress
            const percent =
              typeof progress.percent === 'number'
                ? Math.max(0, Math.min(100, Math.round(progress.percent)))
                : 0

            onDidProgressEmitter.fire({
              percent,
            })
            break
          }
        }
      }
    )
    const toDispose: vscode.Disposable[] = [
      onDidProgressEmitter,
      streamable.onDidComplete((result) => deferred.resolve(result)),
      streamable.onDidReceiveError((error) => {
        if (typeof error === 'string') {
          return
        }
        if (isAbortError(error)) {
          deferred.resolve(undefined)
        } else {
          deferred.reject(error)
        }
      }),
    ]
    deferred.promise.finally(() => disposeAll(...toDispose))
    return {
      pty: createPty(streamable),
      result: deferred.promise,
      progress: onDidProgressEmitter.event,
    }
  }

  upload(
    req: Partial<Omit<UploadRequest, 'instance'>> & { retry?: number },
    signal?: AbortSignal
  ): {
    pty: vscode.Pseudoterminal
    result: Promise<PortIdentifier | undefined>
  } {
    const { retry, ...uploadRequest } = req
    const retryOptions = buildRetryOptions(retry)
    const deferred = defer<PortIdentifier | undefined>()
    const streamable = createStreamable<
      UploadResponse,
      PortIdentifier | undefined
    >(
      (streamSignal) =>
        this.client.upload(
          { ...uploadRequest, instance: this.instance },
          { signal: streamSignal }
        ),
      (response, emitter) => {
        const message = response.message
        if (message?.$case !== 'result') {
          return
        }
        const updatedPort = message.result?.updatedUploadPort
        if (updatedPort?.address && updatedPort.protocol) {
          emitter.fire({
            protocol: updatedPort.protocol,
            address: updatedPort.address,
          })
        }
      },
      retryOptions ? { retry: retryOptions } : undefined
    )
    const toDispose: vscode.Disposable[] = [
      streamable.onDidComplete((result) => deferred.resolve(result)),
      streamable.onDidReceiveError((error) => {
        if (typeof error === 'string') {
          return
        }
        if (isAbortError(error)) {
          deferred.resolve(undefined)
        } else {
          deferred.reject(error)
        }
      }),
    ]
    deferred.promise.finally(() => disposeAll(...toDispose))
    return {
      pty: createPty(streamable),
      result: deferred.promise,
    }
  }

  uploadUsingProgrammer(
    req: Partial<Omit<UploadUsingProgrammerRequest, 'instance'>> & {
      retry?: number
    },
    signal?: AbortSignal
  ): {
    pty: vscode.Pseudoterminal
    result: Promise<PortIdentifier | undefined>
  } {
    const { retry, ...uploadRequest } = req
    const retryOptions = buildRetryOptions(retry)
    return this.execute<
      UploadUsingProgrammerResponse,
      PortIdentifier | undefined
    >(
      (streamSignal) =>
        this.client.uploadUsingProgrammer(
          { ...uploadRequest, instance: this.instance },
          { signal: streamSignal }
        ),
      signal,
      retryOptions ? { retry: retryOptions } : undefined
    )
  }

  burnBootloader(
    req: Partial<Omit<BurnBootloaderRequest, 'instance'>> & { retry?: number },
    signal?: AbortSignal
  ): {
    pty: vscode.Pseudoterminal
    result: Promise<PortIdentifier | undefined>
  } {
    const { retry, ...bootloaderRequest } = req
    const retryOptions = buildRetryOptions(retry)
    return this.execute<BurnBootloaderResponse, PortIdentifier | undefined>(
      (streamSignal) =>
        this.client.burnBootloader(
          { ...bootloaderRequest, instance: this.instance },
          { signal: streamSignal }
        ),
      signal,
      retryOptions ? { retry: retryOptions } : undefined
    )
  }

  private execute<RESP extends StdResponse, RESULT = void>(
    task: (signal: AbortSignal) => AsyncIterable<RESP>,
    signal?: AbortSignal,
    options?: ExecuteOptions
  ): {
    pty: vscode.Pseudoterminal
    result: Promise<RESULT | undefined>
  } {
    const deferred = defer<RESULT | undefined>()
    const streamable = createStreamable<RESP, RESULT>(
      (streamSignal) => task(signal ?? streamSignal),
      undefined,
      options
    )
    const toDispose: vscode.Disposable[] = [
      streamable.onDidComplete((result) => deferred.resolve(result)),
      streamable.onDidReceiveError((error) => {
        if (typeof error === 'string') {
          return
        }
        if (isAbortError(error)) {
          deferred.resolve()
        } else {
          deferred.reject(error)
        }
      }),
    ]
    deferred.promise.finally(() => disposeAll(...toDispose))
    return {
      pty: createPty(streamable),
      result: deferred.promise,
    }
  }

  async searchPlatform(
    req: Partial<Omit<PlatformSearchRequest, 'instance'>>,
    signal?: AbortSignal
  ): Promise<PlatformSummary[]> {
    try {
      const { searchOutput } = await this.client.platformSearch(
        { ...req, instance: this.instance },
        { signal }
      )
      return searchOutput
    } catch (err) {
      if (isAbortError(err)) {
        return []
      }
      throw err
    }
  }

  async installedPlatforms(
    req: Partial<Omit<PlatformSearchRequest, 'instance'>>,
    signal?: AbortSignal
  ): Promise<Platform[]> {
    try {
      const { searchOutput } = await this.client.platformSearch(
        { ...req, instance: this.instance },
        { signal }
      )
      return searchOutput.reduce((acc, summary) => {
        if (summary.installedVersion) {
          acc.push({
            metadata: summary.metadata,
            release: summary.releases[summary.installedVersion],
          })
        }
        return acc
      }, [] as Platform[])
    } catch (err) {
      if (isAbortError(err)) {
        return []
      }
      throw err
    }
  }

  installPlatform(
    req: Partial<Omit<PlatformInstallRequest, 'instance'>>,
    signal?: AbortSignal
  ): AsyncIterable<PlatformInstallResponse> {
    return this.client.platformInstall(
      { ...req, instance: this.instance },
      { signal }
    )
  }

  uninstallPlatform(
    req: Partial<Omit<PlatformUninstallRequest, 'instance'>>,
    signal?: AbortSignal
  ): AsyncIterable<PlatformUninstallResponse> {
    return this.client.platformUninstall(
      { ...req, instance: this.instance },
      { signal }
    )
  }

  async searchLibrary(
    req: Partial<Omit<LibrarySearchRequest, 'instance'>>,
    signal?: AbortSignal
  ): Promise<SearchedLibrary[]> {
    const start = performance.now()
    try {
      const { libraries } = await this.client.librarySearch(
        { ...req, instance: this.instance },
        { signal }
      )
      console.log(
        'RESULT: |' +
          req.searchArgs +
          '|' +
          libraries.length +
          ' took: ' +
          (performance.now() - start) +
          ' ms'
      )
      return libraries
    } catch (err) {
      if (isAbortError(err)) {
        console.log(
          'ABORT: |' +
            req.searchArgs +
            '|' +
            ' took: ' +
            (performance.now() - start)
        )
        return []
      }
      throw err
    }
  }

  async listLibraries(
    req: Partial<Omit<LibraryListRequest, 'instance'>>,
    signal?: AbortSignal
  ): Promise<InstalledLibrary[]> {
    try {
      const { installedLibraries } = await this.client.libraryList(
        { ...req, instance: this.instance },
        { signal }
      )
      return installedLibraries
    } catch (err) {
      if (isAbortError(err)) {
        return []
      }
      throw err
    }
  }

  async libraryVersions(
    library: Library | (LibraryRelease & { name: string }),
    signal?: AbortSignal | undefined
  ): Promise<string[]> {
    const results = await this.searchLibrary(
      { searchArgs: library.name },
      signal
    )
    const versions = results
      .filter((candidate) => library.name === candidate.name)
      .map(({ releases }) => Object.keys(releases))
      .reduce((left, right) => left.concat(right), [])
    return sortSemver(versions, { loose: true }).reverse()
  }

  installLibrary(
    req: Partial<Omit<LibraryInstallRequest, 'instance'>>,
    signal?: AbortSignal
  ): AsyncIterable<LibraryInstallResponse> {
    return this.client.libraryInstall(
      { ...req, instance: this.instance },
      { signal }
    )
  }

  resolveLibraryDependencies(
    req: Partial<Omit<LibraryResolveDependenciesRequest, 'instance'>>,
    signal?: AbortSignal
  ): Promise<LibraryResolveDependenciesResponse> {
    return this.client.libraryResolveDependencies(
      { ...req, instance: this.instance },
      { signal }
    )
  }

  uninstallLibrary(
    req: Partial<Omit<LibraryUninstallRequest, 'instance'>>,
    signal?: AbortSignal
  ): AsyncIterable<LibraryUninstallResponse> {
    return this.client.libraryUninstall(
      { ...req, instance: this.instance },
      { signal }
    )
  }

  async searchBoard(
    req: Partial<Omit<BoardSearchRequest, 'instance'>>,
    signal?: AbortSignal
  ): Promise<BoardListItem[]> {
    try {
      const { boards } = await this.client.boardSearch(
        { instance: this.instance, ...req },
        { signal }
      )
      return boards
    } catch (err) {
      if (isAbortError(err)) {
        return []
      }
      throw err
    }
  }

  boardDetails(
    req: Partial<Omit<BoardDetailsRequest, 'instance'>>
  ): Promise<BoardDetailsResponse> {
    return this.client.boardDetails({ instance: this.instance, ...req })
  }

  async readConfiguration(signal?: AbortSignal): Promise<Configuration> {
    const { configuration } = await this.client.configurationGet({}, { signal })
    if (!configuration) {
      throw new Error('Failed to read Arduino CLI configuration')
    }
    return configuration
  }

  async saveConfiguration(
    req: Partial<ConfigurationSaveRequest>,
    signal?: AbortSignal
  ): Promise<void> {
    await this.client.configurationSave(req, { signal })
  }

  async setConfiguration(
    req: Partial<SettingsSetValueRequest>,
    signal?: AbortSignal
  ): Promise<void> {
    await this.client.settingsSetValue(req, { signal })
  }

  async enumeratePortConfigs(
    req: Partial<Omit<EnumerateMonitorPortSettingsRequest, 'instance'>>,
    signal?: AbortSignal
  ): Promise<EnumerateMonitorPortSettingsResponse> {
    return await this.client.enumerateMonitorPortSettings(
      { instance: this.instance, ...req },
      { signal }
    )
  }

  async archiveSketch(
    req: ArchiveSketchRequest,
    signal?: AbortSignal
  ): Promise<ArchiveSketchResponse> {
    return await this.client.archiveSketch({ ...req }, { signal })
  }
}

type StdResponse =
  | CompileResponse
  | UploadResponse
  | BurnBootloaderResponse
  | UploadUsingProgrammerResponse

interface RetryOptions {
  retries: number
  delayMs?: number
  shouldRetry?: (error: unknown) => boolean
  shouldRetryMessage?: (message: string) => boolean
  onRetry?: (
    attempt: number,
    maxRetries: number,
    error: unknown
  ) => string | undefined
}

interface ExecuteOptions {
  retry?: RetryOptions
}

interface CreateStreamableOptions {
  retry?: RetryOptions
}

const retryableUploadErrorPatterns = [
  /resource busy/i,
  /device or resource busy/i,
  /could not open port/i,
  /failed to open.*port/i,
  /no device found/i,
  /no such file or directory/i,
  /port .*not found/i,
]

function formatErrorMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error
  }
  if (isServiceError(error)) {
    return error.details || error.message || String(error)
  }
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') {
      return message
    }
  }
  return String(error)
}

function isRetryableUploadError(error: unknown): boolean {
  if (isAbortError(error)) {
    return false
  }
  const message = formatErrorMessage(error).toLowerCase()
  return retryableUploadErrorPatterns.some((pattern) => pattern.test(message))
}

function buildRetryOptions(retry?: number): RetryOptions | undefined {
  const retryCount = typeof retry === 'number' ? Math.max(0, retry) : 0
  if (retryCount <= 0) {
    return undefined
  }
  return {
    retries: retryCount,
    delayMs: 500,
    shouldRetry: isRetryableUploadError,
    shouldRetryMessage: (message: string) =>
      retryableUploadErrorPatterns.some((pattern) => pattern.test(message)),
    onRetry: (attempt: number, maxRetries: number) =>
      `Retrying upload (${attempt}/${maxRetries})...\n`,
  }
}

function createStreamable<RESP extends StdResponse, RESULT = void>(
  command: (signal: AbortSignal) => AsyncIterable<RESP>,
  onResponse?: (
    response: RESP,
    onDidCompleteEmitter: vscode.EventEmitter<RESULT | undefined>
  ) => void,
  options?: CreateStreamableOptions
): Streamable<RESULT> {
  const abortController = new AbortController()
  const signal = abortController.signal
  const onDidCompleteEmitter = new OnceEventEmitter<RESULT | undefined>()
  const onDidReceiveMessageEmitter = new BufferedEmitter()
  const onDidReceiveErrorEmitter = new vscode.EventEmitter<unknown>()
  const toDispose: vscode.Disposable[] = [
    onDidCompleteEmitter,
    onDidReceiveMessageEmitter,
    onDidReceiveErrorEmitter,
    new vscode.Disposable(() => abortController.abort()),
  ]

  const start = async (): Promise<void> => {
    const handleMessage = (
      data: Uint8Array | undefined,
      decoder: TextDecoder,
      emitter: vscode.EventEmitter<unknown>
    ): string | undefined => {
      if (data && data.length) {
        const message = decoder.decode(data, { stream: true })
        if (message) {
          emitter.fire(message)
          return message
        }
      }
      return undefined
    }
    const messageDecoder = new TextDecoder()
    const errorDecoder = new TextDecoder()
    const retry = options?.retry
    const maxRetries = retry?.retries ?? 0
    let attempts = 0

    while (true) {
      let retryableOutputSeen = false
      try {
        for await (const response of command(signal)) {
          if (response.message?.$case === 'errStream') {
            const message = handleMessage(
              response.message.errStream,
              errorDecoder,
              onDidReceiveErrorEmitter
            )
            if (message && retry?.shouldRetryMessage?.(message)) {
              retryableOutputSeen = true
            }
          } else if (response.message?.$case === 'outStream') {
            const message = handleMessage(
              response.message.outStream,
              messageDecoder,
              onDidReceiveMessageEmitter
            )
            if (message && retry?.shouldRetryMessage?.(message)) {
              retryableOutputSeen = true
            }
          }
          onResponse?.(response, onDidCompleteEmitter)
        }
        onDidCompleteEmitter.fire(undefined)
        return
      } catch (err) {
        if (
          retry &&
          attempts < maxRetries &&
          !isAbortError(err) &&
          (retryableOutputSeen || (retry.shouldRetry?.(err) ?? true))
        ) {
          attempts += 1
          const message = retry.onRetry?.(attempts, maxRetries, err)
          if (message) {
            onDidReceiveMessageEmitter.fire(message)
          }
          const delay = retry.delayMs ?? 0
          if (delay > 0) {
            await new Promise((resolve) => setTimeout(resolve, delay))
          }
          continue
        }
        onDidReceiveErrorEmitter.fire(err)
        return
      }
    }
  }

  start()

  return {
    onDidReceiveMessage: onDidReceiveMessageEmitter.event,
    onDidReceiveError: onDidReceiveErrorEmitter.event,
    onDidComplete: onDidCompleteEmitter.event,
    dispose(): void {
      disposeAll(...toDispose)
    },
  }
}

function createPty<T = void>(streamable: Streamable<T>): vscode.Pseudoterminal {
  const onDidWriteEmitter = new vscode.EventEmitter<string>()
  const onDidCloseEmitter = new vscode.EventEmitter<void | number>()
  const toDispose: vscode.Disposable[] = [onDidWriteEmitter, onDidCloseEmitter]
  let closed = false

  return {
    onDidWrite: onDidWriteEmitter.event,
    onDidClose: onDidCloseEmitter.event,
    close: () => {
      if (closed) {
        return
      }
      closed = true
      streamable.dispose()
      onDidCloseEmitter.fire()
      disposeAll(...toDispose)
    },
    open: async (): Promise<void> => {
      const deferred = defer<T>()
      toDispose.push(
        streamable.onDidReceiveMessage((message) =>
          onDidWriteEmitter.fire(terminalEOL(message))
        ),
        streamable.onDidReceiveError((error) => {
          if (typeof error === 'string') {
            onDidWriteEmitter.fire(red(terminalEOL(error)))
          } else {
            deferred.reject(error)
          }
        }),
        streamable.onDidComplete(() => deferred.resolve())
      )
      try {
        await deferred.promise
        if (!closed) {
          onDidCloseEmitter.fire(0)
          closed = true
        }
      } catch (err) {
        let code = 1
        let message = String(err)
        if (isServiceError(err)) {
          message = err.details
          code = err.code
        } else if (isAbortError(err)) {
          message = 'User abort'
        }
        onDidWriteEmitter.fire(red(terminalEOL(message)))
        if (!closed) {
          onDidCloseEmitter.fire(code)
          closed = true
        }
      } finally {
        if (!closed) {
          onDidCloseEmitter.fire()
          closed = true
        }
        disposeAll(...toDispose)
      }
    },
  }
}

export function terminalEOL(text: string): string {
  return text.replace(/\r?\n/g, '\r\n')
}

export function red(text: string): string {
  return `\x1b[31m${text}\x1b[0m`
}

class OnceEventEmitter<T> extends vscode.EventEmitter<T> {
  private _fired = false
  override fire(data: T): void {
    if (!this._fired) {
      this._fired = true
      super.fire(data)
    }
  }
}

class BufferedEmitter extends vscode.EventEmitter<string> {
  private readonly decoder = new TextDecoder()
  private readonly buffer: Uint8Array[]
  private lastFlushTimestamp: number
  private timer: NodeJS.Timeout | undefined

  /** The default timeout is ~60Hz. */
  constructor(private readonly timeout = 50) {
    super()
    this.lastFlushTimestamp = -1
    this.buffer = []
    this.decoder = new TextDecoder()
  }

  scheduleFire(data: Uint8Array): void {
    if (!data.length) {
      return
    }
    this.buffer.push(data)
    if (!this.timer) {
      this.timer = setInterval(() => this.flush(), this.timeout)
    }
  }

  protected flush(force = false): void {
    const now = performance.now()
    if (
      this.buffer.length &&
      (force || now - this.lastFlushTimestamp >= this.timeout)
    ) {
      const message = this.buffer.reduce(
        (acc, curr) => (acc += this.decoder.decode(curr, { stream: true })),
        ''
      )
      this.lastFlushTimestamp = now
      this.buffer.length = 0
      this.fire(message)
    }
  }

  override dispose(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    super.dispose()
  }
}
