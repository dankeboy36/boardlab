import {
  NotificationType as MessengerNotificationType,
  RequestType as MessengerRequestType,
} from 'vscode-messenger-common'

export type WebviewMessageLevel = 'info' | 'warning' | 'error'

export interface WebviewMessageParams {
  readonly level: WebviewMessageLevel
  readonly message: string
}

export const requestShowWebviewMessage: MessengerRequestType<
  WebviewMessageParams,
  void
> = {
  method: 'webview/requestShowMessage',
}

export type MonitorToolbarAction =
  | 'copyAll'
  | 'saveToFile'
  | 'clear'
  | 'play'
  | 'stop'

export interface MonitorToolbarActionParams {
  readonly action: MonitorToolbarAction
}

export const notifyMonitorToolbarAction: MessengerNotificationType<MonitorToolbarActionParams> =
  {
    method: 'monitor/toolbar-action',
  }

export type ExamplesToolbarAction = 'refresh'

export interface ExamplesToolbarActionParams {
  readonly action: ExamplesToolbarAction
}

export const notifyExamplesToolbarAction: MessengerNotificationType<ExamplesToolbarActionParams> =
  {
    method: 'examples/toolbar-action',
  }

export type LineEnding = 'none' | 'lf' | 'cr' | 'crlf'

export interface LineEndingChangedParams {
  readonly lineEnding: LineEnding
}

export const notifyMonitorLineEndingChanged: MessengerNotificationType<LineEndingChangedParams> =
  {
    method: 'monitor/line-ending-changed',
  }

export type PlotterToolbarAction = 'clear' | 'resetYScale' | 'play' | 'stop'

export interface PlotterToolbarActionParams {
  readonly action: PlotterToolbarAction
}

export const notifyPlotterToolbarAction: MessengerNotificationType<PlotterToolbarActionParams> =
  {
    method: 'plotter/toolbar-action',
  }

export const notifyPlotterLineEndingChanged: MessengerNotificationType<LineEndingChangedParams> =
  {
    method: 'plotter/line-ending-changed',
  }

export interface ConfigureLineEndingParams {
  readonly kind: 'monitor' | 'plotter'
}

export const requestConfigureLineEnding: MessengerRequestType<
  ConfigureLineEndingParams,
  void
> = {
  method: 'webview/requestConfigureLineEnding',
}
