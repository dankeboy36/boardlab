import type { OnboardingState } from '../onboarding/state'

export type MonitorRuntimeState = 'stopped' | 'running' | 'suspended' | 'error'
export type UploadRuntimeState = 'idle' | 'running' | 'error'
export type CompileRuntimeState = 'idle' | 'running'

export interface RuntimeState {
  readonly compile: {
    readonly state: CompileRuntimeState
    readonly percent?: number
    readonly message?: string
  }
  readonly monitor: { readonly state: MonitorRuntimeState }
  readonly upload: { readonly state: UploadRuntimeState }
}

export interface StatusBarModelItem {
  readonly id: string
  readonly text: string
  readonly tooltip?: string
  readonly command?: string
  readonly args?: readonly unknown[]
  readonly alignment?: 'left' | 'right'
  readonly priority?: number
}

export interface StatusBarModelContext {
  readonly currentSketchName?: string
  readonly openedSketchesCount: number
  readonly boardLabel?: string
  readonly boardFqbn?: string
  readonly portAddress?: string
  readonly portDetected?: boolean
  readonly canInstallPlatform?: boolean
  readonly platformInstallLabel?: string
  readonly runtime?: RuntimeState
}

export const defaultRuntimeState: RuntimeState = {
  compile: { state: 'idle' },
  monitor: { state: 'stopped' },
  upload: { state: 'idle' },
}

const NOOP_COMMAND = 'boardlab.onboarding.noop'

function createItem(
  id: string,
  text: string,
  command?: string,
  priority = 100,
  tooltip?: string
): StatusBarModelItem {
  return {
    id,
    text,
    command,
    priority,
    tooltip,
  }
}

function maybeSketchItem(
  ctx: StatusBarModelContext,
  priority = 130
): StatusBarModelItem | undefined {
  if (ctx.openedSketchesCount <= 1 || !ctx.currentSketchName) {
    return undefined
  }
  return createItem(
    'sketch',
    `$(folder) ${ctx.currentSketchName}`,
    'boardlab.selectSketch',
    priority,
    'Select sketch'
  )
}

function boardTooltip(ctx: StatusBarModelContext): string {
  const label = ctx.boardLabel?.trim()
  const fqbn = ctx.boardFqbn?.trim()
  if (label && fqbn && label !== fqbn) {
    return `Board: ${label} (${fqbn})`
  }
  if (fqbn) {
    return `Board: ${fqbn}`
  }
  if (label) {
    return `Board: ${label}`
  }
  return 'Select board'
}

function boardItem(
  ctx: StatusBarModelContext,
  priority: number
): StatusBarModelItem {
  return createItem(
    'board',
    ctx.boardLabel || 'Board',
    'boardlab.selectBoard',
    priority,
    boardTooltip(ctx)
  )
}

function portTextForReadyFull(
  portAddress: string | undefined,
  runtime: RuntimeState,
  portDetected: boolean | undefined
): string {
  const addressLabel = portAddress ? `on ${portAddress}` : 'Select Port'
  switch (runtime.monitor.state) {
    case 'running':
      return `$(pulse) ${addressLabel}`
    case 'suspended':
      return `$(sync~spin) ${addressLabel}`
    case 'error':
      return `$(error) ${addressLabel}`
    case 'stopped':
    default:
      return portDetected ? `$(plug) ${addressLabel}` : addressLabel
  }
}

function portTooltipForReadyFull(
  portAddress: string | undefined,
  runtime: RuntimeState,
  portDetected: boolean | undefined
): string {
  if (!portAddress) {
    return 'Select port'
  }
  switch (runtime.monitor.state) {
    case 'running':
      return `Port: ${portAddress} (monitor running)`
    case 'suspended':
      return `Port: ${portAddress} (monitor suspended)`
    case 'error':
      return `Port: ${portAddress} (monitor error)`
    case 'stopped':
    default:
      return portDetected
        ? `Port: ${portAddress} (detected)`
        : `Port: ${portAddress} (not detected)`
  }
}

function monitorItem(
  runtime: RuntimeState,
  priority: number
): StatusBarModelItem {
  switch (runtime.monitor.state) {
    case 'running':
      return createItem(
        'monitor',
        '$(monitor-icon)',
        'boardlab.openMonitor',
        priority,
        'Monitor running'
      )
    case 'suspended':
      return createItem(
        'monitor',
        '$(monitor-icon)',
        'boardlab.openMonitor',
        priority,
        'Monitor suspended'
      )
    case 'error':
      return createItem(
        'monitor',
        '$(warning)',
        'boardlab.openMonitor',
        priority,
        'Monitor error'
      )
    case 'stopped':
    default:
      return createItem(
        'monitor',
        '$(monitor-icon)',
        'boardlab.openMonitor',
        priority,
        'Open monitor'
      )
  }
}

function uploadItem(priority: number): StatusBarModelItem {
  return createItem(
    'upload',
    '$(arrow-right)',
    'boardlab.upload',
    priority,
    'Upload sketch'
  )
}

function compileItem(priority: number): StatusBarModelItem {
  return createItem(
    'compile',
    '$(check)',
    'boardlab.compile',
    priority,
    'Compile sketch'
  )
}

function activityItem(
  runtime: RuntimeState,
  priority: number
): StatusBarModelItem | undefined {
  const labels: string[] = []
  const tooltips: string[] = []
  if (runtime.upload.state === 'running') {
    labels.push('Uploading…')
    tooltips.push('Upload in progress')
  }
  if (runtime.compile.state === 'running') {
    const pct =
      typeof runtime.compile.percent === 'number'
        ? Math.max(0, Math.min(100, Math.round(runtime.compile.percent)))
        : undefined
    labels.push(pct !== undefined ? `Compiling… ${pct}%` : 'Compiling…')
    tooltips.push(runtime.compile.message || 'Compile in progress')
  }
  if (!labels.length) {
    return undefined
  }
  return createItem(
    'activity',
    `$(sync~spin) ${labels.join(' • ')}`,
    undefined,
    priority,
    tooltips.join(' ')
  )
}

export function deriveStatusBarModel(
  state: OnboardingState,
  ctx: StatusBarModelContext
): StatusBarModelItem[] {
  const items: StatusBarModelItem[] = []
  const runtime = ctx.runtime ?? defaultRuntimeState
  const sketch = maybeSketchItem(ctx)
  if (sketch) {
    items.push(sketch)
  }

  switch (state) {
    case 'CLI_CHECKING':
      return [
        createItem(
          'cli-checking',
          '$(sync~spin) Checking Arduino CLI…',
          NOOP_COMMAND,
          140,
          'Checking Arduino CLI'
        ),
      ]
    case 'CLI_REQUIRED':
      return [
        createItem(
          'cli-required',
          '$(cloud-download) Download Arduino CLI',
          'boardlab.downloadCli',
          140,
          'Download Arduino CLI'
        ),
      ]
    case 'SKETCH_REQUIRED':
      return [
        createItem(
          'sketch-required',
          '$(file-submodule) Select sketch',
          'boardlab.selectSketch',
          140,
          'Select sketch'
        ),
      ]
    case 'BOARD_REQUIRED':
      items.push(
        createItem(
          'board-required',
          '$(circuit-board) Select board',
          'boardlab.selectBoard',
          120,
          'Select board'
        )
      )
      return items
    case 'PLATFORM_REQUIRED':
      if (ctx.canInstallPlatform) {
        items.push(
          createItem(
            'platform-required',
            `$(cloud-download) Install ${ctx.platformInstallLabel || 'platform'}`,
            'boardlab.installPlatform',
            120,
            `Install ${ctx.platformInstallLabel || 'platform'}`
          )
        )
      } else {
        items.push(
          createItem(
            'platform-required-select-board',
            '$(circuit-board) Select board',
            'boardlab.selectBoard',
            120,
            'Select board'
          )
        )
      }
      return items
    case 'PORT_REQUIRED': {
      items.push(
        compileItem(120),
        boardItem(ctx, 118),
        createItem(
          'port-required',
          '$(plug) Select Port',
          'boardlab.selectPort',
          117,
          'Select port'
        )
      )
      const portRequiredActivity = activityItem(runtime, 115)
      if (portRequiredActivity) {
        items.push(portRequiredActivity)
      }
      return items
    }
    case 'READY_COMPILE': {
      items.push(
        compileItem(120),
        boardItem(ctx, 118),
        createItem(
          'port',
          '$(plug) Select Port',
          'boardlab.selectPort',
          117,
          'Select port'
        )
      )
      const readyCompileActivity = activityItem(runtime, 115)
      if (readyCompileActivity) {
        items.push(readyCompileActivity)
      }
      return items
    }
    case 'READY_FULL': {
      items.push(
        compileItem(120),
        uploadItem(119),
        boardItem(ctx, 118),
        createItem(
          'port',
          portTextForReadyFull(ctx.portAddress, runtime, ctx.portDetected),
          'boardlab.selectPort',
          117,
          portTooltipForReadyFull(ctx.portAddress, runtime, ctx.portDetected)
        ),
        monitorItem(runtime, 116)
      )
      const readyFullActivity = activityItem(runtime, 115)
      if (readyFullActivity) {
        items.push(readyFullActivity)
      }
      return items
    }
    default:
      return items
  }
}
