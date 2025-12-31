// @ts-check

/**
 * @type {(
 *   state: import('../../app/store').RootState
 * ) => import('./terminalSettingsSlice').TerminalSettings}
 */
export const selectTerminalSettings = (state) => state.terminalSettings
