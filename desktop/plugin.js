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
 * v2.1 NOTES
 *   - Hover tooltip now draws a crosshair + point highlight and has a keyboard /
 *     touch equivalent (arrow keys, tap, and an aria-live readout).
 *   - Invalid data renders a readable Chinese error block (naming which item does
 *     not line up) instead of a blank area, keeping the raw directive copyable.
 *   - Compact data syntax: `1..12` ranges and whitespace as a separator, on top of
 *     the original comma form. The old labels/values/series spelling still works.
 *
 * DIRECTIVE GRAMMAR (attributes are untrusted strings; `{`/`}` are not allowed
 * inside the body by the host parser, so a raw JSON option cannot be passed —
 * the data is passed as plain attribute lists):
 *
 *   ::echarts{labels="Mon,Tue,Wed" values="120,200,150" type="bar" title="Sales"}
 *   ::echarts{labels="Mon,Tue,Wed" series="Sales:bar:120,200,150;Cost:line:80,90,70"}
 *   ::echarts{labels="A,B,C" values="3,5,2" type="pie" height="420" zoom="false"}
 *   ::echarts{labels="1..12" values="1 4 9 16 25 36 49 64 81 100 121 144"}
 *
 *   labels  category names (x axis, or pie slice names); comma- or space-separated
 *   values  numbers for a single series; comma- or space-separated, `a..b` ranges
 *   series  `name:type:v1,v2,...` entries separated by `;` (multi series)
 *   type    default series type for entries without one: bar | line | pie
 *   name    single-series name (used with `values`)
 *   title   optional chart title
 *   height  optional pixel height, clamped 280–560 (default 400)
 *   zoom    "true"/"false" — show the dataZoom slider (default: on when > 10 categories)
 *
 * IMPORTS: only `@hermes/plugin-sdk`, `react` and `react/jsx-runtime`, which is
 * exactly what the runtime loader allows. No timers, no document observers, no
 * script tags, no app-internal markup queries. The parser below is pure and
 * deliberately kept in this file: a Desktop plugin cannot import a sibling
 * module (a relative specifier fails the loader allowlist), so the test harness
 * loads this file with stubbed imports instead of importing a shared parser.
 */

import * as sdk from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useMemo, useRef, useState } from 'react'

const MIN_H = 280
const MAX_H = 560
const DEFAULT_H = 400
/** Keep at least this many categories in the zoom window (clamped to the data). */
const MIN_SPAN = 2
/** Bounds so a hostile / typo'd directive can't allocate unbounded work. */
const MAX_CATEGORIES = 2000
const MAX_RANGE = 1000
const CHART_TYPES = ['bar', 'line', 'pie']
const TYPE_HELP = 'bar、line、pie'

// The theme's own categorical tokens, so the chart reskins with every theme and
// no colour is ever hardcoded.
const COLORS = [
  'var(--ui-accent)',
  'var(--ui-purple, #c86bff)',
  'var(--ui-green, #39c07b)',
  'var(--ui-orange, #ff8a4f)',
  'var(--ui-cyan, #4fd1d1)',
  'var(--ui-red, #ff6b6b)',
  'var(--ui-yellow, #ffcf4f)',
  'var(--ui-blue, #4f8cff)'
]

const colorAt = index => COLORS[((index % COLORS.length) + COLORS.length) % COLORS.length]
export const clamp = (value, low, high) => Math.min(high, Math.max(low, value))
const truncate = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text)

const toNumber = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure parsing layer (no React, no SDK) — the unit under test.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split an attribute list into tokens.
 *
 * Numbers accept commas and whitespace interchangeably. Labels keep a multi-word
 * label intact when a comma is present (`"New York, LA"` → 2 labels); with no
 * comma, whitespace is the separator (`"Mon Tue Wed"` → 3 labels).
 */
export function splitTokens(raw, options = {}) {
  const text = String(raw == null ? '' : raw).trim()
  if (!text) return []
  const hasComma = text.includes(',') || text.includes('，')
  const pattern = options.label ? (hasComma ? /[,，]+/ : /\s+/) : /[,，\s]+/
  return text
    .split(pattern)
    .map(token => token.trim())
    .filter(token => token.length > 0)
}

/**
 * Expand an inclusive integer range token like `1..12` or `5..-2`.
 * Returns `null` when the token is not a range, `{ values }` on success, or
 * `{ error }` when the range would expand past MAX_RANGE points.
 */
export function expandRangeToken(token) {
  const match = /^(-?\d+)\s*\.\.\s*(-?\d+)$/.exec(String(token == null ? '' : token).trim())
  if (!match) return null
  const from = Number(match[1])
  const to = Number(match[2])
  const count = Math.abs(to - from) + 1
  if (count > MAX_RANGE) {
    return { error: `区间「${token}」展开后有 ${count} 个点，超过上限 ${MAX_RANGE}` }
  }
  const step = from <= to ? 1 : -1
  const values = []
  for (let value = from; step > 0 ? value <= to : value >= to; value += step) values.push(value)
  return { values }
}

/**
 * Parse a number list, expanding ranges. Returns `{ values, bad }` where each
 * `bad` entry is `{ token, reason }` (reason is null for a plain parse failure).
 */
export function parseNumberList(raw) {
  const values = []
  const bad = []
  for (const token of splitTokens(raw)) {
    const range = expandRangeToken(token)
    if (range) {
      if (range.error) bad.push({ token, reason: range.error })
      else values.push(...range.values)
      continue
    }
    const parsed = Number(token)
    if (Number.isFinite(parsed)) values.push(parsed)
    else bad.push({ token, reason: null })
  }
  return { values, bad }
}

/** Parse a label list, expanding numeric ranges and bounding the count. */
export function parseLabelList(raw) {
  const labels = []
  const warnings = []
  for (const token of splitTokens(raw, { label: true })) {
    const range = expandRangeToken(token)
    if (range && !range.error) {
      for (const value of range.values) labels.push(String(value))
      continue
    }
    if (range && range.error) warnings.push(range.error)
    else labels.push(token)
  }
  if (labels.length > MAX_CATEGORIES) {
    warnings.push(`分类有 ${labels.length} 个，只渲染前 ${MAX_CATEGORIES} 个`)
    labels.length = MAX_CATEGORIES
  }
  return { labels, warnings }
}

/** Reconstruct a copyable directive string from parsed attributes. */
export function serializeDirective(attrs) {
  const source = attrs || {}
  const keys = Object.keys(source).filter(key => String(source[key] == null ? '' : source[key]).length > 0)
  if (!keys.length) return '::echarts{}'
  return (
    '::echarts{' +
    keys.map(key => key + '="' + String(source[key]).replace(/"/g, "'") + '"').join(' ') +
    '}'
  )
}

/**
 * Turn the directive attributes into a chart spec. Pure and synchronous.
 *
 * Returns `{ ok: true, ...spec }` or `{ ok: false, errors, warnings, attrs }`,
 * where each error carries a user-facing Chinese `message`. The spec always
 * includes `errors`, `warnings` and `key` so callers can branch on `ok` alone.
 */
export function parseChartSpec(attrs) {
  const a = attrs || {}
  const errors = []
  const warnings = []

  // ── labels ──────────────────────────────────────────────────────────────
  const labelResult = parseLabelList(a.labels)
  const labels = labelResult.labels
  warnings.push(...labelResult.warnings)

  // ── default type ────────────────────────────────────────────────────────
  let defaultType = 'bar'
  const rawDefaultType = a.type == null ? '' : String(a.type).trim()
  if (rawDefaultType) {
    const type = rawDefaultType.toLowerCase()
    if (CHART_TYPES.includes(type)) defaultType = type
    else errors.push({ code: 'bad-type', message: `type 属性「${rawDefaultType}」不是合法类型，可用：${TYPE_HELP}` })
  }

  // ── single series vs multi series ───────────────────────────────────────
  const series = []
  const hasSeries = a.series != null && String(a.series).trim() !== ''
  const hasValues = a.values != null && String(a.values).trim() !== ''

  if (hasSeries) {
    const entries = String(a.series)
      .split(';')
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0)
    if (!entries.length) errors.push({ code: 'bad-series', message: 'series 属性是空的' })
    entries.forEach((entry, index) => {
      const parts = entry.split(':')
      if (parts.length < 2) {
        errors.push({
          code: 'bad-series',
          message: `series 第 ${index + 1} 段「${entry}」缺少数据，格式应为「名称:类型:数据」或「名称:数据」`
        })
        return
      }
      const name = parts[0].trim() || `Series ${series.length + 1}`
      let type = defaultType
      let body
      if (parts.length >= 3) {
        const rawType = parts[1].trim()
        if (rawType) {
          const lower = rawType.toLowerCase()
          if (CHART_TYPES.includes(lower)) type = lower
          else errors.push({ code: 'bad-type', message: `series「${name}」的类型「${rawType}」不是合法类型，可用：${TYPE_HELP}` })
        }
        body = parts.slice(2).join(':')
      } else {
        body = parts[1]
      }
      const parsed = parseNumberList(body)
      parsed.bad.forEach(item => {
        errors.push({
          code: 'bad-number',
          message: item.reason || `series「${name}」里的「${item.token}」不是数字`
        })
      })
      if (parsed.values.length) series.push({ name, type, data: parsed.values })
      else errors.push({ code: 'no-data', message: `series「${name}」里没有可用的数字` })
    })
  } else if (hasValues) {
    const parsed = parseNumberList(a.values)
    parsed.bad.forEach(item => {
      errors.push({
        code: 'bad-number',
        message: item.reason || `values 里的「${item.token}」不是数字`
      })
    })
    if (parsed.values.length) {
      const name = String(a.name == null ? '' : a.name).trim() || 'Value'
      series.push({ name, type: defaultType, data: parsed.values })
    } else {
      errors.push({ code: 'no-data', message: 'values 里没有可用的数字' })
    }
  } else {
    errors.push({
      code: 'no-data',
      message: '没有数据：请给 values 或 series，例如 ::echarts{labels="Mon,Tue" values="1,2"}'
    })
  }

  // ── labels ↔ data length agreement ──────────────────────────────────────
  if (labels.length) {
    for (const s of series) {
      if (s.data.length !== labels.length) {
        const subject = series.length === 1 && !hasSeries ? 'values' : `series「${s.name}」`
        // Latin subject (`values`) takes a space before the CJK verb; the
        // bracketed series form does not.
        const joiner = /[A-Za-z0-9]$/.test(subject) ? ' ' : ''
        errors.push({
          code: 'length-mismatch',
          message: `labels 有 ${labels.length} 个，${subject}${joiner}有 ${s.data.length} 个`
        })
      }
    }
  }

  if (!series.length) {
    return {
      ok: false,
      errors: dedupeErrors(errors),
      warnings,
      attrs: a,
      key: 'invalid::' + serializeDirective(a)
    }
  }

  if (errors.length) {
    return { ok: false, errors: dedupeErrors(errors), warnings, attrs: a, key: 'invalid::' + serializeDirective(a) }
  }

  const count = Math.max(labels.length, ...series.map(s => s.data.length))
  const categories = []
  for (let i = 0; i < count; i += 1) categories.push(labels[i] != null ? labels[i] : String(i + 1))

  const height = clamp(toNumber(a.height, DEFAULT_H), MIN_H, MAX_H)
  if (a.height != null && String(a.height).trim() !== '' && !Number.isFinite(Number(a.height))) {
    warnings.push(`height「${a.height}」不是数字，已使用默认 ${DEFAULT_H}`)
  }

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
    ok: true,
    key,
    categories,
    series,
    kind,
    height,
    zoom,
    title: String(a.title == null ? '' : a.title),
    errors: [],
    warnings,
    attrs: a
  }
}

function dedupeErrors(errors) {
  const seen = new Set()
  const out = []
  for (const error of errors) {
    if (seen.has(error.message)) continue
    seen.add(error.message)
    out.push(error)
  }
  return out
}

/** Min/max across the visible series values (pure — used for the y scale). */
export function valueExtent(seriesList) {
  let lo = 0
  let hi = 0
  let any = false
  for (const s of seriesList) {
    for (const value of s.data) {
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
  if (!any) return { lo: 0, hi: 1 }
  if (lo > 0) lo = 0
  if (hi < 0) hi = 0
  if (hi === lo) hi = lo + 1
  return { lo, hi }
}

/**
 * Wrap legend entries into rows that fit `width`. Pure, so the layout can be
 * tested without a DOM. Each item is `{ label, index }`.
 */
export function legendLayout(items, width) {
  const rows = []
  let row = []
  let rowWidth = 0
  for (const item of items) {
    const itemWidth = 16 + Math.min(item.label.length, 16) * 6.5 + 14
    if (row.length && rowWidth + itemWidth > width) {
      rows.push(row)
      row = []
      rowWidth = 0
    }
    row.push({ ...item, w: itemWidth })
    rowWidth += itemWidth
  }
  if (row.length) rows.push(row)
  return rows
}

/** Compact axis tick formatting. */
export function formatTick(value) {
  const abs = Math.abs(value)
  if (abs >= 1e9) return (value / 1e9).toFixed(abs >= 1e10 ? 0 : 1) + 'B'
  if (abs >= 1e6) return (value / 1e6).toFixed(abs >= 1e7 ? 0 : 1) + 'M'
  if (abs >= 1e3) return (value / 1e3).toFixed(abs >= 1e4 ? 0 : 1) + 'k'
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(abs < 1 ? 2 : 1)
}

/** Donut / pie slice path. Angles in radians, clockwise from 3 o'clock. */
export function arcPath(cx, cy, radius, inner, from, to) {
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

// ─────────────────────────────────────────────────────────────────────────────
// Rendering layer
// ─────────────────────────────────────────────────────────────────────────────

const visuallyHidden = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0
}

/** A readable, copyable failure block — never a blank area. */
function ChartError({ spec, streaming }) {
  const [copyState, setCopyState] = useState('idle')
  const raw = spec.raw && spec.raw.trim() ? spec.raw : serializeDirective(spec.attrs)

  if (streaming) {
    return jsx('div', {
      className: 'rounded-md border px-3 py-2 text-xs',
      style: { borderColor: 'var(--ui-stroke-secondary)', color: 'var(--ui-text-tertiary)' },
      children: 'echarts：正在读取图表数据…'
    })
  }

  const onCopy = () => {
    try {
      const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null
      if (clipboard && typeof clipboard.writeText === 'function') {
        clipboard.writeText(raw).then(
          () => setCopyState('done'),
          () => setCopyState('fail')
        )
      } else {
        setCopyState('fail')
      }
    } catch (error) {
      setCopyState('fail')
    }
  }

  const copyLabel = copyState === 'done' ? '已复制' : copyState === 'fail' ? '复制失败，请手动选中' : '复制原始指令'

  return jsxs('div', {
    role: 'alert',
    className: 'rounded-md border px-3 py-2 text-xs',
    style: {
      borderColor: 'var(--ui-red, #ff6b6b)',
      background: 'var(--ui-bg-elevated, rgba(30,30,34,0.4))',
      color: 'var(--ui-text-secondary)',
      display: 'grid',
      gap: 6
    },
    children: [
      jsx('div', {
        className: 'font-medium',
        style: { color: 'var(--ui-red, #ff6b6b)' },
        children: 'echarts：图表数据有问题，暂不能绘制'
      }),
      jsxs('ul', {
        style: { margin: 0, paddingLeft: 18, display: 'grid', gap: 2 },
        children: spec.errors.map((error, index) => jsx('li', { children: error.message }, 'err-' + index))
      }),
      jsxs('div', {
        style: { display: 'grid', gap: 4 },
        children: [
          jsx('div', { style: { color: 'var(--ui-text-tertiary)' }, children: '原始指令（可选中或复制后修正）：' }),
          jsx('pre', {
            style: {
              margin: 0,
              padding: '6px 8px',
              borderRadius: 4,
              background: 'var(--ui-bg-editor, rgba(0,0,0,0.15))',
              color: 'var(--ui-text-primary)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              userSelect: 'all',
              fontSize: 11
            },
            children: raw
          }),
          jsx('button', {
            type: 'button',
            onClick: onCopy,
            style: {
              justifySelf: 'start',
              padding: '2px 8px',
              borderRadius: 4,
              border: '1px solid var(--ui-stroke-secondary)',
              background: 'transparent',
              color: 'var(--ui-text-secondary)',
              cursor: 'pointer',
              fontSize: 11
            },
            children: copyLabel
          })
        ]
      })
    ]
  })
}

function readoutFor(spec, active) {
  if (active == null || active < 0 || active >= spec.categories.length) {
    const seriesCount = spec.kind === 'pie' ? spec.categories.length : spec.series.length
    const unit = spec.kind === 'pie' ? '个切片' : '条系列'
    return `共 ${spec.categories.length} 个分类、${seriesCount} ${unit}。悬停数据点，或用 Tab 聚焦后按 ← / → 查看数值。`
  }
  const category = String(spec.categories[active])
  if (spec.kind === 'pie') {
    const value = spec.series[0] ? spec.series[0].data[active] : NaN
    const total = spec.series[0]
      ? spec.series[0].data.reduce((sum, v) => sum + (Number.isFinite(v) && v > 0 ? v : 0), 0)
      : 0
    const share = total > 0 && Number.isFinite(value) ? '（' + ((value / total) * 100).toFixed(1) + '%）' : ''
    return category + '：' + (Number.isFinite(value) ? formatTick(value) : '—') + share
  }
  const parts = spec.series
    .map(s => {
      const value = s.data[active]
      return s.name + '：' + (Number.isFinite(value) ? formatTick(value) : '—')
    })
    .join('，')
  return category + ' — ' + parts
}

function ChartWidget({ attrs, source, streaming }) {
  const spec = useMemo(() => parseChartSpec(attrs), [attrs])
  const withRaw = spec.ok ? spec : { ...spec, raw: source }
  const hostRef = useRef(null)
  const plotRef = useRef(null)
  const dragRef = useRef(null)
  const sliderRef = useRef(null)
  const [width, setWidth] = useState(0)
  const [view, setView] = useState({ start: 0, span: 1 })
  const [hidden, setHidden] = useState({})
  const [active, setActive] = useState(null)

  const n = withRaw.ok ? withRaw.categories.length : 0
  const minSpan = Math.min(MIN_SPAN, Math.max(1, n))
  const span = n > 0 ? clamp(view.span, minSpan, n) : 0
  const start = n > 0 ? clamp(view.start, 0, n - span) : 0
  const showZoom = withRaw.ok && withRaw.kind === 'xy' && withRaw.zoom && n > minSpan

  // Re-seed the view whenever the addressed data changes.
  useEffect(() => {
    setView({ start: 0, span: Math.max(1, n) })
    setHidden({})
    setActive(null)
  }, [withRaw.key, n])

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

  if (!withRaw.ok) {
    return jsx(ChartError, { spec: withRaw, streaming })
  }

  const toggle = index => setHidden(prev => ({ ...prev, [index]: !prev[index] }))

  const H = withRaw.height
  const hasTitle = withRaw.title.length > 0
  const padLeft = 46
  const padRight = 14
  const innerW = Math.max(10, width - padLeft - padRight)

  const legendItems =
    withRaw.kind === 'pie'
      ? withRaw.categories.map((label, index) => ({ label, index }))
      : withRaw.series.map((s, index) => ({ label: s.name, index }))

  const legendRows = legendLayout(legendItems, innerW)
  const legendStartY = hasTitle ? 36 : 18
  const padTop = legendStartY + Math.max(1, legendRows.length) * 16 + 2
  const padBottom = showZoom ? 48 : 24
  const plotW = Math.max(10, width - padLeft - padRight)
  const plotH = Math.max(10, H - padTop - padBottom)

  const onKeyDown = event => {
    if (n <= 0) return
    let next = active
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      next = active == null ? start : clamp(active + 1, start, start + span - 1)
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      next = active == null ? start + span - 1 : clamp(active - 1, start, start + span - 1)
    } else if (event.key === 'Home') {
      next = start
    } else if (event.key === 'End') {
      next = start + span - 1
    } else if (event.key === 'Escape') {
      next = null
    } else {
      return
    }
    event.preventDefault()
    setActive(next)
  }

  const onFocus = () => {
    if (active == null && n > 0) setActive(start)
  }

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
  if (width > 0 && withRaw.kind === 'xy') {
    const visible = withRaw.series.map((s, si) => ({ s, si })).filter(o => o.s.type !== 'pie' && !hidden[o.si])
    const bandW = plotW / Math.max(1, span)
    const xCenter = j => padLeft + (j + 0.5) * bandW
    const extent = valueExtent(visible.map(o => ({ data: sWindow(o.s.data, start, span) })))
    const valuePad = (extent.hi - extent.lo) * 0.08
    const yHi = extent.hi + valuePad
    const yLo = extent.lo - valuePad
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
          style: {
            fill: active != null && active - start === j ? 'var(--ui-text-primary)' : 'var(--ui-text-tertiary)',
            fontSize: 10,
            fontWeight: active != null && active - start === j ? 600 : 400
          },
          children: truncate(String(withRaw.categories[start + j]), 10)
        }, 'xlabel-' + j)
      )
    }

    // Hover crosshair + band highlight, drawn under the series marks overlay.
    if (active != null && active >= start && active < start + span) {
      const j = active - start
      plotChildren.push(
        jsx('rect', {
          x: padLeft + j * bandW,
          y: padTop,
          width: Math.max(1, bandW),
          height: plotH,
          style: { fill: 'var(--ui-accent)', opacity: 0.08 }
        }, 'hover-band'),
        jsx('line', {
          x1: xCenter(j),
          x2: xCenter(j),
          y1: padTop,
          y2: padTop + plotH,
          style: { stroke: 'var(--ui-accent)', strokeWidth: 1, strokeDasharray: '3 3' }
        }, 'crosshair')
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
            style: { fill: colorAt(o.si), opacity: active != null && active - start === j ? 1 : 0.92 }
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
        plotChildren.push(
          jsx('circle', { cx: p[0], cy: p[1], r: 2.5, style: { fill: colorAt(o.si) } }, 'pt-' + o.si + '-' + i)
        )
      })
    }

    // Highlight ring on every visible series at the active category.
    if (active != null && active >= start && active < start + span) {
      for (const o of visible) {
        const value = o.s.data[active]
        if (!Number.isFinite(value)) continue
        plotChildren.push(
          jsx('circle', {
            cx: xCenter(active - start),
            cy: yOf(value),
            r: 4.5,
            style: { fill: 'var(--ui-bg-editor, transparent)', stroke: colorAt(o.si), strokeWidth: 2 }
          }, 'hl-' + o.si)
        )
      }
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
          const j = clamp(Math.floor((event.nativeEvent.offsetX || 0) / Math.max(1, bandW)), 0, Math.max(0, span - 1))
          setActive(start + j)
          if (!showZoom || event.pointerType === 'touch') return
          dragRef.current = { x: event.clientX, start }
          if (event.currentTarget.setPointerCapture) event.currentTarget.setPointerCapture(event.pointerId)
        },
        onPointerMove: event => {
          const offsetX = event.nativeEvent.offsetX
          const j = clamp(Math.floor(offsetX / Math.max(1, bandW)), 0, Math.max(0, span - 1))
          setActive(start + j)
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
          setActive(null)
        }
      }, 'overlay')
    )
  }

  if (width > 0 && withRaw.kind === 'pie') {
    const values = withRaw.series[0].data.map((v, i) => ({
      label: withRaw.categories[i],
      value: Math.max(0, v),
      index: i
    }))
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
      const isActive = active === slice.index
      plotChildren.push(
        jsx('path', {
          d: arcPath(cx, cy, radius, inner, angle, angle + sweep),
          style: {
            fill: colorAt(slice.index),
            stroke: 'var(--ui-bg-editor, transparent)',
            strokeWidth: isActive ? 2 : 1,
            opacity: active == null || isActive ? 1 : 0.55,
            cursor: 'pointer'
          },
          onPointerEnter: () => setActive(slice.index),
          onPointerLeave: () => setActive(null),
          onPointerDown: () => setActive(slice.index)
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
  if (active != null && width > 0 && active >= start && active < start + span) {
    const tooltipRows = []
    if (withRaw.kind === 'xy') {
      withRaw.series.forEach((s, si) => {
        if (hidden[si]) return
        const value = s.data[active]
        tooltipRows.push(
          jsxs('div', {
            style: { display: 'flex', alignItems: 'center', gap: 4 },
            children: [
              jsx('span', {
                style: { width: 8, height: 8, borderRadius: 2, background: colorAt(si), display: 'inline-block' }
              }),
              jsx('span', { children: s.name + ': ' + (Number.isFinite(value) ? formatTick(value) : '—') })
            ]
          }, 'tooltip-' + si)
        )
      })
    } else {
      tooltipRows.push(jsx('div', { children: readoutFor(withRaw, active) }, 'tooltip-pie'))
    }
    if (tooltipRows.length) {
      const bandW = plotW / Math.max(1, span)
      const anchorX = withRaw.kind === 'xy' ? padLeft + (active - start + 0.5) * bandW : width / 2
      tooltip = jsxs('div', {
        style: {
          position: 'absolute',
          left: clamp(anchorX + 8, 4, Math.max(4, width - 150)),
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
          jsx('div', { style: { fontWeight: 600, marginBottom: 2 }, children: String(withRaw.categories[active]) }),
          ...tooltipRows
        ]
      })
    }
  }

  const svgChildren = []
  if (hasTitle) {
    svgChildren.push(
      jsx('text', {
        x: padLeft,
        y: 18,
        style: { fill: 'var(--ui-text-primary)', fontSize: 13, fontWeight: 600 },
        children: withRaw.title
      }, 'chart-title')
    )
  }
  svgChildren.push(...legendChildren, ...plotChildren, ...sliderChildren)

  const seriesSummary = withRaw.kind === 'pie'
    ? withRaw.series[0].name + '（' + withRaw.categories.length + ' 个切片）'
    : withRaw.series.map(s => s.name).join('、')

  return jsxs('div', {
    ref: hostRef,
    tabIndex: 0,
    role: 'group',
    'aria-label': (hasTitle ? withRaw.title : '图表') + '（' + withRaw.kind + '），' + seriesSummary,
    onKeyDown,
    onFocus,
    style: { width: '100%', margin: '8px 0', outline: 'none' },
    children: [
      jsxs('div', {
        style: { position: 'relative', width: '100%', height: H + 'px' },
        children: [
          width > 0
            ? jsxs('svg', {
              ref: plotRef,
              width,
              height: H,
              role: 'img',
              'aria-label': (hasTitle ? withRaw.title : 'chart') + ' (' + withRaw.kind + ')',
              style: { display: 'block', overflow: 'visible', fontFamily: 'inherit' },
              children: svgChildren
            }, 'chart-svg')
            : null,
          tooltip
        ]
      }),
      jsx('div', {
        'aria-live': 'polite',
        style: {
          marginTop: 2,
          fontSize: 11,
          color: active == null ? 'var(--ui-text-quaternary)' : 'var(--ui-text-secondary)',
          minHeight: 16
        },
        children: readoutFor(withRaw, active)
      }),
      jsx('div', { style: visuallyHidden, children: readoutFor(withRaw, active) })
    ]
  })
}

/** Window a series' data to the current zoom view (pure helper for extent). */
function sWindow(data, start, span) {
  const out = []
  for (let i = 0; i < span; i += 1) {
    const value = data[start + i]
    if (Number.isFinite(value)) out.push(value)
  }
  return out
}

function renderDirective(props) {
  return jsx(ChartWidget, { attrs: props.attrs, source: props.source, streaming: props.streaming })
}

export { ChartWidget, readoutFor }

export default {
  id: 'echarts-in-chat',
  name: 'ECharts in Chat',
  register(ctx) {
    ctx.register({
      id: 'echarts-directive',
      area: sdk.TRANSCRIPT_DIRECTIVE_AREA,
      data: {
        name: 'echarts',
        render: renderDirective
      }
    })
  }
}
