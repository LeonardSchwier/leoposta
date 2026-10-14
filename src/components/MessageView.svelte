<script lang="ts">
  import { store, getState } from '../store'

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
    getState().setComposeTo([msg.from])
    getState().setComposeSubject(`Re: ${msg.subject}`)
    getState().setComposeReplyTo(msg.id)
    getState().setComposeOriginalMessage(msg)
    getState().setComposing(true)
  }

  function handleForward() {
    const msg = getCurrentMessage()
    if (!msg) return
    getState().setComposeTo([])
    getState().setComposeSubject(`Fwd: ${msg.subject}`)
    getState().setComposeForward(true)
    getState().setComposeOriginalMessage(msg)
    getState().setComposing(true)
  }

  function handleDelete() {
    const msg = getCurrentMessage()
    if (!msg) return
    getState().deleteMessage(msg.id)
  }

  function handleArchive() {
    const msg = getCurrentMessage()
    if (!msg) return
    getState().deleteMessage(msg.id)
  }

  function handleStar() {
    const msg = getCurrentMessage()
    if (!msg) return
    const flags = msg.flags || []
    const hasFlag = flags.includes('\\Flagged') || flags.includes('Flagged')
    const newFlags = hasFlag
      ? flags.filter(f => f !== '\\Flagged' && f !== 'Flagged')
      : [...flags, '\\Flagged']
    getState().updateMessage(msg.id, { flags: newFlags })
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
        <div class="header-left">
          <button class="back-btn" onclick={() => getState().selectMessage(null)}>←</button>
          <div class="subject-area">
            <h2 class="message-subject">{msg.subject || '(no subject)'}</h2>
            <div class="message-meta">
              <span class="sender">From: {msg.from}</span>
              <span class="recipient">To: {msg.to?.join(', ')}</span>
              <span class="date">{formatFullDate(msg.date || '')}</span>
            </div>
          </div>
        </div>
        <div class="header-actions">
          <button class="action-btn" class:starred={hasFlag(msg.flags || [], 'Flagged')} onclick={handleStar} title="Star">
            {#if hasFlag(msg.flags || [], 'Flagged')}⭐{:else}☆{/if}
          </button>
          <button class="action-btn" onclick={handleReply} title="Reply">↩ Reply</button>
          <button class="action-btn" onclick={handleForward} title="Forward">↪ Forward</button>
          <button class="action-btn" onclick={handleArchive} title="Archive">⬇</button>
          <button class="action-btn danger" onclick={handleDelete} title="Delete">🗑</button>
        </div>
      </div>

      <div class="message-content">
        {#if msg.bodyHtml}
          {@html msg.bodyHtml}
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
  .message-view { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
  .view-header { display: flex; align-items: flex-start; justify-content: space-between; padding: 16px 24px; border-bottom: 1px solid var(--color-border); gap: 16px; }
  .header-left { display: flex; align-items: flex-start; gap: 16px; flex: 1; min-width: 0; }
  .back-btn { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; background: transparent; border: 1px solid var(--color-border); border-radius: var(--radius-sm); font-size: 18px; color: var(--color-text); cursor: pointer; transition: all var(--transition); flex-shrink: 0; }
  .back-btn:hover { background: var(--color-hover); }
  .subject-area { flex: 1; min-width: 0; }
  .message-subject { font-size: 18px; font-weight: 600; color: var(--color-text); margin-bottom: 8px; word-break: break-word; }
  .message-meta { display: flex; flex-direction: column; gap: 4px; }
  .message-meta span { font-size: 13px; color: var(--color-text-secondary); }
  .header-actions { display: flex; gap: 8px; flex-shrink: 0; }
  .action-btn { display: flex; align-items: center; gap: 4px; padding: 8px 12px; background: transparent; border: 1px solid var(--color-border); border-radius: var(--radius-sm); font-size: 13px; color: var(--color-text); cursor: pointer; transition: all var(--transition); white-space: nowrap; }
  .action-btn:hover { background: var(--color-hover); }
  .action-btn.starred { background: var(--color-selected); border-color: var(--color-star); }
  .action-btn.danger:hover { background: rgba(255, 59, 48, 0.1); border-color: var(--color-danger); color: var(--color-danger); }
  .message-content { flex: 1; overflow-y: auto; padding: 24px; font-size: 14px; line-height: 1.7; color: var(--color-text); }
  .message-content img { max-width: 100%; height: auto; }
  .message-content a { color: var(--color-accent); text-decoration: underline; }
  .message-content pre { background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: 12px; overflow-x: auto; font-size: 13px; }
  .plain-body { white-space: pre-wrap; word-wrap: break-word; }
  .empty-body { color: var(--color-text-secondary); font-style: italic; padding: 40px; text-align: center; }
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
</style>
