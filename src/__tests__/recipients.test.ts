import { describe, it, expect } from 'vitest'
import { splitRecipients, recipientAddress, segments } from '../lib/recipients'

describe('splitRecipients', () => {
  it('keeps display names with spaces and non-ASCII letters', () => {
    expect(splitRecipients('Anna Älter <anna@x.test>, bob@x.test')).toEqual(['Anna Älter <anna@x.test>', 'bob@x.test'])
  })
  it('does not split on separators inside quotes or angle brackets', () => {
    expect(splitRecipients('"Doe, John" <j@x.test>; "A;B" <ab@x.test>')).toEqual(['"Doe, John" <j@x.test>', '"A;B" <ab@x.test>'])
  })
  it('splits bare addresses separated only by whitespace', () => {
    expect(splitRecipients('a@x.test b@x.test,  c@x.test ,')).toEqual(['a@x.test', 'b@x.test', 'c@x.test'])
  })
  it('empty and separator-only input gives no recipients', () => {
    expect(splitRecipients('')).toEqual([])
    expect(splitRecipients(' , ; ')).toEqual([])
  })
})

describe('recipientAddress / segments', () => {
  it('extracts the address part', () => {
    expect(recipientAddress('Anna Älter <anna@x.test>')).toBe('anna@x.test')
    expect(recipientAddress(' bob@x.test ')).toBe('bob@x.test')
  })
  it('reports an open quote at the end', () => {
    expect(segments('a@x.test, "Doe').open).toBe(true)
    expect(segments('a@x.test, "Doe" <d@x.test>').open).toBe(false)
  })
})
