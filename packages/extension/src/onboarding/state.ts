import type { BoardDetails } from 'vscode-arduino-api'

export type CliStatus = 'checking' | 'ready' | 'required'
export type OnboardingIntent = 'compile' | 'upload' | 'monitor' | 'none' // TODO: add 'burn-bootloader'? 'external'?

export type OnboardingState =
  | 'CLI_CHECKING'
  | 'CLI_REQUIRED'
  | 'SKETCH_REQUIRED'
  | 'BOARD_REQUIRED'
  | 'PLATFORM_REQUIRED'
  | 'READY_COMPILE'
  | 'PORT_REQUIRED'
  | 'READY_FULL'

interface SketchLike {
  readonly board?: unknown
  readonly port?: {
    readonly protocol?: string
    readonly address?: string
  }
}

interface ArduinoContextLike {
  readonly currentSketch?: SketchLike
}

export interface OnboardingResolverParams {
  cliStatus: CliStatus
  arduinoContext: ArduinoContextLike
  intent?: OnboardingIntent
}

export function isBoardDetails(board: unknown): board is BoardDetails {
  return (
    typeof board === 'object' &&
    board !== null &&
    'configOptions' in board &&
    (board as { configOptions?: unknown }).configOptions !== undefined
  )
}

function hasSelectedPort(port: SketchLike['port']): boolean {
  return Boolean(port?.protocol && port.address)
}

export function deriveOnboardingState({
  cliStatus,
  arduinoContext,
  intent = 'none',
}: OnboardingResolverParams): OnboardingState {
  if (cliStatus === 'checking') {
    return 'CLI_CHECKING'
  }
  if (cliStatus === 'required') {
    return 'CLI_REQUIRED'
  }

  const currentSketch = arduinoContext.currentSketch
  if (!currentSketch) {
    return 'SKETCH_REQUIRED'
  }

  if (!currentSketch.board) {
    return 'BOARD_REQUIRED'
  }

  if (!isBoardDetails(currentSketch.board)) {
    return 'PLATFORM_REQUIRED'
  }

  if (
    (intent === 'upload' || intent === 'monitor') &&
    !hasSelectedPort(currentSketch.port)
  ) {
    return 'PORT_REQUIRED'
  }

  if (hasSelectedPort(currentSketch.port)) {
    return 'READY_FULL'
  }

  return 'READY_COMPILE'
}
