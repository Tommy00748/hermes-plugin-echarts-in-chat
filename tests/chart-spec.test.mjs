/**
 * Unit tests for the pure directive parser (issue: first upgrade round).
 * Run with: node --test tests/
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { loadPlugin } from './load-plugin.mjs'

const mod = await loadPlugin()
const {
  parseChartSpec,
  parseNumberList,
  parseLabelList,
  splitTokens,
  expandRangeToken,
  serializeDirective,
  formatTick,
  arcPath,
  clamp,
  legendLayout,
  valueExtent
} = mod

test('legacy single-series syntax still parses unchanged', () => {
  const spec = parseChartSpec({ labels: 'Mon,Tue,Wed', values: '120,200,150', type: 'bar', title: 'Sales' })
  assert.equal(spec.ok, true)
  assert.deepEqual(spec.categories, ['Mon', 'Tue', 'Wed'])
  assert.equal(spec.series.length, 1)
  assert.deepEqual(spec.series[0].data, [120, 200, 150])
  assert.equal(spec.series[0].type, 'bar')
  assert.equal(spec.title, 'Sales')
  assert.equal(spec.kind, 'xy')
})

test('legacy multi-series syntax (name:type:data;...) still parses', () => {
  const spec = parseChartSpec({
    labels: 'Mon,Tue',
    series: 'Sales:bar:120,200;Cost:line:80,90'
  })
  assert.equal(spec.ok, true)
  assert.deepEqual(spec.series.map(s => s.name), ['Sales', 'Cost'])
  assert.deepEqual(spec.series.map(s => s.type), ['bar', 'line'])
  assert.deepEqual(spec.series[0].data, [120, 200])
})

test('two-part series entries get the default type', () => {
  const spec = parseChartSpec({ labels: 'A,B', series: 'Revenue:1,2', type: 'line' })
  assert.equal(spec.ok, true)
  assert.equal(spec.series[0].name, 'Revenue')
  assert.equal(spec.series[0].type, 'line')
  assert.deepEqual(spec.series[0].data, [1, 2])
})

test('single-series name attribute is honoured, default Value', () => {
  assert.equal(parseChartSpec({ values: '1,2' }).series[0].name, 'Value')
  assert.equal(parseChartSpec({ values: '1,2', name: 'Revenue' }).series[0].name, 'Revenue')
})

test('compact: inclusive integer ranges expand ascending and descending', () => {
  assert.deepEqual(parseNumberList('1..5').values, [1, 2, 3, 4, 5])
  assert.deepEqual(parseNumberList('5..1').values, [5, 4, 3, 2, 1])
  assert.deepEqual(parseNumberList('-2..2').values, [-2, -1, 0, 1, 2])
  assert.deepEqual(parseNumberList('1..1').values, [1])
})

test('compact: ranges work inside values, series bodies and labels', () => {
  assert.deepEqual(parseChartSpec({ labels: '1..3', values: '1..3' }).series[0].data, [1, 2, 3])
  assert.deepEqual(parseChartSpec({ labels: 'A,B,C', series: 'S:bar:1..3' }).series[0].data, [1, 2, 3])
  assert.deepEqual(parseChartSpec({ labels: '1..3', values: '1 2 3' }).categories, ['1', '2', '3'])
})

test('compact: whitespace and comma are interchangeable for numbers', () => {
  assert.deepEqual(parseNumberList('1 2 3').values, [1, 2, 3])
  assert.deepEqual(parseNumberList('1,2,3').values, [1, 2, 3])
  assert.deepEqual(parseNumberList(' 1 , 2   3 ').values, [1, 2, 3])
  assert.deepEqual(parseNumberList('1，2，3').values, [1, 2, 3])
})

test('compact: whitespace separates labels only when no comma is present', () => {
  assert.deepEqual(parseLabelList('Mon Tue Wed').labels, ['Mon', 'Tue', 'Wed'])
  assert.deepEqual(parseLabelList('New York, Los Angeles').labels, ['New York', 'Los Angeles'])
  assert.deepEqual(parseLabelList('New York,Los Angeles').labels, ['New York', 'Los Angeles'])
})

test('splitTokens drops empties and trims', () => {
  assert.deepEqual(splitTokens('  a ,, b  '), ['a', 'b'])
  assert.deepEqual(splitTokens(''), [])
  assert.deepEqual(splitTokens(null), [])
})

test('expandRangeToken returns null for non-ranges', () => {
  assert.equal(expandRangeToken('12'), null)
  assert.equal(expandRangeToken('1...3'), null)
  assert.equal(expandRangeToken('abc'), null)
  assert.deepEqual(expandRangeToken('1..3').values, [1, 2, 3])
})

test('error: labels/values length mismatch names both counts', () => {
  const spec = parseChartSpec({ labels: 'Mon,Tue,Wed', values: '1,2,3,4' })
  assert.equal(spec.ok, false)
  const messages = spec.errors.map(e => e.message)
  assert.ok(messages.some(m => m === 'labels 有 3 个，values 有 4 个'), JSON.stringify(messages))
})

test('error: series length mismatch names the offending series', () => {
  const spec = parseChartSpec({ labels: 'A,B', series: 'Sales:bar:1,2;Cost:line:1,2,3' })
  assert.equal(spec.ok, false)
  const messages = spec.errors.map(e => e.message)
  assert.ok(messages.some(m => m === 'labels 有 2 个，series「Cost」有 3 个'), JSON.stringify(messages))
})

test('error: unparsable number names the token', () => {
  const spec = parseChartSpec({ labels: 'A,B,C', values: '1,abc,3' })
  assert.equal(spec.ok, false)
  const messages = spec.errors.map(e => e.message)
  assert.ok(messages.some(m => m === 'values 里的「abc」不是数字'), JSON.stringify(messages))
})

test('error: illegal type names it and lists the valid ones', () => {
  const spec = parseChartSpec({ labels: 'A,B', values: '1,2', type: 'scatter' })
  assert.equal(spec.ok, false)
  const messages = spec.errors.map(e => e.message)
  assert.ok(messages.some(m => m.includes('scatter') && m.includes('bar、line、pie')), JSON.stringify(messages))
})

test('error: illegal per-series type is reported too', () => {
  const spec = parseChartSpec({ labels: 'A,B', series: 'S:radar:1,2' })
  assert.equal(spec.ok, false)
  assert.ok(spec.errors.some(e => e.message.includes('radar')))
})

test('error: no data at all is reported, never a blank spec', () => {
  const spec = parseChartSpec({})
  assert.equal(spec.ok, false)
  assert.equal(spec.errors[0].code, 'no-data')
})

test('error: malformed series entry names its position', () => {
  const spec = parseChartSpec({ labels: 'A', series: 'oops' })
  assert.equal(spec.ok, false)
  assert.ok(spec.errors.some(e => e.message.includes('series 第 1 段')))
})

test('guard: a huge range is refused, not expanded', () => {
  const spec = parseChartSpec({ values: '1..5000' })
  assert.equal(spec.ok, false)
  assert.ok(spec.errors.some(e => e.message.includes('超过上限')))
})

test('errors are deduplicated', () => {
  const spec = parseChartSpec({ labels: 'A', series: 'S:bar:1,2;T:line:1,2' })
  assert.equal(spec.ok, false)
  const count = spec.errors.filter(e => e.code === 'length-mismatch').length
  assert.equal(count, 2)
})

test('no labels: categories are generated from the data length', () => {
  const spec = parseChartSpec({ values: '5,6,7' })
  assert.equal(spec.ok, true)
  assert.deepEqual(spec.categories, ['1', '2', '3'])
})

test('pie kind is selected by type, by per-series type, or by series mix', () => {
  assert.equal(parseChartSpec({ labels: 'A,B', values: '1,2', type: 'pie' }).kind, 'pie')
  assert.equal(parseChartSpec({ labels: 'A,B', series: 'S:pie:1,2' }).kind, 'pie')
  assert.equal(parseChartSpec({ labels: 'A,B', values: '1,2', type: 'bar' }).kind, 'xy')
})

test('zoom default is on past 10 categories, overridable either way', () => {
  const many = { labels: Array.from({ length: 12 }, (_, i) => 'C' + i).join(','), values: '1 2 3 4 5 6 7 8 9 10 11 12' }
  assert.equal(parseChartSpec(many).zoom, true)
  assert.equal(parseChartSpec({ ...many, zoom: 'false' }).zoom, false)
  assert.equal(parseChartSpec({ labels: 'A,B', values: '1,2', zoom: 'true' }).zoom, true)
})

test('height is clamped and a non-numeric height warns', () => {
  assert.equal(parseChartSpec({ labels: 'A', values: '1', height: '10' }).height, 280)
  assert.equal(parseChartSpec({ labels: 'A', values: '1', height: '9999' }).height, 560)
  assert.equal(parseChartSpec({ labels: 'A', values: '1', height: '420' }).height, 420)
  const warned = parseChartSpec({ labels: 'A', values: '1', height: 'tall' })
  assert.equal(warned.height, 400)
  assert.ok(warned.warnings.some(w => w.includes('tall')))
})

test('serializeDirective rebuilds a copyable directive', () => {
  assert.equal(serializeDirective({ labels: 'A,B', values: '1,2' }), '::echarts{labels="A,B" values="1,2"}')
  assert.equal(serializeDirective({}), '::echarts{}')
})

test('render-layer pure helpers', () => {
  assert.equal(formatTick(1500), '1.5k')
  assert.equal(formatTick(2), '2')
  assert.equal(clamp(9, 0, 5), 5)
  assert.deepEqual(valueExtent([{ data: [3, 1, 4] }]), { lo: 0, hi: 4 })
  assert.deepEqual(valueExtent([{ data: [-5, -1] }]), { lo: -5, hi: 0 })
  const legend = legendLayout([{ label: 'Alpha', index: 0 }, { label: 'Beta', index: 1 }], 60)
  assert.equal(legend.length, 2, 'narrow width wraps legend rows')
  const arc = arcPath(0, 0, 10, 0, 0, Math.PI * 2)
  assert.ok(arc.startsWith('M-10 0'), arc)
})
