import { describe, it, expect } from 'vitest'
import { contactToVCFObj } from '../lib/vcf'

const unfold = (s: string) => s.replace(/\r\n[ \t]/g, '')

describe('contactToVCFObj', () => {
  it('escapes TEXT values so a multi-line note or comma cannot break the card', () => {
    const v = unfold(contactToVCFObj({ uid: 'u1', name: 'Doe, Jane', notes: 'line 1\nline 2; more' }))
    expect(v).toContain('FN:Doe\\, Jane\r\n')
    expect(v).toContain('NOTE:line 1\\nline 2\\; more\r\n')
    expect(v.split('\r\n').filter(l => l.startsWith('line 2'))).toEqual([])
  })
  it('writes the required N property and the street in the street slot of ADR', () => {
    const v = contactToVCFObj({ uid: 'u1', name: 'Jane Q Doe', addressComponents: { street: 'Hauptstr. 1', locality: 'Köln', postalCode: '50667' } })
    expect(v).toContain('N:Doe;Jane Q;;;\r\n')
    expect(v).toContain('ADR;TYPE=HOME:;;Hauptstr. 1;Köln;;50667;\r\n')
  })
  it('folds long unicode lines at 75 octets without splitting a character', () => {
    const v = contactToVCFObj({ uid: 'u1', name: 'Ü'.repeat(60) + '😀'.repeat(10) })
    for (const l of v.split('\r\n')) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75)
    expect(unfold(v)).toContain('FN:' + 'Ü'.repeat(60) + '😀'.repeat(10) + '\r\n')
    expect(v).not.toContain('�')
  })
  it('editing keeps properties the editor does not show (second e-mail, BDAY, PHOTO, version)', () => {
    const base = ['BEGIN:VCARD', 'VERSION:4.0', 'UID:abc', 'FN:Old', 'EMAIL:first@x.test', 'EMAIL:second@x.test',
      'TEL:tel:+1', 'BDAY:19900101', 'PHOTO:data:image/png;base64,AAAA', 'NOTE:old', 'END:VCARD'].join('\r\n')
    const v = unfold(contactToVCFObj({ uid: 'abc', name: 'New Name', email: 'changed@x.test' }, base))
    expect(v).toContain('VERSION:4.0\r\n')
    expect(v).toContain('EMAIL:changed@x.test\r\n')
    expect(v).toContain('EMAIL:second@x.test\r\n')
    expect(v).not.toContain('first@x.test')
    expect(v).not.toContain('tel:+1') // phone field was cleared
    expect(v).toContain('BDAY:19900101')
    expect(v).toContain('PHOTO:data:image/png;base64,AAAA')
    expect(v).not.toContain('NOTE:old')
    expect(v.match(/^UID:/gm)).toHaveLength(1)
    expect(v.match(/^FN:/gm)).toHaveLength(1)
  })
  it('a new contact without uid gets a unique one (no collision between two "John"s)', () => {
    const a = /UID:(.*)\r\n/.exec(contactToVCFObj({ name: 'John' }))![1]
    const b = /UID:(.*)\r\n/.exec(contactToVCFObj({ name: 'John' }))![1]
    expect(a).not.toBe(b)
  })
})
