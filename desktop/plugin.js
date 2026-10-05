/**
 * echarts-in-chat — inline interactive charts in the Hermes Desktop transcript.
 *
 * WHAT IT DOES
 *   Renders a chart *inside an assistant message*. The only Desktop SDK surface
 *   that puts plugin content in the message stream is TRANSCRIPT_DIRECTIVE_AREA:
 *   a plugin registers a named directive and the model addresses it with a
 *   paragraph of the form `::echarts{...}`. The host parses that paragraph and
 *   mounts this plugin's component in its place. Nothing here touches the app's
 *   markup, stores, or script environment.
 *
 * REWRITE NOTES (v2 — why this is not the v1 design)
 *   v1 scanned the transcript with a `document.body` MutationObserver and
 *   swapped matching `<pre>` blocks, then loaded ECharts from a CDN with a
 *   script tag. Hermes catalog admission rule 8 refuses both moves, and the
 *   Desktop runtime loader only resolves `@hermes/plugin-sdk` / `react*`, so a
 *   plugin cannot import a chart library either. This build therefore renders
 *   the chart itself as an inline SVG React component and never injects
 *   anything. See README for the full rationale and the feature mapping.
 *
 * DIRECTIVE GRAMMAR (attributes are untrusted strings; `{`/`}` are not allowed
 * inside the body by the host parser, so a raw JSON option cannot be passed —
 * the data is passed as plain attribute lists):
 *
 *   ::echarts{labels="Mon,Tue,Wed" values="120,200,150" type="bar" title="Sales"}
 *   ::echarts{labels="Mon,Tue,Wed" series="Sales:bar:120,200,150;Cost:line:80,90,70"}
 *   ::echarts{labels="A,B,C" values="3,5,2" type="pie" height="420" zoom="false"}
 *
 *   labels  comma-separated category names (x axis, or pie slice names)
 *   values  comma-separated numbers (single series)
 *   series  `name:type:v1,v2,...` entries separated by `;` (multi series)
 *   type    default series type for entries without one: bar | line | pie
 *   name    single-series name (used with `values`)
 *   title   optional chart title
 *   height  optional pixel height, clamped 280–560 (default 400)
 *   zoom    "true"/"false" — show the dataZoom slider (default: on when > 10 categories)
 *
 * IMPORTS: only `@hermes/plugin-sdk`, `react` and `react/jsx-runtime`, which is
 * exactly what the runtime loader allows. No timers, no document observers, no
 * script tags, no app-internal markup queries.
 */

import { TRANSCRIPT_DIRECTIVE_AREA } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useMemo, useRef, useState } from 'react'

const MIN_H = 280
const MAX_H = 560
const DEFAULT_H = 400
/** Keep at least this many categories in the zoom window (clamped to the data). */
const MIN_SPAN = 2

// The theme's own categorical tokens, so the chart reskins with every theme and
// no colour is ever hardcoded.
const COLORS = [
  'var(--ui-accent)',
  'var(--ui-blue, #4f8cff)',
  'var(--ui-green, #39c07b)',
  'var(--ui-orange, #ff8a4f)',
  'var(--ui-purple, #c86bff)',
  'var(--ui-cyan, #4fd1d1)',
  'var(--ui-red, #ff6b6b)',
  'var(--ui-yellow, #ffcf4f)'
]

const colorAt = index => COLORS[((index % COLORS.length) + COLORS.length) % COLORS.length]
const clamp = (value, low, high) => Math.min(high, Math.max(low, value))
const truncate = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text)

const toNumber = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const normalizeType = value => {
  const type = String(value == null ? '' : value).trim().toLowerCase()
  return type === 'line' || type === 'pie' ? type : 'bar'
}

function parseNumberList(raw) {
  return String(raw == null ? '' : raw)
    .split(',')
    .map(part => Number(part.trim()))
    .filter(parsed => Number.isFinite(parsed))
}

/**
 * Turn the directive attributes into a chart spec. Pure and synchronous.
 * Returns `{ invalid: true }` when there is nothing usable to draw.
 */
function parseChartSpec(attrs) {
  const a = attrs || {}
  const labels = String(a.labels == null ? '' : a.labels)
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
  const defaultType = normalizeType(a.type)
  const series = []

  if (a.series) {
    for (const entry of String(a.series).split(';')) {
      const parts = entry.trim().split(':')
      if (parts.length < 2) continue
      const name = parts[0].trim() || 'Series ' + (series.length + 1)
      const type = parts.length >= 3 ? normalizeType(parts[1]) : defaultType
      const body = parts.length >= 3 ? parts.slice(2).join(':') : parts[1]
      const data = parseNumberList(body)
      if (data.length) series.push({ name, type, data })
    }
  } else if (a.values) {
    const data = parseNumberList(a.values)
    if (data.length) {
      series.push({ name: String(a.name == null || a.name === '' ? 'Value' : a.name), type: defaultType, data })
    }
  }

  if (!series.length) return { invalid: true, key: 'invalid' }

  const count = Math.max(labels.length, ...series.map(s => s.data.length))
  const categories = []
  for (let i = 0; i < count; i += 1) categories.push(labels[i] != null ? labels[i] : String(i + 1))

  const height = clamp(toNumber(a.height, DEFAULT_H), MIN_H, MAX_H)
  const kind = defaultType === 'pie' || series.some(s => s.type === 'pie') ? 'pie' : 'xy'

  const zoomAttr = String(a.zoom == null ? '' : a.zoom).trim().toLowerCase()
  const zoom = zoomAttr === 'true' ? true : zoomAttr === 'false' ? false : count > 10

  const key = [
    kind,
    categories.join(','),
    series.map(s => s.name + '/' + s.type + '/' + s.data.join(',')).join(';'),
    height + '/' + zoom
  ].join('|')

  return {
    invalid: false,
    key,
    categories,
    series,
    kind,
    height,
    zoom,
    title: String(a.title == null ? '' : a.title)
  }
}

function formatTick(value) {
  const abs = Math.abs(value)
  if (abs >= 1e9) return (value / 1e9).toFixed(abs >= 1e10 ? 0 : 1) + 'B'
  if (abs >= 1e6) return (value / 1e6).toFixed(abs >= 1e7 ? 0 : 1) + 'M'
  if (abs >= 1e3) return (value / 1e3).toFixed(abs >= 1e4 ? 0 : 1) + 'k'
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(abs < 1 ? 2 : 1)
}

/** Donut / pie slice path. Angles in radians, clockwise from 3 o'clock. */
function arcPath(cx, cy, radius, inner, from, to) {
  const sweep = to - from
  if (sweep >= Math.PI * 2 - 1e-6) {
    return (
      'M' + (cx - radius) + ' ' + cy +
      ' A' + radius + ' ' + radius + ' 0 1 1 ' + (cx + radius) + ' ' + cy +
      ' A' + radius + ' ' + radius + ' 0 1 1 ' + (cx - radius) + ' ' + cy +
      (inner > 0
        ? ' M' + (cx - inner) + ' ' + cy +
          ' A' + inner + ' ' + inner + ' 0 1 0 ' + (cx + inner) + ' ' + cy +
          ' A' + inner + ' ' + inner + ' 0 1 0 ' + (cx - inner) + ' ' + cy
        : '') +
      ' Z'
    )
  }
  const large = sweep > Math.PI ? 1 : 0
  const x0 = cx + radius * Math.cos(from)
  const y0 = cy + radius * Math.sin(from)
  const x1 = cx + radius * Math.cos(to)
  const y1 = cy + radius * Math.sin(to)
  if (inner <= 0) {
    return 'M' + cx + ' ' + cy + ' L' + x0 + ' ' + y0 +
      ' A' + radius + ' ' + radius + ' 0 ' + large + ' 1 ' + x1 + ' ' + y1 + ' Z'
  }
  const ix1 = cx + inner * Math.cos(to)
  const iy1 = cy + inner * Math.sin(to)
  const ix0 = cx + inner * Math.cos(from)
  const iy0 = cy + inner * Math.sin(from)
  return (
    'M' + x0 + ' ' + y0 +
    ' A' + radius + ' ' + radius + ' 0 ' + large + ' 1 ' + x1 + ' ' + y1 +
    ' L' + ix1 + ' ' + iy1 +
    ' A' + inner + ' ' + inner + ' 0 ' + large + ' 0 ' + ix0 + ' ' + iy0 +
    ' Z'
  )
}

function ChartWidget({ attrs }) {
  const spec = useMemo(() => parseChartSpec(attrs), [attrs])
  const hostRef = useRef(null)
  const plotRef = useRef(null)
  const dragRef = useRef(null)
  const sliderRef = useRef(null)
  const [width, setWidth] = useState(0)
  const [view, setView] = useState({ start: 0, span: 1 })
  const [hidden, setHidden] = useState({})
  const [hover, setHover] = useState(null)

  const n = spec.invalid ? 0 : spec.categories.length
  const minSpan = Math.min(MIN_SPAN, Math.max(1, n))
  const span = n > 0 ? clamp(view.span, minSpan, n) : 0
  const start = n > 0 ? clamp(view.start, 0, n - span) : 0
  const showZoom = !spec.invalid && spec.kind === 'xy' && spec.zoom && n > minSpan

  // Re-seed the view whenever the addressed data changes.
  useEffect(() => {
    setView({ start: 0, span: Math.max(1, n) })
    setHidden({})
    setHover(null)
  }, [spec.key, n])

  // Width follows the message column. Observing only our own host element.
  useEffect(() => {
    const el = hostRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(entries => {
      const rect = entries[0] && entries[0].contentRect
      if (rect) setWidth(Math.max(0, Math.round(rect.width)))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Wheel zoom over the plot. Native listener so preventDefault actually works.
  useEffect(() => {
    const el = plotRef.current
    if (!el || !showZoom) return undefined
    const onWheel = event => {
      if (!event.deltaY) return
      event.preventDefault()
      const rect = el.getBoundingClientRect()
      const frac = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1)
      const anchor = start + frac * span
      const factor = event.deltaY < 0 ? 0.8 : 1.25
      const nextSpan = clamp(Math.round(span * factor), minSpan, n)
      const nextStart = clamp(Math.round(anchor - frac * nextSpan), 0, n - nextSpan)
      setView({ start: nextStart, span: nextSpan })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [showZoom, start, span, minSpan, n])

  if (spec.invalid) {
    return jsx('div', {
      className: 'rounded-md border px-3 py-2 text-xs',
      style: { borderColor: 'var(--ui-stroke-secondary)', color: 'var(--ui-text-tertiary)' },
      children: 'echarts: give me data — e.g. ::echarts{labels="Mon,Tue" values="1,2"}'
    })
  }

  const toggle = index => setHidden(prev => ({ ...prev, [index]: !prev[index] }))

  const H = spec.height
  const hasTitle = spec.title.length > 0
  const padLeft = 46
  const padRight = 14
  const innerW = Math.max(10, width - padLeft - padRight)

  const legendItems =
    spec.kind === 'pie'
      ? spec.categories.map((label, index) => ({ label, index }))
      : spec.series.map((s, index) => ({ label: s.name, index }))

  // Wrap legend items into rows so `padTop` can reserve exactly the right space.
  const legendRows = []
  {
    let row = []
    let rowW = 0
    for (const item of legendItems) {
      const itemW = 16 + Math.min(item.label.length, 16) * 6.5 + 14
      if (row.length && rowW + itemW > innerW) {
        legendRows.push(row)
        row = []
        rowW = 0
      }
      row.push({ ...item, w: itemW })
      rowW += itemW
    }
    if (row.length) legendRows.push(row)
  }

  const legendStartY = hasTitle ? 36 : 18
  const padTop = legendStartY + Math.max(1, legendRows.length) * 16 + 2
  const padBottom = showZoom ? 48 : 24
  const plotW = Math.max(10, width - padLeft - padRight)
  const plotH = Math.max(10, H - padTop - padBottom)

  const legendChildren = []
  legendRows.forEach((row, r) => {
    let x = padLeft
    for (const item of row) {
      const isHidden = Boolean(hidden[item.index])
      legendChildren.push(
        jsx('g', {
          style: { cursor: 'pointer' },
          onClick: () => toggle(item.index),
          children: [
            jsx('rect', {
              x,
              y: legendStartY + r * 16 - 9,
              width: 10,
              height: 10,
              rx: 2,
              style: { fill: colorAt(item.index), opacity: isHidden ? 0.25 : 1 }
            }),
            jsx('text', {
              x: x + 14,
              y: legendStartY + r * 16,
              style: {
                fill: isHidden ? 'var(--ui-text-quaternary)' : 'var(--ui-text-secondary)',
                fontSize: 11
              },
              children: truncate(item.label, 16)
            })
          ]
        }, 'legend-' + r + '-' + item.index)
      )
      x += item.w
    }
  })

  const plotChildren = []
  if (width > 0 && spec.kind === 'xy') {
    const visible = spec.series.map((s, si) => ({ s, si })).filter(o => o.s.type !== 'pie' && !hidden[o.si])
    const bandW = plotW / Math.max(1, span)
    const xCenter = j => padLeft + (j + 0.5) * bandW

    let lo = 0
    let hi = 0
    let any = false
    for (const o of visible) {
      for (let j = 0; j < span; j += 1) {
        const value = o.s.data[start + j]
        if (!Number.isFinite(value)) continue
        if (!any) {
          lo = value
          hi = value
          any = true
        } else {
          if (value < lo) lo = value
          if (value > hi) hi = value
        }
      }
    }
    if (!any) {
      lo = 0
      hi = 1
    }
    if (lo > 0) lo = 0
    if (hi < 0) hi = 0
    if (hi === lo) hi = lo + 1
    const valuePad = (hi - lo) * 0.08
    const yHi = hi + valuePad
    const yLo = lo - valuePad
    const yOf = value => padTop + ((yHi - value) / (yHi - yLo)) * plotH

    for (let t = 0; t <= 4; t += 1) {
      const tickValue = yHi - ((yHi - yLo) * t) / 4
      const y = padTop + (plotH * t) / 4
      plotChildren.push(
        jsx('line', {
          x1: padLeft,
          x2: padLeft + plotW,
          y1: y,
          y2: y,
          style: { stroke: 'var(--ui-stroke-quaternary, #333)', strokeWidth: 1 }
        }, 'grid-' + t),
        jsx('text', {
          x: padLeft - 6,
          y: y + 3,
          textAnchor: 'end',
          style: { fill: 'var(--ui-text-quaternary)', fontSize: 10 },
          children: formatTick(tickValue)
        }, 'tick-' + t)
      )
    }

    const step = Math.max(1, Math.ceil(span / Math.max(1, Math.floor(plotW / 60))))
    for (let j = 0; j < span; j += step) {
      plotChildren.push(
        jsx('text', {
          x: xCenter(j),
          y: padTop + plotH + 14,
          textAnchor: 'middle',
          style: { fill: 'var(--ui-text-tertiary)', fontSize: 10 },
          children: truncate(String(spec.categories[start + j]), 10)
        }, 'xlabel-' + j)
      )
    }

    const barSeries = visible.filter(o => o.s.type === 'bar')
    const m = Math.max(1, visible.length)
    const barW = (bandW * 0.8) / m
    barSeries.forEach((o, rank) => {
      const offset = (rank - (barSeries.length - 1) / 2) * barW
      for (let j = 0; j < span; j += 1) {
        const value = o.s.data[start + j]
        if (!Number.isFinite(value)) continue
        const yTop = yOf(Math.max(value, 0))
        const yBot = yOf(Math.min(value, 0))
        plotChildren.push(
          jsx('rect', {
            x: xCenter(j) + offset - barW / 2,
            y: yTop,
            width: Math.max(1, barW * 0.92),
            height: Math.max(0.5, yBot - yTop),
            rx: 2,
            style: { fill: colorAt(o.si) }
          }, 'bar-' + o.si + '-' + j)
        )
      }
    })

    for (const o of visible) {
      if (o.s.type !== 'line') continue
      const points = []
      for (let j = 0; j < span; j += 1) {
        const value = o.s.data[start + j]
        if (Number.isFinite(value)) points.push([xCenter(j), yOf(value)])
      }
      if (points.length > 1) {
        plotChildren.push(
          jsx('path', {
            d: points.map((p, i) => (i ? 'L' : 'M') + p[0] + ' ' + p[1]).join(' '),
            fill: 'none',
            strokeLinejoin: 'round',
            strokeLinecap: 'round',
            style: { stroke: colorAt(o.si), strokeWidth: 2 }
          }, 'line-' + o.si)
        )
      }
      points.forEach((p, i) => {
        plotChildren.push(jsx('circle', { cx: p[0], cy: p[1], r: 2.5, style: { fill: colorAt(o.si) } }, 'pt-' + o.si + '-' + i))
      })
    }

    if (visible.length === 0) {
      plotChildren.push(
        jsx('text', {
          x: padLeft + plotW / 2,
          y: padTop + plotH / 2,
          textAnchor: 'middle',
          style: { fill: 'var(--ui-text-quaternary)', fontSize: 11 },
          children: 'All series hidden'
        }, 'empty')
      )
    }

    plotChildren.push(
      jsx('rect', {
        x: padLeft,
        y: padTop,
        width: plotW,
        height: plotH,
        fill: 'transparent',
        style: { cursor: showZoom ? 'grab' : 'default' },
        onPointerDown: event => {
          if (!showZoom) return
          dragRef.current = { x: event.clientX, start }
          if (event.currentTarget.setPointerCapture) event.currentTarget.setPointerCapture(event.pointerId)
        },
        onPointerMove: event => {
          const offsetX = event.nativeEvent.offsetX
          const j = clamp(Math.floor(offsetX / Math.max(1, bandW)), 0, Math.max(0, span - 1))
          setHover({ j, category: String(spec.categories[start + j]) })
          const drag = dragRef.current
          if (drag) {
            const moved = Math.round(((event.clientX - drag.x) / Math.max(1, plotW)) * n)
            const nextStart = clamp(drag.start - moved, 0, n - span)
            if (nextStart !== start) setView({ start: nextStart, span })
          }
        },
        onPointerUp: event => {
          dragRef.current = null
          if (event.currentTarget.releasePointerCapture) event.currentTarget.releasePointerCapture(event.pointerId)
        },
        onPointerLeave: () => {
          dragRef.current = null
          setHover(null)
        }
      }, 'overlay')
    )
  }

  if (width > 0 && spec.kind === 'pie') {
    const values = spec.series[0].data.map((v, i) => ({ label: spec.categories[i], value: Math.max(0, v), index: i }))
    const total = values.reduce((sum, slice) => sum + (hidden[slice.index] ? 0 : slice.value), 0)
    const cx = width / 2
    const cy = padTop + plotH / 2
    const radius = Math.max(10, Math.min(plotW, plotH) / 2 - 8)
    const inner = radius * 0.55
    let angle = -Math.PI / 2
    if (total <= 0) {
      plotChildren.push(
        jsx('text', {
          x: cx,
          y: cy,
          textAnchor: 'middle',
          style: { fill: 'var(--ui-text-quaternary)', fontSize: 11 },
          children: 'No data'
        }, 'pie-empty')
      )
    }
    for (const slice of values) {
      if (hidden[slice.index] || slice.value <= 0) continue
      const sweep = (slice.value / total) * Math.PI * 2
      plotChildren.push(
        jsx('path', {
          d: arcPath(cx, cy, radius, inner, angle, angle + sweep),
          style: { fill: colorAt(slice.index), stroke: 'var(--ui-bg-editor, transparent)', strokeWidth: 1 }
        }, 'slice-' + slice.index)
      )
      angle += sweep
    }
  }

  const sliderChildren = []
  if (showZoom && width > 0) {
    const sliderY = padTop + plotH + 24
    const trackH = 10
    const w0 = padLeft + (start / n) * plotW
    const w1 = padLeft + ((start + span) / n) * plotW
    const beginDrag = mode => event => {
      if (event.currentTarget.setPointerCapture) event.currentTarget.setPointerCapture(event.pointerId)
      sliderRef.current = { mode, x: event.clientX, start, span }
    }
    const moveDrag = event => {
      const drag = sliderRef.current
      if (!drag) return
      const deltaCats = ((event.clientX - drag.x) / Math.max(1, plotW)) * n
      if (drag.mode === 'pan') {
        setView({ start: clamp(Math.round(drag.start + deltaCats), 0, n - span), span })
      } else if (drag.mode === 'left') {
        const nextStart = clamp(Math.round(drag.start + deltaCats), 0, drag.start + drag.span - minSpan)
        setView({ start: nextStart, span: drag.start + drag.span - nextStart })
      } else {
        const nextEnd = clamp(Math.round(drag.start + drag.span + deltaCats), drag.start + minSpan, n)
        setView({ start: drag.start, span: nextEnd - drag.start })
      }
    }
    const endDrag = () => {
      sliderRef.current = null
    }
    const handle = (key, x, cursor, mode) =>
      jsx('rect', {
        x,
        y: sliderY - 3,
        width: 6,
        height: trackH + 6,
        rx: 2,
        style: { fill: 'var(--ui-accent)', cursor },
        onPointerDown: beginDrag(mode),
        onPointerMove: moveDrag,
        onPointerUp: endDrag,
        onPointerLeave: endDrag
      }, key)

    sliderChildren.push(
      jsx('rect', {
        x: padLeft,
        y: sliderY,
        width: plotW,
        height: trackH,
        rx: 3,
        style: { fill: 'var(--ui-stroke-quaternary, #333)' }
      }, 'slider-track'),
      jsx('rect', {
        x: w0,
        y: sliderY,
        width: Math.max(8, w1 - w0),
        height: trackH,
        rx: 3,
        style: { fill: 'var(--ui-accent)', opacity: 0.35, cursor: 'grab' },
        onPointerDown: beginDrag('pan'),
        onPointerMove: moveDrag,
        onPointerUp: endDrag,
        onPointerLeave: endDrag
      }, 'slider-window'),
      handle('slider-left', w0 - 3, 'ew-resize', 'left'),
      handle('slider-right', w1 - 3, 'ew-resize', 'right')
    )
  }

  let tooltip = null
  if (hover && spec.kind === 'xy' && width > 0) {
    const tooltipRows = spec.series
      .map((s, si) => ({ s, si }))
      .filter(o => !hidden[o.si])
      .map(o => {
        const value = o.s.data[start + hover.j]
        return jsx('div', {
          style: { display: 'flex', alignItems: 'center', gap: 4 },
          children: [
            jsx('span', { style: { width: 8, height: 8, borderRadius: 2, background: colorAt(o.si), display: 'inline-block' } }),
            jsx('span', { children: o.s.name + ': ' + (Number.isFinite(value) ? formatTick(value) : '—') })
          ]
        }, 'tooltip-' + o.si)
      })
    tooltip = jsxs('div', {
      style: {
        position: 'absolute',
        left: clamp(padLeft + (hover.j + 0.5) * (plotW / Math.max(1, span)) + 8, 4, Math.max(4, width - 150)),
        top: 4,
        pointerEvents: 'none',
        background: 'var(--ui-bg-elevated, rgba(30,30,34,0.96))',
        color: 'var(--ui-text-primary)',
        border: '1px solid var(--ui-stroke-secondary)',
        borderRadius: 6,
        padding: '4px 8px',
        fontSize: 11,
        whiteSpace: 'nowrap',
        zIndex: 5
      },
      children: [
        jsx('div', { style: { fontWeight: 600, marginBottom: 2 }, children: hover.category }),
        ...tooltipRows
      ]
    })
  }

  const svgChildren = []
  if (hasTitle) {
    svgChildren.push(
      jsx('text', {
        x: padLeft,
        y: 18,
        style: { fill: 'var(--ui-text-primary)', fontSize: 13, fontWeight: 600 },
        children: spec.title
      }, 'chart-title')
    )
  }
  svgChildren.push(...legendChildren, ...plotChildren, ...sliderChildren)

  return jsxs('div', {
    ref: hostRef,
    style: { position: 'relative', width: '100%', height: H + 'px', margin: '8px 0' },
    children: [
      width > 0
        ? jsxs('svg', {
          ref: plotRef,
          width,
          height: H,
          role: 'img',
          'aria-label': (hasTitle ? spec.title : 'chart') + ' (' + spec.kind + ')',
          style: { display: 'block', overflow: 'visible', fontFamily: 'inherit' },
          children: svgChildren
        }, 'chart-svg')
        : null,
      tooltip
    ]
  })
}

function renderDirective(props) {
  return jsx(ChartWidget, { attrs: props.attrs })
}

export default {
  id: 'echarts-in-chat',
  name: 'ECharts in Chat',
  register(ctx) {
    ctx.register({
      id: 'echarts-directive',
      area: TRANSCRIPT_DIRECTIVE_AREA,
      data: {
        name: 'echarts',
        render: renderDirective
      }
    })
  }
}
