// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { mount, unmount } from 'svelte'
import Calendar from '../components/Calendar.svelte'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function stubFetch(): void {
  const handler = (input: any) => {
    const url = String(input)
    let body: any = null
    let ok = true
    if (url.includes('/calendar/calendars')) {
      body = { calendars: [{ href: 'cal1', displayname: 'Work' }] }
    } else if (url.includes('/calendar/events')) {
      body = { events: [] }
    } else if (url.includes('/contacts/calendars')) {
      body = { addressBooks: [{ uri: 'b1', name: 'B' }] }
    } else if (url.includes('/contacts?book=b1')) {
      body = { contacts: [{ uid: 'c1', name: 'Jane Doe', email: 'jane@example.com', org: 'Acme' }] }
    } else {
      ok = false
    }
    return Promise.resolve({
      ok,
      status: ok ? 200 : 404,
      json: async () => body
    })
  }
  globalThis.fetch = ((input: any) => handler(input)) as any
}

beforeAll(() => {
  stubFetch()
})

function makeTarget(): HTMLDivElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

let target: HTMLDivElement

beforeEach(() => {
  target = makeTarget()
  localStorage.clear()
})

afterEach(() => {
  target.remove()
})

async function openEditor(tgt: HTMLDivElement): Promise<void> {
  const btn = tgt.querySelector('button.add-evt') as HTMLButtonElement
  expect(btn).not.toBeNull()
  btn.click()
  await sleep(150)
  expect(tgt.querySelector('.modal')).not.toBeNull()
}

function attendeesLabel(tgt: HTMLDivElement): HTMLLabelElement {
  const lbl = Array.from(tgt.querySelectorAll('label')).find(
    (l) => l.querySelector('span')?.textContent === 'Attendees'
  ) as HTMLLabelElement | undefined
  expect(lbl, 'Attendees label should exist').toBeDefined()
  return lbl!
}

describe('Calendar Attendees field uses shared RecipientAutocomplete', () => {
  it('input inside the Attendees label is the autocomplete input (class ra-input)', async () => {
    const c = mount(Calendar as any, { target, props: { showToast: () => {} } } as any)
    await sleep(200)
    await openEditor(target)
    const label = attendeesLabel(target)
    const input = label.querySelector('input') as HTMLInputElement
    expect(input, 'Attendees input should exist').not.toBeNull()
    expect(input.classList.contains('ra-input')).toBe(true)
    unmount(c)
  })

  it('typing a letter shows the suggested contact; Enter commits the email', async () => {
    const c = mount(Calendar as any, { target, props: { showToast: () => {} } } as any)
    await sleep(250)
    await openEditor(target)
    const label = attendeesLabel(target)
    const input = label.querySelector('input.ra-input') as HTMLInputElement
    expect(input, 'Attendees autocomplete input should exist').not.toBeNull()
    input.value = 'j'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(300)
    const row = target.querySelector('.suggestion')
    expect(row, 'suggestion row should exist for "j"').not.toBeNull()
    expect(row!.textContent).toContain('Jane')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await sleep(60)
    expect(input.value).toBe('jane@example.com')
    expect(target.querySelector('.suggestions')).toBeNull()
    unmount(c)
  })

  it('empty value in the field -> no dropdown (covers empty-books case on the wire)', async () => {
    const c = mount(Calendar as any, { target, props: { showToast: () => {} } } as any)
    await sleep(250)
    await openEditor(target)
    const label = attendeesLabel(target)
    const input = label.querySelector('input.ra-input') as HTMLInputElement
    expect(input, 'Attendees autocomplete input should exist').not.toBeNull()
    expect(input.value).toBe('')
    expect(target.querySelector('.suggestions')).toBeNull()
    unmount(c)
  })
})
