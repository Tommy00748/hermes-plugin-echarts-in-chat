/**
 * Test-only loader for `desktop/plugin.js`.
 *
 * A Desktop plugin may only statically import `@hermes/plugin-sdk` / `react*`,
 * so the parser cannot live in a sibling module the plugin imports (a relative
 * specifier fails the loader allowlist). The tests therefore read the real
 * source, rewrite its three bare imports to local stubs, write the copy into a
 * throwaway temp directory, and import that. Zero dependencies — plain
 * `node --test`. Nothing here ships to the Desktop app; `desktop/` is untouched.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginPath = join(here, '..', 'desktop', 'plugin.js')

const SDK_STUB = `
export const TRANSCRIPT_DIRECTIVE_AREA = 'transcript.directives'
`

const REACT_STUB = `
export const useEffect = () => {}
export const useMemo = fn => fn()
export const useRef = value => ({ current: value === undefined ? null : value })
let current = null
export const useState = initial => {
  if (!current) return [typeof initial === 'function' ? initial() : initial, () => {}]
  const store = current
  const index = store.cursor++
  if (!(index in store.values)) store.values[index] = typeof initial === 'function' ? initial() : initial
  return [store.values[index], next => {
    store.values[index] = typeof next === 'function' ? next(store.values[index]) : next
  }]
}
// A controlled component render; effects/DOM remain stubbed. Seeds let tests
// supply a measured width and zoom view without a browser ResizeObserver.
export function createRenderer(Component, props, seeds = []) {
  const store = { values: [...seeds], cursor: 0 }
  return () => {
    store.cursor = 0
    current = store
    try { return Component(props) } finally { current = null }
  }
}
`

const JSX_STUB = `
export const Fragment = Symbol('Fragment')
export function jsx(type, props, key) { return { type, props: props || {}, key } }
export function jsxs(type, props, key) { return { type, props: props || {}, key } }
`

/** Rewrite the plugin's bare imports to sibling stub modules. */
export function rewriteImports(source) {
  return source
    .replace(/from '@hermes\/plugin-sdk'/g, "from './sdk-stub.mjs'")
    .replace(/from 'react\/jsx-runtime'/g, "from './jsx-runtime-stub.mjs'")
    .replace(/from 'react'/g, "from './react-stub.mjs'")
}

export async function loadPlugin({ exposeInternals = false } = {}) {
  const source = await readFile(pluginPath, 'utf8')
  const dir = await mkdtemp(join(tmpdir(), 'echarts-plugin-'))
  await writeFile(join(dir, 'sdk-stub.mjs'), SDK_STUB)
  await writeFile(join(dir, 'react-stub.mjs'), REACT_STUB)
  await writeFile(join(dir, 'jsx-runtime-stub.mjs'), JSX_STUB)
  await writeFile(join(dir, 'plugin.mjs'), rewriteImports(source) + (exposeInternals ? '\nexport { STRINGS, textFor }' : ''))
  const mod = await import(pathToFileURL(join(dir, 'plugin.mjs')).href)
  // Keep the temp dir alive for the process lifetime; clean up on exit.
  process.once('exit', () => {
    rm(dir, { recursive: true, force: true }).catch(() => {})
  })
  const { createRenderer } = await import(pathToFileURL(join(dir, 'react-stub.mjs')).href)
  return { ...mod, createRenderer }
}

/** Depth-first text extraction from the stub element tree. */
export function collectText(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (typeof node === 'object') {
    if (typeof node.type === 'function') {
      collectText(node.type(node.props || {}), out)
      return out
    }
    const props = node.props || {}
    if ('children' in props) collectText(props.children, out)
    return out
  }
  return out
}

/** Collect every `type` used anywhere in the tree (host tags and components). */
export function collectTypes(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectTypes(child, out)
    return out
  }
  if (typeof node.type === 'string') out.push(node.type)
  else if (typeof node.type === 'function') {
    out.push(node.type.name || 'anonymous')
    collectTypes(node.type(node.props || {}), out)
    return out
  }
  const props = node.props || {}
  if ('children' in props) collectTypes(props.children, out)
  return out
}
