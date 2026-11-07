# Email Signature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-account email signature, persisted on the account backend, applied on new compose and on reply/forward with a user-selectable position.

**Architecture:** A new pure-function module `src/lib/signature.ts` holds the `Signature` type, `normalizeAccount` helper, and `buildMessageBody` body-construction function (testable in isolation). The backend `GET/POST /api/account` routes persist the signature in `account.json`. The store's `MailAccount` gains a required `signature` field (populated by `normalizeAccount`). `Compose.svelte` and `MessageView.svelte` seed the body using `buildMessageBody`. The Settings form gains signature fields.

**Tech Stack:** Svelte 5 + TypeScript, Vitest, Node.js Express backend, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-06-email-signature-design.md`

## Global Constraints

- `signature.position` values are exactly `'standard' | 'after_quote'`; default is `'standard'`.
- When `signature.enabled` is `false` OR `signature.text` is empty/whitespace-only, `buildMessageBody` must return the reply/forward body with **no signature and no extra blank lines**.
- No new routes; signature rides the existing `GET /api/account` and `POST /api/account`.
- No new npm dependencies.
- Baseline: `npm test` (3 tests) must remain green throughout.

## Review Focus

1. **Empty or whitespace-only `signature.text` with `enabled: true`** — expected: behave identically to `enabled: false`; no blank lines inserted. `buildMessageBody` and `normalizeAccount` must both guard.
2. **`signature` key absent from backend JSON** (old saved accounts) — expected: default `{ enabled: false, text: '', position: 'standard' }` returned by the API, not `undefined`.
3. **Reply body that is already empty** (user hits "Reply" without typing) with `position: 'after_quote'` — expected: only the `--` separator + original; no leading blank line before `--`.
4. **`buildMessageBody` when `original` is `null`** (new compose path) — expected: return just the signature text (or `''`), never prepend or append blank lines.
5. **Settings save overwrites an existing valid signature with a partial body** (e.g., user clears the text but leaves the old `enabled`) — expected: POST succeeds, GET returns the cleared `text` with the unchanged `enabled` flag.

---

### Task 1: `Signature` type, `normalizeAccount`, `buildMessageBody` + tests

**Files:**
- Create: `src/lib/signature.ts`
- Modify: `src/store/index.ts` (add `signature: Signature` to `MailAccount`)
- Test: `src/__tests__/signature.test.ts`

**Interfaces:**
- Consumes: none
- Produces:
  - `Signature` type — `{ enabled: boolean; text: string; position: 'standard' | 'after_quote' }`
  - `DEFAULT_SIGNATURE: Signature` — `{ enabled: false, text: '', position: 'standard' }`
  - `normalizeSignature(raw?: Partial<Signature> | null): Signature`
  - `normalizeAccount(raw: any): MailAccount` (adds required `signature` field)
  - `buildMessageBody(sig: Signature, replyText: string, original?: string): string`

- [ ] **Step 1: Write `src/__tests__/signature.test.ts` with all test cases**

```ts
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SIGNATURE,
  normalizeSignature,
  buildMessageBody,
  type Signature
} from '../lib/signature'

describe('normalizeSignature', () => {
  it('returns DEFAULT_SIGNATURE when null', () => {
    expect(normalizeSignature(null)).toEqual(DEFAULT_SIGNATURE)
  })

  it('returns DEFAULT_SIGNATURE when undefined', () => {
    expect(normalizeSignature(undefined)).toEqual(DEFAULT_SIGNATURE)
  })

  it('fills missing fields with defaults', () => {
    expect(normalizeSignature({ text: '— Leo' })).toEqual({
      enabled: false, text: '— Leo', position: 'standard'
    })
  })

  it('preserves all fields when given', () => {
    const sig = { enabled: true, text: '— Leo', position: 'after_quote' }
    expect(normalizeSignature(sig)).toEqual(sig)
  })
})

describe('buildMessageBody — new compose (original === null/undefined)', () => {
  const sig: Signature = { enabled: true, text: '— Leo', position: 'standard' }

  it('returns just the signature for a new compose', () => {
    expect(buildMessageBody(sig, '', null)).toBe('— Leo')
  })

  it('returns empty string for disabled signature', () => {
    const off: Signature = { enabled: false, text: '— Leo', position: 'standard' }
    expect(buildMessageBody(off, '', null)).toBe('')
  })

  it('returns empty string for whitespace-only text', () => {
    const ws: Signature = { enabled: true, text: '   ', position: 'standard' }
    expect(buildMessageBody(ws, '', null)).toBe('')
  })
})

describe('buildMessageBody — reply, position=standard', () => {
  const sig: Signature = { enabled: true, text: '— Leo', position: 'standard' }

  it('returns: replyText, blank line, signature, blank line, --, original', () => {
    const result = buildMessageBody(sig, 'Thanks!', 'Original body')
    expect(result).toBe('Thanks!\n\n— Leo\n\n--\nOriginal body')
  })

  it('returns: blank line, signature, blank line, --, original when replyText is empty', () => {
    const result = buildMessageBody(sig, '', 'Original body')
    expect(result).toBe('\n— Leo\n\n--\nOriginal body')
  })

  it('returns: blank line, --, original when signature disabled', () => {
    const off: Signature = { enabled: false, text: '— Leo', position: 'standard' }
    const result = buildMessageBody(off, 'Thanks!', 'Original body')
    expect(result).toBe('Thanks!\n\n--\nOriginal body')
  })
})

describe('buildMessageBody — reply, position=after_quote', () => {
  const sig: Signature = { enabled: true, text: '— Leo', position: 'after_quote' }

  it('returns: replyText, blank line, --, original, blank line, signature', () => {
    const result = buildMessageBody(sig, 'Thanks!', 'Original body')
    expect(result).toBe('Thanks!\n\n--\nOriginal body\n\n— Leo')
  })

  it('returns: blank line, --, original, blank line, signature when replyText is empty', () => {
    const result = buildMessageBody(sig, '', 'Original body')
    expect(result).toBe('\n--\nOriginal body\n\n— Leo')
  })
})

describe('buildMessageBody — original undefined', () => {
  it('same as original === null', () => {
    const sig: Signature = { enabled: true, text: '— Leo', position: 'standard' }
    expect(buildMessageBody(sig, '', undefined)).toBe('— Leo')
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /home/leonard/opencode/leoposta/.worktrees/email-signature && npm test 2>&1 | grep -E "FAIL|✗"
```
Expected: all 4 `describe` blocks FAIL with `Cannot find module '../lib/signature'`.

- [ ] **Step 3: Add `signature: Signature` to the `MailAccount` interface in `src/store/index.ts`**

Import the type at the top (`import type { Signature } from '../lib/signature'`), then add this field after `smtpPass: string`:

```ts
signature: Signature
```

- [ ] **Step 4: Create `src/lib/signature.ts`**

Implementation:

```ts
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

export function normalizeAccount(raw: Record<string, unknown>): Omit<MailAccount, 'id'> & { signature: Signature } {
  const sig = normalizeSignature(raw.signature as Partial<Signature> | undefined)
  const base = raw as Record<string, unknown>
  const { signature: _sig, ...rest } = base
  void _sig
  return { ...rest, signature: sig } as Omit<MailAccount, 'id'> & { signature: Signature }
}

function isSigActive(sig: Signature): boolean {
  return sig.enabled && sig.text.trim().length > 0
}

export function buildMessageBody(
  sig: Signature,
  replyText: string,
  original?: string | null
): string {
  const active  = isSigActive(sig)
  const hasQuote = original !== undefined && original !== null

  // New compose (no quote) → just the signature, or ''
  if (!hasQuote) {
    return active ? sig.text : ''
  }

  // Reply/forward (has quote)
  const parts: string[] = []

  if (replyText) {
    parts.push(replyText)
  }

  if (active) {
    parts.push(sig.text)
  }

  parts.push('')
  parts.push('--')
  parts.push(original!)

  if (sig.position === 'after_quote') {
    // Strip the empty line + -- + original we just pushed, rebuild
    // after_quote: [replyText?] blank -- original blank signature
    return (replyText ? replyText + '\n' : '') +
           '\n--\n' + original! + '\n\n' + (active ? sig.text : '')
  }

  // standard: [replyText?] blank signature blank -- original
  if (active) {
    return [replyText].filter(Boolean).join('\n') +
           '\n\n' + sig.text + '\n\n--\n' + original!
  }
  return [replyText].filter(Boolean).join('\n') + '\n\n--\n' + original!
}
```

> **Note on `buildMessageBody`:** The function above has some redundancy. The final step should be a clean version that handles all three cases cleanly. The exact expected outputs are pinned by the tests in Step 1 — implement `buildMessageBody` to make those tests pass; the reference above is a starting point, not the canonical form. The key rules from the spec:
> - New compose: `active ? sig.text : ''`
> - Reply `standard`: `replyText ? replyText + '\n\n' + sig.text + '\n\n--\n' + original : '\n' + sig.text + '\n\n--\n' + original` (when active)\n>              `replyText ? replyText + '\n\n--\n' + original : '\n--\n' + original` (when not active)
> - Reply `after_quote`: `replyText ? replyText + '\n\n--\n' + original + '\n\n' + (active ? sig.text : '') : '\n--\n' + original + '\n\n' + (active ? sig.text : '')`
>
> **Important:** When `active` is `false` AND `position === 'after_quote'`, the trailing `'\n\n'` must NOT be appended. Implement the conditional carefully.

- [ ] **Step 5: Run tests to confirm they pass**

```bash
cd /home/leonard/opencode/leoposta/.worktrees/email-signature && npm test 2>&1 | tail -15
```
Expected: all signature tests PASS (10 tests), store test still PASS (3 tests) — total 13.

- [ ] **Step 6: Run `npm run build` to check TypeScript**

```bash
cd /home/leonard/opencode/leoposta/.worktrees/email-signature && npm run build 2>&1 | tail -10
```
Expected: build succeeds (0 errors).

- [ ] **Step 7: Commit**

```bash
cd /home/leonard/opencode/leoposta/.worktrees/email-signature && \
  git add src/lib/signature.ts src/store/index.ts src/__tests__/signature.test.ts && \
  git commit -m "feat(signature): add Signature type, normalizeAccount, buildMessageBody + tests"
```

---

### Task 2: Backend — persist `signature` in `GET`/`POST /api/account`

**Files:**
- Modify: `server/index.js:268-294` (GET and POST `/api/account` handlers)

**Interfaces:**
- Consumes: (pure data; no dependency on Task 1's TS types — JS backend)
- Produces:
  - `GET /api/account` response always includes `signature: { enabled, text, position }` when an account is configured.
  - `POST /api/account` accepts `signature` in `req.body` and persists it in `account.json`.

- [ ] **Step 1: Modify `POST /api/account` in `server/index.js` to destruct and store `signature`**

At line 280, extend the destructuring:

```js
const { email, imapHost, imapPort, imapTls, imapUser, imapPass, smtpHost, smtpPort, smtpTls, smtpUser, smtpPass, name, signature } = req.body
```

Then after the existing object literal (line 287), add:

```js
account.signature = signature != null
  ? {
      enabled:    !!signature.enabled,
      text:       String(signature.text ?? ''),
      position:   signature.position === 'after_quote' ? 'after_quote' : 'standard',
    }
  : { enabled: false, text: '', position: 'standard' }
```

- [ ] **Step 2: Modify `GET /api/account` to include `signature` in the response**

At line 268-275, the handler already strips `imapPass`/`smtpPass`. The spread `{...account}` will now pick up `signature` automatically once it's set on the `account` object. No change needed here — `signature` will be present if it was set by POST.

However, if `account.signature` is undefined (legacy account saved before this change), add a fallback:

```js
app.get('/api/account', (req, res) => {
  if (!account) return res.json({ connected: false })
  const safe = { ...account }
  delete safe.imapPass
  delete safe.smtpPass
  if (!safe.signature) {
    safe.signature = { enabled: false, text: '', position: 'standard' }
  }
  res.json(safe)
})
```

- [ ] **Step 3: Verify TypeScript syntax is still valid**

```bash
cd /home/leonard/opencode/leoposta/.worktrees/email-signature && node --check server/index.js && echo "OK"
```
Expected: `OK`

- [ ] **Step 4: Smoke-check the backend endpoint round-trip**

Start the server with the dummy IMAP script (or just run a minimal POST/GET cycle via curl) if a dummy server is available; otherwise verify the code path by reading the diff and confirming the logic. If you can start the server:

```bash
cd /home/leonard/opencode/leoposta/.worktrees/email-signature && \
  node server/index.js & sleep 2 && \
  curl -s -X POST http://localhost:3001/api/account \
    -H 'Content-Type: application/json' \
    -d '{"email":"t@t.com","imapHost":"h","imapPort":993,"smtpHost":"h","smtpPort":465,"name":"Test","signature":{"enabled":true,"text":"— Leo","position":"standard"}}' && \
  echo && curl -s http://localhost:3001/api/account && \
  pkill -f "node server/index.js"
```
Expected: POST returns `{"success":true}`, GET returns the account with `"signature":{"enabled":true,"text":"— Leo","position":"standard"}`.

**If the backend can't be started** (no IMAP server, port 3001 blocked, or credential errors), skip the curl check and rely on the `node --check` + code review to verify. Log "curl check skipped: <reason>" in your report.

- [ ] **Step 5: Commit**

```bash
cd /home/leonard/opencode/leoposta/.worktrees/email-signature && \
  git add server/index.js && \
  git commit -m "feat(signature): persist signature in POST/GET /api/account"
```

---

### Task 3: Settings — add signature fields and save

**Files:**
- Modify: `src/components/Settings.svelte`

**Interfaces:**
- Consumes: `Signature` type from `src/lib/signature.ts`; `normalizeSignature` from `src/lib/signature.ts`
- Produces: signature textarea, enabled checkbox, position radio group; save included in existing `POST /api/account` call

- [ ] **Step 1: Add signature state variables to the Settings `<script>` block**

At the top of the existing `<script lang="ts">` block (after the `pgpErr` line, around line 25), add:

```ts
import { normalizeSignature } from '../lib/signature'
let sigEnabled  = $state(false)
let sigText     = $state('')
let sigPosition = $state<'standard' | 'after_quote'>('standard')
```

- [ ] **Step 2: Pre-populate from GET /api/account on mount**

Add this `$effect` after the existing PGP `$effect`:

```ts
$effect(() => {
  fetch('/api/account')
    .then(r => r.json())
    .then(data => {
      if (data && data.signature) {
        const sig = normalizeSignature(data.signature)
        sigEnabled  = sig.enabled
        sigText     = sig.text
        sigPosition = sig.position
      }
    })
    .catch(() => {})
})
```

- [ ] **Step 3: Include signature in the `handleSave` POST body**

In the `handleSave` function (around line 73), update the `JSON.stringify` body to include signature:

```ts
body: JSON.stringify({
  name: accountName || email.split('@')[0],
  email,
  imapHost,
  imapPort: parseInt(imapPort),
  imapTls,
  smtpHost,
  smtpPort: parseInt(smtpPort),
  smtpTls,
  password,
  signature: {
    enabled:  sigEnabled,
    text:     sigText,
    position: sigPosition
  }
})
```

- [ ] **Step 4: Add the Signature form section to the template**

Insert this block in the template, immediately before the PGP section (before the `<h3 class="section-title">🔐 PGP...` line at line 193):

```svelte
<div class="divider"></div>
<h3 class="section-title">✍️ Email Signature</h3>
<p class="hint">Add a plain-text signature that is applied automatically to new messages and replies.</p>

<div class="form-group checkbox">
  <label>
    <input type="checkbox" bind:checked={sigEnabled} />
    <span>Use signature</span>
  </label>
</div>

<div class="form-group">
  <label>Signature text</label>
  <textarea
    rows="3"
    bind:value={sigText}
    placeholder="— Name"
    spellcheck="false"
  ></textarea>
</div>

<div class="form-group">
  <label>In replies, place signature:</label>
  <label style="display:block; margin-top: 4px;">
    <input type="radio" name="sig-position" bind:value={sigPosition} value="standard" />
    Above the quoted original (default)
  </label>
  <label style="display:block; margin-top: 4px;">
    <input type="radio" name="sig-position" bind:value={sigPosition} value="after_quote" />
    Below the quoted original
  </label>
</div>
```

- [ ] **Step 5: Verify the build succeeds**

```bash
cd /home/leonard/opencode/leoposta/.worktrees/email-signature && npm run build 2>&1 | tail -10
```
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
cd /home/leonard/opencode/leoposta/.worktrees/email-signature && \
  git add src/components/Settings.svelte && \
  git commit -m "feat(signature): add signature form fields to Settings"
```

---

### Task 4: Wire signature into Compose (new compose + reply/forward)

**Files:**
- Modify: `src/components/Compose.svelte`
- Modify: `src/components/MessageView.svelte`

**Interfaces:**
- Consumes: `buildMessageBody`, `Signature` from `src/lib/signature.ts`; `$store.accounts`, `$store.activeAccountId` from `src/store`
- Produces: body already seeded with signature; `handleReply`/`handleForward` in `MessageView.svelte` call `buildMessageBody` to compose the seed body before calling `setComposing(true)`

- [ ] **Step 1: Add `getSignature()` helper to `src/components/Compose.svelte`**

In the `<script lang="ts">` block, after the imports (around line 4), add:

```ts
import { buildMessageBody } from '../lib/signature'
import type { Signature } from '../lib/signature'

function getSignature(): Signature | undefined {
  const s = getState()
  const active = s.accounts.find(a => a.id === s.activeAccountId)
  return active?.signature
}
```

- [ ] **Step 2: Apply signature seed when Compose mounts for new compose**

`bodyInput` is already initialized from `getState().composeBody` at line 11. The seeding logic lives in the caller (`App.svelte`/`MessageView.svelte`) which sets `composeBody` before opening the compose. For a **new compose**, the caller should set `composeBody = sig text` (if enabled and non-empty). Since `Compose.svelte` is the component that knows it's open, apply the seed here at mount time if `composeBody` is still empty:

In `onMount` (line 158), add at the top of the callback, before the existing focus code:

```ts
// Seed signature for a fresh new-compose (no reply, no forward)
if (!getState().composeReplyTo && !getState().composeForward && bodyInput === '') {
  const sig = getSignature()
  if (sig && sig.enabled && sig.text.trim()) {
    bodyInput = sig.text
    setComposeBody(sig.text)
  }
}
```

- [ ] **Step 3: Modify `handleReply` in `MessageView.svelte` to seed the signature correctly**

Read the current `handleReply` implementation at line 58. Add the signature import and body build to it:

```ts
import { buildMessageBody } from '../lib/signature'
```

At the top of `handleReply`, fetch the active account's signature and construct the body:

```ts
function handleReply() {
  const s = getState()
  const active = s.accounts.find(a => a.id === s.activeAccountId)
  const sig = active?.signature
  const sigActive = sig && sig.enabled && sig.text.trim().length > 0
  const originalBody = s.selectedMessageId
    ? (s.messages.find(m => m.id === s.selectedMessageId)?.body ?? '')
    : ''
  const seeded = sigActive
    ? buildMessageBody(sig, '', originalBody)
    : ('' + ('--\n' + originalBody))

  setComposeReplyTo(s.selectedMessageId)
  setComposeSubject('Re: ' + (s.messages.find(m => m.id === s.selectedMessageId)?.subject ?? ''))
  setComposeTo([s.messages.find(m => m.id === s.selectedMessageId)?.from])
  setComposeBody(seeded)
  setComposing(true)
}
```

> Replace the existing `handleReply` body with this version. Match the existing patterns for `setComposeX` — read the current implementation first to confirm the exact function calls.

- [ ] **Step 4: Do the same for `handleForward` at line 69**

```ts
function handleForward() {
  const s = getState()
  const active = s.accounts.find(a => a.id === s.activeAccountId)
  const sig = active?.signature
  const sigActive = sig && sig.enabled && sig.text.trim().length > 0
  const original = s.messages.find(m => m.id === s.selectedMessageId)
  const originalBody = original?.body ?? ''
  const seeded = sigActive
    ? buildMessageBody(sig, '', originalBody)
    : ('\n--\n' + originalBody)

  setComposeForward(true)
  setComposeSubject('Fwd: ' + (original?.subject ?? ''))
  setComposeBody(seeded)
  setComposing(true)
}
```

- [ ] **Step 5: Run all tests and build**

```bash
cd /home/leonard/opencode/leoposta/.worktrees/email-signature && npm test 2>&1 | tail -15 && npm run build 2>&1 | tail -10
```
Expected: all 13 tests PASS; build succeeds.

- [ ] **Step 6: Commit**

```bash
cd /home/leonard/opencode/leoposta/.worktrees/email-signature && \
  git add src/components/Compose.svelte src/components/MessageView.svelte && \
  git commit -m "feat(signature): wire signature into Compose and MessageView reply/forward"
```

---

### Task 5: Full verification and final state

**Files:** (verification only, no code changes expected)

- [ ] **Step 1: Run the full test suite**

```bash
cd /home/leonard/opencode/leoposta/.worktrees/email-signature && npm test 2>&1 | tail -20
```
Expected: Test Files: 2 passed; Tests: 13 passed (3 store + 10 signature); 0 failed.

- [ ] **Step 2: Run the build**

```bash
cd /home/leonard/opencode/leoposta/.worktrees/email-signature && npm run build 2>&1 | tail -15
```
Expected: build completes with no errors (warnings are acceptable).

- [ ] **Step 3: Confirm `server/index.js` syntax**

```bash
node --check server/index.js && echo "syntax OK"
```
Expected: `syntax OK`

- [ ] **Step 4: Read the final diff**

```bash
cd /home/leonard/opencode/leoposta/.worktrees/email-signature && git log --oneline feat/email-signature ~5..HEAD && git diff main..feat/email-signature --stat
```
Expected: 4–5 commits visible; diff shows changes to `src/lib/signature.ts` (new), `src/store/index.ts`, `src/components/Settings.svelte`, `src/components/Compose.svelte`, `src/components/MessageView.svelte`, `server/index.js`, `src/__tests__/signature.test.ts` (new).

- [ ] **Step 5: Report completion**

List all commits, test count, and any deviations from the plan.
