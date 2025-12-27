// @ts-check
import { useResizeObserver } from '@react-hookz/web'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { useDispatch, useSelector } from 'react-redux'

import { useMonitorStream } from '@boardlab/monitor-shared/serial-monitor'

import MonitorPlotter from './MonitorPlotter.jsx'
import { parseSamples } from './parseSamples.js'
import { plotterDebug } from './plotterDebug.js'
import {
  appendColumns as appendColumnsAction,
  clearData as clearPlotterData,
  selectPlotData,
} from './plotterSlice.js'

/**
 * @typedef {Object} PlotterPanelProps
 * @property {boolean} [active]
 * @property {number} [extWidth]
 * @property {number} [extHeight]
 */

/** @typedef {{ clear: () => void; resetYScale: () => void }} PlotterPanelHandle */

/**
 * @param {PlotterPanelProps} props
 * @param {import('react').Ref<PlotterPanelHandle>} ref
 */
const PlotterPanel = forwardRef(function PlotterPanel(
  { active = true, extWidth, extHeight },
  ref
) {
  /**
   * Shape of the imperative MonitorPlotter API. Multiple series note: when
   * adding y2/y3, extend append to accept { x, y1, y2, ... } or parallel
   * arrays, while keeping a common x[].
   *
   * @typedef {{
   *   appendColumns: (
   *     columns: (number[] | (number | null | undefined)[])[]
   *   ) => void
   *   clear: () => void
   *   pause: () => void
   *   resume: () => void
   *   setAutoscale: (next: boolean) => void
   *   ensureSize: () => void
   *   refresh: () => void
   *   uplot?: uPlot
   * }} MonitorPlotterHandle
   */
  const plotRef = useRef(/** @type {MonitorPlotterHandle | null} */ (null))
  const [plotKey, setPlotKey] = useState(0)
  const savedSizeRef = useRef(/** @type */ (null))
  const containerRef = useRef(/** @type {HTMLDivElement | null} */ (null))
  const [panelSize, setPanelSize] = useState(
    /** @type {{ w: number; h: number }} */ ({ w: 0, h: 0 })
  )

  // Observe own container to compute usable size to pass down
  useResizeObserver(containerRef, (entry) => {
    const cr = entry?.contentRect || entry?.target?.getBoundingClientRect?.()
    if (!cr) return
    const w = Math.max(0, Math.floor(cr.width))
    const h = Math.max(0, Math.floor(cr.height))
    setPanelSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
    // Only update saved size when dimensions look "real" (not the 100x100 fallback)
    const looksGood = w >= 150 && h >= 120
    if (active && looksGood) {
      savedSizeRef.current = { w, h }
      try {
        console.log('[plotterPanel] saved size from resize', { w, h })
      } catch {}
    }
  })

  const recreatePlot = useCallback(() => {
    try {
      console.log('[plotterPanel] recreate plot')
    } catch {}
    setPlotKey((k) => (k + 1) % 1_000_000)
  }, [])

  const modeRef = useRef(
    /** @type {'implicit-index' | 'explicit-x'} */ 'implicit-index'
  )
  const nextIndexRef = useRef(0)
  const lastXRef = useRef(/** @type {number | null} */ null)
  const textBufRef = useRef('')

  const pendingRef = useRef(
    /** @type {(number[] | (number | null | undefined)[])[] | null} */ (null)
  )
  const rafIdRef = useRef(/** @type {number | null} */ (null))
  const streamingRef = useRef(false)
  const forceAutoscaleOnceRef = useRef(false)
  const plotData = useSelector(selectPlotData)
  const plotDataRef = useRef(plotData)
  useEffect(() => {
    plotDataRef.current = plotData
  }, [plotData])
  const dispatch = useDispatch()

  const clearPlot = useCallback(() => {
    try {
      console.log('[plotterPanel] clearPlot')
      // Do not change detected mode mid-stream; just reset positional refs
      nextIndexRef.current = 0
      lastXRef.current = null
      textBufRef.current = ''
      pendingRef.current = null
      const rafId = rafIdRef.current
      if (rafId != null) {
        cancelAnimationFrame(rafId)
        rafIdRef.current = null
      }
      dispatch(clearPlotterData())
      // Do not call plotRef.clear(); keep series & visibility as-is
      // A render will occur on version bump via [active, plotData.version]
    } catch {}
  }, [dispatch])

  const flush = useCallback(() => {
    rafIdRef.current = null
    const batch = pendingRef.current
    pendingRef.current = null
    if (!batch || !batch.length) return
    dispatch(appendColumnsAction(batch))
    // No direct render here; redraw is handled by effect on [active, plotData.version]
  }, [dispatch])

  useEffect(() => {
    return () => {
      const rafId = rafIdRef.current
      if (rafId != null) cancelAnimationFrame(rafId)
    }
  }, [])

  useEffect(() => {
    if (!active) {
      plotRef.current?.pause?.()
      // capture last known size to restore on next activation
      try {
        const sz = plotRef.current?.getSize?.()
        // Avoid saving suspiciously small sizes (likely hidden layout fallback)
        if (sz && sz.w >= 150 && sz.h >= 120) {
          savedSizeRef.current = { w: sz.w, h: sz.h }

          console.log('[plotterPanel] saved size before hiding', sz)
        } else {
          console.log('[plotterPanel] skip saving tiny size before hiding', sz)
        }
      } catch {}
      return
    }
    // ensure visible plot is sized
    plotRef.current?.resume?.()
    plotRef.current?.ensureSize?.()

    // After a short delay, if plot still reports invalid size, recreate it
    setTimeout(() => {
      try {
        const u = plotRef.current?.uplot
        const ok = !!u && u.width > 50 && u.height > 50
        if (!ok) {
          console.warn(
            '[plotterPanel] plot size invalid after resume; remounting',
            {
              w: u?.width,
              h: u?.height,
            }
          )
          recreatePlot()
        }
      } catch {}
    }, 120)
  }, [active])

  // Keep size in sync with window resizes (throttled via rAF)
  useEffect(() => {
    const onResize = () => {
      try {
        requestAnimationFrame(() => {
          plotRef.current?.ensureSize?.()
        })
      } catch {
        plotRef.current?.ensureSize?.()
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    if (!active) return
    const opts = { freezeX: !streamingRef.current }
    if (forceAutoscaleOnceRef.current) {
      // @ts-ignore
      opts.autoscale = true
      forceAutoscaleOnceRef.current = false
    }
    // @ts-ignore
    plotRef.current?.render?.(plotData.x, plotData.ys, opts)
  }, [active, plotData.version])

  const handleStreamStart = useCallback(() => {
    try {
      console.log('[plotterPanel] stream:start')
    } catch {}
    clearPlot()
    try {
      plotRef.current?.resetPlot?.({ full: true })
    } catch {}
    try {
      plotRef.current?.setAutoscale?.(true)
    } catch {}
    streamingRef.current = true
    forceAutoscaleOnceRef.current = true
  }, [clearPlot, dispatch])

  const handleStreamStop = useCallback(() => {
    try {
      console.log('[plotterPanel] stream:stop')
      /** @type {{ x: number[]; ys: (number | null)[][] } | null} */
      let padded = null
      // 1) If there is a pending batch scheduled via rAF, flush it NOW so the
      //    final frame reflects all received data before we freeze X.
      const hadPending = !!pendingRef.current || rafIdRef.current != null
      if (rafIdRef.current != null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
      if (hadPending) {
        try {
          // Synchronously flush pending columns into the store and plot
          flush()
        } catch {}
      }

      // Snapshot the currently visible X scale without mutating uPlot; we'll
      // use this to pad and to freeze exactly that domain.
      /** @type {{ min: number; max: number } | null} */
      let frozenX = null
      try {
        const u = plotRef.current?.uplot
        const sx = u?.scales['x']
        if (sx && Number.isFinite(sx.min) && Number.isFinite(sx.max)) {
          frozenX = { min: sx.min, max: sx.max }
        }
      } catch {}

      // Build padded arrays (no render yet)
      try {
        const pd = plotDataRef.current
        const x = Array.isArray(pd?.x) ? pd.x.slice(0) : []
        const ys = Array.isArray(pd?.ys) ? pd.ys.map((col) => col.slice(0)) : []
        if (frozenX && x.length > 0) {
          const targetMax = frozenX.max
          const lastX = x[x.length - 1]
          if (typeof lastX === 'number' && lastX < targetMax) {
            let step = 1
            if (x.length >= 2) {
              const a = x[x.length - 2]
              const b = x[x.length - 1]
              const d = b - a
              if (Number.isFinite(d) && d > 0) step = d
            }
            let cur = lastX
            const maxIters = 100_000
            let iter = 0
            while (cur + step <= targetMax && iter++ < maxIters) {
              cur += step
              x.push(cur)
              for (let s = 0; s < ys.length; s++) ys[s].push(null)
            }
            if (x[x.length - 1] < targetMax && iter < maxIters) {
              x.push(targetMax)
              for (let s = 0; s < ys.length; s++) ys[s].push(null)
            }
          }
        } else if (frozenX && x.length === 0) {
          // No samples: synthesize X domain with null Ys
          const targetMax = frozenX.max
          const synthX = []
          const step = 1
          let cur = 0
          const maxIters = 100_000
          let iter = 0
          while (cur + step <= targetMax && iter++ < maxIters) {
            cur += step
            synthX.push(cur)
          }
          if (synthX.length === 0 || synthX[synthX.length - 1] < targetMax) {
            synthX.push(targetMax)
          }
          for (let s = 0; s < ys.length; s++) {
            ys[s] = new Array(synthX.length).fill(null)
          }
          padded = { x: synthX, ys }
        }
        if (!padded) padded = { x, ys }
      } catch {}

      // If we have more data than the visible window, trim to [xmin, xmax] inclusive
      try {
        if (frozenX && padded && Array.isArray(padded.x) && padded.x.length) {
          const { min: xmin, max: xmax } = frozenX
          const x = padded.x
          const ys = padded.ys
          // Estimate step to compute an epsilon tolerance
          let step = 1
          if (x.length >= 2) {
            const d = x[x.length - 1] - x[x.length - 2]
            if (Number.isFinite(d) && d > 0) step = d
          }
          const eps = Math.max(1e-9, step * 0.5)
          // find first index i where x[i] >= xmin - eps
          let lo = 0
          let hi = x.length - 1
          let first = x.length
          while (lo <= hi) {
            const mid = (lo + hi) >> 1
            if (x[mid] >= xmin - eps) {
              first = mid
              hi = mid - 1
            } else lo = mid + 1
          }
          // find last index j where x[j] <= xmax + eps
          lo = 0
          hi = x.length - 1
          let last = -1
          while (lo <= hi) {
            const mid = (lo + hi) >> 1
            if (x[mid] <= xmax + eps) {
              last = mid
              lo = mid + 1
            } else hi = mid - 1
          }
          if (first === x.length) first = Math.max(0, last)
          if (last < first) last = first
          if (first > 0 || last < x.length - 1) {
            const x2 = x.slice(first, last + 1)
            const ys2 = ys.map((col) => col.slice(first, last + 1))
            padded = { x: x2, ys: ys2 }
          }
        }
      } catch {}

      // ---- [stop] snapshot diagnostics ----
      try {
        const pd = plotDataRef.current
        const x0 = (padded?.x && padded.x[0]) ?? (pd.x && pd.x[0])
        const xN =
          (padded?.x && padded.x[padded.x.length - 1]) ??
          (pd.x && pd.x[pd.x.length - 1])
        console.log('[stop] snapshot', {
          frozenX,
          pdLen: {
            x: pd.x?.length || 0,
            ys: pd.ys?.map((a) => a.length) || [],
          },
          paddedLen: {
            x: padded?.x?.length || 0,
            ys: padded?.ys?.map((a) => a.length) || [],
          },
          firstX: x0,
          lastX: xN,
        })
      } catch {}
      // ---- end snapshot diagnostics ----

      // Snapshot current Y scale so stopping does not rescale vertically
      let frozenY = null
      try {
        const u = plotRef.current?.uplot
        const ys = u?.scales['y']
        if (ys && Number.isFinite(ys.min) && Number.isFinite(ys.max)) {
          frozenY = { min: ys.min, max: ys.max }
        }
      } catch {}

      // 3) Freeze Y autoscale and then freeze X by rendering with freezeX=true
      try {
        plotRef.current?.setAutoscale?.(false)
      } catch {}
      streamingRef.current = false

      // Re-apply frozen Y & X scales to prevent any rescale at stop
      try {
        const u = plotRef.current?.uplot
        if (u) {
          if (frozenY) u.setScale('y', frozenY)
          if (frozenX) u.setScale('x', frozenX)
        }
      } catch {}

      // ---- [stop] apply scales+final render diagnostics ----
      try {
        console.log('[stop] apply scales+final render', {
          frozenX,
          frozenY,
          finalLens: {
            x: padded?.x?.length || plotDataRef.current.x?.length || 0,
            y0:
              padded?.ys?.[0]?.length ||
              plotDataRef.current.ys?.[0]?.length ||
              0,
          },
        })
      } catch {}
      // ---- end apply scales+final render diagnostics ----

      try {
        const pd = plotDataRef.current
        const finalX = padded ? padded.x : pd.x
        const finalYs = padded ? padded.ys : pd.ys
        plotRef.current?.render?.(finalX, finalYs, {
          freezeX: true,
          autoscale: false,
          freezeXScale: frozenX || undefined,
        })
      } catch {}

      // ---- [stop] after final render -> scales diagnostics ----
      try {
        const u = plotRef.current?.uplot
        const sx = u?.scales?.['x']
        const sy = u?.scales?.['y']
        console.log('[stop] after final render -> scales', { x: sx, y: sy })
      } catch {}
      // ---- end after final render diagnostics ----

      // 4) Clear text buffer (no more line parsing after stop)
      textBufRef.current = ''
    } catch {}
  }, [])

  const handleStreamText = useCallback(
    (text) => {
      const chunk = String(text)
      const combined = textBufRef.current + chunk
      const parts = combined.split(/\r?\n/)
      textBufRef.current = parts.pop() ?? ''
      const complete = parts.length ? parts.join('\n') : ''
      const columns = complete
        ? parseSamples(complete, modeRef, nextIndexRef, lastXRef)
        : null
      if (columns && columns.length) {
        try {
          console.log('[plotterPanel] parse->columns', {
            cols: columns.length,
            rows: /** @type {any[]} */ (columns[0]).length,
            mode: modeRef.current,
          })
        } catch {}
        if (!pendingRef.current) {
          pendingRef.current = columns
        } else {
          const pend = /** @type {any[]} */ (pendingRef.current)
          const pRows = pend[0].length
          const cRows = /** @type {any[]} */ (columns[0]).length
          const pCols = pend.length
          const cCols = columns.length
          const totalCols = Math.max(pCols, cCols)
          for (let i = pCols; i < totalCols; i++) {
            const arr = new Array(pRows)
            for (let r = 0; r < pRows; r++) arr[r] = null
            pend[i] = arr
          }
          for (let i = cCols; i < totalCols; i++) {
            const arr = new Array(cRows)
            for (let r = 0; r < cRows; r++) arr[r] = null
            // @ts-ignore
            columns[i] = arr
          }
          for (let i = 0; i < totalCols; i++) {
            // @ts-ignore
            pend[i].push(...columns[i])
          }
        }
        if (rafIdRef.current == null) {
          rafIdRef.current = requestAnimationFrame(flush)
        }
        plotterDebug.log('plotter:parse', {
          rows: /** @type {any[]} */ (columns[0]).length,
          cols: columns.length,
          mode: modeRef.current,
          pendingCols: pendingRef.current ? pendingRef.current.length : 0,
        })
      }
    },
    [flush]
  )

  useMonitorStream({
    onStart: handleStreamStart,
    onStop: handleStreamStop,
    onText: handleStreamText,
  })

  useImperativeHandle(
    ref,
    () => ({
      clear: clearPlot,
      resetYScale: () => plotRef.current?.resetYScale?.(),
    }),
    [clearPlot]
  )

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        minHeight: 0,
        height: '100%',
        position: 'relative',
        margin: 4,
      }}
    >
      <MonitorPlotter
        key={plotKey}
        ref={plotRef}
        maxPoints={5000}
        autoscale={false}
        width={
          (extWidth && extWidth > 0
            ? extWidth
            : (active ? panelSize.w : savedSizeRef.current?.w) ||
              panelSize.w) || 0
        }
        height={
          (extHeight && extHeight > 0
            ? extHeight
            : (active ? panelSize.h : savedSizeRef.current?.h) ||
              panelSize.h) || 0
        }
      />
    </div>
  )
})

export default PlotterPanel
