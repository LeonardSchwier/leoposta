import type { Signature } from './signature'

export interface AccountFormValues {
  editing: boolean
  name: string
  email: string
  imapHost: string
  imapPort: string
  imapTls: boolean
  smtpHost: string
  smtpPort: string
  smtpTls: boolean
  davUrl: string
  davUser: string
  davPass: string
  password: string
  signature: Signature
}

/**
 * The body Settings sends to POST/PUT /api/accounts.
 * - verify: the server logs in to IMAP and SMTP first and saves nothing when
 *   that fails (wrong password, wrong host).
 * - DAV URL/user are always sent, '' included, so clearing the field clears
 *   the setting (undefined used to be dropped by JSON and kept the old value).
 * - Passwords are only sent when typed: an empty field on edit keeps them.
 */
export function accountSavePayload(v: AccountFormValues): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    verify: true,
    name: v.name.trim() || v.email.split('@')[0],
    email: v.email.trim(),
    imapHost: v.imapHost.trim(),
    imapPort: parseInt(v.imapPort, 10) || 993,
    imapTls: v.imapTls,
    smtpHost: v.smtpHost.trim(),
    smtpPort: parseInt(v.smtpPort, 10) || 465,
    smtpTls: v.smtpTls,
    davUrl: v.davUrl.trim(),
    davUser: v.davUser.trim(),
    imapUser: v.email.trim(),
    smtpUser: v.email.trim(),
    signature: v.signature
  }
  if (v.davPass) payload.davPass = v.davPass
  if (v.password) { payload.imapPass = v.password; payload.smtpPass = v.password }
  return payload
}
