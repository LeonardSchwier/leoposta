#!/usr/bin/env node
/**
 * Dummy IMAP4rev1 server — local test/screenshot target for leoposta.
 *
 * Serves:
 *   INBOX (8 mails), Sent (1 mail), Drafts (1), Archive (3), Trash (1)
 *   All credentials ignored; any user/pass pair is accepted.
 *
 * Protocol support: NOOP, LOGOUT, LOGIN, CAPABILITY, LIST, SELECT, EXAMINE,
 * FETCH (ENVELOPE|FLAGS|UID|INTERNALDATE|BODYSTRUCTURE|RFC822|RFC822.SIZE|BODY.PEEK),
 * STORE (\\Seen), SEARCH (SUBJECT|ALL), STATUS, IDLE, UID +
 *
 * Listeners:
 *   - IMAP  : 127.0.0.1:1143  (cleartext, imapTls=false in account.json)
 *
 * Logs protocol to stderr (INFO: / DEBUG:).
 */
'use strict'

const net = require('net')
const path = require('path')
const fs = require('fs')

const LISTEN_HOST = '127.0.0.1'
const LISTEN_PORT = Number(process.env.IMAP_PORT || 1143)
const SEED_FILE = process.env.LEO_IMAP_SEED || path.join(__dirname, 'seed.json')

// ---------------------------------------------------------------- seed -----
let seed
try {
  seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf-8'))
} catch (e) {
  throw new Error(`Cannot load seed at ${SEED_FILE}: ${e.message}`)
}
const FOLDERS = Object.fromEntries(seed.folders.map(f => [f.path, f]))
for (const f of Object.values(FOLDERS)) {
  f.mails = (seed.messages || []).filter(
    m => m.folder === f.path
  )
    // uid ascending
    .sort((a, b) => a.uid - b.uid)
    .map(m => ({
      uid: m.uid,
      seen: !!m.seen,
      flagged: !!m.flagged,
      date: new Date(m.date).toUTCString(),
      subject: m.subject,
      from: m.from,
      to: m.to,
      cc: m.cc || [],
      messageId: m.messageId || `<msg-${m.uid}@demo.mailbox.org>`,
      inReplyTo: m.inReplyTo || '',
      html: m.html || '',
      text: m.text || '',
      attachments: m.attachments || [],
      source: buildRFC822(m)
    }))
  f.exists = f.mails.length
  f.recent = f.mails.filter(m => !m.seen).length
  f.unseen = f.recent
}

function buildRFC822 (m) {
  const head = [
    `From: ${m.from.name} <${m.from.address}>`,
    `To: ${m.to.map(t => `${t.name} <${t.address}>`).join(', ')}`,
    m.subject ? `Subject: ${m.subject}` : null,
    m.messageId ? `Message-ID: ${m.messageId}` : null,
    m.inReplyTo ? `In-Reply-To: ${m.inReplyTo}` : null,
    m.date ? `Date: ${m.date}` : null
  ]
    .filter(Boolean)
    .join('\r\n')

  const parts = []
  if (m.html || m.text) {
    const boundary = 'leoposta-boundary-' + m.uid
    let b = ''
    b += `--${boundary}\r\n`
    b += `Content-Type: text/plain; charset="utf-8"\r\n\r\n${m.text}\r\n`
    if (m.html) {
      b += `--${boundary}\r\n`
      b += `Content-Type: text/html; charset="utf-8"\r\n\r\n${m.html}\r\n`
    }
    for (const at of m.attachments || []) {
      if (!at.filename) continue
      b += `--${boundary}\r\n`
      b += `Content-Type: ${at.contentType || 'application/octet-stream'}; name="${esc(at.filename)}"\r\n`
      b += `Content-Disposition: attachment; filename="${esc(at.filename)}"\r\n`
      b += `Content-Transfer-Encoding: base64\r\n\r\n${at.body}\r\n`
    }
    b += `--${boundary}--\r\n`
    return `${head}\r\n\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n${b}`
  }

  // Single-part message
  const ctype = m.html ? 'text/html' : 'text/plain'
  return (
    `${head}\r\n\r\nContent-Type: ${ctype}; charset="utf-8"\r\n\r\n` +
    (m.html || m.text)
  )
}
function esc (s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// ---------------------------------------------------------------- utils ----
const CAPABILITY =
  'IMAP4rev1 AUTH=PLAIN AUTH=LOGIN LOGIN-REFERRALS ID ' +
  'CHILDREN LITERAL+ SORT THROTTLED'
function log (connTag, level, msg) {
  const tag = connTag ? `[${connTag}] ` : ''
  process.stderr.write(`${new Date().toISOString()} ${tag}${level} ${msg}\n`)
}
function buf (s) {
  return Buffer.from(s, 'utf-8')
}
function q (s) {
  if (s == null) return 'NIL'
  s = String(s)
  if (/^[A-Za-z0-9 _+\-:;.()]+$/.test(s)) return `"${s}"`
  const n = Buffer.byteLength(s, 'utf-8')
  return `{${n}}\r\n${s}`
}
const nil = 'NIL'

// ---------------------------------------------------------------- socket ---
function readLine (socket, buf, cb) {
  const idx = buf.indexOf(CRLF)
  if (idx !== -1) {
    const line = buf.slice(0, idx + 2)
    cb(line, buf.slice(idx + 2))
    return true
  }
  return false
}
function readN (socket, buf, n, cb) {
  if (buf.length >= n) {
    cb(buf.slice(0, n), buf.slice(n))
    return true
  }
  return false
}
function readLiteral (socket, buf, size, cb) {
  return readN(socket, buf, size + 2, (lit, rest) =>
    cb(lit.slice(0, size), rest)
  )
}

function startServer () {
  const srv = net.createServer(onConn)
  srv.listen(LISTEN_PORT, LISTEN_HOST, () =>
    log('', 'INFO', `dummy IMAP listening on ${LISTEN_HOST}:${LISTEN_PORT}`)
  )
  // eslint-disable-next-line no-console
  console.log(`DUMMY-IMAP on ${LISTEN_HOST}:${LISTEN_PORT}`)
  return srv
}

function onConn (socket) {
  let buf = Buffer.alloc(0)
  let tag = 'conn-' + (Math.floor(Math.random() * 1e6).toString(36))
  let currentFolder = null // FOLDER object after SELECT
  log(tag, 'INFO', 'client connected')

  socket.write(buf(`* OK dummy-IMAP ready\r\n`))

  function send (s) {
    socket.write(buf(s + '\r\n'))
  }
  function sendRaw (s) {
    socket.write(buf(s))
  }

  function parseCommand (buf, onResult) {
    // Returns { tag, command, args: [{value, isLiteral}] } | null if more data needed.
    const idx = buf.indexOf(CRLF)
    if (idx === -1) return null
    let i = 0
    const parts = []
    let literal = null
    const scan = (line) => {
      const out = []
      let i2 = 0
      while (i2 < line.length) {
        // skip space
        while (i2 < line.length && line[i2] === ' ') i2++
        if (i2 >= line.length) break
        if (line[i2] === '{') {
          // literal
          let j = i2 + 1
          let n = 0
          while (j < line.length && line[j] >= '0' && line[j] <= '9') {
            n = n * 10 + (line.charCodeAt(j) - 48)
            j += 1
          }
          if (line[j] !== '}') return null // syntax error
          return { literal: { size: n, pos: i2 }, rest: '', out }
        }
        let token = ''
        while (i2 < line.length && line[i2] !== ' ' && line[i2] !== '{') {
          token += line[i2++]
        }
        if (token.length) out.push(token)
      }
      return { literal: null, rest: '', out }
    }

    const result = scan(buf.toString('utf-8', 0, idx))
    if (!result) return null
    const rest = buf.slice(idx + 2)
    if (result.literal) {
      // need literal body in the buffer (after the closing \r\n)
      if (rest.length < result.literal.size + 2) return null
      const literalValue = rest.slice(0, result.literal.size).toString('utf-8')
      const newRest = rest.slice(result.literal.size + 2)
      return {
        tag: result.out[0] || '',
        parts: result.out,
        literalValue,
        literalKind: `idx`,
        newBuf: newRest
      }
    }
    return { tag: result.out[0] || '', parts: result.out, newBuf: rest }
  }

  function handle (cmd) {
    if (!cmd) return
    const first = (cmd.parts[1] || '').toUpperCase()
    log(tag, 'DEBUG', 'CMD ' + cmd.parts.slice(1).join(' '))
    switch (first) {
      case 'CAPABILITY':
        send('* ' + CAPABILITY)
        send('* AUTH=PLAIN')
        send(`OK ${cmd.tag} CAPABILITY OK`)
        break
      case 'LOGIN':
        log(tag, 'INFO', 'LOGIN user=' + cmd.parts[2])
        send(`OK ${cmd.tag} LOGIN OK`)
        break
      case 'SELECT':
      case 'EXAMINE': {
        const name = dequote(cmd.parts[2])
        const f = FOLDERS[name]
        if (!f) {
          send(`NO ${cmd.tag} unknown mailbox ${name}`)
          currentFolder = null
          break
        }
        currentFolder = f
        send(`* ${f.exists} EXISTS`)
        send(`* 0 RECENT`)
        send(`* ${f.unseen} UNSEEN`)
        send(`* OK [UIDVALIDITY 1001]`)
        send(`* FLAGS (\\Seen \\Flagged \\Draft \\Answered \\Deleted)`)
        send(`* OK [PERMANENTFLAGS (\\Seen \\Flagged \\Draft \\Answered \\Deleted)]`)
        send(`OK ${cmd.tag} SELECT OK (READ-ONLY)`)
        break
      }
      case 'LIST': {
        const ref = dequote(cmd.parts[2] || '')
        const pat = dequote(cmd.parts[3] || '*')
        const list = Object.entries(FOLDERS).filter(
          ([p]) => patternMatch(p, pat)
        )
        for (const [p] of list) {
          const name = p.split('/').pop()
          send(`* LIST (\\HasNoChildren \\NoInferiors) "/" "${name}"`)
        }
        send(`OK ${cmd.tag} LIST OK`)
        break
      }
      case 'STATUS': {
        const folder = FOLDERS[dequote(cmd.parts[2])]
        if (!folder) {
          send(`NO ${cmd.tag} unknown mailbox`)
          break
        }
        send(
          `* STATUS ${dequote(cmd.parts[2])} (MESSAGES ${folder.exists} RECENT ${folder.recent} UNSEEN ${folder.unseen} UIDNEXT ${folder.exists + 1} UIDVALIDITY 1001)`
        )
        send(`OK ${cmd.tag} STATUS OK`)
        break
      }
      case 'SEARCH': {
        const crit = cmd.parts.slice(3).join(' ').toUpperCase()
        let uids = currentFolder ? currentFolder.mails.map(m => m.uid) : []
        const m = /SUBJECT\s+"?([^"\s]+(?:\s[^"\s]+)*?)"?/i.exec(crit)
        if (m) {
          const q = m[1].toLowerCase()
          uids = uids.filter(u => {
            const mail = currentFolder.mails.find(x => x.uid === u)
            return mail.subject.toLowerCase().includes(q)
          })
        }
        send(`* SEARCH ${uids.join(' ')}`)
        send(`OK ${cmd.tag} SEARCH OK`)
        break
      }
      case 'NOOP':
        send(`OK ${cmd.tag} NOOP OK`)
        break
      case 'TAGGED':
      case 'IDLE': {
        // Don't really hold — just respond OK (leoposta's /api/idle is for long polling)
        const idle = first === 'IDLE'
        if (idle) {
          // imapflow waits for untagged * BYE or the end-of-idle OK.
          // We respond after ~3 seconds with * OK and tag OK; imapflow will then
          // reissue IDLE.
          setTimeout(() => {
            if (socket.destroyed) return
            send(`* RECENT 1`)
            send(`OK ${cmd.tag} IDLE terminated`),
            setTimeout(() => {
              if (socket.destroyed) return
            }, 200)
          }, 3000)
        } else {
          send(`OK ${cmd.tag} OK`)
        }
        break
      }
      case 'LOGOUT':
        send('* BYE dummy-IMAP logging out')
        send(`OK ${cmd.tag} LOGOUT OK`)
        socket.end()
        break
      case 'STORE': {
        const [range, flag, ...rest] = cmd.parts.slice(2)
        const add = (rest[0] || '').toUpperCase() === 'FLAGS'
        const flags = flag
        if (!currentFolder) {
          send(`BAD ${cmd.tag} not SELECTed`)
          break
        }
        for (const mail of currentFolder.mails) {
          if (add === true) {
            if (flags.includes('Seen')) mail.seen = true
            if (flags.includes('Flagged')) mail.flagged = true
          }
        }
        currentFolder.unseen = currentFolder.mails.filter(m => !m.seen).length
        send(`OK ${cmd.tag} STORE OK`)
        break
      }
      case 'UID': {
        const sub = (cmd.parts[2] || '').toUpperCase()
        if (sub === 'FETCH' || sub === 'SEARCH' || sub === 'STORE') {
          cmd.parts = [
            cmd.parts[0],
            first,
            ...cmd.parts.slice(3)
          ]
          // Re-dispatch
          return handle(cmd)
        }
        send(`BAD ${cmd.tag} UID ${sub} not supported`)
        break
      }
      case 'FETCH': {
        handleFetch(cmd)
        break
      }
      case 'OK':
        // Some servers send unsolicited OK; we don't.
        break
      case 'BYE':
        // Client-initiated disconnect (leoposta sends this after LOGOUT? rare)
        socket.end()
        break
      default:
        send(`BAD ${cmd.tag} unknown command ${first}`)
    }
  }

  function handleFetch (cmd) {
    if (!currentFolder) {
      send(`BAD ${cmd.tag} not SELECTed`)
      return
    }
    // parts: [tag, FETCH, range, '(' attrs ')', ...]
    const range = cmd.parts[2] || '*'
    const attrsStr = (cmd.parts[3] || '').toUpperCase()
    const attrs = new Set(attrsStr.replace(/[()]/g, '').split(/\s+/).filter(Boolean))
    const uidMode = attrs.has('UID') || cmd.parts.some(p => p === 'UID')
    const rangeUids = parseRange(range, currentFolder)
    for (const mail of currentFolder.mails) {
      if (!rangeUids.includes(mail.uid)) continue
      const id = uidMode ? mail.uid : rangeUids.indexOf(mail.uid) + 1
      const seg = [`* ${id} FETCH (`]
      if (attrs.has('UID')) seg.push(`UID ${mail.uid}`)
      if (attrs.has('FLAGS'))
        seg.push(
          'FLAGS (' +
          (mail.seen ? '\\Seen ' : '') +
          (mail.flagged ? '\\Flagged ' : '') +
          ')'.trimEnd()
        )
      if (attrs.has('INTERNALDATE') || attrs.has('UID') && !attrs.has('INTERNALDATE')) {
        seg.push(`INTERNALDATE "${mail.date}"`)
      }
      if (attrs.has('ENVELOPE')) {
        seg.push(`ENVELOPE (${q(mail.date)} ${q(mail.subject)} ${addrList([mail.from])} NIL ${addrList([mail.from])} ${addrList(mail.to)} ${addrList(mail.cc || [])} NIL ${q(mail.inReplyTo)} ${q(mail.messageId)})`)
      }
      if (attrs.has('BODYSTRUCTURE')) {
        seg.push(bodyStructure(mail))
      } else if (attrs.has('RFC822.SIZE')) {
        seg.push(`RFC822.SIZE ${mail.source.length}`)
      }
      if (
        attrs.has('RFC822') ||
        attrs.has('BODY') ||
        attrs.has('BODY[.HEADER]') ||
        attrs.has('BODY.PEEK[HEADER]') ||
        attrs.has('BODY[1.HEADER]') ||
        attrs.has('BODY.PEEK[1.HEADER]') ||
        attrs.has('BODY.PEEK[header]')
      ) {
        seg.push(`BODY[${hdrOnly(attrs)}] {${mail.source.length}}\r\n${mail.source}`)
      }
      seg.push(')')
      sendRaw(seg.join(' '))
      socket.write(buf('\r\n'))
    }
    send(`OK ${cmd.tag} FETCH OK`)
  }
  function hdrOnly (attrs) {
    if (attrs.has('BODY.PEEK[HEADER]')) return ''
    if (attrs.has('BODY[.HEADER]')) return ''
    return ''
  }
  function addrList (list) {
    if (!list || !list.length) return 'NIL'
    const parts = list
      .map(a => `(${q(a.name || '')} NIL ${q(a.address.split('@')[0] || '')} ${q(a.address.split('@')[1] || '')})`)
      .join(' ')
    return `${parts}`
  }
  function bodyStructure (mail) {
    const isMultipart = !!(mail.html && mail.text) || (mail.attachments || []).some(a => a.filename)
    if (isMultipart) {
      // multipart/alternative
      const parts = []
      if (mail.text) {
        parts.push(
          `("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" ${mail.text.length} ${Math.ceil(mail.text.length / 80)})`
        )
      }
      if (mail.html) {
        parts.push(
          `("TEXT" "HTML" ("CHARSET" "utf-8") NIL NIL "7BIT" ${mail.html.length} ${Math.ceil(mail.html.length / 80)})`
        )
      }
      for (const att of mail.attachments || []) {
        if (att.filename) {
          const [type, subtype, ...rest] = String(att.contentType || 'application/octet-stream').split(/[\s/;/]+/)
          parts.push(
            `(${type || 'APPLICATION'} ${subtype || 'OCTETSTREAM'} ("FILENAME" "${esc(att.filename)}" "CHARSET" "utf-8") NIL "BASE64" ${(att.body || '').length})`
          )
        }
      }
      return `BODYSTRUCTURE (${parts.join(' ')} "ALTERNATIVE" ("BOUNDARY" "leoposta-${mail.uid}"))`
    }
    // Single text part
    const ctype = mail.html ? 'text/html' : 'text/plain'
    return `BODYSTRUCTURE ("TEXT" ${ctype.toUpperCase().split('/')[1]} ("CHARSET" "utf-8") NIL NIL "7BIT" ${(mail.text || mail.html || '').length} ${Math.ceil((mail.text || mail.html || '').length / 80)})`
  }
  function parseRange (range, folder) {
    if (range === '*' || range === '1:*') return folder.mails.map(m => m.uid)
    const mm = /^(\d+):(\d+)\$/.exec(range)
    if (mm) {
      const a = Number(mm[1])
      const b = Number(mm[2])
      return folder.mails.slice(a - 1, b).map(m => m.uid)
    }
    const num = Number(range)
    if (!isNaN(num)) {
      return folder.mails[num - 1] ? [folder.mails[num - 1].uid] : []
    }
    return folder.mails.map(m => m.uid)
  }

  function pump () {
    for (;;) {
      let cmd
      try {
        cmd = parseCommand(buf, null)
      } catch (e) {
        log(tag, 'ERROR', 'parse failed: ' + e.message)
        cmd = null
      }
      if (!cmd) {
        if (buf.length > 1024 * 1024) {
          log(tag, 'ERROR', 'oversized buffer; closing')
          socket.destroy()
        }
        return
      }
      buf = cmd.newBuf
      try {
        handle(cmd)
      } catch (e) {
        log(tag, 'ERROR', 'handle failed: ' + (e && e.stack))
        try { socket.end() } catch {}
        return
      }
    }
  }

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    pump()
  })
  socket.on('error', (e) => log(tag, 'ERROR', 'socket error: ' + e.message))
  socket.on('close', () => log(tag, 'INFO', 'client disconnected'))
}

function patternMatch (p, pat) {
  if (pat === '*' || pat === '/') return true
  if (pat.endsWith('*')) return p.startsWith(pat.slice(0, -1).toLowerCase())
  return p.localeCompare(pat) === 0
}
function dequote (s) {
  if (s == null) return ''
  s = String(s).trim()
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1)
  if (s === 'NIL') return ''
  return s
}

if (require.main === module) {
  startServer()
}
module.exports = { startServer }
