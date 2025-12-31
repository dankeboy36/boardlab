// @ts-check
import EventEmitter from 'node:events'

import { createPortKey } from 'boards-list'

/**
 * Watches the board list via Arduino CLI gRPC API and emits add/remove events.
 *
 * @param {import('ardunno-cli/api').ArduinoCoreServiceClient} client -
 *   Initialized gRPC client
 * @param {import('ardunno-cli/api').Instance} instance - CLI instance
 *   identifier
 * @returns {{ emitter: EventEmitter; dispose: () => void }}
 */
export function watchBoardList(client, instance) {
  const emitter = new EventEmitter()
  const abortController = new AbortController()
  const { signal } = abortController

  ;(async () => {
    try {
      for await (const resp of client.boardListWatch(
        { instance },
        { signal }
      )) {
        const { error, eventType, port: detectedPort } = resp
        if (error) {
          emitter.emit('error', error)
          continue
        }
        if (eventType === 'quit') {
          emitter.emit('quit')
          continue
        }
        if (!detectedPort || !detectedPort.port) {
          continue
        }
        const { port, matchingBoards } = detectedPort
        if (eventType === 'add' || eventType === 'remove') {
          emitter.emit('change', {
            type: eventType,
            portKey: createPortKey(port),
            port,
            boards: matchingBoards.map(({ name, fqbn }) => ({ name, fqbn })),
          })
        } else {
          emitter.emit('warn', `Unexpected event type: ${eventType}`)
        }
      }
    } catch (err) {
      if (!signal.aborted) {
        emitter.emit('error', err)
      }
    }
  })()

  return {
    emitter,
    dispose: () => abortController.abort(),
  }
}

/**
 * @typedef {Object} BoardListStateWatcher
 * @property {import('events').EventEmitter} emitter
 * @property {import('boards-list').DetectedPorts} state
 * @property {() => void} dispose
 */

/**
 * Wraps boardListWatch to provide a buffered, stateful view of detected ports.
 *
 * @param {import('ardunno-cli/api').ArduinoCoreServiceClient} client
 * @param {import('ardunno-cli/api').Instance} instance
 * @returns {BoardListStateWatcher}
 */
export function watchBoardListState(client, instance) {
  const { emitter: delegateEmitter, dispose: rawDispose } = watchBoardList(
    client,
    instance
  )
  const emitter = new EventEmitter()
  /** @type {Readonly<Record<string, import('boards-list').DetectedPort>>} */
  let currentState = {}
  /**
   * @type {{
   *   type: 'add' | 'remove'
   *   portKey: string
   *   port: object
   *   boards: { name: string; fqbn: string }[]
   * }[]}
   */
  let bufferedEvents = []
  /** @type {NodeJS.Timeout | undefined} */
  let flushTimer

  function flush() {
    currentState = nextState(currentState, bufferedEvents)
    bufferedEvents = []
    emitter.emit('update', currentState)
  }

  delegateEmitter.on('change', (event) => {
    bufferedEvents.push(event)
    clearTimeout(flushTimer)
    flushTimer = setTimeout(flush, 200)
  })
  delegateEmitter.on('quit', () => emitter.emit('quit'))
  delegateEmitter.on('error', (err) => emitter.emit('error', err))

  function dispose() {
    clearTimeout(flushTimer)
    rawDispose()
  }

  return {
    emitter,
    get state() {
      return {
        ...currentState,
      }
    },
    dispose,
  }
}

/**
 * Compute the next state given current mapping and a list of events.
 *
 * @param {import('boards-list').DetectedPorts} current
 * @param {{
 *   type: 'add' | 'remove'
 *   portKey: string
 *   port: object
 *   boards: { name: string; fqbn: string }[]
 * }[]} events
 * @returns {import('boards-list').DetectedPorts}
 */
function nextState(current, events) {
  const next = { ...current }
  for (const ev of events) {
    const { type, portKey, port, boards } = ev
    if (type === 'remove') {
      delete next[portKey]
    } else {
      next[portKey] = { port, boards }
    }
  }
  return next
}
