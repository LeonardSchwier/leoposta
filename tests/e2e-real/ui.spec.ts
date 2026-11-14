// Global UI quality across the main screens, against the real stack:
// console hygiene, dark mode contrast, responsive layout, split-handle drags,
// keyboard focus, toasts, Escape on dialogs, first paint.
//
// Screenshots land in .e2e-real/ui/<project>/ for human review.
import fs from 'node:fs'
import { test, expect, type Mailbox } from './fixtures'
import type { Page } from '@playwright/test'

const SHOTS = '.e2e-real/ui'

async function seedSome(mailbox: Mailbox) {
  await mailbox.seed('INBOX', [
    { subject: 'Quarterly numbers', text: 'Hi,\n\nthe quarterly numbers are attached.\n\nBest, Ana', from: 'Ana Example <ana@example.test>' },
    { subject: 'Lunch on Friday?', text: 'Are you free for lunch on Friday?', from: 'Bob <bob@example.test>', flags: ['\\Seen'] },
    { subject: 'A newsletter with HTML', html: '<h1>News</h1><p>Some <a href="https://example.test/">link</a> and <b>bold</b> text.</p>', from: 'News <news@example.test>' }
  ])
}

type Screen = { name: string; open: (p: Page) => Promise<void>; ready: (p: Page) => Promise<void>; close?: (p: Page) => Promise<void> }

const screens: Screen[] = [
  {
    name: 'mail',
    open: async (p) => { await p.locator('.message-row', { hasText: 'Quarterly numbers' }).click() },
    ready: async (p) => { await expect(p.locator('.message-view')).toContainText('quarterly numbers are attached') }
  },
  {
    name: 'compose',
    open: async (p) => { await p.locator('.sidebar').getByRole('button', { name: /compose/i }).click() },
    ready: async (p) => { await expect(p.locator('.modal.compose, .compose').first()).toBeVisible() },
    close: async (p) => { await p.keyboard.press('Escape') }
  },
  {
    name: 'settings',
    open: async (p) => { await p.locator('.sidebar').getByRole('button', { name: /settings/i }).click() },
    ready: async (p) => { await expect(p.getByRole('dialog', { name: 'Settings' })).toBeVisible() },
    close: async (p) => { await p.keyboard.press('Escape') }
  },
  {
    name: 'calendar',
    open: async (p) => { await p.locator('.sidebar').getByRole('button', { name: /calendar/i }).click() },
    ready: async (p) => { await expect(p.locator('.cal-main')).toBeVisible() }
  },
  {
    name: 'contacts',
    open: async (p) => { await p.locator('.sidebar').getByRole('button', { name: /contacts/i }).click() },
    ready: async (p) => { await expect(p.locator('.c-body')).toBeVisible() }
  },
  {
    name: 'palette',
    open: async (p) => { await p.keyboard.press('Control+k') },
    ready: async (p) => { await expect(p.getByRole('dialog', { name: 'Command palette' })).toBeVisible() },
    close: async (p) => { await p.keyboard.press('Escape') }
  }
]

async function goMail(p: Page) {
  await p.locator('.sidebar').getByRole('button', { name: /inbox/i }).first().click()
  await expect(p.locator('.message-row').first()).toBeVisible()
}

function shot(project: string, name: string) {
  const dir = `${SHOTS}/${project}`
  fs.mkdirSync(dir, { recursive: true })
  return `${dir}/${name}.png`
}

/** In-page WCAG contrast check of every visible text node's element. */
async function lowContrast(p: Page, min = 4.5) {
  return p.evaluate((min) => {
    const parse = (c: string) => {
      const m = c.match(/rgba?\(([^)]+)\)/)
      if (!m) return null
      const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number)
      return { r, g, b, a }
    }
    const lum = ({ r, g, b }: { r: number; g: number; b: number }) => {
      const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const blend = (fg: { r: number; g: number; b: number; a: number }, bg: { r: number; g: number; b: number }) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a)
    })
    const bgOf = (el: Element | null): { r: number; g: number; b: number } => {
      const chain: { r: number; g: number; b: number; a: number }[] = []
      for (let e = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor)
        if (c && c.a > 0) { chain.push(c); if (c.a >= 1) break }
      }
      let base = { r: 255, g: 255, b: 255 }
      const root = parse(getComputedStyle(document.documentElement).backgroundColor)
      if (root && root.a > 0 && chain.every((c) => c.a < 1)) base = root
      for (const c of chain.reverse()) base = blend(c, base)
      return base
    }
    const out: string[] = []
    const seen = new Set<Element>()
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement
      if (!el || seen.has(el) || !n.textContent?.trim()) continue
      seen.add(el)
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
      if (el.closest('[aria-hidden="true"], .empty-icon')) continue
      // Covered (e.g. behind a modal backdrop): not what the user reads.
      const hit = document.elementFromPoint(Math.min(r.left + r.width / 2, innerWidth - 1), Math.min(r.top + r.height / 2, innerHeight - 1))
      if (!hit || !(hit === el || el.contains(hit) || hit.contains(el))) continue
      let opacity = 1
      for (let e: Element | null = el; e; e = e.parentElement) opacity *= Number(getComputedStyle(e).opacity)
      const fg0 = parse(cs.color)
      if (!fg0) continue
      const bg = bgOf(el)
      const fg = blend({ ...fg0, a: fg0.a * opacity }, bg)
      const L1 = lum(fg), L2 = lum(bg)
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)
      const large = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && Number(cs.fontWeight) >= 700)
      const isDisabled = (el as HTMLButtonElement).disabled || !!el.closest('button:disabled, [aria-disabled="true"]')
      if (isDisabled) continue
      // A lone glyph (☆, ✕, ⚙) is a graphical object: WCAG 1.4.11 asks 3:1.
      const glyph = !/[\p{L}\p{N}]/u.test(n.textContent)
      if (ratio < (large || glyph ? 3 : min)) {
        out.push(`${ratio.toFixed(2)} ${el.tagName.toLowerCase()}.${[...el.classList].join('.')} "${n.textContent.trim().slice(0, 30)}" fg=${cs.color} bg=rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`)
      }
    }
    return out
  }, min)
}

test.describe('every main screen', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test.describe(scheme, () => {
      test.use({ colorScheme: scheme })
      test(`renders cleanly with readable contrast (${scheme})`, async ({ mailbox, app }, info) => {
        const warnings: string[] = []
        app.on('console', (m) => { if (m.type() === 'warning') warnings.push(m.text()) })
        await seedSome(mailbox)
        await app.reload()
        await expect(app.locator('.message-row').first()).toBeVisible()
        const problems: string[] = []
        for (const s of screens) {
          if (s.name !== 'mail' && s.name !== 'palette') await goMail(app)
          await s.open(app)
          await s.ready(app)
          await app.waitForTimeout(400) // animations
          await app.screenshot({ path: shot(info.project.name, `${scheme}-${s.name}`) })
          for (const l of await lowContrast(app)) problems.push(`${s.name}: ${l}`)
          if (s.close) {
            await s.close(app)
          }
        }
        expect(problems, 'text below WCAG AA contrast').toEqual([])
        expect(warnings, 'console warnings').toEqual([])
      })
    })
  }
})

/** Visible controls that are cut off by the viewport or covered by something else. */
async function brokenControls(p: Page) {
  return p.evaluate(() => {
    const out: string[] = []
    const scrollClip = (el: Element, r: DOMRect) => {
      // Controls scrolled out of a scroll container (list rows, a toolbar
      // that scrolls sideways) are reachable by scrolling: fine. Only the
      // axis that actually scrolls counts; overflow: hidden clipping does not.
      for (let e = el.parentElement; e; e = e.parentElement) {
        const cs = getComputedStyle(e)
        const pr = e.getBoundingClientRect()
        const sy = /(auto|scroll)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight
        const sx = /(auto|scroll)/.test(cs.overflowX) && e.scrollWidth > e.clientWidth
        if (sy && (r.top < pr.top || r.bottom > pr.bottom)) return true
        if (sx && (r.left < pr.left || r.right > pr.right)) return true
      }
      return false
    }
    const name = (el: Element) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} "${(el.getAttribute('aria-label') || el.textContent || (el as HTMLInputElement).placeholder || '').trim().slice(0, 24)}"`
    for (const el of document.querySelectorAll('button, input:not([type=hidden]), select, textarea, a[href], [role=button], [role=separator]')) {
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden') continue
      if (el.closest('.message-body, iframe, [aria-hidden="true"]')) continue
      if (scrollClip(el, r)) continue
      if (r.right > innerWidth + 1 || r.left < -1 || r.bottom > innerHeight + 1 || r.top < -1) { out.push(`cut off: ${name(el)} [${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}] vw=${innerWidth}`); continue }
      const x = r.left + r.width / 2, y = r.top + r.height / 2
      const hit = document.elementFromPoint(x, y)
      if (!hit || !(hit === el || el.contains(hit) || hit.contains(el))) out.push(`covered: ${name(el)} by ${hit ? name(hit) : 'nothing'}`)
    }
    return out
  })
}

test.describe('responsive', () => {
  for (const width of [420, 768, 1180, 1600]) {
    test(`no cut-off or overlapping controls at ${width}px`, async ({ mailbox, app }, info) => {
      await seedSome(mailbox)
      await app.setViewportSize({ width, height: 800 })
      await app.reload()
      await expect(app.locator('.message-row').first()).toBeVisible()
      expect(await brokenControls(app), 'list view').toEqual([])
      await app.screenshot({ path: shot(info.project.name, `w${width}-list`) })
      await app.locator('.message-row', { hasText: 'Quarterly numbers' }).click()
      await expect(app.locator('.message-view')).toContainText('quarterly numbers are attached')
      await app.waitForTimeout(300)
      await app.screenshot({ path: shot(info.project.name, `w${width}-message`) })
      // The reading pane gets a readable width (not a sliver next to the list).
      const view = (await app.locator('.message-view').boundingBox())!
      expect(view.width, 'reading pane width').toBeGreaterThanOrEqual(Math.min(320, width - 70))
      expect(view.x + view.width, 'reading pane runs off screen').toBeLessThanOrEqual(width + 1)
      expect(await brokenControls(app), 'message open').toEqual([])
    })
  }
})

test.describe('split handles', () => {
  const handles = [
    { name: 'folder column', label: 'Resize folder column', col: '.sidebar' },
    { name: 'list column', label: 'Resize list column', col: '.message-list-container' }
  ]
  for (const h of handles) {
    test(`${h.name} handle drags and never sticks after release`, async ({ mailbox, app }) => {
      await mailbox.seed('INBOX', Array.from({ length: 40 }, (_, i) => ({ subject: `Filler ${i}`, text: 'x' })))
      await app.setViewportSize({ width: 1400, height: 800 })
      await app.reload()
      await expect(app.locator('.message-row').first()).toBeVisible()
      const handle = app.getByRole('separator', { name: h.label })
      const col = app.locator(h.col).first()
      const width = async () => (await col.boundingBox())!.width
      const center = async () => { const b = (await handle.boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 } }

      // 1. Plain drag: follows the pointer, stops at mouseup.
      let c = await center()
      const w0 = await width()
      await app.mouse.move(c.x, c.y)
      await app.mouse.down()
      await app.mouse.move(c.x + 60, c.y, { steps: 5 })
      await expect.poll(width).toBeCloseTo(w0 + 60, -1)
      await app.mouse.up()
      const w1 = await width()
      await app.mouse.move(c.x + 160, c.y, { steps: 5 })
      expect(await width(), 'still following the pointer after mouseup').toBe(w1)

      // 2. Released outside the window.
      c = await center()
      await app.mouse.move(c.x, c.y)
      await app.mouse.down()
      await app.mouse.move(c.x - 40, c.y, { steps: 4 })
      await app.mouse.move(-20, c.y, { steps: 4 })
      await app.mouse.up()
      const w2 = await width()
      await app.mouse.move(c.x + 200, 400, { steps: 5 })
      expect(await width(), 'stuck after release outside the window').toBe(w2)

      // 3. Release the app never sees (e.g. over a native scrollbar or another
      //    window): the next move reports no button held.
      c = await center()
      await app.mouse.move(c.x, c.y)
      await app.mouse.down()
      await app.mouse.move(c.x + 30, c.y, { steps: 3 })
      const cdp = await app.context().newCDPSession(app)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x + 50, y: c.y, button: 'none', buttons: 0 })
      const w3 = await width()
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x + 150, y: c.y, button: 'none', buttons: 0 })
      expect(await width(), 'stuck after a release that was never delivered').toBe(w3)
      await app.mouse.up()

      // 4. Released over the message list's scrollbar.
      const list = (await app.locator('.message-list').boundingBox())!
      c = await center()
      await app.mouse.move(c.x, c.y)
      await app.mouse.down()
      await app.mouse.move(list.x + list.width - 4, list.y + 100, { steps: 5 })
      await app.mouse.up()
      const w4 = await width()
      await app.mouse.move(list.x + list.width - 150, list.y + 200, { steps: 5 })
      expect(await width(), 'stuck after release over the list scrollbar').toBe(w4)

      // Body cursor / selection lock always restored.
      expect(await app.evaluate(() => [document.body.style.cursor, document.body.style.userSelect])).toEqual(['', ''])

      // 5. Pressing on the list's scrollbar never starts a drag.
      const wBefore = await width()
      const list2 = (await app.locator('.message-list').boundingBox())!
      expect(await app.locator('.message-list').evaluate((e) => e.scrollHeight > e.clientHeight), 'list must scroll for this check').toBe(true)
      await app.mouse.move(list2.x + list2.width - 4, list2.y + 50)
      await app.mouse.down()
      await app.mouse.move(list2.x + list2.width + 80, list2.y + 50, { steps: 4 })
      await app.mouse.up()
      if (h.col === '.message-list-container') expect(await width(), 'scrollbar press resized the column').toBe(wBefore)
    })
  }
})

test('keyboard focus is visible on every tab stop', async ({ mailbox, app }) => {
  await seedSome(mailbox)
  await app.reload()
  await expect(app.locator('.message-row').first()).toBeVisible()
  const invisible: string[] = []
  for (let i = 0; i < 25; i++) {
    await app.keyboard.press('Tab')
    const r = await app.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      if (!el || el === document.body) return null
      const cs = getComputedStyle(el)
      const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none'
      return { ring, el: `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24)}"` }
    })
    if (r && !r.ring) invisible.push(r.el)
  }
  expect(invisible, 'focused without a visible focus indicator').toEqual([])
})

test('toasts do not block clicks underneath', async ({ app }) => {
  await app.locator('.sidebar').getByRole('button', { name: /compose/i }).click()
  await app.getByPlaceholder(/subject/i).fill('Toast check')
  await app.getByRole('button', { name: 'Save Draft' }).click()
  const toast = app.getByTestId('toast')
  await expect(toast).toBeVisible()
  const b = (await toast.boundingBox())!
  const hit = await app.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid=toast]') != null, { x: b.x + b.width / 2, y: b.y + b.height / 2 })
  expect(hit, 'the toast intercepts pointer events').toBe(false)
})

test('modal dialogs close with Escape', async ({ app }) => {
  await app.keyboard.press('Control+k')
  await expect(app.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
  await app.keyboard.press('Escape')
  await expect(app.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0)

  await app.locator('.sidebar').getByRole('button', { name: /settings/i }).click()
  await expect(app.getByRole('dialog', { name: 'Settings' })).toBeVisible()
  await app.keyboard.press('Escape')
  await expect(app.getByRole('dialog', { name: 'Settings' })).toHaveCount(0)

  await app.locator('.sidebar').getByRole('button', { name: /compose/i }).click()
  await expect(app.getByRole('dialog', { name: 'Compose message' })).toBeVisible()
  await app.keyboard.press('Escape')
  await expect(app.getByRole('dialog', { name: 'Compose message' })).toHaveCount(0)
})

test('first load has no layout shift and no unstyled flash', async ({ mailbox, app }) => {
  await seedSome(mailbox)
  await app.addInitScript(() => {
    const w = window as unknown as { __cls: number; __firstBg: string }
    w.__cls = 0
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) if (!e.hadRecentInput) w.__cls += e.value
    }).observe({ type: 'layout-shift', buffered: true })
    document.addEventListener('DOMContentLoaded', () => { w.__firstBg = getComputedStyle(document.body).backgroundColor })
  })
  await app.reload()
  await expect(app.locator('.message-row').first()).toBeVisible()
  await app.waitForTimeout(1000)
  const r = await app.evaluate(() => {
    const w = window as unknown as { __cls: number; __firstBg: string }
    return { cls: w.__cls, firstBg: w.__firstBg, bg: getComputedStyle(document.body).backgroundColor }
  })
  expect(r.firstBg, 'body background before the app mounted').toBe(r.bg)
  expect(r.cls, 'cumulative layout shift during load').toBeLessThan(0.1)
})
