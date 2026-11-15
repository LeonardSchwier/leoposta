// Running a user-written regular expression on mail the sender controls.
//
// JavaScript regexes backtrack, so a pattern such as (a+)+$ takes exponential
// time on the right input (one 31-character subject: tens of seconds), and the
// server is one Node process: every API call, IDLE stream and scheduled send
// stalls with it. Node has no regex timeout, but a script run with the `timeout`
// option of node:vm is aborted by V8 when the budget is spent, regex engine
// included. Three limits keep the damage small:
//
//  1. Each match runs in a reusable vm context with a small budget; a match that
//     spends it counts as "no match".
//  2. A message that spent the budget is remembered (pattern + exact text, for a
//     few minutes), so reloading the list does not pay again, while other mail
//     that the same rule would match is unaffected.
//  3. A pattern that is never slow enough to time out but costs a millisecond or
//     more per message can still add up over a 200-message list, so the time
//     spent in such calls is capped per window; once the cap is reached the
//     remaining regex conditions in that window count as "no match".

import crypto from 'node:crypto'
import vm from 'node:vm'

export const REGEX_BUDGET_MS = 25
export const MAX_PATTERN_LENGTH = 256
// A legitimate pattern on a very large body must still finish well inside the
// budget, so only the start of the text is searched.
export const MAX_INPUT_LENGTH = 100_000
export const SLOW_MEMO_TTL_MS = 5 * 60_000
export const WINDOW_MS = 2_000
export const WINDOW_BUDGET_MS = 250
// Calls cheaper than this are not charged to the window: an ordinary rule costs
// about 0.1 ms per call and must never use up the cap on its own.
const CHARGE_ABOVE_MS = 1
const MAX_REMEMBERED = 500

const context = vm.createContext({ re: null, text: '' })
const script = new vm.Script('re.test(text)')
const compiled = new Map() // pattern -> RegExp | null (invalid)
const slow = new Map() // pattern + text digest -> time until which the match is skipped
let clock = Date.now
let windowStart = -Infinity
let spent = 0
let warnedThisWindow = false

function compile(pattern) {
  if (compiled.has(pattern)) return compiled.get(pattern)
  let re = null
  if (pattern.length <= MAX_PATTERN_LENGTH) {
    try { re = new RegExp(pattern, 'i') } catch { re = null }
  }
  if (compiled.size >= MAX_REMEMBERED) compiled.clear()
  compiled.set(pattern, re)
  return re
}

const slowKey = (pattern, text) =>
  `${pattern}\u0000${crypto.createHash('sha1').update(text).digest('base64')}`

/** Whether `pattern` (case-insensitive) matches `text`. An invalid or over-long
 * pattern, a non-string pattern, and a match that runs out of time all give false. */
export function safeRegexTest(pattern, text) {
  if (typeof pattern !== 'string') return false
  const re = compile(pattern)
  if (!re) return false
  const input = text == null ? '' : String(text).slice(0, MAX_INPUT_LENGTH)

  const now = clock()
  if (now - windowStart >= WINDOW_MS) {
    windowStart = now
    spent = 0
    warnedThisWindow = false
  }
  if (spent >= WINDOW_BUDGET_MS) {
    if (!warnedThisWindow) {
      warnedThisWindow = true
      console.warn(`[rules] regex conditions used ${WINDOW_BUDGET_MS} ms of CPU in ${WINDOW_MS / 1000} s; skipping the rest of that window`)
    }
    return false
  }
  let key = null
  if (slow.size > 0) {
    key = slowKey(pattern, input)
    const until = slow.get(key)
    if (until !== undefined) {
      if (until > now) return false
      slow.delete(key)
    }
  }

  context.re = re
  context.text = input
  const started = performance.now()
  try {
    return script.runInContext(context, { timeout: REGEX_BUDGET_MS }) === true
  } catch (err) {
    if (err && err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      if (slow.size >= MAX_REMEMBERED) slow.clear()
      slow.set(key ?? slowKey(pattern, input), now + SLOW_MEMO_TTL_MS)
      console.warn(`[rules] regex ${JSON.stringify(pattern.slice(0, 60))} exceeded ${REGEX_BUDGET_MS} ms on one message; that message is skipped for it for ${SLOW_MEMO_TTL_MS / 60_000} minutes`)
    }
    return false
  } finally {
    context.re = null
    context.text = ''
    const elapsed = performance.now() - started
    if (elapsed > CHARGE_ABOVE_MS) spent += elapsed
  }
}

/** True when `pattern` is a string within the length limit that compiles. */
export function isValidPattern(pattern) {
  return typeof pattern === 'string' && compile(pattern) !== null
}

export function resetSafeRegexForTests({ now } = {}) {
  compiled.clear()
  slow.clear()
  clock = now || Date.now
  windowStart = -Infinity
  spent = 0
  warnedThisWindow = false
}
