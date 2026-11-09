// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { isTypingFocused } from '../refresh'

function focus(el: HTMLElement): void {
  document.body.appendChild(el)
  el.focus()
}

describe('isTypingFocused', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    document.activeElement?.blur?.()
  })

  it('is false when body is focused', () => {
    expect(isTypingFocused()).toBe(false)
  })

  it('is true while a text input has focus', () => {
    focus(document.createElement('input'))
    expect(isTypingFocused()).toBe(true)
  })

  it('is true while a textarea has focus', () => {
    focus(document.createElement('textarea'))
    expect(isTypingFocused()).toBe(true)
  })

  it('is true while a select has focus', () => {
    focus(document.createElement('select'))
    expect(isTypingFocused()).toBe(true)
  })

  it('is true while a contenteditable has focus', () => {
    const div = document.createElement('div')
    div.setAttribute('contenteditable', 'true')
    focus(div)
    expect(isTypingFocused()).toBe(true)
  })

  it('is false while a generic button or div has focus', () => {
    focus(document.createElement('button'))
    expect(isTypingFocused()).toBe(false)
  })

  it('is false right after blur', () => {
    const el = document.createElement('input')
    focus(el)
    el.blur()
    expect(isTypingFocused()).toBe(false)
  })
})
