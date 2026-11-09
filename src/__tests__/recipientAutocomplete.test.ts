// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { mount, unmount } from 'svelte'
import RecipientAutocomplete from '../components/RecipientAutocomplete.svelte'
import ParentWrapper from './ParentWrapper.svelte'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function pickBody(u: string): any {
  if (u.includes('/contacts/calendars')) {
    return { addressBooks: [{ uri: 'b1', name: 'B' }] }
  }
  if (u.includes('/contacts?book=b1')) {
    return {
      contacts: [
        { uid: 'c1', name: 'Jane Doe', email: 'jane@example.com', org: 'Acme' }
      ]
    }
  }
  throw new Error('unhandled fetch ' + u)
}

beforeAll(() => {
  globalThis.fetch = ((input: any) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => pickBody(String(input))
    })) as any
})

function makeTarget(): HTMLDivElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

const targets: HTMLDivElement[] = []
beforeEach(() => {
  targets.forEach((t) => t.remove())
  targets.length = 0
})

describe('RecipientAutocomplete', () => {
  it('case 1: empty value -> no dropdown', async () => {
    const target = makeTarget()
    targets.push(target)
    const c = mount(RecipientAutocomplete as any, {
      target,
      props: { value: '', placeholder: 'recipient@example.com' }
    })
    await sleep(250)
    expect(target.querySelector('.suggestions')).toBeNull()
    unmount(c)
  })

  it('case 2: value "j" -> one suggestion row, aria-selected false, contains Jane', async () => {
    const target = makeTarget()
    targets.push(target)
    const c = mount(RecipientAutocomplete as any, {
      target,
      props: { value: 'j', placeholder: 'recipient@example.com' }
    })
    await sleep(250)
    const list = target.querySelector('.suggestions')
    expect(list).not.toBeNull()
    const rows = list!.querySelectorAll('.suggestion')
    expect(rows.length).toBe(1)
    expect(rows[0].getAttribute('aria-selected')).toBe('false')
    expect(rows[0].textContent).toContain('Jane')
    const input = target.querySelector('input.ra-input') as HTMLInputElement
    expect(input.value).toBe('j')
    unmount(c)
  })

  it('case 3: Enter on a highlighted suggestion commits the contact email', async () => {
    const target = makeTarget()
    targets.push(target)
    const c = mount(RecipientAutocomplete as any, {
      target,
      props: { value: 'j', placeholder: 'recipient@example.com' }
    })
    await sleep(250)
    const input = target.querySelector('input.ra-input') as HTMLInputElement
    expect(input).not.toBeNull()
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    )
    await sleep(30)
    expect(input.value).toContain('jane@example.com')
    expect(target.querySelector('.suggestions')).toBeNull()
    expect(input.value).toBe('jane@example.com')
    unmount(c)
  })

  it('case 4: Enter with raw text and no suggestion keeps the raw value', async () => {
    const target = makeTarget()
    targets.push(target)
    const c = mount(RecipientAutocomplete as any, {
      target,
      props: { value: 'noone@nowhere.test', placeholder: 'recipient@example.com' }
    })
    await sleep(250)
    const input = target.querySelector('input.ra-input') as HTMLInputElement
    expect(input).not.toBeNull()
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    )
    await sleep(30)
    expect(input.value).toBe('noone@nowhere.test')
    expect(target.querySelector('.suggestions')).toBeNull()
    unmount(c)
  })

  it('case 5: parent writes value from outside -> dropdown appears (Fix 2 $effect)', async () => {
    const target = makeTarget()
    targets.push(target)
    const c = mount(ParentWrapper as any, { target, props: {} } as any)
    await sleep(300)
    expect(target.querySelector('.suggestions')).toBeNull()
    ;(c as any).setValue('j')
    await sleep(350)
    const list = target.querySelector('.suggestions')
    expect(list).not.toBeNull()
    expect(list!.querySelectorAll('.suggestion').length).toBe(1)
    unmount(c)
  })
})
