// @ts-check
import { ArduinoCoreServiceDefinition } from 'ardunno-cli'
import { createChannel, createClient } from 'nice-grpc'

/**
 * @typedef {import('nice-grpc').Client<ArduinoCoreServiceDefinition>} CoreClient
 *
 *
 * @typedef {import('ardunno-cli').Instance} Instance
 *
 * @typedef {Object} CreateCoreClientParams
 * @property {import('./startDaemon').DaemonAddress} address
 *
 * @typedef {Object} CreateCoreClientResult
 * @property {import('nice-grpc').Channel} channel
 * @property {CoreClient} client
 *
 * @typedef {Object} InitCoreClientParams
 * @property {CoreClient} client
 *
 * @typedef {Object} InitCoreClientResult
 * @property {CoreClient} client
 * @property {Instance} instance
 */

/**
 * @param {CreateCoreClientParams} params
 * @returns {CreateCoreClientResult}
 */
export function createCoreClient(params) {
  const { hostname, port } = params.address
  const channel = createChannel(`${hostname}:${port}`)
  const client = createClient(ArduinoCoreServiceDefinition, channel)
  return { channel, client }
}

/**
 * @param {InitCoreClientParams} params
 * @returns {Promise<InitCoreClientResult>}
 */
export async function initCoreClient(params) {
  const { client } = params
  const response = await client.create({})
  const { instance } = response
  for await (const response of client.init({ instance })) {
    switch (response.message?.$case) {
      case 'error': {
        throw new Error(response.message.error.message)
      }
      default: // TODO: log progress
    }
  }
  if (!instance) {
    throw new Error(
      `'instance' was not set in response: ${JSON.stringify(response)}`
    )
  }
  return { client, instance }
}
