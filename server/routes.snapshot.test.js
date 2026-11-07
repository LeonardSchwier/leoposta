import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './index.js'

// C6 snapshot test: record the sorted METHOD path pairs of createApp()
// (walk app.router.stack) into server/routes.snapshot.json and compare.
const SNAPSHOT = path.join(fileURLToPath(new URL('.', import.meta.url)), 'routes.snapshot.json')

function collect(stack, base = '') {
  const out = new Set()
  for (const layer of stack || []) {
    if (layer.route) {
      const p = layer.route.path || ''
      for (const method of Object.keys(layer.route.methods)) {
        out.add(`${method.toUpperCase()} ${base}${p}`)
      }
    } else if (layer.handle && layer.handle.stack) {
      // sub-router (mounted via app.use); base is the mount path if known
      for (const m of collect(layer.handle.stack, base)) out.add(m)
    }
  }
  return out
}

test('server/routes.snapshot.json matches the mounted routes', () => {
  const app = createApp()
  const routes = [...collect(app.router?.stack)].sort()
  assert.ok(routes.length > 0, 'expected at least one route to be registered')

  if (!fs.existsSync(SNAPSHOT)) {
    fs.writeFileSync(SNAPSHOT, JSON.stringify(routes, null, 2) + '\n')
    return
  }

  const prev = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf-8'))
  assert.deepEqual(routes, prev)
})
