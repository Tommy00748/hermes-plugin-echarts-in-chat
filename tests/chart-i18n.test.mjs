import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collectText, loadPlugin } from './load-plugin.mjs'

const { ChartWidget, parseChartSpec, parseLabelList, parseNumberList, expandRangeToken, readoutFor, createRenderer } = await loadPlugin()
const text = node => collectText(node).join('')
function nodes(node, predicate, out = []) {
  if (Array.isArray(node)) node.forEach(child => nodes(child, predicate, out))
  else if (node && typeof node === 'object') {
    if (predicate(node)) out.push(node)
    nodes(node.props?.children, predicate, out)
  }
  return out
}
const byType = (tree, type) => nodes(tree, node => node.type === type)
const live = tree => nodes(tree, node => node.props?.['aria-live'] === 'polite')[0].props.children
function navigatorFor(t, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  if (value === null) delete globalThis.navigator
  else Object.defineProperty(globalThis, 'navigator', { configurable: true, value })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'navigator', original)
    else delete globalThis.navigator
  })
}

// Exact messages cover every error branch, including errors nested in helpers.
const errors = [
  [{ type: 'scatter', values: '1' }, 'bad-type', 'type "scatter" is invalid; use: bar, line, pie', 'type 属性「scatter」不是合法类型，可用：bar、line、pie'],
  [{ series: '; ;' }, 'bad-series', 'series is empty', 'series 属性是空的'],
  [{ series: 'oops' }, 'bad-series', 'series entry 1 "oops" is missing data; expected "name:type:data" or "name:data"', 'series 第 1 段「oops」缺少数据，格式应为「名称:类型:数据」或「名称:数据」'],
  [{ series: 'S:radar:1' }, 'bad-type', 'Type "radar" for series "S" is invalid; use: bar, line, pie', 'series「S」的类型「radar」不是合法类型，可用：bar、line、pie'],
  [{ series: 'S:bar:abc' }, 'bad-number', '"abc" in series "S" is not a number', 'series「S」里的「abc」不是数字'],
  [{ series: 'S:' }, 'no-data', 'series "S" has no usable numbers', 'series「S」里没有可用的数字'],
  [{ values: 'abc' }, 'bad-number', '"abc" in values is not a number', 'values 里的「abc」不是数字'],
  [{ values: ',' }, 'no-data', 'values has no usable numbers', 'values 里没有可用的数字'],
  [{}, 'no-data', 'No data: provide values or series, e.g. ::echarts{labels="Mon,Tue" values="1,2"}', '没有数据：请给 values 或 series，例如 ::echarts{labels="Mon,Tue" values="1,2"}'],
  [{ labels: 'A,B', values: '1' }, 'length-mismatch', 'labels has 2 items, but values has 1', 'labels 有 2 个，values 有 1 个'],
  [{ labels: 'A,B', series: 'S:1' }, 'length-mismatch', 'labels has 2 items, but series "S" has 1', 'labels 有 2 个，series「S」有 1 个'],
  [{ values: '1..5000' }, 'bad-number', 'Range "1..5000" expands to 5000 points, exceeding the limit of 1000', '区间「1..5000」展开后有 5000 个点，超过上限 1000'],
  [{ series: 'S:1..5000' }, 'bad-number', 'Range "1..5000" expands to 5000 points, exceeding the limit of 1000', '区间「1..5000」展开后有 5000 个点，超过上限 1000']
]

for (const locale of [undefined, 'en', 'en-US', 'fr-FR', '', null, 'zh', 'zh-CN', 'zh-TW']) {
  const zh = typeof locale === 'string' && locale.startsWith('zh')
  test(`parser errors use ${locale ?? 'default English'}`, () => {
    for (const [attrs, code, en, cn] of errors) {
      const spec = parseChartSpec(attrs, locale)
      assert.equal(spec.ok, false)
      assert.ok(spec.errors.some(e => e.code === code && e.message === (zh ? cn : en)), JSON.stringify(spec.errors))
    }
  })
  test(`parser warnings and default names use ${locale ?? 'default English'}`, () => {
    const range = zh ? '区间「1..5000」展开后有 5000 个点，超过上限 1000' : 'Range "1..5000" expands to 5000 points, exceeding the limit of 1000'
    assert.equal(expandRangeToken('1..5000', locale).error, range)
    assert.equal(parseNumberList('1..5000', locale).bad[0].reason, range)
    assert.deepEqual(parseLabelList('1..5000', locale).warnings, [range])
    assert.deepEqual(parseChartSpec({ labels: '1..5000', values: '1' }, locale).warnings, [range])
    const labels = Array.from({ length: 2001 }, (_, i) => 'C' + i).join(',')
    const labelResult = parseLabelList(labels, locale)
    assert.equal(labelResult.labels.length, 2000)
    assert.deepEqual(labelResult.warnings, [zh ? '分类有 2001 个，只渲染前 2000 个' : 'There are 2001 categories; only the first 2000 will be rendered'])
    assert.deepEqual(parseChartSpec({ values: '1', height: 'tall' }, locale).warnings, [zh ? 'height「tall」不是数字，已使用默认 400' : 'height "tall" is not a number; using the default of 400'])
    assert.equal(parseChartSpec({ values: '1' }, locale).series[0].name, zh ? '数值' : 'Value')
    assert.deepEqual(parseChartSpec({ series: ':1;:2' }, locale).series.map(s => s.name), zh ? ['系列 1', '系列 2'] : ['Series 1', 'Series 2'])
  })
}

test('pure parser defaults to English even when navigator is Chinese', t => {
  navigatorFor(t, { language: 'zh-CN' })
  assert.equal(parseChartSpec({}).errors[0].message, errors[8][2])
})

for (const [label, nav, zh] of [
  ['absent navigator', null, false], ['absent language', {}, false],
  ['English', { language: 'en-US' }, false], ['unknown', { language: 'xx-ZZ' }, false],
  ['null language', { language: null }, false], ['empty language', { language: '' }, false],
  ['non-string language', { language: 42 }, false], ['non-Chinese prefix', { language: 'zhnot' }, false],
  ['zh', { language: 'zh' }, true], ['zh-CN', { language: 'zh-CN' }, true],
  ['zh-TW', { language: 'zh-TW' }, true], ['case insensitive', { language: 'ZH-cn' }, true]
]) {
  test(`widget error, streaming, readout and both aria labels: ${label}`, t => {
    navigatorFor(t, nav)
    const invalid = ChartWidget({ attrs: { labels: 'A,B', values: '1' } })
    const errorTree = invalid.type(invalid.props)
    assert.equal(errorTree.props.role, 'alert')
    assert.ok(text(errorTree).includes(zh ? 'echarts：图表数据有问题，暂不能绘制' : 'echarts: Cannot render chart because the data is invalid'))
    assert.ok(text(errorTree).includes(zh ? 'labels 有 2 个，values 有 1 个' : 'labels has 2 items, but values has 1'))
    assert.ok(text(errorTree).includes(zh ? '原始指令（可选中或复制后修正）：' : 'Original directive (select or copy it to correct the data):'))
    assert.equal(byType(errorTree, 'button')[0].props.children, zh ? '复制原始指令' : 'Copy original directive')
    assert.equal(byType(errorTree, 'pre')[0].props.children, '::echarts{labels="A,B" values="1"}')
    const streaming = ChartWidget({ attrs: {}, streaming: true })
    assert.equal(text(streaming), zh ? 'echarts：正在读取图表数据…' : 'echarts: Reading chart data…')
    assert.equal(streaming.type(streaming.props).props.role, undefined)
    // Widget state seeds: measured width, zoom view, hidden series, active point.
    const render = createRenderer(ChartWidget, { attrs: { labels: 'A,B', values: '1,3' } }, [640, { start: 0, span: 2 }])
    let tree = render()
    assert.equal(tree.props['aria-label'], zh ? '图表（xy），数值' : 'Chart (xy), Value')
    assert.equal(byType(tree, 'svg')[0].props['aria-label'], zh ? '图表（xy）' : 'Chart (xy)')
    assert.equal(live(tree), zh ? '共 2 个分类、1 条系列。悬停数据点，或用 Tab 聚焦后按 ← / → 查看数值。' : '2 categories, 1 series. Hover a data point, or focus with Tab and press ← / → to inspect values.')
    tree.props.onFocus()
    tree = render()
    assert.equal(live(tree), zh ? 'A — 数值：1' : 'A — Value: 1')
    tree.props.onKeyDown({ key: 'ArrowRight', preventDefault() {} })
    assert.equal(live(render()), zh ? 'B — 数值：3' : 'B — Value: 3')
    const pie = createRenderer(ChartWidget, { attrs: { labels: 'A,B', values: '1,3', type: 'pie' } }, [640, { start: 0, span: 2 }])()
    assert.equal(pie.props['aria-label'], zh ? '图表（pie），数值（2 个切片）' : 'Chart (pie), Value (2 slices)')
    assert.equal(byType(pie, 'svg')[0].props['aria-label'], zh ? '图表（pie）' : 'Chart (pie)')
    assert.equal(live(pie), zh ? '共 2 个分类、2 个切片。悬停数据点，或用 Tab 聚焦后按 ← / → 查看数值。' : '2 categories, 2 slices. Hover a data point, or focus with Tab and press ← / → to inspect values.')
  })
}

for (const locale of ['en', 'zh']) {
  const zh = locale === 'zh'
  test(`active readouts, tooltip, empty states and user text: ${locale}`, t => {
    navigatorFor(t, { language: locale })
    const attrs = { labels: '上海,New York', series: '收入:1,3;Sales:2,4', title: '每周 Sales' }
    const spec = parseChartSpec(attrs, locale)
    assert.deepEqual(spec.categories, ['上海', 'New York'])
    assert.deepEqual(spec.series.map(s => s.name), ['收入', 'Sales'])
    assert.equal(spec.title, attrs.title)
    assert.equal(parseChartSpec({ values: '1', name: '收入' }, locale).series[0].name, '收入')
    assert.equal(readoutFor(spec, 0, locale), zh ? '上海 — 收入：1，Sales：2' : '上海 — 收入: 1, Sales: 2')
    const xy = createRenderer(ChartWidget, { attrs }, [640, { start: 0, span: 2 }, {}, 0])()
    assert.equal(xy.props['aria-label'], zh ? '每周 Sales（xy），收入，Sales' : '每周 Sales (xy), 收入, Sales')
    assert.equal(text(nodes(xy, n => n.key === 'tooltip-0')[0]), zh ? '收入：1' : '收入: 1')
    assert.equal(text(nodes(xy, n => n.key === 'tooltip-1')[0]), zh ? 'Sales：2' : 'Sales: 2')
    const pieAttrs = { labels: '上海,New York', values: '1,3', type: 'pie', name: '收入', title: attrs.title }
    const pieSpec = parseChartSpec(pieAttrs, locale)
    assert.equal(readoutFor(pieSpec, 1, locale), zh ? 'New York：3（75.0%）' : 'New York: 3 (75.0%)')
    for (const active of [null, -1, 99]) assert.match(readoutFor(spec, active, locale), zh ? /^共 2 个分类/ : /^2 categories/)
    const pie = createRenderer(ChartWidget, { attrs: pieAttrs }, [640, { start: 0, span: 2 }, {}, 1])()
    assert.equal(pie.props['aria-label'], zh ? '每周 Sales（pie），收入（2 个切片）' : '每周 Sales (pie), 收入 (2 slices)')
    assert.equal(byType(pie, 'svg')[0].props['aria-label'], zh ? '每周 Sales（pie）' : '每周 Sales (pie)')
    assert.equal(nodes(pie, n => n.key === 'tooltip-pie')[0].props.children, readoutFor(pieSpec, 1, locale))
    const render = createRenderer(ChartWidget, { attrs: { values: '1' } }, [640, { start: 0, span: 1 }])
    byType(render(), 'g')[0].props.onClick()
    assert.ok(text(render()).includes(zh ? '所有系列已隐藏' : 'All series hidden'))
    const emptyPie = createRenderer(ChartWidget, { attrs: { values: '0', type: 'pie' } }, [640, { start: 0, span: 1 }])()
    assert.ok(text(emptyPie).includes(zh ? '暂无数据' : 'No data'))
  })
  for (const outcome of ['done', 'reject', 'throw', 'unavailable']) {
    test(`copy ${outcome}: ${locale}`, async t => {
      const copied = []
      navigatorFor(t, { language: locale, clipboard: outcome === 'unavailable' ? undefined : {
        writeText(raw) {
          copied.push(raw)
          if (outcome === 'throw') throw new Error('denied')
          return outcome === 'reject' ? Promise.reject(new Error('denied')) : Promise.resolve()
        }
      } })
      const source = '::echarts{values="abc" title="原文"}'
      const widget = ChartWidget({ attrs: { values: 'abc' }, source })
      const render = createRenderer(widget.type, widget.props)
      const tree = render()
      assert.equal(byType(tree, 'pre')[0].props.children, source)
      byType(tree, 'button')[0].props.onClick()
      await Promise.resolve()
      assert.deepEqual(copied, outcome === 'unavailable' ? [] : [source])
      assert.equal(byType(render(), 'button')[0].props.children, outcome === 'done' ? (zh ? '已复制' : 'Copied') : (zh ? '复制失败，请手动选中' : 'Copy failed; select the text manually'))
    })
  }
}

test('missing Chinese translations fall back per key for literals and templates', async () => {
  // Expose internals only in the test copy, without adding a public plugin API.
  const { STRINGS, textFor, parseChartSpec: parse } = await loadPlugin({ exposeInternals: true })
  delete STRINGS.zh.copyDone
  delete STRINGS.zh.noData
  delete STRINGS.zh.badHeight
  assert.equal(textFor('zh-CN', 'copyDone'), 'Copied')
  assert.equal(parse({}, 'zh-TW').errors[0].message, errors[8][2])
  assert.deepEqual(parse({ values: '1', height: 'tall' }, 'zh').warnings, ['height "tall" is not a number; using the default of 400'])
  assert.equal(textFor('zh', 'copyIdle'), '复制原始指令')
  assert.equal(textFor('unknown', 'copyIdle'), 'Copy original directive')
})

test('English readout and pie accessibility use singular units for one item', t => {
  navigatorFor(t, null)
  const tree = createRenderer(ChartWidget, { attrs: { values: '1', type: 'pie' } }, [640, { start: 0, span: 1 }])()
  assert.equal(tree.props['aria-label'], 'Chart (pie), Value (1 slice)')
  assert.equal(live(tree), '1 category, 1 slice. Hover a data point, or focus with Tab and press ← / → to inspect values.')
})
