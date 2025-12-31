import type { Event } from '@c4312/evt'
import type { ChangeEvent, SketchFolder } from 'vscode-arduino-api'
import type { NotificationType, RequestType } from 'vscode-messenger-common'

export interface UpdateConfigOptionsParams {
  readonly sketchPath: string
  readonly fqbn: string
}

export interface SelectProgrammerParams {
  readonly sketchPath: string
  readonly programmerId: string
}

export interface ContextServer {
  currentSketch(): Promise<SketchFolder | undefined>
  updateConfigOptions(params: UpdateConfigOptionsParams): Promise<void>
  selectProgrammer(params: SelectProgrammerParams): Promise<void>
}

export interface ContextClient {
  readonly onDidChangeCurrentSketch: Event<SketchFolder | undefined>
  readonly onDidChangeSketch: Event<ChangeEvent<SketchFolder>>
}

export const currentSketch: RequestType<void, SketchFolder | undefined> = {
  method: 'current-sketch',
}
export const updateConfigOptions: RequestType<UpdateConfigOptionsParams, void> =
  { method: 'update-config-options' }
export const selectProgrammer: RequestType<SelectProgrammerParams, void> = {
  method: 'select-programmer',
}
export const didChangeCurrentSketch: NotificationType<
  SketchFolder | undefined
> = {
  method: 'did-change-current-sketch',
}
export const didChangeSketch: NotificationType<ChangeEvent<SketchFolder>> = {
  method: 'did-change-sketch',
}

export type Context = ContextServer &
  ContextClient &
  import('@c4312/evt').IDisposable

export type {
  BoardDetails,
  ChangeEvent,
  ConfigOption,
  ConfigValue,
  Port,
  Programmer,
} from 'vscode-arduino-api'
