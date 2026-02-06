import {
  RequestType as JsonRpcRequestType,
  RequestType0 as JsonRpcRequestType0,
} from 'vscode-jsonrpc'

export interface PortinoHelloResult {
  readonly serverVersion?: string
  readonly protocolVersion: number
  readonly capabilities: ReadonlyArray<string>
  readonly clientId: string
}

export const RequestPortinoHello = new JsonRpcRequestType0<
  PortinoHelloResult,
  void
>('portino.hello')

export type MonitorOpenMode = 'shared' | 'exclusive'

export interface MonitorOpenParams {
  readonly portKey: string
  readonly mode?: MonitorOpenMode
}

export interface MonitorOpenResult {
  readonly monitorId: number
  readonly effectivePortKey: string
}

export const RequestMonitorOpen = new JsonRpcRequestType<
  MonitorOpenParams,
  MonitorOpenResult,
  void
>('monitor.open')

export interface MonitorSubscribeParams {
  readonly monitorId: number
  readonly tailBytes?: number
}

export interface MonitorSubscribeResult {
  readonly ok: true
}

export const RequestMonitorSubscribe = new JsonRpcRequestType<
  MonitorSubscribeParams,
  MonitorSubscribeResult,
  void
>('monitor.subscribe')

export interface MonitorUnsubscribeParams {
  readonly monitorId: number
}

export interface MonitorUnsubscribeResult {
  readonly ok: true
}

export const RequestMonitorUnsubscribe = new JsonRpcRequestType<
  MonitorUnsubscribeParams,
  MonitorUnsubscribeResult,
  void
>('monitor.unsubscribe')

export interface MonitorCloseParams {
  readonly monitorId: number
}

export interface MonitorCloseResult {
  readonly ok: true
}

export const RequestMonitorClose = new JsonRpcRequestType<
  MonitorCloseParams,
  MonitorCloseResult,
  void
>('monitor.close')

export type MonitorWritePayload =
  | Uint8Array
  | ReadonlyArray<number>
  | { readonly type: 'Buffer'; readonly data: ReadonlyArray<number> }

export interface MonitorWriteParams {
  readonly monitorId: number
  readonly data: MonitorWritePayload
}

export interface MonitorWriteResult {
  readonly bytesWritten: number
}

export const RequestMonitorWrite = new JsonRpcRequestType<
  MonitorWriteParams,
  MonitorWriteResult,
  void
>('monitor.write')
