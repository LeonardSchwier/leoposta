<script lang="ts">
  import { store, getState, selectMessage } from '../store'
  import { startReply } from '../lib/reply'
  import { sanitizeHtml, hasRemoteImages } from '../lib/sanitizeHtml'
  import { MailAPI } from '../api'
  import { downloadAttachment } from '../lib/attachmentDownload'
  import PgpUnlock from './PgpUnlock.svelte'

  import { hasFlag as messageHasFlag, isSpecialFolder, type MessageAction } from '../lib/messageActions'

  // Every toolbar action names the message shown here (lib/messageActions.ts).
  let {
    onAction,
    onMoveRequest,
    onEditDraft,
    onReply: propReply
  }: {
    onAction?: (id: string, action: MessageAction) => void
    onMoveRequest?: (id: string) => void
    /** Set while the Drafts mailbox is open: reopen this draft in Compose. */
    onEditDraft?: (id: string) => void
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
    void startReply(msg, 'reply')
  }

  function handleReplyAll() {
    const msg = getCurrentMessage()
    if (!msg) return
    void startReply(msg, 'replyAll')
  }

  function handleForward() {
    const msg = getCurrentMessage()
    if (!msg) return
    void startReply(msg, 'forward')
  }

  const inJunk = $derived(isSpecialFolder($store.folders, $store.activeFolder, '\\Junk', 'Junk'))
  const inArchive = $derived(isSpecialFolder($store.folders, $store.activeFolder, '\\Archive', 'Archive'))

  function act(action: MessageAction) {
    const msg = getCurrentMessage()
    if (msg) onAction?.(msg.id, action)
  }

  // The last failed download, keyed by message so it does not follow the user
  // to the next message.
  let attachmentError = $state<{ messageId: string; text: string } | null>(null)
  let downloadingId = $state<string | null>(null)

  async function handleDownloadAttachment(att: { id?: string; filename?: string }) {
    const msg = getCurrentMessage()
    if (!msg || !att.id || downloadingId) return
    attachmentError = null
    downloadingId = att.id
    try {
      await downloadAttachment(
        () => MailAPI.attachment(msg.id, att.id as string, msg.folder || getState().activeFolder),
        att.filename || 'attachment'
      )
    } catch (e) {
      attachmentError = { messageId: msg.id, text: e instanceof Error ? e.message : String(e) }
    } finally {
      downloadingId = null
    }
  }

  function formatSize(bytes: number) {
    if (!bytes) return ''
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  }

  // A link in a message must never replace the app itself: in the desktop
  // window there is no address bar or back button, so the linked page could
  // pose as Leoposta. Web and mail links open outside the app instead.
  function handleContentClick(e: MouseEvent) {
    const link = (e.target as Element | null)?.closest?.('a[href]')
    if (!link || !(e.currentTarget as Element).contains(link)) return
    e.preventDefault()
    const href = (link.getAttribute('href') || '').trim()
    if (/^(?:https?:|mailto:)/i.test(href)) window.open(href, '_blank', 'noopener,noreferrer')
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
        <button class="action-btn icon" class:starred={hasFlag(msg.flags || [], 'Flagged')} onclick={() => act(hasFlag(msg.flags || [], 'Flagged') ? 'unstar' : 'star')} title={hasFlag(msg.flags || [], 'Flagged') ? 'Unstar (s)' : 'Star (s)'} aria-label={hasFlag(msg.flags || [], 'Flagged') ? 'Unstar' : 'Star'} aria-pressed={hasFlag(msg.flags || [], 'Flagged') ? 'true' : 'false'}>
          {#if hasFlag(msg.flags || [], 'Flagged')}⭐{:else}☆{/if}
        </button>
        {#if onEditDraft}
          <button class="action-btn" onclick={() => onEditDraft?.(msg.id)} title="Edit draft" aria-label="Edit draft">✎ Edit draft</button>
        {/if}
        <button class="action-btn" onclick={handleReply} title="Reply" aria-label="Reply">↩ Reply</button>
        <button class="action-btn" onclick={handleReplyAll} title="Reply all" aria-label="Reply all">↩↩ Reply all</button>
        <button class="action-btn" onclick={handleForward} title="Forward" aria-label="Forward">↪ Forward</button>
        {#if messageHasFlag(msg, '\\Seen')}
          <button class="action-btn icon" onclick={() => act('unread')} title="Mark as unread (u)" aria-label="Mark as unread">●</button>
        {:else}
          <button class="action-btn icon" onclick={() => act('read')} title="Mark as read (u)" aria-label="Mark as read">○</button>
        {/if}
        <button class="action-btn icon" onclick={() => onMoveRequest?.(msg.id)} title="Move to folder (v)" aria-label="Move to folder">📁</button>
        {#if inJunk}
          <button class="action-btn icon" onclick={() => act('notJunk')} title="Not junk" aria-label="Not junk">📥</button>
        {:else}
          <button class="action-btn icon" onclick={() => act('junk')} title="Mark as junk" aria-label="Mark as junk">🚫</button>
        {/if}
        {#if !inArchive}
          <button class="action-btn icon" onclick={() => act('archive')} title="Archive (a)" aria-label="Archive">📦</button>
        {/if}
        <button class="action-btn icon danger" onclick={() => act('delete')} title="Delete (d)" aria-label="Delete">🗑</button>
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

      <!-- Clicks are delegated from links inside sender HTML; keyboard activation of a link also fires click. -->
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="message-content" onclick={handleContentClick}>
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
            <PgpUnlock {msg} />
            {#if !msg.pgp.decrypted}
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
        {:else if !(msg.pgp?.encrypted && !msg.pgp?.decrypted)}
          <p class="empty-body">This message has no visible content.</p>
        {/if}
      </div>

      {#if msg.attachments && msg.attachments.length > 0}
        <div class="attachments">
          <h3>📎 {msg.attachments.length} Attachment{msg.attachments.length !== 1 ? 's' : ''}</h3>
          <div class="attachment-list">
            {#each msg.attachments as att, i (i)}
              <button
                class="attachment-item"
                disabled={!att.id || downloadingId !== null}
                title={att.id ? undefined : 'Download is not available for this attachment yet'}
                onclick={() => handleDownloadAttachment(att)}
              >
                <span class="att-icon">📄</span>
                <div class="att-info">
                  <span class="att-name">{att.filename}</span>
                  <span class="att-size">{formatSize(att.size)}</span>
                </div>
                <span class="att-download">⬇</span>
              </button>
            {/each}
          </div>
          {#if attachmentError && attachmentError.messageId === msg.id}
            <p class="att-error" role="alert">{attachmentError.text}</p>
          {/if}
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
  /* contain: paint makes this pane the containing block of position:fixed/absolute
     sender content and clips it, so a message cannot overlay the app (UI redress). */
  .message-content { flex: 1; overflow-y: auto; padding: 24px; font-size: 14px; line-height: 1.7; color: var(--color-text); contain: paint; isolation: isolate; }
  /* The mail body is {@html}: its elements carry no Svelte scope class, so
     these must be :global (scoped, they matched nothing and a wide image
     pushed the reading pane into horizontal scrolling). */
  .message-content :global(img) { max-width: 100%; height: auto; }
  .message-content :global(a) { color: var(--color-accent); text-decoration: underline; }
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
  .attachment-item:disabled { opacity: 0.6; cursor: not-allowed; }
  .attachment-item:disabled:hover { border-color: var(--color-border); background: var(--color-surface); }
  .att-error { margin-top: 10px; font-size: 13px; color: var(--color-danger); }
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
