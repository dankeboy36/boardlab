// @ts-check
import { TextEncoder } from 'node:util'

import { MonitorPortOpenRequest } from 'ardunno-cli/api'
import defer from 'p-defer'

/**
 * @typedef {Object} PortinoMonitor
 * @property {AsyncIterable<Uint8Array<ArrayBufferLike>>} messages
 * @property {(message: string) => void} sendMessage
 * @property {(baudrate: string) => Promise<void>} updateBaudrate
 * @property {Promise<void>} ready
 * @property {() => Promise<void>} dispose
 * @property {() => Promise<void>} pause
 * @property {() => Promise<void>} resume
 * @property {() => boolean} isPaused
 */

/**
 * Open a serial monitor via the Arduino CLI gRPC API.
 *
 * @param {Object} params
 * @param {import('ardunno-cli/api').ArduinoCoreServiceClient} params.client
 * @param {import('ardunno-cli/api').Instance} params.instance
 * @param {import('ardunno-cli/api').Port} params.port
 * @param {import('fqbn').FQBN} [params.fqbn]
 * @param {string} [params.baudrate='9600'] Default is `'9600'`
 * @returns {PortinoMonitor}
 */
export function createMonitor({ client, instance, port, fqbn, baudrate }) {
  const encoder = new TextEncoder()

  // Deferred signals for outgoing commands and config updates
  /** @type {import('p-defer').DeferredPromise<string>} */
  let nextMessage = defer()
  /** @type {import('p-defer').DeferredPromise<{ baudrate: string }>} */
  let nextBaudrateRequest = defer()
  const ackQueue = []
  /** @type {import('p-defer').DeferredPromise<void>} */
  const closeSignal = defer()
  const readySignal = defer()
  let firstAppliedSettings = true

  // Re-openable gRPC stream state
  let paused = false
  /** @type {import('p-defer').DeferredPromise<void>} */
  let resumeSignal = defer()
  /** @type {AbortController | undefined} */
  let streamAbortController
  /** @type {import('p-defer').DeferredPromise<void>} */
  let pauseSignal = defer()
  /** @type {(() => void)[]} */
  const pendingPauseResolvers = []

  /** @returns {AsyncIterable<import('ardunno-cli/api').MonitorRequest>} */
  function createMonitorRequest() {
    return {
      [Symbol.asyncIterator]: async function* () {
        // Initial open request
        const settings =
          typeof baudrate === 'string'
            ? [{ settingId: 'baudrate', value: baudrate }]
            : []
        const openRequest = MonitorPortOpenRequest.fromPartial({
          instance,
          port,
          fqbn: fqbn?.toString(),
          portConfiguration: { settings },
        })

        console.log('Opening monitor on port:', JSON.stringify(openRequest))
        yield { message: { $case: 'openRequest', openRequest } }

        while (true) {
          const result = await Promise.race([
            nextMessage.promise,
            nextBaudrateRequest.promise,
            closeSignal.promise,
            pauseSignal.promise.then(() => ({ type: 'pause' })),
          ])

          // Reset deferred for next loop
          nextMessage = defer()
          nextBaudrateRequest = defer()

          if (typeof result === 'string') {
            const txData = encoder.encode(result)
            yield { message: { $case: 'txData', txData } }
          } else if (result && typeof result === 'object') {
            if ('type' in result && result.type === 'pause') {
              console.log(
                '[portino][monitor] request loop: close requested for pause'
              )
              yield { message: { $case: 'close', close: true } }
              break
            }
            if ('baudrate' in result && typeof result.baudrate === 'string') {
              yield {
                message: {
                  $case: 'updatedConfiguration',
                  updatedConfiguration: {
                    settings: [
                      {
                        settingId: 'baudrate',
                        value: /** @type {string} */ (result.baudrate),
                      },
                    ],
                  },
                },
              }
              continue
            }
            // Fallback: treat unknown payloads as a close request
            yield { message: { $case: 'close', close: true } }
            break
          } else {
            // Close signal (true stop)
            console.log(
              '[portino][monitor] request loop: close requested (stop)'
            )
            yield { message: { $case: 'close', close: true } }
            break
          }
        }
      },
    }
  }

  function openGrpcStream() {
    pauseSignal = defer()
    streamAbortController = new AbortController()
    const signal = streamAbortController.signal
    const monitorRequest = createMonitorRequest()
    return client.monitor(monitorRequest, { signal })
  }

  async function* messages() {
    console.log('[portino][monitor] messages() started')
    let rxBuffer = Buffer.alloc(0)

    while (true) {
      const responseStream = openGrpcStream()
      const respIterator = responseStream[Symbol.asyncIterator]()
      let nextRead = respIterator.next()
      let nextFlush = new Promise((resolve) => setTimeout(resolve, 32))
      let localFirstAppliedHandled = false

      try {
        while (true) {
          const raced = await Promise.race([
            nextRead.then(
              (res) => /** @type {const} */ ({ type: 'read', res })
            ),
            nextFlush.then(() => /** @type {const} */ ({ type: 'flush' })),
          ])

          if (raced.type === 'read') {
            nextRead = respIterator.next()
            const { value: resp, done } = raced.res
            if (done) break
            switch (resp.message?.$case) {
              case 'rxData':
                rxBuffer = Buffer.concat([
                  rxBuffer,
                  Buffer.from(resp.message.rxData),
                ])
                break
              case 'success':
                if (resp.message.success) {
                  readySignal.resolve()
                } else {
                  readySignal.reject(new Error('Monitor initialization failed'))
                }
                break
              case 'error':
                throw new Error(resp.message.error)
              case 'appliedSettings':
                if (firstAppliedSettings) firstAppliedSettings = false
                else if (localFirstAppliedHandled) {
                  const ack = ackQueue.shift()
                  if (ack) ack.resolve(resp.message.appliedSettings)
                } else {
                  // skip the very first after (re)open
                  localFirstAppliedHandled = true
                }
                break
            }
          } else {
            nextFlush = new Promise((resolve) => setTimeout(resolve, 32))
            if (rxBuffer.length > 0) {
              const chunk = rxBuffer
              rxBuffer = Buffer.alloc(0)
              yield chunk
            }
          }
        }

        // final flush for this session
        if (rxBuffer.length > 0) {
          yield rxBuffer
          rxBuffer = Buffer.alloc(0)
        }

        // If we exited the inner loop without error and not paused, the stream ended naturally
        if (!paused) {
          break
        }
      } catch (err) {
        const name = /** @type {any} */ (err)?.name || ''
        const msg = String(
          (err && /** @type {any} */ (err).message) || err || ''
        )
        const isAbort = name === 'AbortError' || /aborted/i.test(msg)
        if (!paused) {
          // real error -> propagate and end
          readySignal.reject(err)
          throw err
        }
        console.log('[portino][monitor] stream error while paused', {
          name,
          message: msg,
          isAbort,
        })
        // Swallow expected errors while paused and fall through to resume loop
      } finally {
        // Ensure iterator is drained/closed before reopening
        try {
          await respIterator.return?.()
        } catch {}
        streamAbortController = undefined
        console.log('[portino][monitor] stream closed', { paused })
      }

      // Wait here while paused, then reopen the stream and continue
      if (paused) {
        console.log('[portino][monitor] pause: awaiting resume signal')
        if (pendingPauseResolvers.length) {
          pendingPauseResolvers.splice(0).forEach((resolveFn) => {
            try {
              resolveFn()
            } catch {}
          })
        }
        await resumeSignal.promise
        console.log('[portino][monitor] pause: resume signal received')
        resumeSignal = defer() // reset for future pauses
      }
    }

    console.log('[portino][monitor] messages() exiting')
    dispose()
  }

  /** @param {string} message */
  function sendMessage(message) {
    nextMessage.resolve(message)
  }

  /**
   * Sends the new baudrate as a port configuration and wait for ACK
   *
   * @param {string} baudrate
   * @returns {Promise<void>}
   */
  async function updateBaudrate(baudrate) {
    // trigger outgoing config
    nextBaudrateRequest.resolve({ baudrate })
    // prepare ACK promise
    // const ack = defer();
    // ackQueue.push(ack);
    // // reset for next request
    // nextBaudrateRequest = defer();
    // return ack.promise;
  }

  async function pause() {
    if (paused) return
    paused = true
    console.log('[portino][monitor] pause invoked', {
      hasStream: Boolean(streamAbortController),
    })
    await new Promise((resolve) => {
      const resolver = () => resolve()
      pendingPauseResolvers.push(resolver)
      if (streamAbortController) {
        console.log('[portino][monitor] pause: signalling close')
        pauseSignal.resolve()
      } else {
        resolver()
        const index = pendingPauseResolvers.indexOf(resolver)
        if (index >= 0) pendingPauseResolvers.splice(index, 1)
      }
    })
    console.log('[portino][monitor] pause completed')
  }

  async function resume() {
    if (!paused) return
    paused = false
    console.log('[portino][monitor] resume invoked')
    resumeSignal.resolve()
  }

  async function dispose() {
    // True stop: end request stream and abort the transport
    try {
      closeSignal.resolve()
    } catch {}
    try {
      streamAbortController?.abort()
    } catch {}
    if (pendingPauseResolvers.length) {
      pendingPauseResolvers.splice(0).forEach((resolveFn) => {
        try {
          resolveFn()
        } catch {}
      })
    }
  }

  // Start processing the response stream to dispatch the first open request
  const messageStream = messages()

  // Avoid unhandled promise rejection if callers forget to await `ready`.
  // Errors are still observable by awaiting `ready` where needed.
  readySignal.promise.catch(() => {})

  return {
    messages: messageStream,
    sendMessage,
    updateBaudrate,
    pause,
    resume,
    dispose,
    ready: readySignal.promise,
    isPaused: () => paused,
  }
}
