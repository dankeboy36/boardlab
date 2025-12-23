import { describe, expect, it } from 'vitest'

import { stateFromSketchProfile, toSketchProfile } from './sketchProfile'

describe('toSketchProfile', () => {
  it('prefers configOptions fqbn over board fqbn', () => {
    const state: any = {
      board: { name: 'My Board', fqbn: 'vendor:arch:board' },
      configOptions: 'vendor:arch:board:opt1=val1',
      port: { protocol: 'serial', address: '/dev/ttyUSB0' },
      selectedProgrammer: 'my-programmer',
    }

    const profile = toSketchProfile(state)

    expect(profile.fqbn).toBe('vendor:arch:board:opt1=val1')
    expect(profile.port).toBe('/dev/ttyUSB0')
    expect(profile.protocol).toBe('serial')
    expect(profile.programmer).toBe('my-programmer')
  })

  it('falls back to board fqbn when configOptions is missing', () => {
    const state: any = {
      board: { name: 'My Board', fqbn: 'vendor:arch:board' },
      port: undefined,
      selectedProgrammer: { id: 'prog-id', name: 'Prog', platform: 'plat' },
    }

    const profile = toSketchProfile(state)

    expect(profile.fqbn).toBe('vendor:arch:board')
    expect(profile.port).toBeUndefined()
    expect(profile.protocol).toBeUndefined()
    expect(profile.programmer).toBe('prog-id')
  })

  it('handles completely empty state', () => {
    const profile = toSketchProfile({
      board: undefined,
      port: undefined,
      configOptions: undefined,
      selectedProgrammer: undefined,
    })

    expect(profile.fqbn).toBeUndefined()
    expect(profile.port).toBeUndefined()
    expect(profile.protocol).toBeUndefined()
    expect(profile.programmer).toBeUndefined()
  })
})

describe('stateFromSketchProfile', () => {
  it('reconstructs state from a populated profile', () => {
    const profile = {
      fqbn: 'vendor:arch:board:opt1=val1',
      port: '/dev/ttyUSB0',
      protocol: 'serial',
      programmer: 'prog-id',
    }

    const state = stateFromSketchProfile('/path/to/sketch', profile)

    expect(state.sketchPath).toBe('/path/to/sketch')
    expect(state.board).toEqual({
      name: 'vendor:arch:board:opt1=val1',
      fqbn: 'vendor:arch:board:opt1=val1',
    })
    expect(state.port).toEqual({
      protocol: 'serial',
      address: '/dev/ttyUSB0',
    })
    expect(state.configOptions).toBe('vendor:arch:board:opt1=val1')
    expect(state.selectedProgrammer).toBe('prog-id')
  })

  it('creates minimal state when profile is mostly empty', () => {
    const state = stateFromSketchProfile('/path/to/sketch', {})

    expect(state.sketchPath).toBe('/path/to/sketch')
    expect(state.board).toBeUndefined()
    expect(state.port).toBeUndefined()
    expect(state.configOptions).toBeUndefined()
    expect(state.selectedProgrammer).toBeUndefined()
  })
})
