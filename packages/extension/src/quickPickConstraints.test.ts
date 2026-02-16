import { describe, expect, it, vi } from 'vitest'

import {
  filterQuickPickCandidates,
  matchesQuickPickConstraints,
  type QuickPickConstraints,
} from './quickPickConstraints'

describe('matchesQuickPickConstraints', () => {
  it('passes when all filters pass', async () => {
    const constraints: QuickPickConstraints<number> = {
      filters: [(value) => value > 0, (value) => value < 10],
    }
    await expect(matchesQuickPickConstraints(4, constraints)).resolves.toBe(
      true
    )
  })

  it('fails when any filter fails', async () => {
    const constraints: QuickPickConstraints<number> = {
      filters: [(value) => value > 0, (value) => value < 10],
    }
    await expect(matchesQuickPickConstraints(12, constraints)).resolves.toBe(
      false
    )
  })

  it('fails when a filter throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const constraints: QuickPickConstraints<number> = {
      filters: [
        () => {
          throw new Error('boom')
        },
      ],
    }
    await expect(matchesQuickPickConstraints(1, constraints)).resolves.toBe(
      false
    )
    warnSpy.mockRestore()
  })
})

describe('filterQuickPickCandidates', () => {
  it('keeps only matching values', async () => {
    const constraints: QuickPickConstraints<number> = {
      filters: [(value) => value % 2 === 0],
    }
    await expect(
      filterQuickPickCandidates([1, 2, 3, 4], constraints)
    ).resolves.toEqual([2, 4])
  })
})
