import { NotificationType as JsonRpcNotificationType } from 'vscode-jsonrpc'

export type TraceLayer = 'bridge' | 'ext' | 'webview'

export interface TraceEventNotification {
  readonly event: string
  readonly data?: Record<string, unknown>
  readonly monitorSessionId?: string
  readonly clientId?: string
  readonly webviewId?: string
  readonly webviewType?: string
  readonly portKey?: string
  readonly src?: {
    readonly layer?: TraceLayer
    readonly runId?: string
    readonly pid?: number
  }
}

export const NotifyTraceEvent =
  new JsonRpcNotificationType<TraceEventNotification>(
    'boardlab/monitor/trace-event'
  )
