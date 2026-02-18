import { spawn } from 'node:child_process'
import { promises as fs, constants as fsConstants, watch } from 'node:fs'
import { homedir } from 'node:os'
import path, { resolve as resolvePath } from 'node:path'

import deepEqual from 'fast-deep-equal'
import * as vscode from 'vscode'
import type { CliConfig as ApiCliConfig } from 'vscode-arduino-api'

import { disposeAll } from '../utils'
import { CliContext } from './context'

const CONFIG_FILENAME = 'arduino-cli.yaml'

export interface TrackedCliConfig extends ApiCliConfig {
  additionalUrls?: string[]
  networkProxy?: string
  locale?: string
}

export interface AddAdditionalPackageIndexUrlParams {
  url: string
}

export interface TrackedCliConfigWithValidationIssues extends TrackedCliConfig {
  validationIssues?: string[]
}

export class CliConfig implements vscode.Disposable {
  private readonly onDidChangeDataEmitter = new vscode.EventEmitter<
    TrackedCliConfigWithValidationIssues | undefined
  >()

  private readonly onDidChangeUriEmitter = new vscode.EventEmitter<
    vscode.Uri | undefined
  >()

  private readonly toDispose: vscode.Disposable[] = [
    this.onDidChangeDataEmitter,
    this.onDidChangeUriEmitter,
  ]

  private readonly readyPromise: Promise<void>

  private toDisposeOnDidChangeUri: vscode.Disposable | undefined
  private shownWarnings: Record<string, boolean> = {}

  private _uri: vscode.Uri | undefined
  private _data: TrackedCliConfigWithValidationIssues | undefined

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly cliContext: CliContext
  ) {
    this.toDispose.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('boardlab.cli.configPath')) {
          this.refresh({ allowPrompt: false })
        }
      })
    )

    this.toDispose.push(
      this.cliContext.daemon.onDidChangeAddress(() => {
        this.refresh({ allowPrompt: false })
      })
    )

    this.readyPromise = this.initialize().catch((error) => {
      console.error('Failed to initialize Arduino CLI configuration', error)
    })
  }

  dispose(): void {
    if (this.toDisposeOnDidChangeUri) {
      this.toDisposeOnDidChangeUri.dispose()
      this.toDisposeOnDidChangeUri = undefined
    }
    disposeAll(...this.toDispose)
  }

  async ready(): Promise<void> {
    await this.readyPromise
  }

  async refresh(options?: { allowPrompt?: boolean }): Promise<void> {
    try {
      const targetUri = await this.resolveAndSetUri({
        allowPrompt: options?.allowPrompt ?? false,
      })
      await this.loadConfiguration(targetUri)
    } catch (error) {
      console.error('Failed to refresh Arduino CLI configuration', error)
    }
  }

  get data(): TrackedCliConfigWithValidationIssues | undefined {
    return this._data
  }

  get onDidChangeData(): vscode.Event<
    TrackedCliConfigWithValidationIssues | undefined
  > {
    return this.onDidChangeDataEmitter.event
  }

  get uri(): vscode.Uri | undefined {
    return this._uri
  }

  get onDidChangeUri(): vscode.Event<vscode.Uri | undefined> {
    return this.onDidChangeUriEmitter.event
  }

  async addAdditionalPackageIndexUrl({
    url,
  }: AddAdditionalPackageIndexUrlParams): Promise<boolean> {
    await this.ready()

    if (this._data?.additionalUrls?.includes(url)) {
      return false
    }
    const newAdditionalUrls = [...(this._data?.additionalUrls ?? []), url]
    await this.setConfigValue(
      'board_manager.additional_urls',
      newAdditionalUrls,
      this._uri
    )
    return true
  }

  private async initialize(): Promise<void> {
    const uri = await this.resolveAndSetUri({ allowPrompt: true })
    await this.loadConfiguration(uri)
  }

  private async loadConfiguration(uri?: vscode.Uri): Promise<void> {
    const configFromCli = await this.loadConfigViaCli(uri)
    if (configFromCli) {
      this.handleConfigDidLoad(configFromCli)
    }
  }

  private async loadConfigViaCli(
    uri?: vscode.Uri
  ): Promise<
    { data: TrackedCliConfigWithValidationIssues; uri?: vscode.Uri } | undefined
  > {
    try {
      const [directories, boardManager, network, locale] = await Promise.all([
        this.loadConfigValue('directories', uri),
        this.loadConfigValue('board_manager', uri),
        this.loadConfigValue('network', uri),
        this.loadConfigValue('locale', uri),
      ])
      const additionalUrls: string[] = boardManager['additional_urls'] ?? []
      additionalUrls.sort()

      return {
        data: {
          userDirPath: directories.user,
          dataDirPath: directories.data,
          additionalUrls: boardManager.additional_urls ?? [],
          networkProxy: network.proxy,
          locale,
        },
        uri,
      }
    } catch (error) {
      console.warn('Failed to dump Arduino CLI configuration', error)
      return undefined
    }
  }

  private async setConfigValue(
    configKey: string,
    value: string | string[],
    cliConfigFileUri?: vscode.Uri
  ): Promise<any> {
    const executablePath = await this.cliContext.resolveExecutablePath()
    const configArgs = ['config', 'set', configKey]
    if (Array.isArray(value)) {
      configArgs.push(...value)
    } else {
      configArgs.push(value)
    }
    if (cliConfigFileUri?.fsPath) {
      configArgs.push('--config-file', cliConfigFileUri.fsPath)
    }

    await execCommand(executablePath, configArgs, {
      // It's false by default anyway, but being explicit here
      // In case of error it prints {"error":"Cannot get the configuration key X: key X not found"} to stderr
      throwOnError: false,
    })
  }

  private async loadConfigValue(
    configKey: string,
    cliConfigFileUri?: vscode.Uri
  ): Promise<any> {
    const executablePath = await this.cliContext.resolveExecutablePath()
    const configArgs = ['config', 'get', configKey]
    if (cliConfigFileUri?.fsPath) {
      configArgs.push('--config-file', cliConfigFileUri.fsPath)
    }
    // XXX: with CLI 1.1.1 format json must come before the config-key?
    configArgs.push('--format', 'json')

    const { stdout, stderr } = await execCommand(executablePath, configArgs, {
      // It's false by default anyway, but being explicit here
      // In case of error it prints {"error":"Cannot get the configuration key X: key X not found"} to stderr
      throwOnError: false,
    })
    const json = stdout.trim() || stderr.trim()
    try {
      return JSON.parse(json)
    } catch (err) {
      // handles for example, locale, that returns with a string like "en"
      console.log(
        `Could not parse config key ${configKey} value from stdout ${stdout} and stderr ${stderr}`,
        err
      )
      throw err
    }
  }

  private handleConfigDidLoad(loadResult: {
    data: TrackedCliConfigWithValidationIssues
    uri?: vscode.Uri
  }): void {
    const previousUri = this._uri
    const previousData = this._data

    if (loadResult?.uri) {
      this._uri = loadResult.uri
    } else if (!loadResult) {
      this._uri = undefined
    }

    this._data = loadResult?.data

    const uriChanged = this._uri?.toString() !== previousUri?.toString()
    if (uriChanged) {
      if (this.toDisposeOnDidChangeUri) {
        this.toDisposeOnDidChangeUri.dispose()
        this.toDisposeOnDidChangeUri = undefined
      }
      if (this._uri) {
        this.registerWatcher(this._uri.fsPath)
      }
      this.onDidChangeUriEmitter.fire(this._uri)
    }

    if (!dataEquals(this._data, previousData)) {
      this.onDidChangeDataEmitter.fire(this._data)
    }
  }

  private async resolveAndSetUri(options?: {
    allowPrompt?: boolean
  }): Promise<vscode.Uri | undefined> {
    const uri = await this.resolvePreferredConfigUri(options)
    if (!uri) {
      if (this._uri) {
        this._uri = undefined
        if (this.toDisposeOnDidChangeUri) {
          this.toDisposeOnDidChangeUri.dispose()
          this.toDisposeOnDidChangeUri = undefined
        }
        this.onDidChangeUriEmitter.fire(undefined)
      }
      return undefined
    }

    if (!this._uri || this._uri.fsPath !== uri.fsPath) {
      this._uri = uri
      this.onDidChangeUriEmitter.fire(this._uri)
      this.registerWatcher(uri.fsPath)
    }

    return uri
  }

  private async resolvePreferredConfigUri(options?: {
    allowPrompt?: boolean
  }): Promise<vscode.Uri | undefined> {
    const envPathRaw = process.env.ARDUINO_CONFIG_FILE
    if (envPathRaw) {
      this.showEnvWarningOnce(
        'arduinoConfigFileEnv',
        `Environment variable ARDUINO_CONFIG_FILE is set (${envPathRaw}); BoardLab settings will be ignored.`
      )
      return undefined
    }

    // If set in settings, use that
    const configured = this.settings.get<string>('cli.configPath')?.trim()
    if (configured) {
      return vscode.Uri.file(resolvePath(expandHome(configured)))
    }

    // Ensure managed config and use it
    const managed = await this.ensureManagedConfig(true)
    if (managed) {
      const allowPrompt = options?.allowPrompt ?? false
      if (allowPrompt) {
        this.maybePromptUseIdeConfig()
      }
      return managed
    }

    return undefined
  }

  private async maybePromptUseIdeConfig(): Promise<void> {
    const idePath = await this.resolveIdeConfigPath()
    if (idePath) {
      const choice = await vscode.window.showInformationMessage(
        `An Arduino CLI configuration file used by the Arduino IDE 2.x was found at "${idePath}". Do you want BoardLab to reuse it?`,
        'Use Arduino IDE 2.x existing config'
      )
      if (choice === 'Use Arduino IDE 2.x existing config') {
        await this.updateConfigPathSetting(idePath)
        await this.promptReload()
      }
    }
  }

  private async ensureManagedConfig(
    initConfigOnAbsence: boolean = false
  ): Promise<vscode.Uri | undefined> {
    try {
      const storageDir = path.join(
        this.context.globalStorageUri.fsPath,
        'arduino-cli'
      )
      await fs.mkdir(storageDir, { recursive: true })
      const managedPath = path.join(storageDir, CONFIG_FILENAME)

      try {
        const rawConfigYaml = await fs.readFile(managedPath, 'utf8')
        console.log(`Managed Arduino CLI configuration found at ${managedPath}`)
        console.log('Managed Arduino CLI configuration:', rawConfigYaml)
      } catch (e) {
        if (
          e instanceof Error &&
          (e as NodeJS.ErrnoException).code === 'ENOENT' &&
          initConfigOnAbsence
        ) {
          console.log(
            `Managed Arduino CLI configuration not found at ${managedPath}`
          )
          console.log('Creating a new managed configuration file')
          const arduinoCliPath = await this.cliContext.resolveExecutablePath()
          const { stdout } = await execCommand(arduinoCliPath, [
            'config',
            'init',
            '--dest-file',
            managedPath,
          ])
          console.log(`Arduino CLI config init output: ${stdout}`)
          return this.ensureManagedConfig()
        }
        throw e
      }

      return vscode.Uri.file(managedPath)
    } catch (error) {
      console.error(
        'Failed to provision managed Arduino CLI configuration',
        error
      )
      vscode.window.showErrorMessage(
        'Failed to provision Arduino CLI configuration. BoardLab will continue without a custom configuration file.'
      )
      return undefined
    }
  }

  private async resolveIdeConfigPath(): Promise<string | undefined> {
    const candidate = resolvePath(homedir(), '.arduinoIDE', CONFIG_FILENAME)
    if (await fileExists(candidate)) {
      return candidate
    }
    return undefined
  }

  private async updateConfigPathSetting(path: string): Promise<void> {
    const current = this.settings.get<string>('cli.configPath')
    if (current !== path) {
      try {
        await this.settings.update(
          'cli.configPath',
          path,
          vscode.ConfigurationTarget.Global
        )
      } catch (error) {
        console.error('Failed to update boardlab.cli.configPath', error)
      }
    }
  }

  private showEnvWarningOnce(warningKey: string, message: string): void {
    if (this.shownWarnings[warningKey]) {
      return
    }
    this.shownWarnings[warningKey] = true
    vscode.window.showInformationMessage(message)
  }

  private get settings(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('boardlab')
  }

  private async promptReload(): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      'BoardLab needs to reload the window to apply the Arduino CLI configuration change.',
      'Reload now',
      'Later'
    )
    if (choice === 'Reload now') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow')
    }
  }

  private async registerWatcher(cliConfigPath: string): Promise<void> {
    if (this.toDisposeOnDidChangeUri) {
      this.toDisposeOnDidChangeUri.dispose()
      this.toDisposeOnDidChangeUri = undefined
    }
    if (!(await fileExists(cliConfigPath))) {
      return
    }
    try {
      const watcher = watch(cliConfigPath, async () => {
        await this.loadConfiguration(vscode.Uri.file(cliConfigPath))
      })
      this.toDisposeOnDidChangeUri = new vscode.Disposable(() =>
        watcher.close()
      )
    } catch (error) {
      console.warn('Failed to watch Arduino CLI configuration file', error)
    }
  }
}

function dataEquals(
  left: TrackedCliConfigWithValidationIssues | undefined,
  right: TrackedCliConfigWithValidationIssues | undefined
): boolean {
  if (left && right) {
    return deepEqual(left, right)
  }
  return left === right
}

async function fileExists(pathValue: string): Promise<boolean> {
  try {
    await fs.access(pathValue, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

function expandHome(pathValue: string): string {
  if (!pathValue.startsWith('~')) {
    return pathValue
  }
  if (pathValue === '~') {
    return homedir()
  }
  return pathValue.replace(/^~(?=$|[\\/])/, homedir())
}

interface ExecCommandResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

interface ExecCommandOptions {
  throwOnError?: boolean
}

// Must not use tinyexec with CJS on win32: https://github.com/dankeboy36/boardlab/issues/20
async function execCommand(
  command: string,
  args: string[],
  options?: ExecCommandOptions
): Promise<ExecCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    child.stdout?.on('data', (chunk) => (stdout += chunk.toString()))
    child.stderr?.on('data', (chunk) => (stderr += chunk.toString()))

    child.on('error', (error) => {
      if (settled) {
        return
      }
      settled = true
      reject(error)
    })

    child.on('close', (exitCode) => {
      if (settled) {
        return
      }
      settled = true

      const result: ExecCommandResult = {
        stdout,
        stderr,
        exitCode,
      }

      if ((options?.throwOnError ?? false) && exitCode !== 0) {
        const error = new Error(
          `Command "${command}" exited with code ${exitCode ?? 'unknown'}`
        ) as Error & ExecCommandResult
        error.stdout = stdout
        error.stderr = stderr
        error.exitCode = exitCode
        reject(error)
        return
      }

      resolve(result)
    })
  })
}
