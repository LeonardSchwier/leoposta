import { test as base, expect } from '@playwright/test'

// Fails any test that logs a console error or throws an uncaught page error.
export const test = base.extend<{ _guard: void }>({
  _guard: [
    async ({ page }, use) => {
      const problems: string[] = []
      page.on('console', (m) => {
        if (m.type() === 'error') problems.push(`console.error: ${m.text()}`)
      })
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
      await use()
      expect(problems, 'unexpected console errors').toEqual([])
    },
    { auto: true }
  ]
})
export { expect }
