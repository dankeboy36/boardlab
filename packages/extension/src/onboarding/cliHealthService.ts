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
      const available = await this.cliContext.isExecutableAvailable()
      if (token !== this.refreshToken) {
        return
      }
      if (available) {
        this.setCliStatus('ready')
        return
      }
      this.setCliStatus('required')
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

  async confirmAndInstallCli(): Promise<boolean> {
    const token = ++this.refreshToken
    try {
      await this.cliContext.resolveExecutablePathWithConfirmation()
      if (token === this.refreshToken) {
        this.setCliStatus('ready')
      }
      return true
    } catch (error) {
      if (token === this.refreshToken) {
        this.setCliStatus('required')
      }
      if (error instanceof Error && error.name === 'AbortError') {
        return false
      }
      this.outputChannel?.appendLine(
        `Arduino CLI installation did not complete: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return false
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
