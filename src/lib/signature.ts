import type { MailAccount } from '../store'

export interface Signature {
  enabled: boolean
  text: string
  position: 'standard' | 'after_quote'
}

export const DEFAULT_SIGNATURE: Signature = { enabled: false, text: '', position: 'standard' }

export function normalizeSignature(raw?: Partial<Signature> | null): Signature {
  if (!raw) return { ...DEFAULT_SIGNATURE }
  return {
    enabled: raw.enabled ?? false,
    text: raw.text ?? '',
    position: raw.position === 'after_quote' ? 'after_quote' : 'standard'
  }
}

export type NormalizedAccount = Omit<MailAccount, 'id'> & { signature: Signature }

export function normalizeAccount(raw: Record<string, unknown>): NormalizedAccount {
  const sig = normalizeSignature(raw.signature as Partial<Signature> | undefined)
  const { signature: _omit, ...rest } = raw
  void _omit
  return { ...rest, signature: sig } as unknown as NormalizedAccount
}

function isSigActive(sig: Signature): boolean {
  return sig.enabled && sig.text.trim().length > 0
}

export function buildMessageBody(
  sig: Signature,
  replyText: string,
  original?: string | null
): string {
  const active = isSigActive(sig)
  const hasQuote = original !== undefined && original !== null

  if (!hasQuote) {
    return active ? sig.text : ''
  }

  const orig = original as string
  const head = replyText ? replyText + '\n' : ''

  if (sig.position === 'standard') {
    if (active) {
      return head + '\n' + sig.text + '\n\n--\n' + orig
    }
    return head + '\n--\n' + orig
  }

  // after_quote
  const tail = active ? '\n\n' + sig.text : ''
  return head + '\n--\n' + orig + tail
}
