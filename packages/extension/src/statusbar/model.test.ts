import { describe, expect, it } from 'vitest'

import { deriveStatusBarModel, type StatusBarModelContext } from './model'

const baseContext: StatusBarModelContext = {
  currentSketchName: 'blink',
  openedSketchesCount: 1,
  boardLabel: 'Arduino Uno',
  boardFqbn: 'arduino:avr:uno',
  portAddress: '/dev/ttyUSB0',
  portDetected: true,
}

function idsOf(
  contextState: ReturnType<typeof deriveStatusBarModel>
): string[] {
  return contextState.map((item) => item.id)
}

describe('deriveStatusBarModel', () => {
  it('maps CLI_CHECKING to checking item', () => {
    const model = deriveStatusBarModel('CLI_CHECKING', baseContext)
    expect(idsOf(model)).toEqual(['cli-checking'])
    expect(model[0]?.command).toBe('boardlab.onboarding.noop')
    expect(model[0]?.text).toContain('Checking Arduino CLI')
  })

  it('maps CLI_REQUIRED to download item', () => {
    const model = deriveStatusBarModel('CLI_REQUIRED', baseContext)
    expect(idsOf(model)).toEqual(['cli-required'])
    expect(model[0]?.command).toBe('boardlab.downloadCli')
  })

  it('maps SKETCH_REQUIRED to select sketch item', () => {
    const model = deriveStatusBarModel('SKETCH_REQUIRED', baseContext)
    expect(idsOf(model)).toEqual(['sketch-required'])
    expect(model[0]?.text).toContain('Select sketch')
    expect(model[0]?.command).toBe('boardlab.selectSketch')
  })

  it('shows sketch selector first when multiple sketches are open', () => {
    const model = deriveStatusBarModel('BOARD_REQUIRED', {
      ...baseContext,
      openedSketchesCount: 2,
    })
    expect(idsOf(model)).toEqual(['sketch', 'board-required'])
    expect(model[0]?.text).toContain('$(folder)')
    expect(model[0]?.command).toBe('boardlab.selectSketch')
  })

  it('does not show sketch selector when a single sketch is open', () => {
    const model = deriveStatusBarModel('BOARD_REQUIRED', baseContext)
    expect(idsOf(model)).toEqual(['board-required'])
  })

  it('shows install action when platform install target can be derived', () => {
    const model = deriveStatusBarModel('PLATFORM_REQUIRED', {
      ...baseContext,
      canInstallPlatform: true,
      platformInstallLabel: 'Arduino AVR Boards',
    })
    expect(idsOf(model)).toEqual(['platform-required'])
    expect(model[0]?.text).toContain('Install Arduino AVR Boards')
    expect(model[0]?.command).toBe('boardlab.installPlatform')
  })

  it('falls back to select board when platform target is unknown', () => {
    const model = deriveStatusBarModel('PLATFORM_REQUIRED', {
      ...baseContext,
      canInstallPlatform: false,
    })
    expect(idsOf(model)).toEqual(['platform-required-select-board'])
    expect(model[0]?.text).toContain('Select board')
    expect(model[0]?.command).toBe('boardlab.selectBoard')
  })

  it('maps READY_COMPILE to compile + board + select port', () => {
    const model = deriveStatusBarModel('READY_COMPILE', baseContext)
    expect(idsOf(model)).toEqual(['compile', 'board', 'port'])
    expect(model[0]?.command).toBe('boardlab.compile')
    expect(model[1]?.command).toBe('boardlab.selectBoard')
    expect(model[2]?.command).toBe('boardlab.selectPort')
    expect(model[0]?.text).toBe('$(check)')
  })

  it('maps PORT_REQUIRED to compile + board + select port', () => {
    const model = deriveStatusBarModel('PORT_REQUIRED', baseContext)
    expect(idsOf(model)).toEqual(['compile', 'board', 'port-required'])
    expect(model[2]?.text).toContain('Select Port')
    expect(model[0]?.text).toBe('$(check)')
  })

  it('maps READY_FULL to compile/upload + board/port + monitor commands', () => {
    const model = deriveStatusBarModel('READY_FULL', {
      ...baseContext,
      runtime: {
        compile: { state: 'idle' },
        monitor: { state: 'stopped' },
        upload: { state: 'idle' },
      },
    })
    expect(idsOf(model)).toEqual([
      'compile',
      'upload',
      'board',
      'port',
      'monitor',
    ])
    expect(model.find((item) => item.id === 'compile')?.text).toBe('$(check)')
    expect(model.find((item) => item.id === 'upload')?.text).toBe(
      '$(arrow-right)'
    )
    expect(model.find((item) => item.id === 'monitor')?.text).toBe(
      '$(monitor-icon)'
    )
  })

  it('provides tooltips for all READY_FULL items', () => {
    const model = deriveStatusBarModel('READY_FULL', {
      ...baseContext,
      runtime: {
        compile: { state: 'idle' },
        monitor: { state: 'stopped' },
        upload: { state: 'idle' },
      },
    })
    expect(model.every((item) => Boolean(item.tooltip))).toBe(true)
    expect(model.find((item) => item.id === 'board')?.tooltip).toContain(
      'arduino:avr:uno'
    )
  })

  it('adds pulse prefix to port text when monitor is running', () => {
    const model = deriveStatusBarModel('READY_FULL', {
      ...baseContext,
      runtime: {
        compile: { state: 'idle' },
        monitor: { state: 'running' },
        upload: { state: 'idle' },
      },
    })
    const port = model.find((item) => item.id === 'port')
    const monitor = model.find((item) => item.id === 'monitor')
    expect(port?.text).toContain('$(pulse)')
    expect(port?.text).toContain('on /dev/ttyUSB0')
    expect(monitor?.tooltip).toBe('Monitor running')
  })

  it('adds spinner prefix to port text when monitor is suspended', () => {
    const model = deriveStatusBarModel('READY_FULL', {
      ...baseContext,
      runtime: {
        compile: { state: 'idle' },
        monitor: { state: 'suspended' },
        upload: { state: 'idle' },
      },
    })
    const port = model.find((item) => item.id === 'port')
    expect(port?.text).toContain('$(sync~spin)')
    expect(port?.text).toContain('on /dev/ttyUSB0')
  })

  it('shows plain port label when monitor is stopped', () => {
    const model = deriveStatusBarModel('READY_FULL', {
      ...baseContext,
      runtime: {
        compile: { state: 'idle' },
        monitor: { state: 'stopped' },
        upload: { state: 'idle' },
      },
    })
    const port = model.find((item) => item.id === 'port')
    expect(port?.text).toBe('$(plug) on /dev/ttyUSB0')
  })

  it('shows no icon when selected port is not detected', () => {
    const model = deriveStatusBarModel('READY_FULL', {
      ...baseContext,
      portDetected: false,
      runtime: {
        compile: { state: 'idle' },
        monitor: { state: 'stopped' },
        upload: { state: 'idle' },
      },
    })
    const port = model.find((item) => item.id === 'port')
    expect(port?.text).toBe('on /dev/ttyUSB0')
  })

  it('keeps compile command passive and shows trailing compile activity with percent', () => {
    const model = deriveStatusBarModel('READY_FULL', {
      ...baseContext,
      runtime: {
        compile: { state: 'running', percent: 42, message: 'Compiling core' },
        monitor: { state: 'stopped' },
        upload: { state: 'idle' },
      },
    })
    const compile = model.find((item) => item.id === 'compile')
    const activity = model.find((item) => item.id === 'activity')
    expect(compile?.text).toBe('$(check)')
    expect(compile?.command).toBe('boardlab.compile')
    expect(activity?.text).toBe('$(sync~spin) Compiling… 42%')
    expect(activity?.command).toBeUndefined()
  })

  it('shows trailing compile activity without percent during pre-compile phase', () => {
    const model = deriveStatusBarModel('READY_COMPILE', {
      ...baseContext,
      runtime: {
        compile: { state: 'running', message: 'Pre-compile tasks' },
        monitor: { state: 'stopped' },
        upload: { state: 'idle' },
      },
    })
    const compile = model.find((item) => item.id === 'compile')
    const activity = model.find((item) => item.id === 'activity')
    expect(compile?.text).toBe('$(check)')
    expect(activity?.text).toBe('$(sync~spin) Compiling…')
    expect(activity?.tooltip).toBe('Pre-compile tasks')
  })

  it('shows combined upload and compile activity in the tail item', () => {
    const model = deriveStatusBarModel('READY_FULL', {
      ...baseContext,
      runtime: {
        compile: { state: 'running', percent: 7, message: 'Compiling core' },
        monitor: { state: 'suspended' },
        upload: { state: 'running' },
      },
    })
    const upload = model.find((item) => item.id === 'upload')
    const monitor = model.find((item) => item.id === 'monitor')
    const activity = model.find((item) => item.id === 'activity')
    expect(upload?.text).toBe('$(arrow-right)')
    expect(upload?.command).toBe('boardlab.upload')
    expect(monitor?.text).toBe('$(monitor-icon)')
    expect(monitor?.command).toBe('boardlab.openMonitor')
    expect(activity?.text).toBe('$(sync~spin) Uploading… • Compiling… 7%')
    expect(activity?.command).toBeUndefined()
  })
})
