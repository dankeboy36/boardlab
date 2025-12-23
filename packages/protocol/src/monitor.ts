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
>('portino/requestClientConnect')

export const NotifyDidChangeDetectedPorts =
  new JsonRpcNotificationType<DetectedPorts>(
    'portino/notifyDidChangeDetectedPorts'
  )

export const RequestDetectedPorts = new JsonRpcRequestType0<
  DetectedPorts,
  void
>('portino/requestDetectedPorts')

export const NotifyDidChangeMonitorSettings =
  new JsonRpcNotificationType<MonitorSettingsByProtocol>(
    'portino/notifyDidChangeMonitorSettings'
  )

export interface DidChangeBaudrateNotification {
  readonly port: PortIdentifier
  readonly baudrate: string
}

export const NotifyDidChangeBaudrate =
  new JsonRpcNotificationType<DidChangeBaudrateNotification>(
    'portino/notifyDidChangeBaudrate'
  )

export interface DidPauseMonitorNotification {
  readonly port: PortIdentifier
}

export const NotifyMonitorDidPause =
  new JsonRpcNotificationType<DidPauseMonitorNotification>(
    'portino/notifyMonitorDidPause'
  )

export interface DidResumeMonitorNotification {
  readonly didPauseOnPort: PortIdentifier
  readonly didResumeOnPort?: PortIdentifier
}

export const NotifyMonitorDidResume =
  new JsonRpcNotificationType<DidResumeMonitorNotification>(
    'portino/notifyMonitorDidResume'
  )

export interface DidStartMonitorNotification {
  readonly port: PortIdentifier
  readonly baudrate?: string
}

export const NotifyMonitorDidStart =
  new JsonRpcNotificationType<DidStartMonitorNotification>(
    'portino/notifyMonitorDidStart'
  )

export interface DidStopMonitorNotification {
  readonly port: PortIdentifier
}

export const NotifyMonitorDidStop =
  new JsonRpcNotificationType<DidStopMonitorNotification>(
    'portino/notifyMonitorDidStop'
  )

export interface RequestPauseResumeMonitorParams {
  readonly port: PortIdentifier
}

export const RequestPauseMonitor = new JsonRpcRequestType<
  RequestPauseResumeMonitorParams,
  boolean,
  void
>('portino/requestPauseMonitor')

export const RequestResumeMonitor = new JsonRpcRequestType<
  RequestPauseResumeMonitorParams,
  boolean,
  void
>('portino/requestResumeMonitor')

export interface RequestUpdateBaudrateParams {
  readonly port: PortIdentifier
  readonly baudrate: string
}

export const RequestUpdateBaudrate = new JsonRpcRequestType<
  RequestUpdateBaudrateParams,
  void,
  void
>('portino/requestUpdateBaudrate')

export interface RequestSendMonitorMessageParams {
  readonly port: PortIdentifier
  readonly message: string
}

export const RequestSendMonitorMessage = new JsonRpcRequestType<
  RequestSendMonitorMessageParams,
  void,
  void
>('portino/requestSendMonitorMessage')

export interface MonitorSelectionNotification {
  readonly port?: PortIdentifier
  readonly baudrate?: string
}

export const notifyMonitorSelectionChanged: MessengerNotificationType<MonitorSelectionNotification> =
  {
    method: 'monitor/selectionChanged',
  }

export const getMonitorSelection: MessengerRequestType<
  void,
  MonitorSelectionNotification
> = {
  method: 'monitor/get-selection',
}

export interface MonitorBridgeInfo {
  readonly wsUrl: string
  readonly httpBaseUrl: string
}

export const getMonitorBridgeInfo: MessengerRequestType<
  void,
  MonitorBridgeInfo
> = {
  method: 'monitor/get-bridge-info',
}

export const notifyMonitorBridgeError: MessengerNotificationType<{
  readonly message: string
}> = {
  method: 'monitor/bridge-error',
}

export const notifyMonitorThemeChanged: MessengerNotificationType<void> = {
  method: 'monitor/theme-changed',
}

export const connectMonitorClient: MessengerRequestType<
  ConnectClientParams,
  HostConnectClientResult
> = {
  method: 'monitor/connect-client',
}

export interface DisconnectMonitorClientParams {
  readonly clientId: string
}

export const disconnectMonitorClient: MessengerNotificationType<DisconnectMonitorClientParams> =
  {
    method: 'monitor/disconnect-client',
  }

export const requestMonitorDetectedPorts: MessengerRequestType<
  void,
  DetectedPorts
> = {
  method: 'monitor/request-detected-ports',
}

export const requestMonitorUpdateBaudrate: MessengerRequestType<
  RequestUpdateBaudrateParams,
  void
> = {
  method: 'monitor/request-update-baudrate',
}

export const requestMonitorSendMessage: MessengerRequestType<
  RequestSendMonitorMessageParams,
  void
> = {
  method: 'monitor/request-send-message',
}

export const requestMonitorPause: MessengerRequestType<
  RequestPauseResumeMonitorParams,
  boolean
> = {
  method: 'monitor/request-pause',
}

export const requestMonitorResume: MessengerRequestType<
  RequestPauseResumeMonitorParams,
  boolean
> = {
  method: 'monitor/request-resume',
}

export const notifyMonitorViewDidChangeDetectedPorts: MessengerNotificationType<DetectedPorts> =
  {
    method: 'monitor/view/did-change-detected-ports',
  }

export const notifyMonitorViewDidChangeMonitorSettings: MessengerNotificationType<MonitorSettingsByProtocol> =
  {
    method: 'monitor/view/did-change-monitor-settings',
  }

export const notifyMonitorViewDidChangeBaudrate: MessengerNotificationType<DidChangeBaudrateNotification> =
  {
    method: 'monitor/view/did-change-baudrate',
  }

export const notifyMonitorViewDidPause: MessengerNotificationType<DidPauseMonitorNotification> =
  {
    method: 'monitor/view/did-pause',
  }

export const notifyMonitorViewDidResume: MessengerNotificationType<DidResumeMonitorNotification> =
  {
    method: 'monitor/view/did-resume',
  }
