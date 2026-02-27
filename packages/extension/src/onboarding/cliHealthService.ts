import * as vscode from 'vscode'

import type { CliContext } from '../cli/context'
import type { CliStatus } from './state'

export class CliHealthService implements vscode.Disposable {
  private readonly onDidChangeCliStatusEmitter =
    new vscode.EventEmitter<CliStatus>()

  private cliStatusValue: CliStatus = 'checking'
  private refreshToken = 0

  readonly onDidChangeCliStatus = this.onDidChangeCliStatusEmitter.event

  constructor(
    private readonly cliContext: CliContext,
    private readonly outputChannel?: vscode.OutputChannel
  ) {
    this.refresh().catch((error) =>
      console.warn('CLI health check failed', error)
    )
  }

  get cliStatus(): CliStatus {
    return this.cliStatusValue
  }

  async refresh(): Promise<void> {
    const token = ++this.refreshToken
    this.setCliStatus('checking')
    try {
      // resolveExecutablePath checks whether file can be executed
      await this.cliContext.resolveExecutablePath()
      if (token !== this.refreshToken) {
        return
      }
      this.setCliStatus('ready')
    } catch (error) {
      if (token !== this.refreshToken) {
        return
      }
      this.outputChannel?.appendLine(
        `Arduino CLI health check failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      this.setCliStatus('required')
    }
  }

  dispose(): void {
    this.onDidChangeCliStatusEmitter.dispose()
  }

  private setCliStatus(next: CliStatus): void {
    if (this.cliStatusValue === next) {
      return
    }
    this.cliStatusValue = next
    this.onDidChangeCliStatusEmitter.fire(next)
  }
}
