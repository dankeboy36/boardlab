import { createPortKey } from 'boards-list'
import { describe, expect, it } from 'vitest'

import { revivePort } from './arduino'

describe('revivePort', () => {
  const port = { protocol: 'serial', address: '/dev/ttyUSB0' }

  it('revives port keys created by boards-list', () => {
    const portKey = createPortKey(port)
    expect(revivePort(portKey)).toEqual(port)
  })

  it('revives legacy arduino+ port keys', () => {
    const portKey = `arduino+${port.protocol}://${port.address}`
    expect(revivePort(portKey)).toEqual(port)
  })

  it('returns undefined for invalid port keys', () => {
    expect(
      revivePort(`invalid+${port.protocol}://${port.address}`)
    ).toBeUndefined()
  })
})
