<script lang="ts">
  import { store, getState, setComposeTo, setComposeSubject, setComposeReplyTo, setComposeOriginalMessage, setComposing, setComposeForward, deleteMessage, updateMessage, selectMessage } from '../store'
  import { sanitizeHtml, hasRemoteImages } from '../lib/sanitizeHtml'

  let {
    onDelete: propDelete,
    onArchive: propArchive,
    onStar: propStar,
    onReply: propReply
  }: {
    onDelete?: () => void
    onArchive?: () => void
    onStar?: () => void
    onReply?: () => void
  } = $props()

  // Per-message opt-in; not persisted.
  let imagesLoadedFor = $state<string | null>(null)

  function formatFullDate(dateStr: string) {
    return new Date(dateStr).toLocaleString()
  }

  function getCurrentMessage() {
    const s = getState()
    return s.messages.find(m => m.id === s.selectedMessageId)
  }

  function handleReply() {
    const msg = getCurrentMessage()
    if (!msg) return
    if (propReply) { propReply(); return }
    setComposeTo([msg.from])
    setComposeSubject(`Re: ${msg.subject}`)
    setComposeReplyTo(msg.id)
    setComposeOriginalMessage(msg)
    setComposing(true)
  }

  function handleForward() {
    const msg = getCurrentMessage()
    if (!msg) return
    setComposeTo([])
    setComposeSubject(`Fwd: ${msg.subject}`)
    setComposeForward(true)
    setComposeOriginalMessage(msg)
    setComposing(true)
  }

  function handleDelete() {
    if (propDelete) { propDelete(); return }
    const msg = getCurrentMessage()
    if (!msg) return
    deleteMessage(msg.id)
  }

  function handleArchive() {
    if (propArchive) { propArchive(); return }
    const msg = getCurrentMessage()
    if (!msg) return
    deleteMessage(msg.id)
  }

  function handleStar() {
    if (propStar) { propStar(); return }
    const msg = getCurrentMessage()
    if (!msg) return
    const flags = msg.flags || []
    const hasFlag = flags.includes('\\Flagged') || flags.includes('Flagged')
    const newFlags = hasFlag
      ? flags.filter(f => f !== '\\Flagged' && f !== 'Flagged')
      : [...flags, '\\Flagged']
    updateMessage(msg.id, { flags: newFlags })
  }

  function downloadAttachment(att: any) {
    const msg = getCurrentMessage()
    if (!msg) return
    const a = document.createElement('a')
    a.href = `/api/attachment/${msg.id}?name=${encodeURIComponent(att.filename)}`
    a.download = att.filename || 'attachment'
    a.target = '_blank'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  function formatSize(bytes: number) {
    if (!bytes) return ''
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  }

  function hasFlag(flags: string[], flag: string) {
    return flags.includes('\\' + flag) || flags.includes(flag)
  }
</script>

{#if $store.selectedMessageId}
  {@const msg = $store.messages.find(m => m.id === $store.selectedMessageId)}
  {#if msg}
    <div class="message-view">
    <div class="view-header">
      <div class="header-actions">
        <button class="action-btn icon" class:starred={hasFlag(msg.flags || [], 'Flagged')} onclick={handleStar} title="Star" aria-label="Star" aria-pressed={hasFlag(msg.flags || [], 'Flagged') ? 'true' : 'false'}>
          {#if hasFlag(msg.flags || [], 'Flagged')}⭐{:else}☆{/if}
        </button>
        <button class="action-btn" onclick={handleReply} title="Reply" aria-label="Reply">↩ Reply</button>
        <button class="action-btn" onclick={handleForward} title="Forward" aria-label="Forward">↪ Forward</button>
        <button class="action-btn icon" onclick={handleArchive} title="Archive" aria-label="Archive">📦</button>
        <button class="action-btn icon danger" onclick={handleDelete} title="Delete" aria-label="Delete">🗑</button>
      </div>
      <div class="header-left">
        <button class="back-btn" aria-label="Back to message list" onclick={() => selectMessage(null)}>←</button>
        <div class="subject-area">
          <h2 class="message-subject">{msg.subject || '(no subject)'}</h2>
          <div class="message-meta">
            <span class="sender">From: {msg.from}</span>
            <span class="recipient">To: {msg.to?.join(', ')}</span>
            <span class="date">{formatFullDate(msg.date || '')}</span>
          </div>
        </div>
      </div>
    </div>

      <div class="message-content">
        {#if msg.pgp && msg.pgp.encrypted}
          <div class="pgp-banner" class:pgp-banner-decrypted={!!msg.pgp.decrypted}>
            <div class="pgp-banner-row">
              <span class="pgp-ico">🔐</span>
              {#if msg.pgp.decrypted}
                <span class="pgp-title">Encrypted message — <b>decrypted</b> below</span>
              {:else}
                <span class="pgp-title">Encrypted message — <b>cannot decrypt</b></span>
              {/if}
              {#if msg.pgp.signed}
                <span class="pgp-chip" class:verified={!!msg.pgp.verified}>
                  {#if msg.pgp.verified === true}✓ signature verified
                  {:else if msg.pgp.verified === false}✕ signature invalid
                  {:else}signed (not verified){/if}
                </span>
              {/if}
            </div>
            {#if !msg.pgp.decrypted}
              <p class="pgp-help">
                {msg.pgp.error || 'OpenPGP private key not configured.'}
                Add your private key in <b>Settings → PGP</b> and reopen this message.
              </p>
              {#if msg.pgp.armored}
                <details class="pgp-armor">
                  <summary>Raw armored message</summary>
                  <pre>{msg.pgp.armored}</pre>
                </details>
              {/if}
            {/if}
          </div>
        {/if}

        {#if msg.bodyHtml}
          {#if hasRemoteImages(msg.bodyHtml) && imagesLoadedFor !== msg.id}
            <div class="remote-images-banner">
              Remote images blocked
              <button type="button" onclick={() => (imagesLoadedFor = msg.id)}>Load images</button>
            </div>
          {/if}
          {@html sanitizeHtml(msg.bodyHtml, { allowRemoteImages: imagesLoadedFor === msg.id })}
        {:else if msg.body}
          <div class="plain-body">{msg.body}</div>
        {:else}
          <p class="empty-body">This message has no visible content. It may be PGP-encrypted or empty.</p>
        {/if}
      </div>

      {#if msg.attachments?.length > 0}
        <div class="attachments">
          <h3>📎 {msg.attachments.length} Attachment{msg.attachments.length !== 1 ? 's' : ''}</h3>
          <div class="attachment-list">
            {#each msg.attachments as att, i (i)}
              <button class="attachment-item" onclick={() => downloadAttachment(att)}>
                <span class="att-icon">📄</span>
                <div class="att-info">
                  <span class="att-name">{att.filename}</span>
                  <span class="att-size">{formatSize(att.size)}</span>
                </div>
                <span class="att-download">⬇</span>
              </button>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  {/if}
{:else}
  <div class="no-message">
    <div class="empty-icon">📧</div>
    <p>Select a message to view</p>
  </div>
{/if}

<style>
  .message-view { display: flex; flex-direction: column; height: 100%; overflow: hidden; flex: 1; }
  .view-header { display: flex; flex-direction: column; gap: 12px; padding: 16px 24px; border-bottom: 1px solid var(--color-border); }
  .header-left { display: flex; align-items: flex-start; gap: 16px; min-width: 0; }
  .back-btn { display: flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px; padding: 0; background: transparent; border: 1px solid var(--color-border); border-radius: var(--radius-sm); font-size: 18px; color: var(--color-text); cursor: pointer; transition: all var(--transition); flex-shrink: 0; box-sizing: border-box; }
  .back-btn:hover { background: var(--color-hover); }
  .subject-area { flex: 1; min-width: 0; }
  .message-subject { font-size: 18px; font-weight: 600; color: var(--color-text); margin-bottom: 8px; word-break: break-word; }
  .message-meta { display: flex; flex-direction: column; gap: 4px; }
  .message-meta span { font-size: 13px; color: var(--color-text-secondary); }
  .header-actions { display: flex; gap: 8px; overflow-x: auto; flex-shrink: 0; }
  .action-btn { display: flex; align-items: center; gap: 4px; min-height: 44px; padding: 8px 12px; background: transparent; border: 1px solid var(--color-border); border-radius: var(--radius-sm); font-size: 13px; color: var(--color-text); cursor: pointer; transition: all var(--transition); white-space: nowrap; box-sizing: border-box; }
  .action-btn:hover { background: var(--color-hover); }
  .action-btn.starred { background: var(--color-selected); border-color: var(--color-star); }
  .action-btn.danger:hover { background: var(--danger-bg); border-color: var(--color-danger); color: var(--color-danger); }
  .message-content { flex: 1; overflow-y: auto; padding: 24px; font-size: 14px; line-height: 1.7; color: var(--color-text); }
  .message-content img { max-width: 100%; height: auto; }
  .message-content a { color: var(--color-accent); text-decoration: underline; }
  .message-content pre { background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: 12px; overflow-x: auto; font-size: 13px; }
  .plain-body { white-space: pre-wrap; word-wrap: break-word; }
  .empty-body { color: var(--color-text-secondary); font-style: italic; padding: 40px; text-align: center; }

  /* ---- PGP banner ---- */
  .pgp-banner {
    margin-bottom: 16px;
    padding: 12px 14px;
    border: 1px solid var(--color-border);
    border-left: 4px solid var(--color-star);
    background: var(--accent-soft);
    border-radius: var(--radius-sm);
    font-size: 13px;
    line-height: 1.5;
    color: var(--color-text);
  }
  .pgp-banner.pgp-banner-decrypted { border-left-color: var(--color-success); background: var(--accent-soft); }
  .pgp-banner-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .pgp-ico { font-size: 18px; }
  .pgp-title { font-weight: 600; }
  .pgp-title b { color: var(--color-star); }
  .pgp-banner.pgp-banner-decrypted .pgp-title b { color: var(--color-success); }
  .pgp-help { margin: 8px 0 0 26px; color: var(--color-text-secondary); font-size: 12px; }
  .pgp-chip {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 999px;
    background: rgba(0,0,0,.05);
    color: var(--color-text-secondary);
  }
  .pgp-chip.verified { background: var(--accent-soft); color: var(--color-success); }
  .pgp-chip:not(.verified) { background: var(--accent-soft); color: var(--color-star); }
  .pgp-armor { margin: 8px 0 0 26px; }
  .pgp-armor summary { cursor: pointer; font-size: 12px; color: var(--color-text-secondary); }
  .pgp-armor pre {
    max-height: 240px; overflow: auto; margin-top: 6px;
    background: var(--code-bg); color: var(--code-fg); padding: 10px 12px; border-radius: 6px;
    font-size: 11px; line-height: 1.4; white-space: pre-wrap; word-break: break-word;
  }
  .attachments { padding: 16px 24px; border-top: 1px solid var(--color-border); background: var(--color-bg); }
  .attachments h3 { font-size: 13px; font-weight: 600; color: var(--color-text-secondary); margin-bottom: 12px; }
  .attachment-list { display: flex; flex-direction: column; gap: 8px; }
  .attachment-item { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-sm); cursor: pointer; transition: all var(--transition); text-align: left; }
  .attachment-item:hover { border-color: var(--color-accent); background: var(--color-hover); }
  .att-icon { font-size: 20px; }
  .att-info { display: flex; flex-direction: column; min-width: 0; }
  .att-name { font-size: 13px; font-weight: 500; color: var(--color-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .att-size { font-size: 12px; color: var(--color-text-secondary); }
  .att-download { font-size: 16px; color: var(--color-accent); flex-shrink: 0; }
  .no-message { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--color-text-secondary); }
  .empty-icon { font-size: 48px; }
  @media (max-width: 768px) {
    .view-header { flex-wrap: wrap; padding: 12px; }
    .header-actions { width: 100%; overflow-x: auto; flex-wrap: nowrap; padding-bottom: 4px; }
    .message-subject { font-size: 16px; }
    .message-content { padding: 16px; }
    .attachments { padding: 12px; }
  }
  .remote-images-banner { padding: 6px 10px; margin-bottom: 8px; font-size: 13px; background: rgba(128,128,128,.15); border-radius: 6px; display: flex; gap: 8px; align-items: center; }
</style>
