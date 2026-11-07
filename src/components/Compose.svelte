<script lang="ts">
  import { apiFetch } from '../api'
  import { store, getState, setComposeTo, setComposeSubject, setComposeBody, setIsLoading, setComposeScheduled, clearCompose, setComposing } from '../store'
  import { onMount } from 'svelte'
  import { addQueuedMessage } from '../lib/offlineQueue'
  import { buildMessageBody, normalizeAccount, type Signature } from '../lib/signature'
  import { fileToAttachment, type OutboundAttachment, AttachmentTooLargeError } from '../lib/attachments'

  let { onClose } = $props()
  
  
  // Local editable state
  let subjectInput = $state(getState().composeSubject || '')
  let bodyInput = $state(getState().composeBody || '')

  // ---- Signature seeding ----
  // The compose body is finalized the moment the panel opens so the user types
  // above the signature. New compose seeds the signature text only; reply and
  // forward place it per the account's `position` setting, above/below the
  // quoted original. The backend is the source of truth for the active
  // account's signature (GET /api/account returns it normalized).
  function quotedOriginal(): string | null {
    const m = getState().composeOriginalMessage
    if (!m) return null
    return m.body || m.bodyHtml || null
  }
  function applySignature(sig: Signature, original: string | null): boolean {
    if (!sig || !sig.enabled || !sig.text.trim()) return false
    const body = buildMessageBody(sig, '', original)
    if (body) { bodyInput = body; setComposeBody(body) }
    return true
  }
  async function seedBody() {
    // Prefer the store account (already normalized); fall back to the backend.
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
    } catch {
      /* offline / no backend: seed with nothing */
    }
  }
  
  let toInput = $state('')
  let showCc = $state(false)
  let showBcc = $state(false)
  let showSchedule = $state(false)
  let scheduleDate = $state('')
  let scheduleTime = $state('')
  let attachFile: HTMLInputElement | null = null
  let attachments = $state<OutboundAttachment[]>([])
  let attachmentError = $state<string | null>(null)

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }
  
  function addRecipient(input: string) {
    const emails = input.split(/[,;]/).map(e => e.trim()).filter(e => e)
    if (emails.length > 0) {
      setComposeTo([...getState().composeTo, ...emails])
      toInput = ''
    }
  }
  
  function handleToKey(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addRecipient(toInput)
    }
  }
  
  function removeRecipient(email: string) {
    setComposeTo(getState().composeTo.filter(e => e !== email))
  }
  
  function handleKeyDown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      if (toInput.trim()) addRecipient(toInput)
      handleSend()
      return
    }
    // Focus trap within the compose dialog: cycle Tab/Shift-Tab.
    if (e.key === 'Tab') {
      const root = document.querySelector<HTMLElement>('.compose-window')
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
      // If focus is outside the dialog, snap it back to the first element.
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
    if (toInput.trim()) addRecipient(toInput)
    if (getState().composeTo.length === 0) {
      alert('Please add at least one recipient')
      return
    }
    
    setIsLoading(true)
    
    const message: Record<string, unknown> = {
      to: getState().composeTo,
      cc: getState().composeCc,
      bcc: getState().composeBcc,
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
        // Offline: queued for later sending
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
            to: getState().composeTo,
            cc: getState().composeCc,
            bcc: getState().composeBcc,
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
    if (scheduleDate && scheduleTime) {
      const date = new Date(`${scheduleDate}T${scheduleTime}`)
      setComposeScheduled(date.toISOString())
      showSchedule = false
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
    // Reset so re-selecting the same file fires change again.
    input.value = ''
  }

  function removeAttachment(index: number) {
    attachments.splice(index, 1)
  }

  onMount(() => {
    void seedBody()
    window.addEventListener('keydown', handleKeyDown)
    // Move initial focus to the first recipient input for keyboard entry.
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLInputElement>('.compose-window .recipient-input input')
        || document.querySelector<HTMLInputElement>('.compose-window input')
      if (el) el.focus()
    })
    return () => window.removeEventListener('keydown', handleKeyDown)
  })
</script>

<div class="compose-window" role="dialog" aria-modal="true" aria-label="Compose message" onclick={e => e.stopPropagation()}>
  <div class="compose-header">
    <h2 class="compose-title">
      {#if $store.composeReplyTo}Reply{:else if $store.composeForward}Forward{:else}New Message{/if}
    </h2>
    <button class="close-btn" onclick={onClose} aria-label="Close compose (Esc)">✕</button>
  </div>
  
  <div class="compose-body">
    <div class="field-row">
      <label class="field-label">To</label>
      <div class="recipient-input" class:focused={toInput}>
        {#each $store.composeTo as email (email)}
          <span class="chip">{email} <button onclick={() => removeRecipient(email)}>✕</button></span>
        {/each}
        <input 
          type="text"
          bind:value={toInput}
          placeholder={$store.composeTo.length === 0 ? "recipient@example.com" : ""}
          onkeydown={handleToKey}
        />
      </div>
    </div>
    
    {#if showCc}
      <div class="field-row">
        <label class="field-label">Cc</label>
        <div class="recipient-input">
          {#each $store.composeCc as email (email)}
            <span class="chip">{email}</span>
          {/each}
          <input type="text" placeholder="Add Cc..." />
        </div>
      </div>
    {/if}
    
    {#if showBcc}
      <div class="field-row">
        <label class="field-label">Bcc</label>
        <div class="recipient-input">
          {#each $store.composeBcc as email (email)}
            <span class="chip">{email}</span>
          {/each}
          <input type="text" placeholder="Add Bcc..." />
        </div>
      </div>
    {/if}
    
    <div class="field-row">
      <label class="field-label">&nbsp;</label>
      <div class="field-actions">
        <button class="text-btn" onclick={() => showCc = !showCc}>
          {#if showCc}Hide Cc{:else}Add Cc{/if}
        </button>
        <button class="text-btn" onclick={() => showBcc = !showBcc}>
          {#if showBcc}Hide Bcc{:else}Add Bcc{/if}
        </button>
      </div>
    </div>
    
    <div class="field-row">
      <label class="field-label">Subject</label>
      <input 
        type="text"
        bind:value={subjectInput}
        oninput={() => setComposeSubject(subjectInput)}
        placeholder="Subject"
      />
    </div>
    
    <div class="compose-editor">
      <textarea
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
      <div class="schedule-row">
        <input type="date" bind:value={scheduleDate} />
        <input type="time" bind:value={scheduleTime} />
      </div>
      <div class="schedule-actions">
        <button class="btn-secondary" onclick={() => showSchedule = false}>Cancel</button>
        <button class="btn-primary" onclick={handleSchedule}>Schedule</button>
      </div>
    </div>
  {/if}
  
  <div class="compose-footer">
    <div class="footer-left">
      <button class="icon-btn" title="Attach file" onclick={() => attachFile?.click()}>
        <span>📎</span>
      </button>
      <input 
        type="file" 
        multiple 
        bind:this={attachFile}
        onchange={handleAttach}
        hidden
      />
      <div class="attachment-chips" class:empty={attachments.length === 0}>
        {#each attachments as att, i (att.filename + i)}
          <span class="attachment-chip" title="{att.contentType}">
            <span class="attachment-name">{att.filename}</span>
            <button class="attachment-remove" onclick={() => removeAttachment(i)} aria-label="Remove {att.filename}">✕</button>
          </span>
        {/each}
      </div>
      {#if attachmentError}
        <span class="attachment-error">{attachmentError}</span>
      {/if}
      <button 
        class="icon-btn" 
        title="Schedule send"
        class:active={showSchedule || $store.composeScheduled}
        onclick={() => showSchedule = !showSchedule}
      >
        <span>⏰</span>
      </button>
      {#if $store.composeScheduled}
        <span class="schedule-badge">
          Scheduled: {new Date($store.composeScheduled).toLocaleString()}
          <button onclick={() => setComposeScheduled(null)}>✕</button>
        </span>
      {/if}
    </div>
    <div class="footer-right">
      <button class="btn-secondary" onclick={onClose}>Save Draft</button>
      <button 
        class="btn-primary" 
        onclick={handleSend}
        disabled={$store.isLoading}
      >
        {#if $store.isLoading}Sending...{:else}Send{/if}
      </button>
    </div>
  </div>
</div>

<style>
  .compose-window {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--color-bg);
  }
  
  .compose-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    border-bottom: 1px solid var(--color-border);
  }
  
  .compose-title {
    font-size: 16px;
    font-weight: 600;
    color: var(--color-text);
  }
  
  .close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    font-size: 16px;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: background var(--transition);
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
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }
  
  .field-label {
    width: 60px;
    font-size: 14px;
    color: var(--color-text-secondary);
    text-align: right;
    flex-shrink: 0;
  }
  
  .recipient-input {
    flex: 1;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 12px;
    background: var(--color-bg-secondary);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
  }
  
  .recipient-input input {
    flex: 1;
    min-width: 100px;
    border: none;
    background: transparent;
    font-size: 14px;
    color: var(--color-text);
    outline: none;
  }
  
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: var(--color-selected);
    border-radius: 12px;
    font-size: 13px;
    color: var(--color-text);
  }
  
  .chip button {
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
  }
  
  .chip button:hover {
    color: var(--color-danger);
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
    font-family: var(--font-sans);
  }
  
  .compose-editor textarea:focus {
    outline: none;
    border-color: var(--color-accent);
  }
  
  .schedule-panel {
    padding: 16px 20px;
    background: var(--color-bg-secondary);
    border-top: 1px solid var(--color-border);
  }
  
  .schedule-panel h3 {
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 12px;
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
  
  .compose-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    border-top: 1px solid var(--color-border);
    background: var(--color-bg-secondary);
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
    width: 32px;
    height: 32px;
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    font-size: 16px;
    cursor: pointer;
    transition: all var(--transition);
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
