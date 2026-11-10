import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function listTestFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listTestFiles(full))
    else if (entry.name.endsWith('.test.js')) out.push(path.relative(root, full).split(path.sep).join('/'))
  }
  return out
}

describe('npm run test:server', () => {
  const script: string = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')).scripts['test:server']
  const patterns = script
    .replace(/^node\s+--test\s+/, '')
    .split(/\s+/)
    .map((p) => p.replace(/^['"]|['"]$/g, ''))

  it('passes globs, not a bare directory', () => {
    // On Node 22 `node --test server` runs server/index.js as ONE test (it just
    // starts the app and passes), so CI silently skipped every *.test.js file.
    expect(script).toMatch(/^node\s+--test\s+\S/)
    for (const pattern of patterns) expect(pattern).toMatch(/\.test\.js$/)
  })

  it('covers every server test file', () => {
    const files = listTestFiles(path.join(root, 'server'))
    expect(files.length).toBeGreaterThan(8)
    const missed = files.filter((f) => !patterns.some((p) => path.matchesGlob(f, p)))
    expect(missed).toEqual([])
  })
})
