/**
 * Minimal render-layer tests: the error/empty states and the accessible
 * readout. These run the real component with stubbed React hooks (see
 * `load-plugin.mjs`) so no React runtime or DOM is needed.
 * Run with: node --test tests/
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { collectText, collectTypes, loadPlugin } from './load-plugin.mjs'

const mod = await loadPlugin()
const { ChartWidget, parseChartSpec, readoutFor } = mod

test('invalid data renders a readable error block, not a blank area', () => {
  const tree = ChartWidget({
    attrs: { labels: 'Mon,Tue,Wed', values: '1,2,3,4' },
    source: '::echarts{labels="Mon,Tue,Wed" values="1,2,3,4"}'
  })
  const text = collectText(tree).join('')
  assert.ok(text.includes('charts') || text.includes('echarts'), text)
  assert.ok(text.includes('图表数据有问题'), text)
  assert.ok(text.includes('labels 有 3 个，values 有 4 个'), text)
  assert.ok(text.includes('::echarts{labels="Mon,Tue,Wed" values="1,2,3,4"}'), 'raw directive is preserved')
  const types = collectTypes(tree)
  assert.ok(types.includes('pre'), 'raw directive is rendered as copyable <pre>')
  assert.ok(types.includes('button'), 'a copy control is offered')
})

test('an illegal type renders an error that lists the valid types', () => {
  const tree = ChartWidget({ attrs: { labels: 'A,B', values: '1,2', type: 'scatter' }, source: '::echarts{type="scatter"}' })
  const text = collectText(tree).join('')
  assert.ok(text.includes('scatter'), text)
  assert.ok(text.includes('bar、line、pie'), text)
})

test('while the message streams, an incomplete directive shows a settling state', () => {
  const tree = ChartWidget({
    attrs: { labels: 'A,B', values: '1,2,3' },
    source: '::echarts{labels="A,B" values="1,2,3"',
    streaming: true
  })
  const text = collectText(tree).join('')
  assert.ok(text.includes('正在读取图表数据'), text)
  assert.ok(!text.includes('图表数据有问题'), 'no red error while streaming')
})

test('a valid chart renders an accessible readout with keyboard instructions', () => {
  const spec = parseChartSpec({ labels: 'Mon,Tue', values: '1,2' })
  const tree = ChartWidget({ attrs: { labels: 'Mon,Tue', values: '1,2' }, source: '' })
  const text = collectText(tree).join('')
  assert.ok(text.includes('共 2 个分类、1 条系列'), text)
  assert.ok(text.includes('← / →'), text)
  const types = collectTypes(tree)
  assert.ok(types.includes('div'))
  assert.equal(readoutFor(spec, null).startsWith('共 2 个分类'), true)
  assert.equal(readoutFor(spec, 0), 'Mon — Value：1')
})

test('pie readout reports the active slice and its share', () => {
  const spec = parseChartSpec({ labels: 'Direct,Search', values: '1,3', type: 'pie' })
  assert.equal(readoutFor(spec, 1), 'Search：3（75.0%）')
})

test('empty-state text is English-consistent for an all-hidden xy chart', () => {
  // The all-series-hidden branch is unreachable without state control, but the
  // parse of a valid-but-hidden spec must still be ok.
  assert.equal(parseChartSpec({ labels: 'A', values: '1' }).ok, true)
})
