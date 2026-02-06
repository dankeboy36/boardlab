import { describe, expect, it } from 'vitest'

import { MonitorPortSession } from './monitorPortSession'

const PORT = { protocol: 'serial', address: '/dev/mock0' }

describe('MonitorPortSession', () => {
  it('opens once for multi-client start', () => {
    const session = new MonitorPortSession(PORT)
    session.attachClient('client-a')
    session.attachClient('client-b')
    session.markDetected(true)
    session.intentStart('client-a')
    session.intentStart('client-b')

    const action = session.nextAction()
    expect(action?.type).toBe('open')
    expect(session.snapshot().openPending).toBe(true)

    session.markMonitorStarted({ monitorSessionId: 'ms-1', baudrate: '9600' })
    const snapshot = session.snapshot()
    expect(snapshot.status).toBe('active')
    expect(snapshot.clients).toEqual(['client-a', 'client-b'])
  })

  it('stops only after all clients stop', () => {
    const session = new MonitorPortSession(PORT)
    session.attachClient('client-a')
    session.attachClient('client-b')
    session.markDetected(true)
    session.intentStart('client-a')
    session.intentStart('client-b')
    session.nextAction()
    session.markMonitorStarted({ monitorSessionId: 'ms-1', baudrate: '9600' })

    session.intentStop('client-a')
    expect(session.snapshot().desired).toBe('running')
    expect(session.nextAction()).toBeNull()

    session.intentStop('client-b')
    const action = session.nextAction()
    expect(action?.type).toBe('close')
  })

  it('resumes after suspend without losing clients', () => {
    const session = new MonitorPortSession(PORT)
    session.attachClient('client-a')
    session.markDetected(true)
    session.intentStart('client-a')
    session.nextAction()
    session.markMonitorStarted({ monitorSessionId: 'ms-1', baudrate: '9600' })

    session.markPaused('suspend')
    expect(session.snapshot().status).toBe('paused')

    session.intentResume('client-a')
    const action = session.nextAction()
    expect(action?.type).toBe('open')
    session.markMonitorStarted({ monitorSessionId: 'ms-2', baudrate: '9600' })

    const snapshot = session.snapshot()
    expect(snapshot.status).toBe('active')
    expect(snapshot.clients).toEqual(['client-a'])
  })

  it('reconnects twice after repeated disconnects', () => {
    const session = new MonitorPortSession(PORT)
    session.attachClient('client-a')
    session.markDetected(true)
    session.intentStart('client-a')
    session.nextAction()
    session.markMonitorStarted({ monitorSessionId: 'ms-1', baudrate: '9600' })

    let openCount = 0

    session.markDetected(false)
    session.markMonitorStopped()
    session.markDetected(true)
    if (session.nextAction()?.type === 'open') {
      openCount += 1
    }
    session.markMonitorStarted({ monitorSessionId: 'ms-2', baudrate: '9600' })

    session.markDetected(false)
    session.markMonitorStopped()
    session.markDetected(true)
    if (session.nextAction()?.type === 'open') {
      openCount += 1
    }
    session.markMonitorStarted({ monitorSessionId: 'ms-3', baudrate: '9600' })

    expect(openCount).toBe(2)
    expect(session.snapshot().status).toBe('active')
  })

  it('keeps multi-client sessions running across two reattach cycles', () => {
    const session = new MonitorPortSession(PORT)
    session.attachClient('monitor')
    session.attachClient('plotter')
    session.markDetected(true)
    session.intentStart('monitor')
    session.intentStart('plotter')

    let action = session.nextAction()
    expect(action?.type).toBe('open')
    session.markMonitorStarted({ monitorSessionId: 'ms-1', baudrate: '9600' })

    let openCount = 0
    for (let i = 0; i < 2; i += 1) {
      session.markDetected(false)
      session.markMonitorStopped('resource-missing')
      session.markDetected(true)
      action = session.nextAction()
      if (action?.type === 'open') {
        openCount += 1
        session.markMonitorStarted({
          monitorSessionId: `ms-${i + 2}`,
          baudrate: '9600',
        })
      }
    }

    const snapshot = session.snapshot()
    expect(openCount).toBe(2)
    expect(snapshot.status).toBe('active')
    expect(snapshot.clients).toEqual(['monitor', 'plotter'])
    expect(snapshot.desired).toBe('running')
  })

  it('keeps two ports isolated on detach/reattach', () => {
    const portA = PORT
    const portB = { protocol: 'serial', address: '/dev/mock1' } as const

    const sessionA = new MonitorPortSession(portA)
    const sessionB = new MonitorPortSession(portB)

    sessionA.attachClient('monitor-a')
    sessionB.attachClient('monitor-b')
    sessionA.markDetected(true)
    sessionB.markDetected(true)
    sessionA.intentStart('monitor-a')
    sessionB.intentStart('monitor-b')

    let actionA = sessionA.nextAction()
    let actionB = sessionB.nextAction()
    expect(actionA?.type).toBe('open')
    expect(actionB?.type).toBe('open')
    sessionA.markMonitorStarted({ monitorSessionId: 'ms-a', baudrate: '9600' })
    sessionB.markMonitorStarted({ monitorSessionId: 'ms-b', baudrate: '9600' })

    sessionA.markDetected(false)
    sessionA.markMonitorStopped('resource-missing')
    expect(sessionA.snapshot().status).toBe('paused')
    expect(sessionB.snapshot().status).toBe('active')

    sessionA.markDetected(true)
    actionA = sessionA.nextAction()
    expect(actionA?.type).toBe('open')
    sessionA.markMonitorStarted({ monitorSessionId: 'ms-a2', baudrate: '9600' })

    expect(sessionA.snapshot().status).toBe('active')
    expect(sessionB.snapshot().status).toBe('active')
  })

  it('clears 502 errors when the monitor starts again', () => {
    const session = new MonitorPortSession(PORT)
    session.attachClient('client-a')
    session.markDetected(true)
    session.intentStart('client-a')
    session.nextAction()
    session.markOpenError({
      status: 502,
      code: 'bridge-unavailable',
      message: 'bad gateway',
    })
    expect(session.snapshot().status).toBe('error')
    expect(session.snapshot().openPending).toBe(false)

    session.markMonitorStarted({ monitorSessionId: 'ms-1', baudrate: '9600' })
    const snapshot = session.snapshot()
    expect(snapshot.status).toBe('active')
    expect(snapshot.lastError).toBeUndefined()
  })

  it('clears openPending on timeout and preserves desired state', () => {
    const session = new MonitorPortSession(PORT)
    session.attachClient('client-a')
    session.markDetected(true)
    session.intentStart('client-a')
    session.nextAction()
    session.markOpenTimeout()

    const snapshot = session.snapshot()
    expect(snapshot.openPending).toBe(false)
    expect(snapshot.desired).toBe('running')
    expect(snapshot.status).toBe('error')
  })

  it('clears pending open when the port disappears mid-connect', () => {
    const session = new MonitorPortSession(PORT)
    session.attachClient('client-a')
    session.markDetected(true)
    session.intentStart('client-a')
    session.nextAction()

    session.markDetected(false)
    const snapshot = session.snapshot()
    expect(snapshot.status).toBe('paused')
    expect(snapshot.openPending).toBe(false)
    expect(snapshot.currentAttemptId).toBeNull()

    session.markDetected(true)
    const action = session.nextAction()
    expect(action?.type).toBe('open')
  })
})
