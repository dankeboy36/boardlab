import { spawn } from 'child_process'

import defer from 'p-defer'
import * as vscode from 'vscode'

import { CliContext } from './context'

export interface DaemonAddress {
  readonly hostname: string
  readonly port: number
}

export class Daemon implements vscode.Disposable {
  private readonly outputChannel: vscode.OutputChannel
  private readonly onDidChangeAddressEmitter: vscode.EventEmitter<
    DaemonAddress | undefined
  >

  private _deferredAddress: defer.DeferredPromise<DaemonAddress> | undefined
  private _process: ({ address: DaemonAddress } & vscode.Disposable) | undefined

  constructor(
    context: vscode.ExtensionContext,
    private readonly cliContext: CliContext
  ) {
    this.onDidChangeAddressEmitter = new vscode.EventEmitter<
      DaemonAddress | undefined
    >()
    this.outputChannel = vscode.window.createOutputChannel(
      'BoardLab - Arduino CLI',
      {
        log: true,
      }
    )
    context.subscriptions.push(
      this.outputChannel,
      this.onDidChangeAddressEmitter,
      this
    )
  }

  dispose(): void {
    if (this._process) {
      this._process.dispose()
      this._process = undefined
    }
  }

  get onDidChangeAddress(): vscode.Event<DaemonAddress | undefined> {
    return this.onDidChangeAddressEmitter.event
  }

  get address(): DaemonAddress | undefined {
    return this._process?.address
  }

  async start(): Promise<DaemonAddress | undefined> {
    if (this._process?.address) {
      return this._process.address
    }
    if (this._deferredAddress) {
      return this._deferredAddress.promise
    }
    const command = await this.cliContext.resolveExecutablePath()
    await this.cliContext.cliConfig.ready()
    this._deferredAddress = defer()
    const cliConfigPath = this.cliContext.cliConfig.uri?.fsPath
    setTimeout(async () => {
      try {
        const process = await spawnDaemon(command, cliConfigPath, (data) =>
          this.outputChannel.append(data)
        )
        this._process = process
        this.onDidChangeAddressEmitter.fire(this._process.address)
      } catch (err) {
        this._deferredAddress?.reject(err)
      }
    }, 0)
    return this._deferredAddress.promise
  }
}

async function spawnDaemon(
  command: string,
  cliConfigPath: string | undefined,
  onStdOut: (data: string) => void = console.log,
  debug = true,
  onStdErr?: (data: string) => void
): Promise<{ address: DaemonAddress } & vscode.Disposable> {
  return new Promise((resolve, reject) => {
    let address: DaemonAddress | undefined
    const args = ['daemon', '--port', '0', '-v']
    if (debug) {
      args.push('--debug')
    }
    if (cliConfigPath) {
      args.push('--config-file', cliConfigPath)
    }
    const process = spawn(command, args)
    process.stdout.on('data', (data) => {
      const chunk: string = data.toString()
      onStdOut(chunk)
      if (!address) {
        const lines = chunk.split('\n')
        for (const line of lines) {
          address = tryParseAddress(line)
          if (address) {
            resolve({
              address,
              dispose: () => {
                if (!process.killed) {
                  process.kill()
                }
              },
            })
            break
          }
        }
      }
    })
    process.stderr.on('data', (data) =>
      onStdErr ? onStdErr(data.toString()) : onStdOut(data.toString())
    )
    process.on('error', (err) => reject(err))
    process.on('exit', (code, signal) => {
      let err: Error | undefined
      if (signal) {
        err = new Error(`Exited with signal ${signal}`)
      }
      if (!err && code) {
        err = new Error(`Exited with code ${code}`)
      }
      if (err) {
        reject(err)
      }
      if (!address) {
        reject(new Error('Exited before receiving the daemon address.'))
      }
    })
  })
}

function tryParseAddress(raw: string): DaemonAddress | undefined {
  let json: Record<string, unknown> | undefined
  try {
    json = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!json) {
    return undefined
  }
  const hostname = json['IP']
  const port = json['Port']
  if (typeof hostname === 'string' && typeof port === 'string') {
    const maybePort = Number.parseInt(port, 10)
    if (!Number.isNaN(maybePort)) {
      return { hostname, port: maybePort }
    }
  }
  return undefined
}
