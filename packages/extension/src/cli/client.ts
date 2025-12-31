import {
  ArduinoCoreServiceClient,
  ArduinoCoreServiceDefinition,
  Instance,
} from 'ardunno-cli'
import {
  Channel,
  ChannelCredentials,
  createChannel,
  createClient,
} from 'nice-grpc'
import * as vscode from 'vscode'

import { Arduino, ArduinoCli, ProgressUpdate } from './arduino'
import { DaemonAddress } from './daemon'

export class Client implements vscode.Disposable {
  private readonly channel: Channel
  private readonly client: ArduinoCoreServiceClient
  private _instance: Instance | undefined
  private _arduino: Arduino | undefined

  constructor({ hostname, port }: DaemonAddress) {
    this.channel = createChannel(
      `${hostname}:${port}`,
      ChannelCredentials.createInsecure(),
      {
        'grpc.max_receive_message_length': 1024 * 1024 * 100,
        'grpc.max_send_message_length': 1024 * 1024 * 100,
      }
    )
    this.client = createClient(ArduinoCoreServiceDefinition, this.channel)
  }

  async start(progress?: vscode.Progress<ProgressUpdate>): Promise<void> {
    if (!this._instance) {
      const { instance } = await this.client.create({})
      this._instance = instance
      await this.arduino.init(progress)
    }
  }

  get arduino(): Arduino {
    if (!this._arduino) {
      this._arduino = new ArduinoCli(this.client, this._instance)
    }
    return this._arduino
  }

  dispose(): void {
    this._arduino?.dispose()
    this.channel.close()
  }
}
