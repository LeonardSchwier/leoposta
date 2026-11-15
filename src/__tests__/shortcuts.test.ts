import { describe, it, expect } from 'vitest'
import { globalShortcut, KEYBOARD_HELP } from '../lib/shortcuts'

const k = (key: string, mods: { ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean } = {}) =>
  ({ key, ctrlKey: false, metaKey: false, altKey: false, ...mods })

describe('globalShortcut', () => {
  it("'?' opens the keyboard help, not the palette", () => {
    expect(globalShortcut(k('?'), false)).toBe('help')
  })
  it("'?' while typing (search box, palette input, Compose) is just a character", () => {
    expect(globalShortcut(k('?'), true)).toBeNull()
  })
  it("'?' with a modifier is not the help", () => {
    expect(globalShortcut(k('?', { ctrlKey: true }), false)).toBeNull()
    expect(globalShortcut(k('?', { altKey: true }), false)).toBeNull()
  })
  it('Ctrl/Cmd+K opens the palette, also while typing', () => {
    expect(globalShortcut(k('k', { ctrlKey: true }), false)).toBe('palette')
    expect(globalShortcut(k('K', { metaKey: true }), true)).toBe('palette')
    expect(globalShortcut(k('k'), false)).toBeNull()
  })
  it('the help names both shortcuts', () => {
    expect(KEYBOARD_HELP).toMatch(/Ctrl\+K palette/)
    expect(KEYBOARD_HELP).toMatch(/\? this help/)
  })
})
