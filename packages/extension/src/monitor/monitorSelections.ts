import {
  notifyMonitorSelectionChanged,
  type MonitorSelectionNotification,
} from '@vscode-ardunno/protocol'
import { createPortKey, type PortIdentifier } from 'boards-list'
import * as vscode from 'vscode'
import { Messenger } from 'vscode-messenger'
import type {
  MessageParticipant,
  WebviewIdMessageParticipant,
} from 'vscode-messenger-common'

export type SelectionProvider = () => MonitorSelectionNotification | undefined

interface SelectionTarget {
  readonly participant: WebviewIdMessageParticipant
  readonly provider: SelectionProvider
}

export class MonitorSelectionCoordinator implements vscode.Disposable {
  private readonly targets = new Map<string, SelectionTarget>()
  private readonly disposables: vscode.Disposable[] = []

  constructor(
    private readonly messenger: Messenger,
    private readonly defaultProvider: SelectionProvider
  ) {}

  registerTarget(
    participant: WebviewIdMessageParticipant,
    provider: SelectionProvider
  ): vscode.Disposable {
    const key = participant.webviewId
    this.targets.set(key, { participant, provider })
    return new vscode.Disposable(() => {
      this.targets.delete(key)
    })
  }

  resolveFor(
    sender?: MessageParticipant
  ): MonitorSelectionNotification | undefined {
    if (sender?.type === 'webview' && 'webviewId' in sender) {
      const target = this.targets.get(sender.webviewId)
      if (target) {
        return target.provider()
      }
    }
    return this.defaultProvider()
  }

  async pushSelection(
    participant: WebviewIdMessageParticipant | PortIdentifier
  ): Promise<void> {
    const target =
      'webviewId' in participant
        ? this.targets.get(participant.webviewId)
        : this.getTargetByPort(participant)
    if (!target) {
      return
    }
    const selection = target.provider()
    if (!selection) {
      return
    }
    try {
      await this.messenger.sendNotification(
        notifyMonitorSelectionChanged,
        target.participant,
        selection
      )
    } catch (error) {
      console.error('Failed to push monitor selection', {
        participant: target.participant.webviewId,
        error,
      })
    }
  }

  async pushAll(): Promise<void> {
    await Promise.all(
      Array.from(this.targets.values()).map((target) =>
        this.pushSelection(target.participant)
      )
    )
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose()
    this.targets.clear()
  }

  private getTargetByPort(port: PortIdentifier): SelectionTarget | undefined {
    const key = createPortKey(port)
    for (const target of this.targets.values()) {
      const selection = target.provider()
      if (selection?.port && createPortKey(selection.port) === key) {
        return target
      }
    }
    return undefined
  }
}
