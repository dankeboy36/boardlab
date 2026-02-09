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

/** The style of the cursor when the terminal is focused. */
export type CursorStyle = 'block' | 'underline' | 'bar'

/**
 * /**
 *
 * The style of the cursor when the terminal is not focused.
 */
export type CursorInactiveStyle =
  | 'outline'
  | 'block'
  | 'bar'
  | 'underline'
  | 'none'

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
    readonly monitorSessionId?: string
  }>
  readonly physicalStates?: ReadonlyArray<MonitorPhysicalState>
  readonly sessionStates?: ReadonlyArray<MonitorSessionState>
  readonly transport?: MonitorTransport
}

export type MonitorTransport = 'http' | 'ws'

export type MonitorSessionStatus =
  | 'idle'
  | 'connecting'
  | 'active'
  | 'paused'
  | 'error'

export type MonitorSessionDesired = 'running' | 'stopped'

export type MonitorSessionPauseReason =
  | 'user'
  | 'suspend'
  | 'resource-busy'
  | 'resource-missing'

export interface MonitorSessionError {
  readonly code?: string
  readonly status?: number
  readonly message?: string
}

export interface MonitorSessionState {
  readonly portKey: string
  readonly port: PortIdentifier
  readonly status: MonitorSessionStatus
  readonly desired: MonitorSessionDesired
  readonly detected: boolean
  readonly clients: ReadonlyArray<string>
  readonly openPending: boolean
  readonly closePending: boolean
  readonly currentAttemptId: number | null
  readonly lastCompletedAttemptId: number | null
  readonly pauseReason?: MonitorSessionPauseReason
  readonly lastError?: MonitorSessionError
  readonly monitorSessionId?: string
  readonly baudrate?: string
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
  readonly monitorSessionId?: string
}

export const NotifyMonitorDidStart =
  new JsonRpcNotificationType<DidStartMonitorNotification>(
    'boardlab/monitor/notifyMonitorDidStart'
  )

export interface DidStopMonitorNotification {
  readonly port: PortIdentifier
  readonly monitorSessionId?: string
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

export type PhysicalSessionState =
  | 'CREATED'
  | 'STARTING'
  | 'STARTED'
  | 'STOPPING'
  | 'STOPPED'
  | 'FAILED'

export interface MonitorPhysicalState {
  readonly port: PortIdentifier
  readonly state: PhysicalSessionState
  readonly monitorSessionId?: string
  readonly baudrate?: string
  readonly attemptId?: number
  readonly reason?: string
  readonly error?: string
  readonly updatedAt?: string
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

export const notifyMonitorPhysicalStateChanged: MessengerNotificationType<MonitorPhysicalState> =
  {
    method: 'boardlab/monitor/physical-state-changed',
  }

export const requestMonitorPhysicalStateSnapshot: MessengerRequestType<
  void,
  ReadonlyArray<MonitorPhysicalState>
> = {
  method: 'boardlab/monitor/get-physical-state',
}

export interface MonitorClientAttachParams {
  readonly clientId: string
  readonly port: PortIdentifier
}

export interface MonitorClientDetachParams {
  readonly clientId: string
  readonly port: PortIdentifier
}

export interface MonitorIntentParams {
  readonly port: PortIdentifier
  readonly clientId?: string
}

export interface MonitorOpenErrorNotification {
  readonly port: PortIdentifier
  readonly status?: number
  readonly code?: string
  readonly message?: string
}

export const notifyMonitorClientAttached: MessengerNotificationType<MonitorClientAttachParams> =
  {
    method: 'boardlab/monitor/client-attached',
  }

export const notifyMonitorClientDetached: MessengerNotificationType<MonitorClientDetachParams> =
  {
    method: 'boardlab/monitor/client-detached',
  }

export const notifyMonitorIntentStart: MessengerNotificationType<MonitorIntentParams> =
  {
    method: 'boardlab/monitor/intent-start',
  }

export const notifyMonitorIntentStop: MessengerNotificationType<MonitorIntentParams> =
  {
    method: 'boardlab/monitor/intent-stop',
  }

export const notifyMonitorIntentResume: MessengerNotificationType<MonitorIntentParams> =
  {
    method: 'boardlab/monitor/intent-resume',
  }

export const notifyMonitorOpenError: MessengerNotificationType<MonitorOpenErrorNotification> =
  {
    method: 'boardlab/monitor/open-error',
  }

export const notifyMonitorSessionState: MessengerNotificationType<MonitorSessionState> =
  {
    method: 'boardlab/monitor/session-state',
  }

export interface MonitorStreamDataNotification {
  readonly portKey: string
  readonly data: Uint8Array
}

export interface MonitorStreamErrorNotification {
  readonly portKey: string
  readonly code?: string
  readonly status?: number
  readonly message?: string
}

export const notifyMonitorStreamData: MessengerNotificationType<MonitorStreamDataNotification> =
  {
    method: 'boardlab/monitor/stream-data',
  }

export const notifyMonitorStreamError: MessengerNotificationType<MonitorStreamErrorNotification> =
  {
    method: 'boardlab/monitor/stream-error',
  }

export const requestMonitorSessionSnapshot: MessengerRequestType<
  void,
  ReadonlyArray<MonitorSessionState>
> = {
  method: 'boardlab/monitor/get-session-state',
}

export type MonitorBridgeLogLevel =
  | 'trace'
  | 'debug'
  | 'info'
  | 'warn'
  | 'error'

export interface MonitorBridgeLogEntry {
  readonly level: MonitorBridgeLogLevel
  readonly message: string
  readonly timestamp?: string
  readonly context?: Record<string, unknown>
}

export const NotifyMonitorBridgeLog =
  new JsonRpcNotificationType<MonitorBridgeLogEntry>(
    'boardlab/monitor/bridge-log'
  )

export const notifyMonitorThemeChanged: MessengerNotificationType<void> = {
  method: 'boardlab/monitor/theme-changed',
}

export interface MonitorTerminalSettings {
  readonly cursorStyle?: CursorStyle
  readonly cursorInactiveStyle?: CursorInactiveStyle
  readonly cursorBlink?: boolean
  readonly scrollback?: number
  readonly fontSize?: number
}

export const notifyMonitorTerminalSettingsChanged: MessengerNotificationType<MonitorTerminalSettings> =
  {
    method: 'boardlab/monitor/terminal-settings-changed',
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
