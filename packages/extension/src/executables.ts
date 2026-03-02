// Automatically install an executable releases from GitHub.
// This wraps `./install` in the VSCode UI. See that package for more.

// import AbortController from 'abort-controller';
import { promises as fs, constants as fsConstants } from 'node:fs'
import * as path from 'node:path'

import { AbortError } from 'abort-controller-x'
import { GetToolParams, getTool } from 'get-arduino-tools'
import pDefer, { DeferredPromise } from 'p-defer'
import * as vscode from 'vscode'

export class Executables {}

export type ExecutableContextParams = Required<
  Pick<GetToolParams, 'tool' | 'version'>
>

// File layout:
//  <storageUri>/
//    tools/
//      <tool-name>/
//        <version>/
//          tool-name(.exe)?

export class ExecutableContext {
  constructor(
    protected readonly context: vscode.ExtensionContext,
    protected readonly params: ExecutableContextParams
  ) {}

  private _downloadInProgress: DeferredPromise<string> | undefined
  private _promptInProgress: DeferredPromise<boolean> | undefined

  async isExecutableAvailable(): Promise<boolean> {
    try {
      await fs.access(this.toolPath, fsConstants.X_OK)
      return true
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        typeof (err as { code?: unknown }).code === 'string'
      ) {
        return false
      }
      throw err
    }
  }

  async resolveExecutablePath(): Promise<string> {
    if (this._downloadInProgress) {
      return this._downloadInProgress.promise
    }
    if (await this.isExecutableAvailable()) {
      return this.toolPath
    }
    if (!(await this.promptDownload())) {
      throw new AbortError()
    }
    return this.ensureDownloaded()
  }

  async resolveExecutablePathWithConfirmation(): Promise<string> {
    if (this._downloadInProgress) {
      return this._downloadInProgress.promise
    }
    if (await this.isExecutableAvailable()) {
      return this.toolPath
    }
    if (!(await this.confirmDownload())) {
      throw new AbortError()
    }
    return this.ensureDownloaded()
  }

  private ensureDownloaded(): Promise<string> {
    if (this._downloadInProgress) {
      return this._downloadInProgress.promise
    }

    const deferred = pDefer<string>()
    this._downloadInProgress = deferred
    this.download().then(
      (toolPath) => {
        this.showSuccess()
        deferred.resolve(toolPath)
        this._downloadInProgress = undefined
      },
      (error) => {
        deferred.reject(error)
        this._downloadInProgress = undefined
      }
    )
    return deferred.promise
  }

  private async download(): Promise<string> {
    const destinationFolderPath = path.dirname(this.toolPath)
    const { tool, version } = this.params
    return vscode.window.withProgress(
      {
        title: `Downloading '${tool}' version '${version}'...`,
        cancellable: true,
        location: vscode.ProgressLocation.Notification,
      },
      async (progress, cancel) => {
        let controller: AbortController | undefined
        if (cancel) {
          controller = new AbortController()
          cancel.onCancellationRequested(() => controller?.abort())
        }

        await fs.mkdir(destinationFolderPath, { recursive: true })

        const result = await getTool({
          destinationFolderPath,
          tool,
          version,
          onProgress({ current }) {
            progress.report({ increment: current })
          },
          signal: controller?.signal,
        })
        return result.toolPath
      }
    )
  }

  private get toolPath(): string {
    const { tool, version } = this.params
    const storagePath = this.context.globalStorageUri.fsPath
    return path.join(
      storagePath,
      'tools',
      tool,
      version,
      `${tool}${process.platform === 'win32' ? '.exe' : ''}`
    )
  }

  private promptDownload(): Promise<boolean> {
    if (this._promptInProgress) {
      return this._promptInProgress.promise
    }

    const deferred = pDefer<boolean>()
    this._promptInProgress = deferred
    const { tool, version } = this.params
    vscode.window
      .showInformationMessage(
        `Welcome to BoardLab! BoardLab needs the ${tool} (version ${version}) to work. It can be downloaded automatically from the official Arduino servers. Would you like to download it now?`,
        'Yes',
        'Later'
      )
      .then(
        (answer) => {
          deferred.resolve(answer === 'Yes')
          this._promptInProgress = undefined
        },
        (error) => {
          deferred.reject(error)
          this._promptInProgress = undefined
        }
      )
    return deferred.promise
  }

  private async confirmDownload(): Promise<boolean> {
    const { tool, version } = this.params
    const answer = await vscode.window.showInformationMessage(
      'Welcome to BoardLab',
      {
        modal: true,
        detail: `BoardLab needs the ${tool} (version ${version}) to work. It can be downloaded automatically from the official Arduino servers. Would you like to download it now?`,
      },
      'Download'
    )
    return answer === 'Download'
  }

  private showSuccess(): void {
    const { tool, version } = this.params
    vscode.window.showInformationMessage(
      `Successfully downloaded '${tool}' version '${version}'`
    )
  }
}
