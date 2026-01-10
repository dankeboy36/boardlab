import http from 'node:http'
import https from 'node:https'

import { createPortKey } from 'boards-list'
import type { PortIdentifier } from 'boards-list'
import * as vscode from 'vscode'

import type { BoardLabContextImpl } from '../boardlabContext'

interface DetectedPortSummary {
  readonly portKey: string
  readonly port?: PortIdentifier
  readonly boards?: ReadonlyArray<{
    readonly name?: string
    readonly fqbn?: string
  }>
}

interface ActiveStreamSummary {
  readonly portKey: string
  readonly clientCount: number
  readonly lastCount?: number
  readonly clientIds: string[]
}

interface RunningMonitorSummary {
  readonly portKey: string
  readonly port?: PortIdentifier
  readonly baudrate?: string
  readonly clientCount: number
  readonly lastCount?: number
}

interface MonitorRefSummary {
  readonly portKey: string
  readonly port?: PortIdentifier
  readonly refs: number
  readonly baudrate?: string
  readonly paused: boolean
}

interface MonitorMetricsResponse {
  readonly timestamp: string
  readonly host: string
  readonly bridgePort: number
  readonly httpBaseUrl: string
  readonly wsBaseUrl: string
  readonly attachments: { readonly total: number }
  readonly connections: {
    readonly wsConnections: number
    readonly details: ReadonlyArray<{ readonly clientId: string | null }>
  }
  readonly clientConnectCount: number
  readonly globalClientCount: number
  readonly runningMonitors: ReadonlyArray<RunningMonitorSummary>
  readonly activeStreams: ReadonlyArray<ActiveStreamSummary>
  readonly monitorRefs: ReadonlyArray<MonitorRefSummary>
  readonly detectedPorts: ReadonlyArray<DetectedPortSummary>
  readonly cliBridge: {
    readonly selectedBaudrates: ReadonlyArray<readonly [PortIdentifier, string]>
    readonly suspendedPortKeys: readonly string[]
  }
}

export async function logMonitorBridgeMetrics(
  boardlabContext: BoardLabContextImpl
): Promise<void> {
  const channel = boardlabContext.outputChannel
  let metrics: MonitorMetricsResponse
  try {
    metrics = await fetchBridgeJson(boardlabContext, 'metrics')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    channel.appendLine(`[monitor metrics] failed: ${message}`)
    channel.show(true)
    vscode.window.showErrorMessage(
      'Unable to fetch monitor metrics. Check the BoardLab output channel for details.'
    )
    return
  }

  channel.appendLine(
    `[monitor metrics] ${metrics.timestamp} bridge=${metrics.host}:${metrics.bridgePort}`
  )
  channel.appendLine(
    `[monitor metrics] http=${metrics.httpBaseUrl} ws=${metrics.wsBaseUrl}`
  )
  channel.appendLine(
    `[monitor metrics] attachments=${metrics.attachments.total}`
  )
  const connectionList = metrics.connections.details
    .map((entry) => entry.clientId ?? '<anonymous>')
    .join(', ')
  channel.appendLine(
    `[monitor metrics] wsConnections=${metrics.connections.wsConnections} (${connectionList || 'none'})`
  )
  channel.appendLine(
    `[monitor metrics] clientConnectCount=${metrics.clientConnectCount} globalClientCount=${metrics.globalClientCount}`
  )

  if (metrics.activeStreams.length) {
    channel.appendLine(
      `[monitor metrics] activeStreams (${metrics.activeStreams.length}):`
    )
    metrics.activeStreams.forEach((entry) => {
      const ids = entry.clientIds.length ? entry.clientIds.join(', ') : 'none'
      channel.appendLine(
        `[monitor metrics]   ${entry.portKey} clients=${entry.clientCount} lastCount=${
          entry.lastCount ?? 'n/a'
        } ids=${ids}`
      )
    })
  } else {
    channel.appendLine('[monitor metrics] activeStreams: none')
  }

  if (metrics.runningMonitors.length) {
    channel.appendLine(
      `[monitor metrics] runningMonitors (${metrics.runningMonitors.length}):`
    )
    metrics.runningMonitors.forEach((entry) => {
      channel.appendLine(
        `[monitor metrics]   ${formatPortDescription(entry.port, entry.portKey)} baud=${
          entry.baudrate ?? 'unknown'
        } clients=${entry.clientCount} lastCount=${entry.lastCount ?? 'n/a'}`
      )
    })
  } else {
    channel.appendLine('[monitor metrics] runningMonitors: none')
  }

  if (metrics.monitorRefs.length) {
    channel.appendLine(
      `[monitor metrics] monitorRefs (${metrics.monitorRefs.length}):`
    )
    metrics.monitorRefs.forEach((entry) => {
      channel.appendLine(
        `[monitor metrics]   ${formatPortDescription(
          entry.port,
          entry.portKey
        )} refs=${entry.refs} baud=${entry.baudrate ?? 'auto'} ${
          entry.paused ? 'paused' : 'running'
        }`
      )
    })
  } else {
    channel.appendLine('[monitor metrics] monitorRefs: none')
  }

  if (metrics.detectedPorts.length) {
    channel.appendLine(
      `[monitor metrics] detectedPorts (${metrics.detectedPorts.length}):`
    )
    metrics.detectedPorts.forEach((entry) => {
      channel.appendLine(
        `[monitor metrics]   ${entry.portKey} ${formatBoardList(entry.boards)}`
      )
    })
  } else {
    channel.appendLine('[monitor metrics] detectedPorts: none')
  }

  if (metrics.cliBridge.selectedBaudrates.length) {
    channel.appendLine(
      `[monitor metrics] selectedBaudrates (${metrics.cliBridge.selectedBaudrates.length}):`
    )
    metrics.cliBridge.selectedBaudrates.forEach(([port, baud]) => {
      channel.appendLine(
        `[monitor metrics]   ${formatPortDescription(port)} = ${baud}`
      )
    })
  } else {
    channel.appendLine('[monitor metrics] selectedBaudrates: none')
  }
  channel.appendLine(
    `[monitor metrics] suspendedPortKeys: ${
      metrics.cliBridge.suspendedPortKeys.join(', ') || 'none'
    }`
  )
  channel.show(true)
}

export async function logDetectedPorts(
  boardlabContext: BoardLabContextImpl
): Promise<void> {
  const channel = boardlabContext.outputChannel
  let detected: DetectedPortSummary[]
  try {
    detected = await fetchBridgeJson(boardlabContext, 'metrics/detected-ports')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    channel.appendLine(`[monitor detected ports] failed: ${message}`)
    channel.show(true)
    vscode.window.showErrorMessage(
      'Unable to fetch detected ports. Check the BoardLab output channel for details.'
    )
    return
  }

  channel.appendLine(
    `[monitor detected ports] ${detected.length} detected port(s)`
  )
  if (!detected.length) {
    channel.appendLine('[monitor detected ports]   none')
    channel.show(true)
    return
  }
  detected.forEach((entry) => {
    channel.appendLine(
      `[monitor detected ports]   ${entry.portKey} ${formatBoardList(entry.boards)}`
    )
  })
  channel.show(true)
}

async function fetchBridgeJson<T>(
  boardlabContext: BoardLabContextImpl,
  relativePath: string
): Promise<T> {
  const info = await boardlabContext.monitorManager.getBridgeInfo()
  const target = new URL(relativePath, info.httpBaseUrl)
  return fetchJson(target)
}

async function fetchJson<T>(target: string | URL): Promise<T> {
  const url = typeof target === 'string' ? new URL(target) : target
  const transport = url.protocol === 'https:' ? https : http
  return new Promise<T>((resolve, reject) => {
    const request = transport.get(url, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk) => {
        chunks.push(
          typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
        )
      })
      response.on('error', reject)
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        if (response.statusCode && response.statusCode >= 400) {
          reject(
            new Error(
              `Request failed with status ${response.statusCode}: ${
                body || response.statusMessage || 'no body'
              }`
            )
          )
          return
        }
        try {
          resolve(JSON.parse(body || 'null'))
        } catch (error) {
          reject(error)
        }
      })
    })
    request.on('error', reject)
  })
}

function formatBoardList(
  boards?: ReadonlyArray<{ readonly name?: string; readonly fqbn?: string }>
): string {
  if (!boards || !boards.length) {
    return 'no discovered boards'
  }
  return boards
    .map((board) => {
      const label = board.name ?? board.fqbn ?? 'unknown'
      return board.fqbn ? `${label} (${board.fqbn})` : label
    })
    .join(', ')
}

function formatPortDescription(
  port?: PortIdentifier,
  fallback?: string
): string {
  if (port) {
    try {
      return createPortKey(port)
    } catch {
      return `${port.protocol ?? 'unknown'} ${port.address ?? 'unknown'}`
    }
  }
  return fallback ?? 'unknown port'
}
