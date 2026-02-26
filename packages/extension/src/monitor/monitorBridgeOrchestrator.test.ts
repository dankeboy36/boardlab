import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  MonitorBridgeOrchestrator,
  type BridgeOwnerLease,
} from './monitorBridgeOrchestrator'

const FIXED_IDENTITY = {
  version: '0.0.12',
  mode: 'external-process',
  extensionPath:
    'c:\\\\users\\\\dev\\\\.vscode\\\\extensions\\\\dankeboy36.boardlab-0.0.12',
  commit: 'abc123',
}

async function createLeaseFilePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'boardlab-orch-test-'))
  return path.join(dir, 'owner-lease.json')
}

describe('MonitorBridgeOrchestrator', () => {
  const tempRoots: string[] = []

  afterEach(async () => {
    await Promise.all(
      tempRoots.map(async (root) => {
        await fs.rm(root, { recursive: true, force: true })
      })
    )
    tempRoots.length = 0
  })

  it('requires active demand before allowing takeover', async () => {
    let now = Date.parse('2026-02-25T13:00:00.000Z')
    const leaseFilePath = await createLeaseFilePath()
    tempRoots.push(path.dirname(leaseFilePath))
    const orchestrator = new MonitorBridgeOrchestrator({
      identity: FIXED_IDENTITY,
      clientId: 'client-a',
      leaseFilePath,
      now: () => now,
    })

    const decision = await orchestrator.evaluateTakeoverPolicy(
      'version-mismatch',
      55888
    )

    expect(decision).toEqual({ allowed: false, reason: 'demand-inactive' })
    now += 1
  })

  it('enforces local cooldown after takeover', async () => {
    let now = Date.parse('2026-02-25T13:00:00.000Z')
    const leaseFilePath = await createLeaseFilePath()
    tempRoots.push(path.dirname(leaseFilePath))
    const orchestrator = new MonitorBridgeOrchestrator({
      identity: FIXED_IDENTITY,
      clientId: 'client-a',
      leaseFilePath,
      now: () => now,
      takeoverCooldownMs: 10_000,
    })

    orchestrator.noteDemand()
    orchestrator.noteTakeover()
    now += 2_000

    const decision = await orchestrator.evaluateTakeoverPolicy(
      'stale-recovery',
      55888
    )

    expect(decision).toEqual({ allowed: false, reason: 'cooldown-local' })
  })

  it('blocks takeover when a fresh foreign owner lease exists', async () => {
    const now = Date.parse('2026-02-25T13:00:00.000Z')
    const leaseFilePath = await createLeaseFilePath()
    tempRoots.push(path.dirname(leaseFilePath))
    const orchestrator = new MonitorBridgeOrchestrator({
      identity: FIXED_IDENTITY,
      clientId: 'client-a',
      leaseFilePath,
      now: () => now,
      leaseFreshWindowMs: 15_000,
    })

    const lease: BridgeOwnerLease = {
      pid: 2222,
      port: 55888,
      version: '0.0.13-preview',
      extensionPath:
        'c:\\\\users\\\\dev\\\\.vscode\\\\extensions\\\\dankeboy36.boardlab-0.0.13-preview',
      mode: 'external-process',
      commit: 'def456',
      ownerClientId: 'foreign-client',
      updatedAt: new Date(now).toISOString(),
      lastHeartbeatAt: new Date(now).toISOString(),
      lastTakeoverAt: undefined,
    }
    await fs.writeFile(leaseFilePath, JSON.stringify(lease), 'utf8')

    orchestrator.noteDemand()
    const decision = await orchestrator.evaluateTakeoverPolicy(
      'version-mismatch',
      55888
    )

    expect(decision).toEqual({
      allowed: false,
      reason: 'lease-fresh-foreign-owner',
    })
  })

  it('writes and reads owner lease', async () => {
    const now = Date.parse('2026-02-25T13:00:00.000Z')
    const leaseFilePath = await createLeaseFilePath()
    tempRoots.push(path.dirname(leaseFilePath))
    const orchestrator = new MonitorBridgeOrchestrator({
      identity: FIXED_IDENTITY,
      clientId: 'client-a',
      leaseFilePath,
      now: () => now,
    })

    await orchestrator.writeOwnerLease(
      {
        ownerPid: 7777,
        port: 55888,
        version: '0.0.12',
        extensionPath: FIXED_IDENTITY.extensionPath,
        mode: 'external-process',
        commit: 'abc123',
      },
      { heartbeat: true, takeover: true }
    )

    const lease = await orchestrator.readOwnerLease()
    expect(lease?.pid).toBe(7777)
    expect(lease?.port).toBe(55888)
    expect(lease?.ownerClientId).toBe('client-a')
    expect(typeof lease?.lastHeartbeatAt).toBe('string')
    expect(typeof lease?.lastTakeoverAt).toBe('string')
  })

  it('identifies incompatible bridge by version or extensionPath', () => {
    const orchestrator = new MonitorBridgeOrchestrator({
      identity: FIXED_IDENTITY,
      clientId: 'client-a',
    })

    expect(
      orchestrator.isCompatibleBridge({
        ownerPid: 1,
        port: 55888,
        version: '0.0.12',
        extensionPath: FIXED_IDENTITY.extensionPath,
        mode: 'external-process',
        commit: 'abc123',
      })
    ).toBe(true)

    expect(
      orchestrator.isCompatibleBridge({
        ownerPid: 1,
        port: 55888,
        version: '0.0.13-preview',
        extensionPath: FIXED_IDENTITY.extensionPath,
        mode: 'external-process',
        commit: 'abc123',
      })
    ).toBe(false)
  })

  it('allows only one active restart lock owner', async () => {
    const now = Date.parse('2026-02-25T13:00:00.000Z')
    const leaseFilePath = await createLeaseFilePath()
    tempRoots.push(path.dirname(leaseFilePath))
    const orchestratorA = new MonitorBridgeOrchestrator({
      identity: FIXED_IDENTITY,
      clientId: 'client-a',
      leaseFilePath,
      now: () => now,
      restartLockTtlMs: 20_000,
    })
    const orchestratorB = new MonitorBridgeOrchestrator({
      identity: FIXED_IDENTITY,
      clientId: 'client-b',
      leaseFilePath,
      now: () => now,
      restartLockTtlMs: 20_000,
    })

    await expect(
      orchestratorA.tryAcquireRestartLock(55888, '0.0.12')
    ).resolves.toEqual({ acquired: true })
    await expect(
      orchestratorB.tryAcquireRestartLock(55888, '0.0.12')
    ).resolves.toEqual({ acquired: false, reason: 'restart-lock-foreign' })
  })

  it('allows restart lock takeover after ttl expiry', async () => {
    let now = Date.parse('2026-02-25T13:00:00.000Z')
    const leaseFilePath = await createLeaseFilePath()
    tempRoots.push(path.dirname(leaseFilePath))
    const orchestratorA = new MonitorBridgeOrchestrator({
      identity: FIXED_IDENTITY,
      clientId: 'client-a',
      leaseFilePath,
      now: () => now,
      restartLockTtlMs: 5_000,
    })
    const orchestratorB = new MonitorBridgeOrchestrator({
      identity: FIXED_IDENTITY,
      clientId: 'client-b',
      leaseFilePath,
      now: () => now,
      restartLockTtlMs: 5_000,
    })

    await orchestratorA.tryAcquireRestartLock(55888, '0.0.12')
    now += 6_000
    await expect(
      orchestratorB.tryAcquireRestartLock(55888, '0.0.12')
    ).resolves.toEqual({ acquired: true })
  })
})
