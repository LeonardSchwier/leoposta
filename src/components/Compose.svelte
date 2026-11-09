<script lang="ts">
  import { apiFetch } from '../api'
  import { store, getState, setComposeTo, setComposeCc, setComposeBcc, setComposeSubject, setComposeBody, setIsLoading, setComposeScheduled, clearCompose, setComposing } from '../store'
  import { onMount } from 'svelte'
  import { addQueuedMessage } from '../lib/offlineQueue'
  import { buildMessageBody, normalizeAccount, type Signature } from '../lib/signature'
  import { fileToAttachment, type OutboundAttachment, AttachmentTooLargeError } from '../lib/attachments'
  import RecipientAutocomplete from './RecipientAutocomplete.svelte'

  let { onClose } = $props()

  // Local flat-string state driven by RecipientAutocomplete (same pattern as Calendar).
  // Seed once from the store; the store is written back on send.
  let toValue   = $state(getState().composeTo.join(', '))
  let ccValue   = $state(getState().composeCc.join(', '))
  let bccValue  = $state(getState().composeBcc.join(', '))

  let subjectInput = $state(getState().composeSubject || '')
  let bodyInput    = $state(getState().composeBody || '')

  // ---- Signature seeding ----
  function quotedOriginal(): string | null {
    const m = getState().composeOriginalMessage
    if (!m) return null
    return m.body || m.bodyHtml || null
  }
  function applySignature(sig: Signature, original: string | null): boolean {
    if (!sig || !sig.enabled || !sig.text.trim()) {
      if (original) { const q = '\n--\n' + original; bodyInput = q; setComposeBody(q) }
      return false
    }
    const body = buildMessageBody(sig, '', original)
    if (body) { bodyInput = body; setComposeBody(body) }
    return true
  }
  async function seedBody() {
    const s = getState()
    const account = s.accounts.find(a => a.id === s.activeAccountId)
    if (account && (account as any).signature) {
      applySignature((account as any).signature, quotedOriginal())
      return
    }
    try {
      const res = await apiFetch('/api/account')
      if (!res.ok) return
      const raw = await res.json()
      if (!raw || raw.connected === false || !raw.signature) return
      applySignature(normalizeAccount(raw as Record<string, unknown>).signature, quotedOriginal())
    } catch { /* offline / no backend: seed with nothing */ }
  }

  let showCc = $state(false)
  let showBcc = $state(false)
  let showSchedule = $state(false)
  let scheduleDate = $state('')
  let scheduleTime = $state('')
  let scheduleError = $state<string | null>(null)
  let attachFile: HTMLInputElement | null = null
  let attachments = $state<OutboundAttachment[]>([])
  let attachmentError = $state<string | null>(null)

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  function parseRecipients(value: string): string[] {
    return value.split(/[,;\s]+/).map(e => e.trim()).filter(e => e)
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      handleSend()
      return
    }
    // Focus trap within the compose dialog: cycle Tab/Shift-Tab.
    if (e.key === 'Tab') {
      const root = document.querySelector<HTMLElement>('.modal.compose')
      if (!root) return
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
        )
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (!active || !root.contains(active)) {
        e.preventDefault()
        first.focus()
        return
      }
      if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  function handleSend() {
    const to   = parseRecipients(toValue)
    const cc   = parseRecipients(ccValue)
    const bcc  = parseRecipients(bccValue)

    // Sync parsed recipients back to the store so downstream state is consistent.
    if (to.length)  setComposeTo(to)
    if (cc.length)  setComposeCc(cc)
    if (bcc.length) setComposeBcc(bcc)

    if (to.length === 0) {
      alert('Please add at least one recipient')
      return
    }

    setIsLoading(true)

    const message: Record<string, unknown> = {
      to,
      cc,
      bcc,
      subject: subjectInput,
      body: bodyInput,
      scheduled: getState().composeScheduled
    }
    if (attachments.length) message.attachments = attachments

    apiFetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message)
    })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        clearCompose()
        setComposing(false)
        onClose()
      } else if (data.queued) {
        clearCompose()
        setComposing(false)
        onClose()
        alert(data.message)
      } else {
        alert('Failed to send: ' + data.error)
      }
    })
    .catch(async (err: any) => {
      if (!navigator.onLine) {
        try {
          const queued: Parameters<typeof addQueuedMessage>[0] = {
            to, cc, bcc,
            subject: subjectInput,
            body: bodyInput,
            scheduled: getState().composeScheduled,
            createdAt: new Date().toISOString()
          }
          if (attachments.length) queued.attachments = attachments
          await addQueuedMessage(queued)
          clearCompose()
          setComposing(false)
          onClose()
        } catch {
          alert('Failed to queue message: ' + err.message)
        }
      } else {
        alert('Error: ' + err.message)
      }
    })
    .finally(() => {
      setIsLoading(false)
    })
  }

  function handleSchedule() {
    if (!scheduleDate || !scheduleTime) {
      scheduleError = 'Pick both a date and a time to schedule'
      return
    }
    const date = new Date(`${scheduleDate}T${scheduleTime}`)
    if (Number.isNaN(date.getTime())) {
      scheduleError = 'That date and time don\u2019t combine into a real moment'
      return
    }
    scheduleError = null
    setComposeScheduled(date.toISOString())
    showSchedule = false
  }

  function pad2(n: number): string { return String(n).padStart(2, '0') }
  function localDateStr(d: Date): string {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  }
  function localTimeStr(d: Date): string {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  }
  function prefillSchedule(label: string) {
    const target = new Date()
    if (label === '30m') target.setTime(target.getTime() + 30 * 60 * 1000)
    else if (label === '1d') target.setDate(target.getDate() + 1)
    else if (label === '1w') target.setDate(target.getDate() + 7)
    else if (label === '1m') target.setMonth(target.getMonth() + 1)
    scheduleDate = localDateStr(target)
    scheduleTime = localTimeStr(target)
    scheduleError = null
  }

  function toggleSchedulePanel() {
    showSchedule = !showSchedule
    scheduleError = null
    if (showSchedule && (!scheduleDate || !scheduleTime)) {
      prefillSchedule('30m')
    }
  }

  async function handleAttach(e: Event) {
    const input = e.target as HTMLInputElement
    if (!input.files) return
    let lastError: string | null = null
    for (const f of Array.from(input.files)) {
      try {
        attachments.push(await fileToAttachment(f))
      } catch (err) {
        lastError = err instanceof AttachmentTooLargeError
          ? err.message
          : `Could not attach ${f.name}: ${err?.message ?? String(err)}`
      }
    }
    attachmentError = lastError
    input.value = ''
  }

  function removeAttachment(index: number) {
    attachments.splice(index, 1)
  }

  function onCloseBack(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose()
  }

  onMount(() => {
    void seedBody()
    window.addEventListener('keydown', handleKeyDown)
    requestAnimationFrame(() => {
      (document.querySelector<HTMLElement>('.modal.compose input.ra-input')
        ?? document.querySelector<HTMLElement>('.modal.compose textarea'))?.focus()
    })
    return () => window.removeEventListener('keydown', handleKeyDown)
  })
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="modal-back" onclick={onCloseBack} role="dialog" aria-modal="true" aria-label="Compose message" tabindex="-1">
<div class="modal compose">
  <div class="compose-header">
    <h2 class="compose-title">
      {#if $store.composeReplyTo}Reply{:else if $store.composeForward}Forward{:else}New Message{/if}
    </h2>
    <button class="close-btn" onclick={onClose} aria-label="Close compose (Esc)">✕</button>
  </div>

  <div class="compose-body">
    <div class="field-row">
      <label class="field-label" for="compose-to">To</label>
      <div class="field-control">
        <RecipientAutocomplete bind:value={toValue} placeholder="recipient@example.com" maxSuggestions={8} />
      </div>
    </div>

    {#if showCc}
      <div class="field-row">
        <label class="field-label" for="compose-cc">Cc</label>
        <div class="field-control">
          <RecipientAutocomplete bind:value={ccValue} placeholder="recipient@example.com" maxSuggestions={8} />
        </div>
      </div>
    {/if}

    {#if showBcc}
      <div class="field-row">
        <label class="field-label" for="compose-bcc">Bcc</label>
        <div class="field-control">
          <RecipientAutocomplete bind:value={bccValue} placeholder="recipient@example.com" maxSuggestions={8} />
        </div>
      </div>
    {/if}

    <div class="field-row">
      <span class="field-label">&nbsp;</span>
      <div class="field-actions">
        <button type="button" class="text-btn" onclick={() => showCc = !showCc}>
          {#if showCc}Hide Cc{:else}Add Cc{/if}
        </button>
        <button type="button" class="text-btn" onclick={() => showBcc = !showBcc}>
          {#if showBcc}Hide Bcc{:else}Add Bcc{/if}
        </button>
      </div>
    </div>

    <div class="field-row">
      <label class="field-label" for="compose-subject">Subject</label>
      <div class="field-control">
        <input id="compose-subject"
          type="text"
          bind:value={subjectInput}
          oninput={() => setComposeSubject(subjectInput)}
          placeholder="Subject"
        />
      </div>
    </div>

    <div class="compose-editor">
      <textarea
        id="compose-body"
        bind:value={bodyInput}
        oninput={() => setComposeBody(bodyInput)}
        placeholder="Write your message..."
        rows="15"
      ></textarea>
    </div>
  </div>

  {#if showSchedule}
    <div class="schedule-panel">
      <h3>Schedule Send</h3>
      <div class="schedule-quick">
        <button type="button" class="quick-btn" onclick={() => prefillSchedule('30m')}>+30 min</button>
        <button type="button" class="quick-btn" onclick={() => prefillSchedule('1d')}>+1 day</button>
        <button type="button" class="quick-btn" onclick={() => prefillSchedule('1w')}>+1 week</button>
        <button type="button" class="quick-btn" onclick={() => prefillSchedule('1m')}>+1 month</button>
      </div>
      <div class="schedule-row">
        <input type="date" aria-label="Schedule date" bind:value={scheduleDate} required />
        <input type="time" step="300" aria-label="Schedule time" bind:value={scheduleTime} required />
      </div>
      {#if scheduleError}
        <p class="schedule-error" role="alert">{scheduleError}</p>
      {/if}
      <div class="schedule-actions">
        <button type="button" class="btn-secondary" onclick={() => { showSchedule = false; scheduleError = null }}>Cancel</button>
        <button type="button" class="btn-primary" onclick={handleSchedule}>Schedule</button>
      </div>
    </div>
  {/if}

  <div class="compose-footer">
    <div class="footer-left">
      <button type="button" class="icon-btn" title="Attach file" aria-label="Attach file" onclick={() => attachFile?.click()}>
        <span>📎</span>
      </button>
      <input type="file" multiple bind:this={attachFile} onchange={handleAttach} hidden />
      <div class="attachment-chips" class:empty={attachments.length === 0}>
        {#each attachments as att, i (att.filename + i)}
          <span class="attachment-chip" title="{att.contentType}">
            <span class="attachment-name">{att.filename}</span>
            <button type="button" class="attachment-remove" onclick={() => removeAttachment(i)} aria-label="Remove {att.filename}">✕</button>
          </span>
        {/each}
      </div>
      {#if attachmentError}
        <span class="attachment-error">{attachmentError}</span>
      {/if}
      <button
        type="button"
        class="icon-btn"
        title="Schedule send"
        aria-label="Schedule send"
        class:active={showSchedule || $store.composeScheduled}
        onclick={toggleSchedulePanel}
      >
        <span>⏰</span>
      </button>
      {#if $store.composeScheduled}
        <span class="schedule-badge">
          Scheduled: {new Date($store.composeScheduled).toLocaleString()}
          <button type="button" aria-label="Clear scheduled time" onclick={() => setComposeScheduled(null)}>✕</button>
        </span>
      {/if}
    </div>
    <div class="footer-right">
      <button type="button" class="btn-secondary" onclick={onClose}>Save Draft</button>
      <button
        type="button"
        class="btn-primary"
        onclick={handleSend}
        disabled={$store.isLoading}
      >
        {#if $store.isLoading}Sending...{:else}Send{/if}
      </button>
    </div>
  </div>
</div>
</div>

<style>
  .modal-back {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal.compose {
    width: min(560px, 92vw);
    height: min(80vh, 720px);
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    background: var(--color-bg);
    border-radius: 14px;
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.35);
    border: 1px solid var(--color-border);
    overflow: hidden;
  }

  .compose-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  .compose-title {
    font-size: 16px;
    font-weight: 600;
    color: var(--color-text);
    margin: 0;
  }

  .close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    font-size: 16px;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: background var(--transition);
    box-sizing: border-box;
  }

  .close-btn:hover {
    background: var(--color-hover);
  }

  .compose-body {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
  }

  .field-row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 12px;
  }

  .field-label {
    width: 60px;
    font-size: 14px;
    color: var(--color-text-secondary);
    text-align: right;
    flex-shrink: 0;
    padding-top: 8px;
    line-height: 1.4;
  }

  .field-control {
    flex: 1;
    min-width: 0;
  }

  .field-control input[type="text"] {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    font-size: 14px;
    color: var(--color-text);
    background: var(--color-bg-secondary);
  }

  .field-control input[type="text"]:focus {
    outline: none;
    border-color: var(--color-accent);
  }

  .field-actions {
    flex: 1;
    display: flex;
    gap: 12px;
  }

  .text-btn {
    background: transparent;
    border: none;
    font-size: 13px;
    color: var(--color-accent);
    cursor: pointer;
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    transition: background var(--transition);
  }

  .text-btn:hover {
    background: var(--color-hover);
  }

  .compose-editor {
    margin-top: 12px;
  }

  .compose-editor textarea {
    width: 100%;
    padding: 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    font-size: 14px;
    line-height: 1.6;
    color: var(--color-text);
    background: var(--color-bg);
    resize: vertical;
    font-family: inherit;
  }

  .compose-editor textarea:focus {
    outline: none;
    border-color: var(--color-accent);
  }

  .schedule-panel {
    padding: 16px 20px;
    background: var(--color-bg-secondary);
    border-top: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  .schedule-panel h3 {
    font-size: 14px;
    font-weight: 600;
    margin: 0 0 12px;
    color: var(--color-text);
  }

  .schedule-row {
    display: flex;
    gap: 12px;
    margin-bottom: 12px;
  }

  .schedule-row input {
    padding: 8px 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    font-size: 14px;
    color: var(--color-text);
    background: var(--color-bg);
  }

  .schedule-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .schedule-error {
    margin: 0 0 10px;
    padding: 8px 10px;
    background: rgba(220, 38, 38, 0.08);
    color: #b91c1c;
    border: 1px solid rgba(220, 38, 38, 0.3);
    border-radius: 6px;
    font-size: 13px;
  }

  .schedule-quick {
    display: flex;
    gap: 8px;
    margin-bottom: 10px;
  }

  .schedule-quick .quick-btn {
    padding: 5px 12px;
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: 16px;
    font-size: 12px;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: all var(--transition);
  }

  .schedule-quick .quick-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .compose-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    border-top: 1px solid var(--color-border);
    background: var(--color-bg-secondary);
    flex-shrink: 0;
  }

  .footer-left {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    flex: 1;
    min-width: 0;
  }

  .attachment-chips {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    max-width: 40ch;
  }

  .attachment-chips.empty {
    display: none;
  }

  .attachment-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    background: var(--color-selected);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    font-size: 12px;
    color: var(--color-text);
    max-width: 24ch;
  }

  .attachment-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .attachment-remove {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    background: transparent;
    border: none;
    font-size: 10px;
    color: var(--color-text-secondary);
    cursor: pointer;
    padding: 0;
  }

  .attachment-remove:hover {
    color: var(--color-danger);
  }

  .attachment-error {
    color: var(--color-danger);
    font-size: 12px;
    max-width: 30ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
    padding: 0;
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    font-size: 16px;
    cursor: pointer;
    transition: all var(--transition);
    box-sizing: border-box;
  }

  .icon-btn:hover {
    background: var(--color-hover);
  }

  .icon-btn.active {
    background: var(--color-selected);
    border-color: var(--color-accent);
  }

  .schedule-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: var(--color-selected);
    border-radius: 12px;
    font-size: 12px;
    color: var(--color-text);
  }

  .schedule-badge button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    background: transparent;
    border: none;
    font-size: 8px;
    color: var(--color-text-secondary);
    cursor: pointer;
    padding: 0;
  }

  .schedule-badge button:hover {
    color: var(--color-danger);
  }

  .footer-right {
    display: flex;
    gap: 8px;
  }

  .btn-secondary {
    padding: 8px 16px;
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    font-size: 14px;
    color: var(--color-text);
    cursor: pointer;
    transition: all var(--transition);
  }

  .btn-secondary:hover {
    background: var(--color-hover);
  }

  .btn-primary {
    padding: 8px 16px;
    background: var(--color-accent);
    border: none;
    border-radius: var(--radius-sm);
    font-size: 14px;
    font-weight: 500;
    color: white;
    cursor: pointer;
    transition: background var(--transition);
  }

  .btn-primary:hover {
    background: var(--color-accent-hover);
  }

  .btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
