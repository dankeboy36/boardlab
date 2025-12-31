import { NotificationHandler, NotificationType } from 'vscode-messenger-common'
import { Messenger } from 'vscode-messenger-webview'
import type { WebviewApi } from 'vscode-webview'

export interface Store {
  getState: () => unknown | undefined
  setState: <T extends unknown | undefined>(newState: T) => T
}

class VSCodeWrapper implements Store {
  private readonly webviewApi: WebviewApi<unknown> | undefined
  readonly messenger: Messenger | undefined

  constructor() {
    if (typeof acquireVsCodeApi === 'function') {
      this.webviewApi = acquireVsCodeApi()
      this.messenger = new Messenger(this.webviewApi)

      const messenger = this.messenger as Messenger & {
        handlerRegistry?: Map<string, unknown>
      }
      const originalOnNotification = messenger.onNotification.bind(messenger)
      messenger.onNotification = ((
        type: NotificationType<unknown>,
        handler: NotificationHandler<unknown>
      ) => {
        originalOnNotification(type, handler)
        return {
          dispose: () => {
            try {
              const registry = messenger.handlerRegistry
              const current = registry?.get(type.method)
              if (current === handler) {
                registry.delete(type.method)
              }
            } catch (error) {
              console.error('[vscode] Failed to dispose notification handler', {
                method: type.method,
                error,
              })
            }
          },
        }
      }) as unknown as Messenger['onNotification']
      this.messenger.start()
    }
  }

  getState(): unknown | undefined {
    if (this.webviewApi) {
      return this.webviewApi.getState()
    } else {
      const state = localStorage.getItem('vscodeState')
      return state ? JSON.parse(state) : undefined
    }
  }

  setState<T extends unknown | undefined>(newState: T): T {
    if (this.webviewApi) {
      return this.webviewApi.setState(newState)
    } else {
      localStorage.setItem('vscodeState', JSON.stringify(newState))
      return newState
    }
  }
}

export const vscode = new VSCodeWrapper()
