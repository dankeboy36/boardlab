import type {
  Disposable,
  NotificationHandler,
  NotificationType,
  RequestHandler,
  RequestType,
} from 'vscode-messenger-common'
import type { Messenger } from 'vscode-messenger-webview'

// https://github.com/TypeFox/vscode-messenger/issues/51
export const messengerx = {
  onNotification<T>(
    messenger: Messenger,
    type: NotificationType<T>,
    handler: NotificationHandler<T>
  ): Disposable {
    messenger.onNotification(type, handler)
    return {
      dispose: () => {
        messenger['handlerRegistry'].delete(type.method)
      },
    }
  },
  onRequest<R, T>(
    messenger: Messenger,
    type: RequestType<R, T>,
    handler: RequestHandler<R, T>
  ): Disposable {
    messenger.onRequest(type, handler)
    return {
      dispose: () => {
        messenger['handlerRegistry'].delete(type.method)
      },
    }
  },
} as const
