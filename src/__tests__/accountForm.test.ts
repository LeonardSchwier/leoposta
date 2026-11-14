import { describe, it, expect } from 'vitest'
import { accountSavePayload, type AccountFormValues } from '../lib/accountForm'

const base: AccountFormValues = {
  editing: true, name: 'Me', email: 'me@example.test',
  imapHost: 'imap.example.test', imapPort: '143', imapTls: false,
  smtpHost: 'smtp.example.test', smtpPort: '587', smtpTls: false,
  davUrl: '', davUser: '', davPass: '', password: '',
  signature: { enabled: true, text: 'Gruß', position: 'after_quote' }
}

describe('accountSavePayload', () => {
  it('sends an emptied DAV URL/user as "" so the server clears them (JSON drops undefined)', () => {
    const body = JSON.parse(JSON.stringify(accountSavePayload(base)))
    expect(body.davUrl).toBe('')
    expect(body.davUser).toBe('')
  })
  it('asks the server to verify the login before saving', () => {
    expect(accountSavePayload(base).verify).toBe(true)
  })
  it('omits passwords that were not typed (edit keeps them) and sends typed ones', () => {
    const p = accountSavePayload(base)
    expect('imapPass' in p || 'smtpPass' in p || 'davPass' in p).toBe(false)
    const q = accountSavePayload({ ...base, password: 'pw', davPass: 'dp' })
    expect([q.imapPass, q.smtpPass, q.davPass]).toEqual(['pw', 'pw', 'dp'])
  })
  it('keeps ports, TLS toggles and the signature', () => {
    const p = accountSavePayload(base)
    expect([p.imapPort, p.imapTls, p.smtpPort, p.smtpTls]).toEqual([143, false, 587, false])
    expect(p.signature).toEqual(base.signature)
  })
})
