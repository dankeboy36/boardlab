import { describe, expect, it } from 'vitest'

import { computeConfigOverrides } from './configOptions'

describe('computeConfigOverrides', () => {
  it('returns undefined when selecting the default value (no override)', () => {
    const boardFqbn = 'vendor:arch:board'
    const defaultConfigOptions = 'vendor:arch:board:foo=bar1'

    const result = computeConfigOverrides({
      boardFqbn,
      boardConfigOptions: [],
      defaultConfigOptions,
      currentConfigOptions: undefined,
      option: 'foo',
      value: 'bar1',
    })

    expect(result).toBeUndefined()
  })

  it('stores only non-default overrides', () => {
    const boardFqbn = 'vendor:arch:board'
    const defaultConfigOptions = 'vendor:arch:board:foo=bar1'

    const result = computeConfigOverrides({
      boardFqbn,
      boardConfigOptions: [],
      defaultConfigOptions,
      currentConfigOptions: undefined,
      option: 'foo',
      value: 'bar2',
    })

    expect(result).toBe('vendor:arch:board:foo=bar2')
  })

  it('removes an override when switching back to default', () => {
    const boardFqbn = 'vendor:arch:board'
    const defaultConfigOptions = 'vendor:arch:board:foo=bar1'
    const currentConfigOptions = 'vendor:arch:board:foo=bar2'

    const result = computeConfigOverrides({
      boardFqbn,
      boardConfigOptions: [],
      defaultConfigOptions,
      currentConfigOptions,
      option: 'foo',
      value: 'bar1',
    })

    expect(result).toBeUndefined()
  })

  it('reanchors overrides when switching boards', () => {
    // Board A: esp32c3, override FlashSize=16M
    const boardAFqbn = 'esp32:esp32:esp32c3'
    const defaultA = 'esp32:esp32:esp32c3:FlashSize=4M'
    const overrideA = 'esp32:esp32:esp32c3:FlashSize=16M'

    const overrideAResult = computeConfigOverrides({
      boardFqbn: boardAFqbn,
      boardConfigOptions: [],
      defaultConfigOptions: defaultA,
      currentConfigOptions: undefined,
      option: 'FlashSize',
      value: '16M',
    })
    expect(overrideAResult).toBe(overrideA)

    // Board B: esp32da, same option, same non-default value.
    const boardBFqbn = 'esp32:esp32:esp32da'
    const defaultB = 'esp32:esp32:esp32da:FlashSize=4M'

    const overrideBResult = computeConfigOverrides({
      boardFqbn: boardBFqbn,
      boardConfigOptions: [],
      defaultConfigOptions: defaultB,
      currentConfigOptions: overrideA,
      option: 'FlashSize',
      value: '16M',
    })

    expect(overrideBResult).toBe('esp32:esp32:esp32da:FlashSize=16M')
  })
})
