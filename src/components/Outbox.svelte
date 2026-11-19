<script lang="ts">
  // The offline outbox, as the user sees it: mail written without a connection
  // that has not left yet. Without this panel a message the server refuses
  // (its account was removed, a bad recipient) stayed in IndexedDB forever, was
  // retried on every reconnect and could be neither read nor discarded.
  import { onMount, tick } from 'svelte'
  import {
    getQueuedMessages, discardQueuedMessage, flushQueue, QUEUE_CHANGED,
    type QueuedMessage
  } from '../lib/offlineQueue'

  let { online = true, onClose }: { online?: boolean; onClose: () => void } = $props()

  let messages = $state<QueuedMessage[]>([])
  let loaded = $state(false)
  let retrying = $state(false)
  let error = $state('')
  let panel: HTMLDivElement | undefined = $state()
  let loadSeq = 0

  function describe(e: unknown): string {
    return e instanceof Error && e.message ? e.message : String(e)
  }

  /** Removing the focused row (Discard, a send that went through) drops focus
   * to the page, and then Escape and the Tab trap, which listen on the panel,
   * no longer fire. Take focus back, but only from the page itself: focus that
   * went to another dialog opened on top of this one is left alone. */
  async function keepFocus() {
    await tick()
    const a = document.activeElement as HTMLButtonElement | null
    // Lost: on the page, or on a button of the panel that is disabled now (a
    // browser moves focus off it on its own; jsdom does not).
    const lost = !a || a === document.body || (!!panel?.contains(a) && a.disabled === true)
    if (!panel || !lost) return
    ;(panel.querySelector<HTMLElement>('button:not([disabled])') ?? panel).focus()
  }

  async function load() {
    const seq = ++loadSeq
    try {
      const all = await getQueuedMessages()
      if (seq === loadSeq) messages = all
    } catch (e) {
      if (seq === loadSeq) error = `The outbox could not be read: ${describe(e)}`
    } finally {
      if (seq === loadSeq) loaded = true
    }
    await keepFocus()
  }

  async function retry() {
    if (retrying || !online) return
    retrying = true
    error = ''
    try {
      await flushQueue()
    } catch (e) {
      error = `Sending failed: ${describe(e)}`
    } finally {
      retrying = false
      await load()
    }
  }

  async function discard(m: QueuedMessage) {
    const name = m.subject.trim() || '(no subject)'
    if (!confirm(`Discard "${name}"? It is deleted from this device and will not be sent.`)) return
    error = ''
    try {
      await discardQueuedMessage(m.id!)
    } catch (e) {
      error = `The message could not be discarded: ${describe(e)}`
    }
    await load()
  }

  function recipients(m: QueuedMessage): string {
    return [...m.to, ...(m.cc ?? []), ...(m.bcc ?? [])].join(', ')
  }

  function written(m: QueuedMessage): string {
    const d = new Date(m.createdAt)
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      // The dialog owns Escape: the app's own handler would also deselect the
      // open message.
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key !== 'Tab' || !panel) return
    const stops = [...panel.querySelectorAll<HTMLElement>('button:not([disabled])')]
    if (stops.length === 0) { e.preventDefault(); return }
    const first = stops[0]
    const last = stops[stops.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || active === panel)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  onMount(() => {
    const opener = document.activeElement as HTMLElement | null
    load()
    window.addEventListener(QUEUE_CHANGED, load)
    panel?.focus()
    return () => {
      window.removeEventListener(QUEUE_CHANGED, load)
      if (opener && opener.isConnected) opener.focus()
    }
  })
</script>

<div
  class="modal-back"
  role="presentation"
  onclick={(e) => { if (e.target === e.currentTarget) onClose() }}
  onkeydown={onKeydown}
>
  <div class="modal outbox-panel" role="dialog" aria-modal="true" aria-labelledby="outbox-title" tabindex="-1" bind:this={panel}>
    <h4 id="outbox-title">Unsent messages</h4>
    <p class="outbox-intro">
      Written without a connection and not sent yet.
      {#if !online}They are sent when you are back online.{/if}
    </p>

    {#if error}<p class="outbox-problem" role="alert">{error}</p>{/if}

    {#if loaded && messages.length === 0}
      <p class="outbox-empty">No unsent messages.</p>
    {/if}

    <ul class="outbox-list">
      {#each messages as m (m.id)}
        <li class="outbox-item" data-testid="outbox-item">
          <div class="outbox-subject">{m.subject.trim() || '(no subject)'}</div>
          <div class="outbox-meta">To: {recipients(m)}</div>
          {#if m.account}<div class="outbox-meta">From: {m.account}</div>{/if}
          {#if written(m)}<div class="outbox-meta">Written: {written(m)}</div>{/if}
          {#if m.attachments?.length}
            <div class="outbox-meta">{m.attachments.length} attachment{m.attachments.length === 1 ? '' : 's'}</div>
          {/if}
          {#if m.lastError}<div class="outbox-error">Last attempt failed: {m.lastError}</div>{/if}
          <div class="outbox-item-actions">
            <button type="button" class="outbox-discard" aria-label={`Discard "${m.subject.trim() || '(no subject)'}"`} onclick={() => discard(m)}>Discard</button>
          </div>
        </li>
      {/each}
    </ul>

    <div class="actions">
      <button type="button" class="primary" onclick={retry} disabled={!online || retrying || messages.length === 0}>
        {retrying ? 'Sending…' : 'Retry now'}
      </button>
      <span class="spacer"></span>
      <button type="button" onclick={() => onClose()}>Close</button>
    </div>
  </div>
</div>

<style>
  .modal-back { position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 250; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .modal { background: var(--color-bg); color: var(--color-text); border-radius: 14px; padding: 18px 20px 14px; width: min(520px, 92vw); max-height: 90vh; overflow-y: auto; box-shadow: 0 18px 60px rgba(0,0,0,0.35); border: 1px solid var(--color-border); }
  .modal:focus { outline: none; }
  .modal h4 { font-size: 15px; font-weight: 700; margin: 0 0 6px; }
  .outbox-intro { font-size: 12px; color: var(--color-text-secondary); margin: 0 0 12px; }
  .outbox-empty { font-size: 13px; color: var(--color-text-secondary); margin: 8px 0 14px; }
  .outbox-problem { font-size: 12px; color: var(--color-danger); margin: 0 0 10px; }
  .outbox-list { list-style: none; margin: 0 0 12px; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .outbox-item { border: 1px solid var(--color-border); border-radius: 8px; padding: 10px 12px; background: var(--color-bg-secondary); }
  .outbox-subject { font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
  .outbox-meta { font-size: 12px; color: var(--color-text-secondary); overflow-wrap: anywhere; }
  .outbox-error { font-size: 12px; color: var(--color-danger); margin-top: 4px; overflow-wrap: anywhere; }
  .outbox-item-actions { margin-top: 8px; display: flex; justify-content: flex-end; }
  .outbox-discard { padding: 6px 10px; min-height: 32px; border-radius: 6px; font-size: 12px; cursor: pointer; border: 1px solid var(--color-danger); background: transparent; color: var(--color-danger); }
  .outbox-discard:hover { background: var(--color-hover); }
  .actions { display: flex; gap: 8px; margin-top: 6px; }
  .actions .spacer { flex: 1; }
  .actions button { padding: 8px 14px; border-radius: 6px; font-size: 13px; font-weight: 500; cursor: pointer; border: 1px solid var(--color-border); background: var(--color-bg-secondary); color: var(--color-text); }
  .actions button:disabled { opacity: 0.5; cursor: not-allowed; }
  .actions .primary { background: var(--color-accent); color: var(--color-on-accent); border-color: var(--color-accent); }
</style>
