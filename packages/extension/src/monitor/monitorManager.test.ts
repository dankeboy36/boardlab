import { describe, expect, it } from 'vitest'

import {
  decideBridgeOwnerReuse,
  shouldBypassTakeoverPolicyForStartupWait,
} from './monitorManager'

describe('decideBridgeOwnerReuse', () => {
  it('does not reuse owner after kill', () => {
    expect(decideBridgeOwnerReuse('killed', true, 'preferred-port')).toEqual({
      reuse: false,
    })
    expect(decideBridgeOwnerReuse('killed', false, 'wait-for-bridge')).toEqual({
      reuse: false,
    })
  })

  it('reuses owner only when handled is none and owner is compatible', () => {
    expect(decideBridgeOwnerReuse('none', true, 'preferred-port')).toEqual({
      reuse: true,
    })
  })

  it('returns retry-recheck incompatible reason', () => {
    expect(decideBridgeOwnerReuse('none', false, 'retry-recheck')).toEqual({
      reuse: false,
      reason: 'retry-recheck-owner-incompatible',
    })
  })

  it('returns preferred-port incompatible reason', () => {
    expect(decideBridgeOwnerReuse('none', false, 'preferred-port')).toEqual({
      reuse: false,
      reason: 'preferred-port-owner-incompatible',
    })
  })

  it('returns wait-for-bridge incompatible reason', () => {
    expect(decideBridgeOwnerReuse('none', false, 'wait-for-bridge')).toEqual({
      reuse: false,
      reason: 'wait-owner-incompatible',
    })
  })
})

describe('shouldBypassTakeoverPolicyForStartupWait', () => {
  it('bypasses local and shared cooldown plus fresh foreign lease', () => {
    expect(shouldBypassTakeoverPolicyForStartupWait('cooldown-local')).toBe(
      true
    )
    expect(shouldBypassTakeoverPolicyForStartupWait('cooldown-shared')).toBe(
      true
    )
    expect(
      shouldBypassTakeoverPolicyForStartupWait('lease-fresh-foreign-owner')
    ).toBe(true)
  })

  it('does not bypass unrelated reasons', () => {
    expect(shouldBypassTakeoverPolicyForStartupWait('demand-inactive')).toBe(
      false
    )
    expect(
      shouldBypassTakeoverPolicyForStartupWait('wait-owner-incompatible')
    ).toBe(false)
    expect(shouldBypassTakeoverPolicyForStartupWait(undefined)).toBe(false)
  })
})
