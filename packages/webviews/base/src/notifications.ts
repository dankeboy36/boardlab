import {
  requestShowWebviewMessage,
  type WebviewMessageLevel,
} from '@vscode-ardunno/protocol'
import { HOST_EXTENSION } from 'vscode-messenger-common'

import { vscode } from './vscode'

async function send(
  level: WebviewMessageLevel,
  message: string
): Promise<void> {
  if (!message) {
    return
  }
  try {
    if (vscode.messenger) {
      await vscode.messenger.sendRequest(
        requestShowWebviewMessage,
        HOST_EXTENSION,
        {
          level,
          message,
        }
      )
    } else {
      const log =
        level === 'error'
          ? console.error
          : level === 'warning'
            ? console.warn
            : console.info
      log('[webview]', message)
    }
  } catch (error) {
    console.error('[webview] failed to send notification', {
      level,
      message,
      error,
    })
  }
}

export const notifyInfo = (message: string) => send('info', message)
export const notifyWarning = (message: string) => send('warning', message)
export const notifyError = (message: string) => send('error', message)
