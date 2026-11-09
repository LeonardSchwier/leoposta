<script lang="ts">
  import { apiFetch, ContactsAPI } from '../api'
  import { store, getState, setComposeTo, setComposeSubject, setComposeBody, setIsLoading, setComposeScheduled, clearCompose, setComposing } from '../store'
  import { onMount } from 'svelte'
  import { addQueuedMessage } from '../lib/offlineQueue'
  import { buildMessageBody, normalizeAccount, type Signature } from '../lib/signature'
  import { fileToAttachment, type OutboundAttachment, AttachmentTooLargeError } from '../lib/attachments'

  // ---- Contact autocomplete ----
  interface AddressBook { uri: string; name: string }
  let addressBooks = $state<AddressBook[]>([])
  let contactsCache = $state<Record<string, any[]>>({})
  let contactsLoadingBook = $state<string | null>(null)
  let activeBookUri = $state<string>('')
  let toSuggestions = $state<any[]>([])
  let showSuggestions = $state(false)
  let suggestionIndex = $state(-1)
  let debounce: any = null

  async function loadAddressBooks() {
    try {
      const data = await ContactsAPI.addressBooks()
      addressBooks = data.addressBooks || []
      if (addressBooks.length) activeBookUri = addressBooks[0].uri
    } catch { addressBooks = [] }
  }

  async function loadContactsForBook(uri: string): Promise<any[]> {
    if (contactsCache[uri]) return contactsCache[uri]
    if (!contactsLoadingBook) {
      contactsLoadingBook = uri
      try {
        const data = await ContactsAPI.contacts(uri)
        const contacts = data.contacts || []
        contactsCache[uri] = contacts
        return contacts
      } catch {
        return []
      } finally {
        contactsLoadingBook = null
      }
    }
    return []
  }

  function allContacts(): any[] {
    const out: any[] = []
    for (const b of addressBooks) {
      const list = contactsCache[b.uri]
      if (list) for (const c of list) {
        if (!out.find((x: any) => x.email === c.email || x.uid === c.uid)) out.push(c)
      }
    }
    return out
  }

  function computeSuggestions(rawValue: string): any[] {
    const q = (rawValue || '').split(/[,\s;]+/).pop()?.trim().toLowerCase() || ''
    if (q.length < 1) return []
    const all = allContacts()
    // Lazily load contacts for the first book if we haven't yet
    if (activeBookUri) void loadContactsForBook(activeBookUri)
    return all
      .filter((c: any) => {
        const name = (c.name || '').toLowerCase()
        const email = (c.email || '').toLowerCase()
        const org = (c.org || '').toLowerCase()
        return name.startsWith(q) || email.includes(q) || org.includes(q)
      })
      .slice(0, 8)
  }

  function onToInput() {
    clearTimeout(debounce)
    debounce = setTimeout(() => {
      toSuggestions = computeSuggestions(toInput)
      suggestionIndex = -1
      showSuggestions = toSuggestions.length > 0
    }, 120)
  }

  function addSuggestion() {
    if (suggestionIndex < 0 || suggestionIndex >= toSuggestions.length) return
    const c = toSuggestions[suggestionIndex]
    const emails = [...getState().composeTo, c.email]
    setComposeTo(emails)
    toInput = ''
    toSuggestions = []
    showSuggestions = false
  }

  function onToKey(e: KeyboardEvent) {
    if (showSuggestions) {
      if (e.key === 'ArrowDown') { e.preventDefault(); suggestionIndex = Math.min(suggestionIndex + 1, toSuggestions.length - 1); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); suggestionIndex = Math.max(suggestionIndex - 1, 0); return }
      if (e.key === 'Tab' || (e.key === 'Enter' && suggestionIndex >= 0)) {
        e.preventDefault()
        addSuggestion()
        return
      }
      if (e.key === 'Escape') { showSuggestions = false; return }
      if (e.key === ',' || (e.key === 'Enter' && suggestionIndex === -1)) {
        e.preventDefault()
        addRecipient(toInput)
        toSuggestions = []
        showSuggestions = false
        return
      }
    }
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addRecipient(toInput)
    }
  }

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
    if (!sig || !sig.enabled || !sig.text.trim()) {
      // No active signature — still seed the quoted original for reply/forward.
      if (original) { const q = '\n--\n' + original; bodyInput = q; setComposeBody(q) }
      return false
    }
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
  let scheduleError = $state<string | null>(null)
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

  // Quick-preset schedule buttons: now+30m, +1d, +1w, +1m
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
      <div class="recipient-input" class:focused={toInput} class:open={showSuggestions}>
        {#each $store.composeTo as email (email)}
          <span class="chip">{email} <button aria-label={`Remove ${email}`} onclick={() => removeRecipient(email)}>✕</button></span>
        {/each}
        <input
          type="text"
          bind:value={toInput}
          oninput={onToInput}
          onkeydown={onToKey}
          onblur={() => { setTimeout(() => { toSuggestions = []; showSuggestions = false }, 150) }}
          placeholder={$store.composeTo.length === 0 ? "recipient@example.com" : ""}
          autocomplete="off"
        />
        {#if showSuggestions && toSuggestions.length > 0}
          <div class="suggestions" role="listbox">
            {#each toSuggestions as c, i (c.uid || c.email)}
              <div
                class="suggestion"
                class:active={i === suggestionIndex}
                role="option"
                aria-selected={i === suggestionIndex}
                onmousedown={(e) => { e.preventDefault(); showSuggestions = false
                  const emails = [...getState().composeTo, c.email]
                  setComposeTo(emails)
                  toInput = ''
                  toSuggestions = [] }
                }
              >
                <span class="sug-name">{c.name || c.email}</span>
                {#if c.email && c.name}<span class="sug-email">{c.email}</span>{/if}
                {#if c.org}<span class="sug-org">{c.org}</span>{/if}
              </div>
            {/each}
          </div>
        {/if}
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
      <div class="schedule-quick">
        <button type="button" class="quick-btn" onclick={() => prefillSchedule('30m')}>+30 min</button>
        <button type="button" class="quick-btn" onclick={() => prefillSchedule('1d')}>+1 day</button>
        <button type="button" class="quick-btn" onclick={() => prefillSchedule('1w')}>+1 week</button>
        <button type="button" class="quick-btn" onclick={() => prefillSchedule('1m')}>+1 month</button>
      </div>
      <div class="schedule-row">
        <input type="date" bind:value={scheduleDate} required />
        <input type="time" step="300" bind:value={scheduleTime} required />
      </div>
      {#if scheduleError}
        <p class="schedule-error" role="alert">{scheduleError}</p>
      {/if}
      <div class="schedule-actions">
        <button class="btn-secondary" onclick={() => { showSchedule = false; scheduleError = null }}>Cancel</button>
        <button class="btn-primary" onclick={handleSchedule}>Schedule</button>
      </div>
    </div>
  {/if}
  
  <div class="compose-footer">
    <div class="footer-left">
      <button class="icon-btn" title="Attach file" aria-label="Attach file" onclick={() => attachFile?.click()}>
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
        onclick={toggleSchedulePanel}
      >
        <span>⏰</span>
      </button>
      {#if $store.composeScheduled}
        <span class="schedule-badge">
          Scheduled: {new Date($store.composeScheduled).toLocaleString()}
          <button aria-label="Clear scheduled time" onclick={() => setComposeScheduled(null)}>✕</button>
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
    position: relative;
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

  .chip button::before {
    content: '';
    position: absolute;
    inset: -14px;
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
  
  .schedule-error {
    margin: 0;
    padding: 8px 10px;
    background: rgba(220, 38, 38, 0.08);
    color: #b91c1c;
    border: 1px solid rgba(220, 38, 38, 0.3);
    border-radius: 6px;
    font-size: 13px;
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

  .recipient-input {
    position: relative;
  }

  .recipient-input .suggestions {
    position: absolute;
    top: 100%;
    left: 0;
    width: 100%;
    margin-top: 4px;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
    z-index: 50;
    overflow: auto;
    max-height: 220px;
  }

  .recipient-input .suggestion {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 8px 12px;
    cursor: pointer;
    font-size: 13px;
    color: var(--color-text);
    border-bottom: 1px solid var(--color-border);
  }

  .recipient-input .suggestion:last-child {
    border-bottom: none;
  }

  .recipient-input .suggestion.active,
  .recipient-input .suggestion:hover {
    background: var(--color-selected);
  }

  .sug-name {
    font-weight: 500;
  }

  .sug-email {
    color: var(--color-text-secondary);
    font-size: 12px;
  }

  .sug-org {
    color: var(--color-text-secondary);
    font-size: 12px;
    margin-left: auto;
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
