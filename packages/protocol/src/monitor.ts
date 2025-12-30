import type { MonitorPortSettingDescriptor } from 'ardunno-cli'
import type { DetectedPorts, PortIdentifier } from 'boards-list'
import {
  NotificationType as JsonRpcNotificationType,
  RequestType as JsonRpcRequestType,
  RequestType0 as JsonRpcRequestType0,
} from 'vscode-jsonrpc'
import type {
  NotificationType as MessengerNotificationType,
  RequestType as MessengerRequestType,
} from 'vscode-messenger-common'

export interface ConnectClientParams {
  readonly clientId: string
  readonly selectedPort?: PortIdentifier
  readonly selectedBaudrate?: string
}

export interface MonitorProtocolSettings {
  readonly settings?: MonitorPortSettingDescriptor[]
  readonly error?: string
}

export interface MonitorSettingsByProtocol {
  readonly protocols: Record<string, MonitorProtocolSettings>
}

export interface ConnectClientResult {
  readonly detectedPorts: DetectedPorts
  readonly monitorSettingsByProtocol: MonitorSettingsByProtocol
  readonly selectedBaudrates?: ReadonlyArray<
    readonly [port: PortIdentifier, baudrate: string]
  >
  readonly suspendedPortKeys?: string[]
}

export interface HostConnectClientResult extends ConnectClientResult {
  readonly selectedPort?: PortIdentifier
  readonly selectedBaudrate?: string
  readonly runningMonitors?: ReadonlyArray<{
    readonly port: PortIdentifier
    readonly baudrate?: string
  }>
}

export const RequestClientConnect = new JsonRpcRequestType<
  ConnectClientParams,
  ConnectClientResult,
  void
>('boardlab/monitor/requestClientConnect')

export const NotifyDidChangeDetectedPorts =
  new JsonRpcNotificationType<DetectedPorts>(
    'boardlab/monitor/notifyDidChangeDetectedPorts'
  )

export const RequestDetectedPorts = new JsonRpcRequestType0<
  DetectedPorts,
  void
>('boardlab/monitor/requestDetectedPorts')

export const NotifyDidChangeMonitorSettings =
  new JsonRpcNotificationType<MonitorSettingsByProtocol>(
    'boardlab/monitor/notifyDidChangeMonitorSettings'
  )

export interface DidChangeBaudrateNotification {
  readonly port: PortIdentifier
  readonly baudrate: string
}

export const NotifyDidChangeBaudrate =
  new JsonRpcNotificationType<DidChangeBaudrateNotification>(
    'boardlab/monitor/notifyDidChangeBaudrate'
  )

export interface DidPauseMonitorNotification {
  readonly port: PortIdentifier
}

export const NotifyMonitorDidPause =
  new JsonRpcNotificationType<DidPauseMonitorNotification>(
    'boardlab/monitor/notifyMonitorDidPause'
  )

export interface DidResumeMonitorNotification {
  readonly didPauseOnPort: PortIdentifier
  readonly didResumeOnPort?: PortIdentifier
}

export const NotifyMonitorDidResume =
  new JsonRpcNotificationType<DidResumeMonitorNotification>(
    'boardlab/monitor/notifyMonitorDidResume'
  )

export interface DidStartMonitorNotification {
  readonly port: PortIdentifier
  readonly baudrate?: string
}

export const NotifyMonitorDidStart =
  new JsonRpcNotificationType<DidStartMonitorNotification>(
    'boardlab/monitor/notifyMonitorDidStart'
  )

export interface DidStopMonitorNotification {
  readonly port: PortIdentifier
}

export const NotifyMonitorDidStop =
  new JsonRpcNotificationType<DidStopMonitorNotification>(
    'boardlab/monitor/notifyMonitorDidStop'
  )

export interface RequestPauseResumeMonitorParams {
  readonly port: PortIdentifier
}

export const RequestPauseMonitor = new JsonRpcRequestType<
  RequestPauseResumeMonitorParams,
  boolean,
  void
>('boardlab/monitor/requestPauseMonitor')

export const RequestResumeMonitor = new JsonRpcRequestType<
  RequestPauseResumeMonitorParams,
  boolean,
  void
>('boardlab/monitor/requestResumeMonitor')

export interface RequestUpdateBaudrateParams {
  readonly port: PortIdentifier
  readonly baudrate: string
}

export const RequestUpdateBaudrate = new JsonRpcRequestType<
  RequestUpdateBaudrateParams,
  void,
  void
>('boardlab/monitor/requestUpdateBaudrate')

export interface RequestSendMonitorMessageParams {
  readonly port: PortIdentifier
  readonly message: string
}

export const RequestSendMonitorMessage = new JsonRpcRequestType<
  RequestSendMonitorMessageParams,
  void,
  void
>('boardlab/monitor/requestSendMonitorMessage')

export interface MonitorSelectionNotification {
  readonly port?: PortIdentifier
  readonly baudrate?: string
}

export type MonitorEditorStatus =
  | 'idle'
  | 'running'
  | 'suspended'
  | 'disconnected'

export interface MonitorEditorStatusNotification {
  readonly status: MonitorEditorStatus
}

export interface MonitorEditorContent {
  readonly text: string
}

export const notifyMonitorSelectionChanged: MessengerNotificationType<MonitorSelectionNotification> =
  {
    method: 'boardlab/monitor/selectionChanged',
  }

export const getMonitorSelection: MessengerRequestType<
  void,
  MonitorSelectionNotification
> = {
  method: 'boardlab/monitor/get-selection',
}

export interface MonitorBridgeInfo {
  readonly wsUrl: string
  readonly httpBaseUrl: string
}

export const getMonitorBridgeInfo: MessengerRequestType<
  void,
  MonitorBridgeInfo
> = {
  method: 'boardlab/monitor/get-bridge-info',
}

export const notifyMonitorBridgeError: MessengerNotificationType<{
  readonly message: string
}> = {
  method: 'boardlab/monitor/bridge-error',
}

export const notifyMonitorThemeChanged: MessengerNotificationType<void> = {
  method: 'boardlab/monitor/theme-changed',
}

export const connectMonitorClient: MessengerRequestType<
  ConnectClientParams,
  HostConnectClientResult
> = {
  method: 'boardlab/monitor/connect-client',
}

export interface DisconnectMonitorClientParams {
  readonly clientId: string
}

export const disconnectMonitorClient: MessengerNotificationType<DisconnectMonitorClientParams> =
  {
    method: 'boardlab/monitor/disconnect-client',
  }

export const requestMonitorDetectedPorts: MessengerRequestType<
  void,
  DetectedPorts
> = {
  method: 'boardlab/monitor/request-detected-ports',
}

export const requestMonitorUpdateBaudrate: MessengerRequestType<
  RequestUpdateBaudrateParams,
  void
> = {
  method: 'boardlab/monitor/request-update-baudrate',
}

export const requestMonitorSendMessage: MessengerRequestType<
  RequestSendMonitorMessageParams,
  void
> = {
  method: 'boardlab/monitor/request-send-message',
}

export const requestMonitorPause: MessengerRequestType<
  RequestPauseResumeMonitorParams,
  boolean
> = {
  method: 'boardlab/monitor/request-pause',
}

export const requestMonitorResume: MessengerRequestType<
  RequestPauseResumeMonitorParams,
  boolean
> = {
  method: 'boardlab/monitor/request-resume',
}

export const notifyMonitorViewDidChangeDetectedPorts: MessengerNotificationType<DetectedPorts> =
  {
    method: 'boardlab/monitor/view/did-change-detected-ports',
  }

export const notifyMonitorViewDidChangeMonitorSettings: MessengerNotificationType<MonitorSettingsByProtocol> =
  {
    method: 'boardlab/monitor/view/did-change-monitor-settings',
  }

export const notifyMonitorViewDidChangeBaudrate: MessengerNotificationType<DidChangeBaudrateNotification> =
  {
    method: 'boardlab/monitor/view/did-change-baudrate',
  }

export const notifyMonitorViewDidPause: MessengerNotificationType<DidPauseMonitorNotification> =
  {
    method: 'boardlab/monitor/view/did-pause',
  }

export const notifyMonitorViewDidResume: MessengerNotificationType<DidResumeMonitorNotification> =
  {
    method: 'boardlab/monitor/view/did-resume',
  }

export const notifyMonitorEditorStatus: MessengerNotificationType<MonitorEditorStatusNotification> =
  {
    method: 'boardlab/monitor/editor/status',
  }

export const notifyPlotterEditorStatus: MessengerNotificationType<MonitorEditorStatusNotification> =
  {
    method: 'boardlab/plotter/editor/status',
  }

export const requestMonitorEditorContent: MessengerRequestType<
  void,
  MonitorEditorContent
> = {
  method: 'boardlab/monitor/editor/get-content',
}

export const requestPlotterEditorContent: MessengerRequestType<
  void,
  MonitorEditorContent
> = {
  method: 'boardlab/plotter/editor/get-content',
}
