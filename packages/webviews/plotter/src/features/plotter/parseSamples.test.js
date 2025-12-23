// @ts-check
import { describe, expect, it } from 'vitest'

import { parseSamples } from './parseSamples.js'

function makeRefs() {
  return {
    modeRef: /** @type {{ current: 'implicit-index' | 'explicit-x' }} */ ({
      current: 'implicit-index',
    }),
    nextIndexRef: { current: 0 },
    lastXRef: { current: null },
  }
}

describe('parseSamples', () => {
  it('A) implicit index with one-number lines', () => {
    const r = makeRefs()
    const text = '12\n13\n14\n15\n'
    const s = parseSamples(text, r.modeRef, r.nextIndexRef, r.lastXRef)
    if (!s) throw new Error('no samples')
    const [x, y1] = s
    expect(x).toEqual([0, 1, 2, 3])
    expect(y1).toEqual([12, 13, 14, 15])
    expect(r.modeRef.current).toBe('implicit-index')
  })

  it('B) explicit X (monotonic) x=first, y1..N=rest', () => {
    const r = makeRefs()
    const text = '0.0  1.0  10.5\n0.1  1.1  10.6\n0.2  1.2  10.7\n'
    const s = parseSamples(text, r.modeRef, r.nextIndexRef, r.lastXRef)
    expect(r.modeRef.current).toBe('explicit-x')
    if (!s) throw new Error('no samples')
    const [x, y1, y2] = s
    expect(x).toEqual([0.0, 0.1, 0.2])
    expect(y1).toEqual([1.0, 1.1, 1.2])
    expect(y2).toEqual([10.5, 10.6, 10.7])
  })

  it('C) explicit X drops duplicates and out-of-order', () => {
    const r = makeRefs()
    // First line with >=2 numbers switches to explicit
    const text = '0.2 42\n0.2 43\n0.1 44\n0.3 45\n'
    const s = parseSamples(text, r.modeRef, r.nextIndexRef, r.lastXRef)
    expect(r.modeRef.current).toBe('explicit-x')
    if (!s) throw new Error('no samples')
    const [x, y1] = s
    expect(x).toEqual([0.2, 0.3])
    expect(y1).toEqual([42, 45])
  })

  it('D) mixed noise: ignore non-numeric tokens', () => {
    const r = makeRefs()
    const text = 'hello\n1\n2\t\t\nA,B,C\n3\n'
    const s = parseSamples(text, r.modeRef, r.nextIndexRef, r.lastXRef)
    if (!s) throw new Error('no samples')
    const [x, y1] = s
    expect(x).toEqual([0, 1, 2])
    expect(y1).toEqual([1, 2, 3])
  })
})
