// Builds OpenPGP test mail (used by server/pgp.test.js and the real-stack
// e2e suite): inline-armored text/plain and RFC 3156 PGP/MIME messages,
// optionally signed and with an encrypted attachment.
import crypto from 'node:crypto'
import * as openpgp from 'openpgp'
import MailComposer from 'nodemailer/lib/mail-composer/index.js'

/** Generate a key pair. type: 'ecc' (curve25519) | 'rsa' (3072). */
export async function makeKey({ type = 'ecc', email = 'me@example.test', passphrase } = {}) {
  const opts = type === 'rsa'
    ? { type: 'rsa', rsaBits: 3072 }
    : { type: 'ecc', curve: 'curve25519Legacy' }
  const k = await openpgp.generateKey({ ...opts, userIDs: [{ name: 'Test', email }], passphrase, format: 'armored' })
  return { privateKey: k.privateKey, publicKey: k.publicKey, passphrase }
}

async function encryptText(text, recipientPublic, { signWith, signPassphrase } = {}) {
  const encryptionKeys = await openpgp.readKey({ armoredKey: recipientPublic })
  let signingKeys
  if (signWith) {
    const k = await openpgp.readPrivateKey({ armoredKey: signWith })
    signingKeys = k.isDecrypted() ? k : await openpgp.decryptKey({ privateKey: k, passphrase: signPassphrase })
  }
  return openpgp.encrypt({ message: await openpgp.createMessage({ text }), encryptionKeys, signingKeys })
}

async function build(mail) {
  return new MailComposer(mail).compile().build()
}

/** text/plain mail whose body is an armored PGP MESSAGE of `text`. */
export async function inlineEncrypted({ from, to, subject, text, publicKey, signWith, signPassphrase }) {
  const armored = await encryptText(text, publicKey, { signWith, signPassphrase })
  return build({ from, to, subject, text: armored })
}

/**
 * RFC 3156 multipart/encrypted mail. The encrypted entity is a MIME part
 * (text/plain, plus `attachments` → multipart/mixed).
 */
export async function pgpMimeEncrypted({ from, to, subject, text, attachments = [], publicKey, signWith, signPassphrase }) {
  const inner = (await build({ text, attachments })).toString('utf-8')
  // MailComposer adds top-level headers (Message-ID, Date, MIME-Version…);
  // keep only the entity headers RFC 3156 encrypts.
  const sep = inner.indexOf('\r\n\r\n')
  const headers = inner.slice(0, sep).split(/\r\n(?![ \t])/).filter(h => /^content-/i.test(h)).join('\r\n')
  const entity = headers + '\r\n\r\n' + inner.slice(sep + 4)
  const armored = await encryptText(entity, publicKey, { signWith, signPassphrase })
  const boundary = '----leoposta-pgp-' + crypto.randomBytes(12).toString('hex')
  const head = await build({ from, to, subject, text: 'x' })
  const h = head.toString('utf-8')
  const outerHeaders = h.slice(0, h.indexOf('\r\n\r\n')).split(/\r\n(?![ \t])/).filter(l => !/^content-/i.test(l))
  return Buffer.from([
    ...outerHeaders,
    `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${boundary}"`,
    '',
    'This is an OpenPGP/MIME encrypted message (RFC 4880 and 3156)',
    `--${boundary}`,
    'Content-Type: application/pgp-encrypted',
    'Content-Description: PGP/MIME version identification',
    '',
    'Version: 1',
    '',
    `--${boundary}`,
    'Content-Type: application/octet-stream; name="encrypted.asc"',
    'Content-Description: OpenPGP encrypted message',
    'Content-Disposition: inline; filename="encrypted.asc"',
    '',
    armored.replace(/\r?\n/g, '\r\n').trimEnd(),
    '',
    `--${boundary}--`,
    ''
  ].join('\r\n'), 'utf-8')
}
