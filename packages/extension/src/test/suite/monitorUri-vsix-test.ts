import assert from 'node:assert'

import * as vscode from 'vscode'

import { formatMonitorUri, parseMonitorUri } from '../../monitor/monitorUri'

describe('monitorUri helpers', () => {
  it('formats and parses monitor URIs with query parameters', () => {
    const uri = formatMonitorUri({
      port: { protocol: 'serial', address: 'usbserial-14101' },
      query: new Map([
        ['baud', '115200'],
        ['flow', 'none'],
      ]),
    })

    assert.strictEqual(uri.scheme, 'monitor')
    assert.strictEqual(uri.path, '/usbserial-14101')
    assert.strictEqual(uri.query, 'baud=115200&flow=none')
    assert.strictEqual(
      uri.toString(),
      'monitor://serial/usbserial-14101?baud%3D115200%26flow%3Dnone'
    )
    const parsed = parseMonitorUri(uri)
    assert.deepStrictEqual(parsed.port, {
      protocol: 'serial',
      address: 'usbserial-14101',
    })
    assert.strictEqual(parsed.query.get('baud'), '115200')
    assert.strictEqual(parsed.query.get('flow'), 'none')
  })

  it('encodes leading slashes without double encoding', () => {
    const address = '/dev/cu.usbserial-0001'
    const uri = formatMonitorUri({
      port: { protocol: 'serial', address },
    })

    assert.strictEqual(uri.path, '//dev/cu.usbserial-0001')
    assert.strictEqual(
      uri.toString(),
      'monitor://serial//dev/cu.usbserial-0001'
    )
    assert.strictEqual(parseMonitorUri(uri).port.address, address)
  })

  it('throws for unsupported schemes', () => {
    const bad = vscode.Uri.parse('file:///tmp/foo')
    assert.throws(() => parseMonitorUri(bad))
  })
})
