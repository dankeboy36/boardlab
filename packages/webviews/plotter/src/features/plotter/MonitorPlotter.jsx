// @ts-check
import { useResizeObserver } from '@react-hookz/web'
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import UplotReact from 'uplot-react'
import 'uplot/dist/uPlot.min.css'
import {
  VscodeContextMenu,
  VscodeSplitLayout,
  VscodeTextfield,
} from 'vscode-react-elements-x'
import './uplotTheme.css'

import {
  attachUplotTheme,
  isPlotThemeReady,
  onPlotThemeChange,
} from './plotTheme.js'
import { plotterDebug } from './plotterDebug.js'

/**
 * Minimal, fast uPlot wrapper for Monitor. uPlot expects columnar data: [x[],
 * y[]], with x strictly increasing. We keep plain number arrays and call
 * setData with full columns.
 *
 * @param {{
 *   maxPoints?: number
 *   autoscale?: boolean
 *   strokeWidth?: number
 *   pxRatio?: number
 *   onReady?: (u: uPlot) => void
 *   xWindow?: number
 *   useAnsiColors?: boolean
 *   width?: number
 *   height?: number
 * }} props
 */
const MonitorPlotter = forwardRef(function MonitorPlotter(
  {
    maxPoints = 10000,
    autoscale = true,
    strokeWidth = 0.5,
    onReady,
    xWindow = 10,
    useAnsiColors = false,
    width: extWidth,
    height: extHeight,
  },
  ref
) {
  /** Root container */
  const containerRef = useRef(
    /** @type {VscodeSplitLayoutElement | null} */ (null)
  )
  /** Right pane (plot area) for sizing */
  const plotPaneRef = useRef(/** @type {HTMLDivElement | null} */ (null))
  /** Left pane (external legend host) */
  const legendHostRef = useRef(/** @type {HTMLDivElement | null} */ (null))
  /** @type {React.MutableRefObject<uPlot | null>} */
  const plotRef = useRef(null)
  const pausedRef = useRef(false)
  const themeRef = useRef(/** @type */ (null))
  const [ctxMenu, setCtxMenu] = useState(
    /**
     * @type {{
     *   show: boolean
     *   x: number
     *   y: number
     *   seriesIdx: number
     *   label?: string
     * }}
     */ ({
      show: false,
      x: 0,
      y: 0,
      seriesIdx: -1,
      label: undefined,
    })
  )
  const [rename, setRename] = useState(
    /**
     * @type {{
     *   show: boolean
     *   x: number
     *   y: number
     *   seriesIdx: number
     *   value: string
     * }}
     */ ({
      show: false,
      x: 0,
      y: 0,
      seriesIdx: -1,
      value: '',
    })
  )
  const renameInputRef = useRef(/** @type {HTMLElement | null} */ (null))
  const renameOverlayRef = useRef(/** @type {HTMLDivElement | null} */ (null))

  function queueFocusRenameInput() {
    const focusOnce = () => {
      try {
        const el = renameInputRef.current
        // @ts-ignore access to wrappedElement (native <input>)
        const inner =
          el?.wrappedElement || el?.shadowRoot?.querySelector?.('input')
        if (inner) {
          inner.focus()
          inner.select?.()
        } else {
          el?.focus?.()
        }
      } catch {}
    }
    try {
      requestAnimationFrame(() => {
        focusOnce()
        setTimeout(focusOnce, 0)
        setTimeout(focusOnce, 30)
      })
    } catch {
      focusOnce()
      setTimeout(focusOnce, 0)
      setTimeout(focusOnce, 30)
    }
  }
  const ctxMenuRef = useRef(/** @type {HTMLElement | null} */ (null))

  // Columnar buffers (plain numbers per uPlot README). To add more series
  // later, add y2BufRef/y3BufRef and extend `series` and setData([x, y1, y2...]).
  const xBufRef = useRef(/** @type {number[]} */ ([]))
  const yBufsRef = useRef(
    /** @type {import('./parseSamples.js').YArray[]} */ ([])
  )

  const [isAutoscale, setIsAutoscale] = useState(!!autoscale)
  const [themeReady, setThemeReady] = useState(
    typeof document !== 'undefined' ? isPlotThemeReady({ useAnsiColors }) : true
  )
  const lastSizeRef = useRef({ w: 0, h: 0 })
  const extInitDoneRef = useRef(false)
  const hiddenSeriesRef = useRef(new Set())
  const seriesUpdateMutedRef = useRef(false)
  const hasFixedX = typeof xWindow === 'number' && xWindow > 0

  // Persist last manual Y scale (survives autoscale on/off & session restarts)
  const yManualRef = useRef(
    /** @type {{ min: number; max: number } | null} */ (null)
  )
  const yAxisListenerRef = useRef(
    /** @type {{ el: HTMLElement; onDown: (e: MouseEvent) => void } | null} */ (
      null
    )
  )
  const cursorHelpersRef = useRef(
    /**
     * @type {{
     *   root: HTMLElement | null
     *   onKeyDown: (e: KeyboardEvent) => void
     *   onKeyUp: (e: KeyboardEvent) => void
     * } | null}
     */ (null)
  )

  // Force re-mount of uPlot to fully reset internal state (series, legend DOM, hooks)
  const [uplotKey, setUplotKey] = useState(0)

  const colorForSeries = (idx) => themeRef.current?.getColor(idx) || '#3b3b3b'
  const withAlpha = (hex, alpha) => {
    if (
      typeof hex !== 'string' ||
      !/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(hex)
    ) {
      return hex
    }
    const a = Math.max(0, Math.min(1, typeof alpha === 'number' ? alpha : 1))
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    return `rgba(${r}, ${g}, ${b}, ${a})`
  }

  function ensureSize() {
    try {
      const rect = plotPaneRef.current?.getBoundingClientRect()
      const u = plotRef.current
      if (!rect || !u) return
      const w = Math.max(100, Math.floor(rect.width))
      const h = Math.max(100, Math.floor(rect.height))
      if (u.width !== w || u.height !== h) {
        console.log(
          '[plotter] ensureSize -> setSize',
          u.width,
          u.height,
          '->',
          w,
          h
        )
        u.setSize({ width: w, height: h })
        lastSizeRef.current = { w, h }
        extInitDoneRef.current = true
        try {
          console.log('[plotter] ensureSize -> setSize', { w, h })
        } catch {}
      }
    } catch {}
  }

  function withSeriesUpdateMuted(fn) {
    seriesUpdateMutedRef.current = true
    try {
      fn()
    } finally {
      seriesUpdateMutedRef.current = false
    }
  }

  // Ensure there are exactly `count` series (including x at index 0)
  function ensureSeriesCount(count) {
    try {
      const u = plotRef.current
      if (!u) return
      // u.series includes the x-series at index 0
      while ((u.series?.length || 0) < count) {
        const idx = u.series.length // adding at end => y index == idx
        u.addSeries({
          label: 'y' + String(idx),
          width: strokeWidth,
          stroke: () => colorForSeries(idx - 1),
          fill: () => withAlpha(colorForSeries(idx - 1), 0.12),
        })
      }
      withSeriesUpdateMuted(() => {
        // Ensure required series reflect toggle state (idx 1..count-1) without churn
        for (let i = 1; i < count; i++) {
          const shouldShow = !hiddenSeriesRef.current.has(i)
          const curShown = u.series?.[i]?.show !== false
          if (curShown !== shouldShow) {
            try {
              u.setSeries?.(i, { show: shouldShow }, true)
            } catch {}
          }
        }
        // We don't remove extra series; if more than needed, hide extras
        for (let i = count; i < (u.series?.length || 0); i++) {
          try {
            u.setSeries?.(i, { show: false }, true)
          } catch {}
        }
      })
    } catch {}
  }

  const opts = useMemo(() => {
    /** Keep legend enabled; move it in onCreate when host is ready */
    const legend = { show: true, live: true }
    /** @type {uPlot.Options} */
    const opts = {
      width: 300,
      height: 200,
      scales: {
        x: {
          time: false,
          ...(hasFixedX ? { min: 0, max: xWindow } : {}),
        }, // treat x as plain numbers
        y: {},
      },
      legend,
      hooks: {
        setSeries: [
          /** @param {uPlot} u */
          (u, si) => {
            try {
              if (seriesUpdateMutedRef.current) return
              if (typeof si === 'number' && si > 0) {
                const shown = u.series?.[si]?.show !== false
                if (shown) hiddenSeriesRef.current.delete(si)
                else hiddenSeriesRef.current.add(si)

                console.log('[plotter] hook:setSeries', { si, shown })
              }
            } catch {}
          },
        ],
      },
      axes: [{ grid: { show: true } }, { grid: { show: true } }],
      series: [],
    }
    try {
      console.log('[plotter] build opts', { hasFixedX, xWindow, strokeWidth })
    } catch {}
    return opts
  }, [strokeWidth, hasFixedX, xWindow])

  // Initial sizing
  useEffect(() => {
    const rect = plotPaneRef.current?.getBoundingClientRect()
    if (!rect) return
    const initW = Math.max(100, Math.floor(rect.width))
    const initH = Math.max(100, Math.floor(rect.height))
    lastSizeRef.current = { w: initW, h: initH }
    try {
      const u = plotRef.current
      if (u && (u.width !== initW || u.height !== initH)) {
        u.setSize({ width: initW, height: initH })
      }
    } catch {}
    try {
      console.log('[plotter] initial size', { initW, initH })
    } catch {}
  }, [])

  // Apply external width/height from parent, but account for legend width
  // and prefer real plot pane size if available to avoid thrashing.
  useEffect(() => {
    const u = plotRef.current
    if (!u) return

    const paneRect = plotPaneRef.current?.getBoundingClientRect?.()
    const paneW = paneRect && paneRect.width ? Math.floor(paneRect.width) : 0
    const paneH = paneRect && paneRect.height ? Math.floor(paneRect.height) : 0
    // If pane is measurable, let ensureSize()/resizeObserver handle it
    if (paneW > 0 && paneH > 0) return

    // Fallback path only before first real pane sizing
    if (extInitDoneRef.current) return

    let w = 0
    let h = 0

    {
      const extW =
        typeof extWidth === 'number' ? Math.max(0, Math.floor(extWidth)) : 0
      const extH =
        typeof extHeight === 'number' ? Math.max(0, Math.floor(extHeight)) : 0
      if (!extW || !extH) return
      const legendRect = legendHostRef.current?.getBoundingClientRect?.()
      const legendW =
        legendRect && legendRect.width ? Math.floor(legendRect.width) : 0
      const gutter = 2
      w = Math.max(0, extW - legendW - gutter)
      h = extH
    }

    if (!w || !h) return

    const { w: lw, h: lh } = lastSizeRef.current || { w: 0, h: 0 }
    if (u.width !== w || u.height !== h) {
      try {
        u.setSize({ width: w, height: h })
        lastSizeRef.current = { w, h }
        extInitDoneRef.current = true
        console.log('[plotter] external size applied', { w, h })
      } catch {}
    } else if (lw !== w || lh !== h) {
      lastSizeRef.current = { w, h }
    }
  }, [extWidth, extHeight])

  // Resize to container via react-hookz; guard to avoid loops
  useResizeObserver(plotPaneRef, (entry) => {
    const cr = entry?.contentRect || entry?.target?.getBoundingClientRect?.()
    if (!cr) return
    const w = Math.max(100, Math.floor(cr.width))
    const h = Math.max(100, Math.floor(cr.height))
    if (lastSizeRef.current.w === w && lastSizeRef.current.h === h) return
    lastSizeRef.current = { w, h }
    try {
      const u = plotRef.current
      if (u && (u.width !== w || u.height !== h)) {
        u.setSize({ width: w, height: h })
      }
    } catch {}
    plotterDebug.log('uplot:resize', { w, h })
    try {
      console.log('[plotter] resize observer', { w, h })
    } catch {}
  })

  // Track theme readiness (avoid initial default colors flash)
  useEffect(() => {
    setThemeReady(isPlotThemeReady({ useAnsiColors }))
    try {
      console.log('[plotter] theme check', {
        ready: isPlotThemeReady({ useAnsiColors }),
        useAnsiColors,
      })
    } catch {}
    const dispose = onPlotThemeChange(() => {
      setThemeReady(isPlotThemeReady({ useAnsiColors }))
      try {
        console.log('[plotter] theme change', {
          ready: isPlotThemeReady({ useAnsiColors }),
        })
      } catch {}
    })
    return () => dispose()
  }, [useAnsiColors])

  // Re-attach theme when palette mode changes
  useEffect(() => {
    const u = plotRef.current
    if (!u) return
    try {
      themeRef.current?.dispose?.()
    } catch {}
    try {
      themeRef.current = attachUplotTheme(u, { useAnsiColors })
    } catch {}
    try {
      console.log('[plotter] attach theme', { useAnsiColors })
    } catch {}
  }, [useAnsiColors])

  // Log document visibility changes to correlate with tab switching
  useEffect(() => {
    const onVis = () => {
      try {
        console.log('[plotter] visibilitychange', document.visibilityState)
      } catch {}
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  // Install context-menu handler on legend rows (marker/label/value)
  useEffect(() => {
    const host = legendHostRef.current
    if (!host) return

    console.log('[plotter] attaching contextmenu listener to legend host')

    /** @param {MouseEvent} ev */
    const onContextMenu = (ev) => {
      // Close any active inline rename when opening a new context menu
      try {
        setRename((s) => (s.show ? { ...s, show: false } : s))
      } catch {}

      console.log('[plotter] contextmenu event', {
        target: ev.target,
        type: ev.type,
        buttons: ev.buttons,
        button: ev.button,
      })
      const path = ev.composedPath?.() || []
      try {
        console.log(
          '[plotter] contextmenu path',
          path.map((n) =>
            n && n.tagName ? `${n.tagName}.${n.className || ''}` : n
          )
        )
      } catch {}
      // find the legend row (tr) anywhere in the path
      const row = /** @type {HTMLElement | undefined} */ (
        path.find((n) => n && n instanceof HTMLElement && n.tagName === 'TR')
      )
      if (!row) {
        console.log('[plotter] contextmenu: no legend row found in path')
        return
      }

      const table = row.closest('table')
      let seriesIdx = -1
      if (table) {
        // prefer tbody rows to avoid header rows if present
        const tbody = table.querySelector('tbody') || table
        const rows = Array.from(tbody.querySelectorAll('tr'))
        seriesIdx = rows.indexOf(row)
      }

      ev.preventDefault()
      ev.stopPropagation()

      // get label from uPlot if available
      let label
      try {
        const u = plotRef.current
        label = u?.series?.[seriesIdx]?.label
      } catch {}

      console.log('[plotter] show context menu', {
        x: ev.clientX,
        y: ev.clientY,
        seriesIdx,
        label,
      })
      setCtxMenu({
        show: true,
        x: ev.clientX,
        y: ev.clientY,
        seriesIdx,
        label: typeof label === 'string' ? label : undefined,
      })
    }

    // capture: true to ensure we see the event before internal handlers
    host.addEventListener('contextmenu', onContextMenu, true)

    // Extra diagnostics: observe right-button mouseup/auxclicks
    /** @param {MouseEvent} ev */
    const onMouseUp = (ev) => {
      if (ev.button !== 2) return
      const path = ev.composedPath?.() || []
      const row = /** @type {HTMLTableRowElement | undefined} */ (
        path.find(
          (n) => n && n instanceof HTMLTableRowElement && n.tagName === 'TR'
        )
      )
      const table = row?.closest?.('table')
      let seriesIdx = -1
      if (row && table) {
        const tbody = table.querySelector('tbody') || table
        const rows = Array.from(tbody.querySelectorAll('tr'))
        seriesIdx = rows.indexOf(row)
      }

      console.log('[plotter] mouseup(button=2) on legend?', {
        seriesIdx,
        rowFound: !!row,
      })
    }
    /** @param {MouseEvent} ev */
    const onAuxClick = (ev) => {
      if (ev.button !== 1 && ev.button !== 2) return

      console.log('[plotter] auxclick', {
        button: ev.button,
        target: ev.target,
      })
    }
    host.addEventListener('mouseup', onMouseUp, true)
    host.addEventListener('auxclick', onAuxClick, true)

    return () => {
      host.removeEventListener('contextmenu', onContextMenu, true)
      host.removeEventListener('mouseup', onMouseUp, true)
      host.removeEventListener('auxclick', onAuxClick, true)
    }
  }, [legendHostRef])

  // Auto-close context menu on any document click after opening
  useEffect(() => {
    if (!ctxMenu.show) return
    const onAnyClick = () => setCtxMenu((s) => ({ ...s, show: false }))
    document.addEventListener('click', onAnyClick, { once: true })
    return () => document.removeEventListener('click', onAnyClick)
  }, [ctxMenu.show])

  // Focus & select rename input (inner input of vscode-textfield) when shown
  useLayoutEffect(() => {
    if (!rename.show) return
    try {
      const el = renameInputRef.current
      // Web Component exposes `wrappedElement` which is the native <input>
      // @ts-ignore
      const inner =
        el?.wrappedElement || el?.shadowRoot?.querySelector?.('input')
      if (inner) {
        inner.focus()
        inner.select?.()
      } else {
        el?.focus?.()
      }
    } catch {}
  }, [rename.show])

  // Close rename overlay on outside click
  useEffect(() => {
    if (!rename.show) return
    const onDocClick = (ev) => {
      const path = ev.composedPath?.() || []
      const inside = path.includes(renameOverlayRef.current)
      if (!inside) {
        setRename((s) => ({ ...s, show: false }))
      }
    }
    document.addEventListener('click', onDocClick, true)
    return () => document.removeEventListener('click', onDocClick, true)
  }, [rename.show])

  // Keep rename overlay within viewport
  useLayoutEffect(() => {
    if (!rename.show) return
    const el = renameOverlayRef.current
    if (!el) return
    const measureAndAdjust = () => {
      try {
        const rect = el.getBoundingClientRect()
        const pad = 6
        const vw = window.innerWidth
        const vh = window.innerHeight
        let nx = rename.x
        let ny = rename.y
        if (nx + rect.width > vw - pad) {
          nx = Math.max(pad, vw - rect.width - pad)
        }
        if (ny + rect.height > vh - pad) {
          ny = Math.max(pad, vh - rect.height - pad)
        }
        if (nx !== rename.x || ny !== rename.y) {
          setRename((s) => ({ ...s, x: nx, y: ny }))
        }
      } catch {}
    }
    try {
      requestAnimationFrame(measureAndAdjust)
    } catch {
      measureAndAdjust()
    }
  }, [rename.show, rename.x, rename.y])

  function commitRename(nextRaw) {
    const next = (typeof nextRaw === 'string' ? nextRaw : rename.value).trim()
    const idx = rename.seriesIdx
    if (!next) {
      setRename((s) => ({ ...s, show: false }))
      return
    }
    try {
      const u = plotRef.current
      if (u && u.series && u.series[idx]) {
        u.series[idx].label = next
      }
    } catch {}
    try {
      const host = legendHostRef.current
      if (host) {
        const rows = host.querySelectorAll('tbody tr')
        const row = rows?.[idx]
        const labelEl = row?.querySelector?.('.u-label')
        if (labelEl) labelEl.textContent = next
      }
    } catch {}

    console.log('hallo', { index: idx, name: next })
    setRename((s) => ({ ...s, show: false }))
  }

  // After opening, keep the menu within viewport bounds
  useLayoutEffect(() => {
    if (!ctxMenu.show) return
    const el = ctxMenuRef.current
    if (!el) return
    const measureAndAdjust = () => {
      try {
        const rect = el.getBoundingClientRect()
        const pad = 6
        const vw = window.innerWidth
        const vh = window.innerHeight
        let nx = ctxMenu.x
        let ny = ctxMenu.y
        if (nx + rect.width > vw - pad) {
          nx = Math.max(pad, vw - rect.width - pad)
        }
        if (ny + rect.height > vh - pad) {
          ny = Math.max(pad, vh - rect.height - pad)
        }
        if (nx !== ctxMenu.x || ny !== ctxMenu.y) {
          console.log('[plotter] reposition context menu', {
            from: { x: ctxMenu.x, y: ctxMenu.y },
            to: { x: nx, y: ny },
            size: { w: rect.width, h: rect.height },
          })
          setCtxMenu((s) => ({ ...s, x: nx, y: ny }))
        }
      } catch {}
    }
    // Ensure shadow DOM is rendered before measuring
    try {
      requestAnimationFrame(measureAndAdjust)
    } catch {
      measureAndAdjust()
    }
  }, [ctxMenu.show, ctxMenu.x, ctxMenu.y])

  // Reflect autoscale changes on Y only
  useEffect(() => {
    const u = plotRef.current
    if (!u) return
    setIsAutoscale(!!autoscale)
    if (autoscale) {
      u.setScale('y', { min: null, max: null })
    } else {
      // If we have a remembered manual Y range, apply it; otherwise derive from data and persist it
      if (
        yManualRef.current &&
        Number.isFinite(yManualRef.current.min) &&
        Number.isFinite(yManualRef.current.max)
      ) {
        u.setScale('y', {
          min: yManualRef.current.min,
          max: yManualRef.current.max,
        })
      } else {
        let min = Infinity
        let max = -Infinity
        for (const arr of yBufsRef.current) {
          for (const v of arr) {
            if (v == null) continue
            if (v < min) min = v
            if (v > max) max = v
          }
        }
        if (!Number.isFinite(min) || !Number.isFinite(max)) {
          min = -1
          max = 1
        }
        yManualRef.current = { min, max }
        u.setScale('y', { min, max })
      }
    }
  }, [autoscale])

  // multi-series append: columns = [x[], y1[], y2[], ...]
  function appendColumns(columns) {
    if (!columns || columns.length === 0) return
    if (pausedRef.current) return
    const xIn = /** @type {number[]} */ (columns[0] || [])
    const yIns = columns.slice(1)
    try {
      console.log('[plotter] appendColumns', {
        rows: xIn.length,
        cols: columns.length,
        paused: pausedRef.current,
        bufLens: {
          x: xBufRef.current.length,
          ys: yBufsRef.current.map((a) => a.length),
        },
      })
    } catch {}

    // ensure series buffers
    const ensure = (n) => {
      const yBufs = yBufsRef.current
      const u = plotRef.current
      while (yBufs.length < n) {
        const arr = new Array(xBufRef.current.length)
        for (let i = 0; i < arr.length; i++) arr[i] = null
        yBufs.push(arr)
        if (u) {
          const idx = yBufs.length
          try {
            u.addSeries({
              label: 'y' + String(idx),
              width: strokeWidth,
              stroke: () => colorForSeries(idx - 1),
              fill: () => withAlpha(colorForSeries(idx - 1), 0.12),
            })
          } catch {}
        }
      }
    }
    ensure(yIns.length)

    const xBuf = xBufRef.current
    const yBufs = yBufsRef.current
    for (let i = 0; i < xIn.length; i++) {
      xBuf.push(xIn[i])
      for (let s = 0; s < yBufs.length; s++) {
        const col = /** @type {(number | null | undefined)[]} */ (yIns[s] || [])
        const v = col[i]
        yBufs[s].push(v == null ? null : v)
      }
    }

    const over = xBuf.length - maxPoints
    if (over > 0) {
      xBuf.splice(0, over)
      for (let s = 0; s < yBufs.length; s++) yBufs[s].splice(0, over)
    }

    try {
      // keep sizing healthy in case visibility/layout changed
      // ensureSize()
      const u = plotRef.current
      const data = [xBuf].concat(yBufs)
      u && u.setData && u.setData(data, isAutoscale)
      try {
        console.log('[plotter] setData', {
          rows: xBuf.length,
          series: yBufs.length + 1,
          autoscale: isAutoscale,
        })
      } catch {}
      if (u && hasFixedX) {
        const lastX = xBuf.length ? xBuf[xBuf.length - 1] : 0
        const min = lastX >= xWindow ? lastX - xWindow : 0
        const max = lastX >= xWindow ? lastX : xWindow
        u.setScale('x', { min, max })
        try {
          console.log('[plotter] setScale x', { min, max, lastX })
        } catch {}
      }
    } catch {}
  }

  function clear() {
    try {
      console.log('[plotter] clear')
    } catch {}
    xBufRef.current = []
    yBufsRef.current = yBufsRef.current.map(() => [])
    try {
      const u = plotRef.current
      const data = [[], ...yBufsRef.current]
      // @ts-ignore
      u?.setData(data, true)
      if (u && hasFixedX) {
        u.setScale('x', { min: 0, max: xWindow })
      }
    } catch {}
  }

  function pause() {
    pausedRef.current = true
    try {
      console.log('[plotter] pause')
    } catch {}
  }
  function resume() {
    pausedRef.current = false
    try {
      console.log('[plotter] resume')
    } catch {}
  }

  function setAutoscale(next) {
    const u = plotRef.current
    setIsAutoscale(!!next)
    try {
      console.log('[plotter] setAutoscale', { next })
    } catch {}
    if (!u) return
    if (next) {
      u.setScale('y', { min: null, max: null })
      u.setData([xBufRef.current].concat(yBufsRef.current), true)
    } else {
      let min = Infinity
      let max = -Infinity
      for (const arr of yBufsRef.current) {
        for (const v of arr) {
          if (v == null) continue
          if (v < min) min = v
          if (v > max) max = v
        }
      }
      if (!Number.isFinite(min) || !Number.isFinite(max)) {
        min = -1
        max = 1
      }
      u.setScale('y', { min, max })
    }
  }

  function refresh() {
    try {
      ensureSize()
      const u = plotRef.current
      if (!u) return
      // Ensure uPlot series visibility matches user toggles
      try {
        const count =
          1 + (Array.isArray(yBufsRef.current) ? yBufsRef.current.length : 0)
        ensureSeriesCount(count)
      } catch {}

      const data = [xBufRef.current].concat(yBufsRef.current)
      u.setData?.(data, isAutoscale)

      console.log('[plotter] refresh -> setData', {
        rows: xBufRef.current.length,
        series: yBufsRef.current.length + 1,
      })
    } catch {}
  }

  function setSize(width, height) {
    try {
      const u = plotRef.current
      if (!u) return
      const w = Math.max(100, Math.floor(width || 0))
      const h = Math.max(100, Math.floor(height || 0))
      if (u.width !== w || u.height !== h) {
        u.setSize({ width: w, height: h })
      }
      lastSizeRef.current = { w, h }

      console.log('[plotter] setSize (external)', { w, h })
    } catch {}
  }

  function getSize() {
    try {
      const u = plotRef.current
      if (u) return { w: u.width, h: u.height }
    } catch {}
    return { w: lastSizeRef.current.w, h: lastSizeRef.current.h }
  }

  function resetVisibility() {
    try {
      hiddenSeriesRef.current.clear()
      const u = plotRef.current
      if (u) {
        withSeriesUpdateMuted(() => {
          for (let i = 1; i < (u.series?.length || 0); i++) {
            try {
              u.setSeries?.(i, { show: true }, true)
            } catch {}
          }
        })
      }
    } catch {}
  }

  /**
   * Reset plot state. When `full` is true (default), we hard re-mount uPlot to
   * guarantee a pristine instance (series list, labels, legend DOM, hooks).
   * When `full` is false, we keep the current instance but clear data, scales,
   * and show all series.
   *
   * @param {{ full?: boolean }} [opts]
   */
  function resetPlot(opts) {
    const full = !opts || opts.full !== false

    // Clear client-side caches/buffers
    hiddenSeriesRef.current.clear()
    lastXScaleRef.current = null
    xBufRef.current = []
    yBufsRef.current = []

    try {
      const u = plotRef.current
      if (!u || full) {
        // Hard reset: drop current uPlot instance by changing key
        setUplotKey((k) => k + 1)
        // Legend host will be cleared by onDelete handler during unmount
        return
      }

      // Soft reset on the existing instance: clear data & restore defaults
      const data = [[], ...yBufsRef.current]
      try {
        u.setData?.(data, true)
      } catch {}

      // Reset X scale window if fixed
      if (hasFixedX) {
        try {
          u.setScale('x', { min: 0, max: xWindow })
        } catch {}
      }

      // Show all series again (1..n)
      try {
        withSeriesUpdateMuted(() => {
          for (let i = 1; i < (u.series?.length || 0); i++) {
            u.setSeries?.(i, { show: true }, true)
          }
        })
      } catch {}

      // Reset Y autoscale explicitly
      try {
        u.setScale('y', { min: null, max: null })
      } catch {}
    } catch {}
  }

  // Reset Y scale to autoscale, discard manual state
  const resetYScale = useCallback(() => {
    try {
      yManualRef.current = null
      setIsAutoscale(true)
      const u = plotRef.current
      if (u) {
        u.setScale('y', { min: null, max: null })
      }
    } catch {}
  }, [])

  // Remember last applied X scale to allow freezing after stop
  const lastXScaleRef = useRef(
    /** @type {{ min: number; max: number } | null} */ (null)
  )

  // Render full buffers in one call; `ys` is an array of y-columns
  function render(x, ys, opts) {
    try {
      const u = plotRef.current
      if (!u) return
      ensureSize()
      const seriesCount = 1 + (Array.isArray(ys) ? ys.length : 0)
      ensureSeriesCount(seriesCount)
      // Keep local buffers in sync for subsequent operations
      const xArr = Array.isArray(x) ? x.slice(0) : []
      const yArrs = Array.isArray(ys)
        ? ys.map((col) => (Array.isArray(col) ? col.slice(0) : []))
        : []
      // Freeze flags must be computed early; later logic relies on them
      const wantFreeze = !!(opts && opts.freezeX)
      /** @type {{ min: number; max: number } | null} */
      const forcedFreeze =
        opts && opts.freezeXScale && typeof opts.freezeXScale === 'object'
          ? opts.freezeXScale
          : null

      // --- Diagnostics: log input and freeze logic ---
      try {
        console.log('[render] input', {
          rows: xArr.length,
          firstX: xArr[0],
          lastX: xArr[xArr.length - 1],
          wantFreeze: !!(opts && opts.freezeX),
          forcedFreeze: opts && opts.freezeXScale ? opts.freezeXScale : null,
          doAutoscale:
            opts && typeof opts.autoscale === 'boolean'
              ? opts.autoscale
              : isAutoscale,
        })
      } catch {}
      // --- End diagnostics ---

      // Removed fixed-length padding to avoid axis vibration/flicker

      // When freezing with an explicit scale, pre-filter data to that window to
      // avoid any domain nudges from out-of-window points.
      if (
        hasFixedX &&
        wantFreeze &&
        forcedFreeze &&
        Number.isFinite(forcedFreeze.min) &&
        Number.isFinite(forcedFreeze.max)
      ) {
        const xmin = forcedFreeze.min
        const xmax = forcedFreeze.max
        // Estimate step for a small epsilon guard against float rounding
        let step = 1
        if (xArr.length >= 2) {
          const d = xArr[xArr.length - 1] - xArr[xArr.length - 2]
          if (Number.isFinite(d) && d > 0) step = d
        }
        const eps = Math.max(1e-9, step * 0.5)
        // Find inclusive slice bounds [first..last]
        let lo = 0
        let hi = xArr.length - 1
        let first = xArr.length
        while (lo <= hi) {
          const mid = (lo + hi) >> 1
          if (xArr[mid] >= xmin - eps) {
            first = mid
            hi = mid - 1
          } else lo = mid + 1
        }
        lo = 0
        hi = xArr.length - 1
        let last = -1
        while (lo <= hi) {
          const mid = (lo + hi) >> 1
          if (xArr[mid] <= xmax + eps) {
            last = mid
            lo = mid + 1
          } else hi = mid - 1
        }
        if (first === xArr.length) first = Math.max(0, last)
        if (last < first) last = first
        if (first > 0 || last < xArr.length - 1) {
          const nx = xArr.slice(first, last + 1)
          const nys = yArrs.map((col) => col.slice(first, last + 1))
          xBufRef.current = nx
          yBufsRef.current = nys
        } else {
          xBufRef.current = xArr
          yBufsRef.current = yArrs
        }
      } else {
        xBufRef.current = xArr
        yBufsRef.current = yArrs
      }

      // Ensure data cols match uPlot series length (uPlot requires data.length === series.length)
      try {
        const uSeriesLen = (u.series && u.series.length) || 1
        const requiredYCols = Math.max(1, uSeriesLen - 1)
        const xLen = xBufRef.current.length
        // If fewer y columns than required, pad with null columns
        while (yBufsRef.current.length < requiredYCols) {
          const pad = new Array(xLen)
          for (let i = 0; i < xLen; i++) pad[i] = null
          yBufsRef.current.push(pad)
        }
        // If more y columns than series, truncate extra columns (we also hide extras elsewhere)
        if (yBufsRef.current.length > requiredYCols) {
          yBufsRef.current.length = requiredYCols
        }
      } catch {}

      const data = [xBufRef.current].concat(yBufsRef.current)
      const doAutoscale =
        opts && typeof opts.autoscale === 'boolean'
          ? opts.autoscale
          : isAutoscale

      // --- Robust X-freeze logic: snapshot current X scale if needed ---
      // Always snapshot current live X scale when we are asked to freeze.
      let snapX = null
      if (hasFixedX && wantFreeze) {
        try {
          if (
            forcedFreeze &&
            Number.isFinite(forcedFreeze.min) &&
            Number.isFinite(forcedFreeze.max)
          ) {
            lastXScaleRef.current = {
              min: forcedFreeze.min,
              max: forcedFreeze.max,
            }
          } else {
            snapX = u.scales['x']
            if (
              snapX &&
              Number.isFinite(snapX.min) &&
              Number.isFinite(snapX.max)
            ) {
              lastXScaleRef.current = { min: snapX.min, max: snapX.max }
            }
          }
        } catch {}
      }
      // --- End X-freeze pre-snapshot ---

      // --- Diagnostics: pre-setData x-scale ---
      try {
        const pre = u.scales?.['x']
        console.log('[render] pre-setData x-scale', pre)
      } catch {}
      // --- End diagnostics ---

      // If caller provided an explicit freezeXScale, pre-apply it before setData
      if (
        hasFixedX &&
        wantFreeze &&
        forcedFreeze &&
        Number.isFinite(forcedFreeze.min) &&
        Number.isFinite(forcedFreeze.max)
      ) {
        try {
          u.setScale('x', { min: forcedFreeze.min, max: forcedFreeze.max })
        } catch {}
      }

      u.setData?.(data, doAutoscale)

      // Defensive: if data column count does not match uPlot series, reapply with padded columns
      try {
        const uSeriesLen2 = (u.series && u.series.length) || 1
        const dataLen = data.length
        if (dataLen !== uSeriesLen2) {
          // Rebuild with padded null columns to satisfy uPlot invariants
          const xLen = xBufRef.current.length
          const needY = Math.max(1, uSeriesLen2 - 1)
          const ysFixed = []
          for (let i = 0; i < needY; i++) {
            ysFixed[i] = yBufsRef.current[i] || new Array(xLen).fill(null)
          }
          u.setData?.([xBufRef.current].concat(ysFixed), doAutoscale)
        }
      } catch {}

      // Ensure manual Y scale is applied when autoscale is off
      if (!doAutoscale && yManualRef.current) {
        const { min, max } = yManualRef.current
        if (Number.isFinite(min) && Number.isFinite(max)) {
          try {
            u.setScale('y', { min, max })
          } catch {}
        }
      }

      // --- Diagnostics: post-setData x-scale ---
      try {
        const mid = u.scales?.['x']
        console.log('[render] post-setData x-scale', mid)
      } catch {}
      // --- End diagnostics ---

      // Robust X-freeze/restore logic after setData
      const freezeX = !!(opts && opts.freezeX)
      if (hasFixedX) {
        if (freezeX) {
          // Apply the remembered (or just snapshotted) X window exactly
          const last = lastXScaleRef.current
          if (last && Number.isFinite(last.min) && Number.isFinite(last.max)) {
            try {
              u.setScale('x', last)
            } catch {}
            // --- Diagnostics: after setScale(x) for freezeX ---
            try {
              const fin = u.scales?.['x']
              console.log('[render] applied freezeX -> setScale(x)', fin)
            } catch {}
            // --- End diagnostics ---
          } else {
            // Fallback: snapshot now and apply immediately
            try {
              const cur = u.scales['x']
              if (cur && Number.isFinite(cur.min) && Number.isFinite(cur.max)) {
                lastXScaleRef.current = { min: cur.min, max: cur.max }
                u.setScale('x', lastXScaleRef.current)
                // --- Diagnostics: after setScale(x) fallback ---
                try {
                  const fin = u.scales?.['x']
                  console.log('[render] applied freezeX -> setScale(x)', fin)
                } catch {}
                // --- End diagnostics ---
              }
            } catch {}
          }
        } else {
          // Live streaming: compute the sliding window and remember it
          const lastX = xBufRef.current.length
            ? xBufRef.current[xBufRef.current.length - 1]
            : 0
          const min = lastX >= xWindow ? lastX - xWindow : 0
          const max = lastX >= xWindow ? lastX : xWindow
          try {
            u.setScale('x', { min, max })
          } catch {}
          lastXScaleRef.current = { min, max }
          // --- Diagnostics: after setScale(x) live window ---
          try {
            console.log('[render] live window setScale(x)', { min, max, lastX })
          } catch {}
          // --- End diagnostics ---
        }
      }

      console.log('[plotter] render(setData)', {
        rows: xBufRef.current.length,
        series: yBufsRef.current.length + 1,
      })
    } catch {}
  }

  useImperativeHandle(ref, () => ({
    appendColumns,
    render,
    clear,
    pause,
    resume,
    setAutoscale,
    refresh,
    ensureSize,
    setSize,
    getSize,
    resetVisibility,
    resetPlot,
    resetYScale,
    // Expose raw uPlot instance for diagnostics
    get uplot() {
      return plotRef.current
    },
  }))

  // Build dynamic context menu items for current legend row
  const menuItems = (() => {
    if (!ctxMenu.show) {
      return [{ label: 'Rename label', value: 'rename', tabindex: 0 }]
    }
    const u = plotRef.current
    const idx = ctxMenu.seriesIdx
    const s = u?.series?.[idx]
    const baseLabel =
      typeof s?.label === 'string'
        ? s.label
        : typeof ctxMenu.label === 'string'
          ? ctxMenu.label
          : `s${idx}`
    const items = [{ label: 'Rename label', value: 'rename', tabindex: 0 }]
    if (idx > 0 && s) {
      const forcedHidden = hiddenSeriesRef.current.has(idx)
      const isShown = s.show !== false && !forcedHidden
      items.push({
        label: `${isShown ? 'Hide' : 'Show'} ${baseLabel}`,
        value: 'toggle',
        tabindex: 0,
      })
    }
    return items
  })()

  return (
    <VscodeSplitLayout
      ref={containerRef}
      split="vertical"
      style={{ width: '100%', height: '100%', minHeight: 0 }}
      fixedPane="end"
      initialHandlePosition="85%"
      resetOnDblClick
    >
      <div
        slot="start"
        ref={plotPaneRef}
        style={{ width: '100%', height: '100%', minHeight: 0 }}
      >
        {themeReady && (
          <UplotReact
            key={uplotKey}
            options={opts}
            data={[xBufRef.current].concat(yBufsRef.current)}
            onCreate={(u) => {
              plotRef.current = u
              try {
                console.log('[plotter] onCreate', {
                  width: u.width,
                  height: u.height,
                  seriesCount: u.series?.length,
                })
              } catch {}
              try {
                onReady?.(u)
              } catch {}
              // Move legend into external host once both panes are mounted
              try {
                const host = legendHostRef.current
                const legendEl = u.root?.querySelector?.('.u-legend')
                if (host && legendEl && legendEl instanceof HTMLElement) {
                  console.log(
                    '[plotter] moving uPlot legend into external host'
                  )
                  while (host.firstChild) host.removeChild(host.firstChild)
                  host.appendChild(legendEl)
                }
              } catch {}
              // attach theme sync for series colors
              try {
                themeRef.current?.dispose?.()
                themeRef.current = attachUplotTheme(u, { useAnsiColors })
              } catch {}
              const measureAndSet = () => {
                const rect = plotPaneRef.current?.getBoundingClientRect()
                if (!rect) return
                const w = Math.max(100, Math.floor(rect.width))
                const h = Math.max(100, Math.floor(rect.height))
                lastSizeRef.current = { w, h }
                try {
                  if (u.width !== w || u.height !== h) {
                    u.setSize({ width: w, height: h })
                  }
                } catch {}
              }
              measureAndSet()
              try {
                requestAnimationFrame(measureAndSet)
              } catch {}
              // Attach draggable Y-axis (hold Shift to expand/contract around min)
              try {
                const root = /** @type {HTMLElement} */ (u.root)
                const axes = u.root?.querySelectorAll?.('.u-axis') || []
                // Typical layout: axes[0] is bottom X, axes[1] is left Y
                const yAxis = /** @type {HTMLElement | null} */ (
                  axes[1] || null
                )
                if (yAxis) {
                  const onDown = (e) => {
                    // Only left button
                    if (e.button !== 0) return
                    root.classList.add('uplot-dragging-axis')
                    const startY = e.clientY
                    const s = u.scales?.['y'] || { min: 0, max: 1 }
                    let { min, max } = s
                    if (!Number.isFinite(min) || !Number.isFinite(max)) {
                      min = 0
                      max = 1
                    }
                    // Units per physical pixel (approx using devicePixelRatio)
                    const dpr = (window && window.devicePixelRatio) || 1
                    const unitsPerPx = (max - min) / (u.bbox.height / dpr || 1)

                    const onMove = (ev) => {
                      const dy = ev.clientY - startY
                      const delta = dy * unitsPerPx
                      const next = ev.shiftKey
                        ? { min: min - delta, max: max + delta } // grow/contract symmetrically when Shift
                        : { min: min + delta, max: max + delta } // pan otherwise
                      try {
                        u.setScale('y', next)
                        yManualRef.current = { ...next }
                        // Turn off autoscale while user is manually scaling
                        setIsAutoscale(false)
                      } catch {}
                    }
                    const onUp = () => {
                      root.classList.remove('uplot-dragging-axis')
                      document.removeEventListener('mousemove', onMove)
                      document.removeEventListener('mouseup', onUp)
                    }
                    document.addEventListener('mousemove', onMove)
                    document.addEventListener('mouseup', onUp)
                  }

                  yAxis.addEventListener('mousedown', onDown)
                  yAxisListenerRef.current = { el: yAxis, onDown }
                  // Toggle a CSS class while Shift is held (for cursor styling)
                  const onKeyDown = (e) => {
                    if (e.key === 'Shift') root.classList.add('uplot-shift')
                  }
                  const onKeyUp = (e) => {
                    if (e.key === 'Shift') root.classList.remove('uplot-shift')
                  }
                  window.addEventListener('keydown', onKeyDown)
                  window.addEventListener('keyup', onKeyUp)
                  cursorHelpersRef.current = { root, onKeyDown, onKeyUp }
                }
              } catch {}
            }}
            onDelete={() => {
              try {
                console.log('[plotter] onDelete')
              } catch {}
              try {
                const l = yAxisListenerRef.current
                if (l && l.el) l.el.removeEventListener('mousedown', l.onDown)
                yAxisListenerRef.current = null
              } catch {}
              try {
                const ch = cursorHelpersRef.current
                if (ch) {
                  window.removeEventListener('keydown', ch.onKeyDown)
                  window.removeEventListener('keyup', ch.onKeyUp)
                  ch.root?.classList?.remove('uplot-shift')
                  ch.root?.classList?.remove('uplot-dragging-axis')
                }
                cursorHelpersRef.current = null
              } catch {}
              plotRef.current = null
              try {
                themeRef.current?.dispose?.()
              } catch {}
              try {
                const host = legendHostRef.current
                if (host) host.innerHTML = ''
              } catch {}
            }}
          />
        )}
      </div>
      <div slot="end" ref={legendHostRef} className="plot-legend-host" />
      {ctxMenu.show && (
        <VscodeContextMenu
          ref={ctxMenuRef}
          slot="end"
          style={{
            position: 'fixed',
            left: `${ctxMenu.x}px`,
            top: `${ctxMenu.y}px`,
            zIndex: 1000,
            width: 'max-content',
            height: 'auto',
          }}
          show={ctxMenu.show}
          data={menuItems}
          onVscContextMenuSelect={(e) => {
            const detail = /** @type {{ detail?: any }} */ (e).detail || {}
            const value = detail?.value

            console.log('[plotter] context menu select', detail)
            if (value === 'rename') {
              const u = plotRef.current
              const idx = ctxMenu.seriesIdx
              const current = u?.series?.[idx]?.label
              const currentLabel =
                typeof current === 'string'
                  ? current
                  : typeof ctxMenu.label === 'string'
                    ? ctxMenu.label
                    : `s${idx}`
              // Anchor to the legend label element if possible
              let x = ctxMenu.x
              let y = ctxMenu.y
              try {
                const host = legendHostRef.current
                if (host) {
                  const rows = host.querySelectorAll('tbody tr')
                  const row = rows?.[idx]
                  const labelEl = row?.querySelector?.('.u-label') || row
                  const rect = labelEl?.getBoundingClientRect?.()
                  if (rect) {
                    x = rect.left
                    y = rect.top
                  }
                }
              } catch {}
              setRename({
                show: true,
                x,
                y,
                seriesIdx: idx,
                value: currentLabel,
              })
              queueFocusRenameInput()
            } else if (value === 'toggle') {
              try {
                const u = plotRef.current
                const idx = ctxMenu.seriesIdx
                if (u && idx > 0) {
                  const currentlyShown =
                    !hiddenSeriesRef.current.has(idx) &&
                    u.series?.[idx]?.show !== false
                  const nextShow = !currentlyShown
                  if (nextShow) hiddenSeriesRef.current.delete(idx)
                  else hiddenSeriesRef.current.add(idx)
                  u.setSeries?.(idx, { show: nextShow }, true)
                  // Immediate redraw so the change is visible now
                  try {
                    refresh()
                  } catch {}
                }
              } catch {}
            }
            setCtxMenu((s) => ({ ...s, show: false }))
          }}
        />
      )}

      {rename.show && (
        <div
          ref={renameOverlayRef}
          slot="end"
          style={{
            position: 'fixed',
            left: `${rename.x}px`,
            top: `${rename.y}px`,
            zIndex: 2000,
            width: 'max-content',
            height: 'auto',
            background: 'var(--vscode-editorWidget-background, #1f1f1f)',
            border: '1px solid var(--vscode-editorWidget-border, #454545)',
            padding: '6px',
            borderRadius: '5px',
            boxShadow:
              '0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,0.36))',
          }}
        >
          <VscodeTextfield
            ref={renameInputRef}
            value={rename.value}
            autofocus
            onInput={(e) => {
              // @ts-ignore value exists
              const v = e.target?.value ?? ''
              setRename((s) => ({ ...s, value: String(v) }))
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                setRename((s) => ({ ...s, show: false }))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                commitRename()
              }
            }}
            style={{ minWidth: '180px' }}
            placeholder="Rename label"
          />
        </div>
      )}
    </VscodeSplitLayout>
  )
})

export default MonitorPlotter
