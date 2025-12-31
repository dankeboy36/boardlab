// @ts-check
import { vscode } from '@boardlab/base'

const initialState = (() => {
  try {
    const state = vscode.getState()
    if (state && typeof state === 'object') {
      return { .../** @type {Record<string, unknown>} */ (state) }
    }
  } catch (error) {
    console.error('[plotter][persistence] failed to load state', error)
  }
  return /** @type {Record<string, unknown>} */ ({})
})()

/** @type {Record<string, unknown>} */
let currentState = initialState

export function getPersistedState() {
  return currentState
}

export function updatePersistentState(partial) {
  currentState = { ...currentState, ...partial }
  try {
    vscode.setState(currentState)
  } catch (error) {
    console.error('[plotter][persistence] failed to persist state', error)
  }
}
