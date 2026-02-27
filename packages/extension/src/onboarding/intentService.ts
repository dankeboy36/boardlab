import * as vscode from 'vscode'

import type { OnboardingIntent } from './state'

export class OnboardingIntentService implements vscode.Disposable {
  private readonly onDidChangeIntentEmitter =
    new vscode.EventEmitter<OnboardingIntent>()

  private intentValue: OnboardingIntent = 'none'

  readonly onDidChangeIntent = this.onDidChangeIntentEmitter.event

  get intent(): OnboardingIntent {
    return this.intentValue
  }

  setIntent(intent: OnboardingIntent): void {
    if (this.intentValue === intent) {
      return
    }
    this.intentValue = intent
    this.onDidChangeIntentEmitter.fire(this.intentValue)
  }

  dispose(): void {
    this.onDidChangeIntentEmitter.dispose()
  }
}
