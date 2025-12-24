import * as vscode from 'vscode'

import { ExecutableContext } from '../executables'
import { CliConfig } from './config'
import { Daemon } from './daemon'

const getArduinoCliParams = {
  tool: 'arduino-cli',
  version: '1.3.1',
} as const

export class CliContext extends ExecutableContext {
  readonly daemon: Daemon
  readonly cliConfig: CliConfig

  constructor(
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel
  ) {
    super(context, getArduinoCliParams)
    this.daemon = new Daemon(context, this, outputChannel)
    this.cliConfig = new CliConfig(context, this)
  }
}
