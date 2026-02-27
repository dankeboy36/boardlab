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

  private _ensureExists: DeferredPromise<string> | undefined
  async resolveExecutablePath(): Promise<string> {
    if (this._ensureExists) {
      return this._ensureExists.promise
    }
    const deferred = pDefer<string>()
    this._ensureExists = deferred
    this.ensureExists().then(deferred.resolve, (error) => {
      // Allow retry after a failed attempt (e.g. user selected "Later",
      // download canceled, transient network error).
      deferred.reject(error)
      this._ensureExists = undefined
    })
    return deferred.promise
  }

  private async ensureExists(): Promise<string> {
    try {
      await fs.access(this.toolPath, fsConstants.X_OK)
      return this.toolPath
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        if (await this.promptDownload()) {
          const toolPath = await this.download()
          this.showSuccess()
          return toolPath
        }
        throw new AbortError()
      }
      throw err
    }
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

  private async promptDownload(): Promise<boolean> {
    const { tool, version } = this.params
    const answer = await vscode.window.showInformationMessage(
      `Welcome to BoardLab! BoardLab needs the ${tool} (version ${version}) to work. It can be downloaded automatically from the official Arduino servers. Would you like to download it now?`,
      'Yes',
      'Later'
    )
    return answer === 'Yes'
  }

  private showSuccess(): void {
    const { tool, version } = this.params
    vscode.window.showInformationMessage(
      `Successfully downloaded '${tool}' version '${version}'`
    )
  }
}
