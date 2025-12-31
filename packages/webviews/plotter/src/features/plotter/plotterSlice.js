// @ts-check
import { createSelector, createSlice } from '@reduxjs/toolkit'

/**
 * @typedef {{
 *   x: number[]
 *   ys: (number | null)[][]
 *   maxPoints: number
 *   version: number
 * }} PlotterState
 */

/** @type {PlotterState} */
const initialState = {
  x: [],
  ys: [],
  maxPoints: 5000,
  version: 0,
}

const plotterSlice = createSlice({
  name: 'plotter',
  initialState,
  reducers: {
    reset(state, action) {
      state.x = []
      state.ys = []
      if (
        action?.payload?.maxPoints &&
        Number.isFinite(action.payload.maxPoints)
      ) {
        state.maxPoints = Math.max(1, Math.floor(action.payload.maxPoints))
      }
      state.version++
    },
    clearData(state) {
      state.x = []
      state.ys = []
      state.version++
    },
    hardReset() {
      // Return a fresh initial state object
      return {
        x: [],
        ys: [],
        maxPoints: 5000,
        version: 0,
      }
    },
    setMaxPoints(state, action) {
      const v = Math.max(1, Math.floor(action.payload || 1))
      state.maxPoints = v
      state.version++
    },
    /**
     * Append normalized columns: [x[], y1[], y2[], ...]
     *
     * @param {PlotterState} state
     * @param {{ payload: (number[] | (number | null)[])[] }} action
     */
    appendColumns(state, action) {
      const cols = action.payload || []
      if (!Array.isArray(cols) || cols.length === 0) return
      const xIn = /** @type {number[]} */ (cols[0] || [])
      const yIns = /** @type {(number | null)[][]} */ (cols.slice(1))
      // Ensure y columns exist
      while (state.ys.length < yIns.length) state.ys.push([])
      // Append rows
      for (let i = 0; i < xIn.length; i++) {
        state.x.push(xIn[i])
        for (let s = 0; s < state.ys.length; s++) {
          const col = /** @type {(number | null)[]} */ (yIns[s] || [])
          const v = col[i]
          state.ys[s].push(typeof v === 'number' ? v : null)
        }
      }
      // Trim ring buffer
      const over = state.x.length - state.maxPoints
      if (over > 0) {
        state.x.splice(0, over)
        for (let s = 0; s < state.ys.length; s++) state.ys[s].splice(0, over)
      }
      state.version++
    },
  },
})

/** @typedef {typeof plotterSlice.actions} PlotterActions */

/** @type {PlotterActions} */
const actions = plotterSlice.actions

export const { reset, clearData, hardReset, setMaxPoints, appendColumns } =
  actions
export default plotterSlice.reducer

/** @type {(state: import('../../app/store').RootState) => PlotterState} */
export const selectPlotter = (state) => state.plotter
/**
 * @type {(
 *   state: import('../../app/store').RootState
 * ) => Pick<PlotterState, 'x' | 'ys' | 'version'>}
 */
export const selectPlotData = createSelector([selectPlotter], (plotter) => ({
  x: plotter.x,
  ys: plotter.ys,
  version: plotter.version,
  maxPoints: plotter.maxPoints,
}))
