// @vitest-environment node
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/app.css', 'utf8')
const main = readFileSync('src/main.ts', 'utf8')

function rootBlock(): string {
  const start = css.indexOf(':root')
  return css.slice(start, css.indexOf('}', start))
}

describe('Leoforma tokens (D1)', () => {
  it('imports Leoforma fonts and tokens before the app stylesheet', () => {
    const fonts = main.indexOf("@leonardschwier/leoforma/fonts.css")
    const tokens = main.indexOf("@leonardschwier/leoforma/tokens.css")
    const app = main.indexOf("./app.css")
    expect(fonts).toBeGreaterThanOrEqual(0)
    expect(tokens).toBeGreaterThanOrEqual(0)
    expect(Math.max(fonts, tokens)).toBeLessThan(app)
  })

  it('maps every app colour variable to a Leoforma token', () => {
    const block = rootBlock()
    const colours = [...block.matchAll(/--(color-[a-z-]+|danger-bg):\s*([^;]+);/g)]
    expect(colours.length).toBeGreaterThan(10)
    for (const [, name, value] of colours) {
      expect(value, `--${name}`).toMatch(/var\(--ds-|color-mix\(/)
    }
  })

  it('has no dead .dark block, dark mode comes from the tokens', () => {
    expect(css).not.toMatch(/^\.dark\s*\{/m)
  })

  it('keeps the code block colours readable in dark mode', () => {
    expect(css).toMatch(/prefers-color-scheme:\s*dark[\s\S]*--code-bg/)
  })
})

describe('CSS variables', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = `${dir}/${name}`
      if (statSync(full).isDirectory()) {
        if (name !== '__tests__') walk(full, out)
      } else if (/\.(svelte|css|ts)$/.test(name)) out.push(full)
    }
    return out
  }

  it('defines every custom property that the source uses', () => {
    const tokens = readFileSync('node_modules/@leonardschwier/leoforma/dist/tokens.css', 'utf8')
    const defined = new Set<string>()
    const sources = walk('src').map((f) => readFileSync(f, 'utf8'))
    for (const text of [tokens, ...sources])
      for (const m of text.matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(m[1])
    const undefinedUses = new Set<string>()
    for (const text of sources)
      for (const m of text.matchAll(/var\((--[a-z0-9-]+)\s*(,[^)]*)?\)/g))
        if (!defined.has(m[1]) && !m[2]) undefinedUses.add(m[1])
    expect([...undefinedUses]).toEqual([])
  })
})
