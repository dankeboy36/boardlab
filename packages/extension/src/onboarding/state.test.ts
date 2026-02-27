import { describe, expect, it } from 'vitest'

import { deriveOnboardingState, isBoardDetails } from './state'

describe('isBoardDetails', () => {
  it('identifies board details by config options', () => {
    expect(
      isBoardDetails({
        fqbn: 'arduino:avr:uno',
        name: 'Arduino Uno',
        configOptions: [],
      })
    ).toBe(true)
    expect(
      isBoardDetails({
        fqbn: 'arduino:avr:uno',
        name: 'Arduino Uno',
      })
    ).toBe(false)
  })
})

describe('deriveOnboardingState', () => {
  const boardDetails = {
    fqbn: 'arduino:avr:uno',
    name: 'Arduino Uno',
    configOptions: [],
  }

  it('CLI checking overrides everything', () => {
    expect(
      deriveOnboardingState({
        cliStatus: 'checking',
        arduinoContext: {
          currentSketch: {
            board: boardDetails,
            port: { protocol: 'serial', address: '/dev/ttyUSB0' },
          },
        },
        intent: 'upload',
      })
    ).toBe('CLI_CHECKING')
  })

  it('CLI required overrides everything', () => {
    expect(
      deriveOnboardingState({
        cliStatus: 'required',
        arduinoContext: {
          currentSketch: {
            board: boardDetails,
            port: { protocol: 'serial', address: '/dev/ttyUSB0' },
          },
        },
        intent: 'upload',
      })
    ).toBe('CLI_REQUIRED')
  })

  it('returns SKETCH_REQUIRED when there is no current sketch', () => {
    expect(
      deriveOnboardingState({
        cliStatus: 'ready',
        arduinoContext: {},
      })
    ).toBe('SKETCH_REQUIRED')
  })

  it('returns BOARD_REQUIRED when board is missing', () => {
    expect(
      deriveOnboardingState({
        cliStatus: 'ready',
        arduinoContext: {
          currentSketch: {},
        },
      })
    ).toBe('BOARD_REQUIRED')
  })

  it('returns PLATFORM_REQUIRED when board is unresolved identifier', () => {
    expect(
      deriveOnboardingState({
        cliStatus: 'ready',
        arduinoContext: {
          currentSketch: {
            board: {
              fqbn: 'arduino:mbed_nano:nano33ble',
              name: 'Arduino Nano 33 BLE',
            },
          },
        },
      })
    ).toBe('PLATFORM_REQUIRED')
  })

  it('returns READY_COMPILE when board details are present and no intent', () => {
    expect(
      deriveOnboardingState({
        cliStatus: 'ready',
        arduinoContext: {
          currentSketch: {
            board: boardDetails,
          },
        },
      })
    ).toBe('READY_COMPILE')
  })

  it('returns PORT_REQUIRED for upload intent without selected port', () => {
    expect(
      deriveOnboardingState({
        cliStatus: 'ready',
        arduinoContext: {
          currentSketch: {
            board: boardDetails,
          },
        },
        intent: 'upload',
      })
    ).toBe('PORT_REQUIRED')
  })

  it('returns PORT_REQUIRED for monitor intent without selected port', () => {
    expect(
      deriveOnboardingState({
        cliStatus: 'ready',
        arduinoContext: {
          currentSketch: {
            board: boardDetails,
          },
        },
        intent: 'monitor',
      })
    ).toBe('PORT_REQUIRED')
  })

  it('returns READY_FULL when selected port is available', () => {
    expect(
      deriveOnboardingState({
        cliStatus: 'ready',
        arduinoContext: {
          currentSketch: {
            board: boardDetails,
            port: { protocol: 'serial', address: '/dev/ttyUSB0' },
          },
        },
        intent: 'upload',
      })
    ).toBe('READY_FULL')
  })
})
