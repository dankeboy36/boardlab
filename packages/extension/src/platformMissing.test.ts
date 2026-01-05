import type { BoardIdentifier } from 'boards-list'
import { describe, expect, it, vi } from 'vitest'

const loadBoardsModule = async () => import('./boards')
const loadPlatformMissing = async () => import('./platformMissing')

describe('resolvePlatformMissingState', () => {
  it('returns undefined for board details without resolving', async () => {
    const board = {
      name: 'Arduino Uno',
      fqbn: 'arduino:avr:uno',
      configOptions: [],
    }

    const { resolvePlatformMissingState } = await loadPlatformMissing()
    const resolver = vi.fn(async () => undefined)
    const result = await resolvePlatformMissingState(board, resolver)

    expect(result).toBeUndefined()
    expect(resolver).not.toHaveBeenCalled()
  })

  it('returns platform missing when details fail with platform error', async () => {
    const board = {
      name: 'Arduino Giga',
      fqbn: 'arduino:mbed_giga:giga',
      platform: {
        metadata: { id: 'arduino:mbed_giga' },
        release: { name: 'Arduino Mbed OS Giga Boards', version: '4.0.1' },
      },
    }

    const { resolvePlatformMissingState } = await loadPlatformMissing()
    const { PlatformNotInstalledError } = await loadBoardsModule()
    const result = await resolvePlatformMissingState(board, async () => {
      throw new PlatformNotInstalledError(board.fqbn)
    })

    expect(result?.reason).toBe('platform')
    expect(result?.platform?.id).toBe('arduino:mbed_giga')
    expect(result?.platform?.name).toBe('Arduino Mbed OS Giga Boards')
  })

  it('returns fqbn missing when board has no fqbn', async () => {
    const board = { name: 'Unknown Board' }

    const { resolvePlatformMissingState } = await loadPlatformMissing()
    const resolver = vi.fn(async () => undefined)
    const result = await resolvePlatformMissingState(
      board as unknown as BoardIdentifier,
      resolver
    )

    expect(result?.reason).toBe('fqbn')
    expect(resolver).not.toHaveBeenCalled()
  })

  it('returns unresolved when board details fail for other reasons', async () => {
    const board = {
      name: 'Custom Board',
      fqbn: 'custom:foo:bar',
    }

    const { resolvePlatformMissingState } = await loadPlatformMissing()
    const result = await resolvePlatformMissingState(board, async () => {
      throw new Error('boom')
    })

    expect(result?.reason).toBe('unresolved')
    expect(result?.fqbn).toBe('custom:foo:bar')
  })

  it('returns undefined when board details resolve', async () => {
    const board = {
      name: 'Custom Board',
      fqbn: 'custom:foo:bar',
    }

    const { resolvePlatformMissingState } = await loadPlatformMissing()
    const result = await resolvePlatformMissingState(board, async () => ({
      fqbn: board.fqbn,
      name: board.name,
    }))

    expect(result).toBeUndefined()
  })
})

describe('formatPlatformMissingTooltip', () => {
  it('includes platform label when available', async () => {
    const { formatPlatformMissingTooltip } = await loadPlatformMissing()
    const tooltip = formatPlatformMissingTooltip({
      reason: 'platform',
      platform: {
        id: 'arduino:mbed_giga',
        name: 'Arduino Mbed OS Giga Boards',
      },
    })

    expect(tooltip).toContain('Arduino Mbed OS Giga Boards')
    expect(tooltip).toContain('arduino:mbed_giga')
  })

  it('falls back to fqbn missing copy when needed', async () => {
    const { formatPlatformMissingTooltip } = await loadPlatformMissing()
    const tooltip = formatPlatformMissingTooltip({
      reason: 'fqbn',
    })

    expect(tooltip).toContain('FQBN')
  })
})
