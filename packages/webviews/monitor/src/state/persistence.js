// @ts-check
import { vscode } from '@boardlab/base'

/** @typedef {Record<string, unknown>} PersistedState */

const initialState = (() => {
  try {
    const state = vscode.getState()
    if (state && typeof state === 'object') {
      return /** @type {PersistedState} */ ({ ...state })
    }
  } catch (error) {
    console.error('[monitor][persistence] failed to load state', error)
  }
  return /** @type {PersistedState} */ ({})
})()

/** @type {PersistedState} */
let currentState = initialState

export function getPersistedState() {
  return currentState
}

export function updatePersistentState(partial) {
  currentState = { ...currentState, ...partial }
  try {
    vscode.setState(currentState)
  } catch (error) {
    console.error('[monitor][persistence] failed to persist state', error)
  }
}
