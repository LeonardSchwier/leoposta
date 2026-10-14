<script lang="ts">
  import { store, getState } from '../store'
  
  let { onCompose, onSelectMessage, onDelete, onArchive, onStar, onSearch, searchQuery = '', isLoading = false, error = null } = $props()
  
  function formatDate(dateStr: string) {
    if (!dateStr) return ''
    const date = new Date(dateStr)
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    const days = Math.floor(diff / (1000 * 60 * 60 * 24))
    
    if (days === 0) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    } else if (days === 1) {
      return 'Yesterday'
    } else if (days < 7) {
      return date.toLocaleDateString([], { weekday: 'short' })
    } else {
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
    }
  }
  
  function handleSelect(message: typeof messages[0]) {
    getState().selectMessage(message.id)
    if (onSelectMessage) onSelectMessage(message.id)
    const flags = message.flags || []
    if (!flags.includes('\\Seen') && !flags.includes('Seen')) {
      getState().updateMessage(message.id, { flags: [...flags, '\\Seen'] })
    }
  }
  
  function handleReply(message: typeof messages[0]) {
    getState().setComposeTo([message.from])
    getState().setComposeSubject(`Re: ${message.subject}`)
    getState().setComposeReplyTo(message.id)
    getState().setComposeOriginalMessage(message)
    getState().setComposing(true)
  }
  
  function handleForward(message: typeof messages[0]) {
    getState().setComposeTo([])
    getState().setComposeSubject(`Fwd: ${message.subject}`)
    getState().setComposeForward(true)
    getState().setComposeOriginalMessage(message)
    getState().setComposing(true)
  }
  
  function isRead(message: typeof messages[0]) {
    return message.flags?.includes('\\Seen') || message.flags?.includes('Seen')
  }
  
  function isFlagged(message: typeof messages[0]) {
    return message.flags?.includes('\\Flagged') || message.flags?.includes('Flagged')
  }
  
  function getPreview(message: typeof messages[0]): string {
    if (message.body) return message.body.substring(0, 120)
    if (message.bodyHtml) return message.bodyHtml.replace(/<[^>]*>/g, '').substring(0, 120)
    if (message.attachments?.length) return '📎 ' + message.attachments.length + ' attachment(s)'
    return ''
  }
</script>

<div class="message-list-container">
  <div class="list-header">
    <h2 class="folder-title">
      {searchQuery ? `Results: "${searchQuery}"` : $store.activeFolder}
    </h2>
    <div class="search-box">
      <input
        type="text"
        placeholder="Search mail..."
        value={searchQuery}
        oninput={(e) => onSearch?.((e.target as HTMLInputElement).value)}
        class="search-input"
      />
    </div>
    <div class="actions">
      <button class="action-btn" title="New Message" onclick={onCompose}>✉</button>
    </div>
  </div>
  
  {#if error}
    <div class="error-state">
      <p class="error-text">{error}</p>
    </div>
  {/if}
  
  {#if isLoading}
    <div class="loading">
      <div class="spinner"></div>
      <p>Loading messages...</p>
    </div>
  {:else if $store.messages.length === 0}
    <div class="empty-state">
      <div class="empty-icon">📭</div>
      <h3>{searchQuery ? 'No results' : 'No messages'}</h3>
      <p>{searchQuery ? 'Try a different search term' : 'Your inbox is empty. Enjoy the calm!'}</p>
    </div>
  {:else}
    <div class="message-list">
      {#each $store.messages as message (message.id)}
        <div 
          class="message-row"
          class:unread={!isRead(message)}
          class:selected={$store.selectedMessageId === message.id}
          onclick={() => handleSelect(message)}
        >
          <div class="message-star">
            <button 
              class="star-btn"
              class:starred={isFlagged(message)}
              title={isFlagged(message) ? 'Unstar' : 'Star'}
              onclick={(e) => { e.stopPropagation(); onStar?.() }}
            >
              {#if isFlagged(message)}⭐{:else}☆{/if}
            </button>
          </div>
          <div class="message-info">
            <div class="message-top">
              <span class="sender-name">{message.from}</span>
              <span class="message-date">{formatDate(message.date)}</span>
            </div>
            <div class="message-subject">{message.subject || '(no subject)'}</div>
            <div class="message-preview">{getPreview(message)}</div>
          </div>
          <div class="message-actions" onclick={(e) => e.stopPropagation()}>
            <button class="msg-btn" title="Reply" onclick={() => handleReply(message)}>↩</button>
            <button class="msg-btn" title="Forward" onclick={() => handleForward(message)}>↪</button>
            <button class="msg-btn" title="Archive" onclick={() => onArchive?.()}>⬇</button>
            <button class="msg-btn danger" title="Delete" onclick={() => onDelete?.()}>🗑</button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .message-list-container {
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  
  .list-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 20px;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface);
  }
  
  .folder-title {
    font-size: 18px;
    font-weight: 600;
    color: var(--color-text);
    white-space: nowrap;
  }
  
  .search-box {
    flex: 1;
    max-width: 300px;
  }
  
  .search-input {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-bg);
    color: var(--color-text);
    font-size: 13px;
    outline: none;
  }
  
  .search-input:focus {
    border-color: var(--color-accent);
  }
  
  .actions {
    display: flex;
    gap: 8px;
    margin-left: auto;
  }
  
  .action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    font-size: 16px;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: all var(--transition);
  }
  
  .action-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }
  
  .loading {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    color: var(--color-text-secondary);
  }
  
  .spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--color-border);
    border-top-color: var(--color-accent);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }
  
  .empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--color-text-secondary);
  }
  
  .empty-icon {
    font-size: 48px;
    opacity: 0.5;
  }
  
  .error-state {
    padding: 16px;
    text-align: center;
  }
  
  .error-text {
    color: #e74c3c;
    font-size: 14px;
  }
  
  .message-list {
    flex: 1;
    overflow-y: auto;
  }
  
  .message-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--color-border);
    cursor: pointer;
    transition: background var(--transition);
    position: relative;
  }
  
  .message-row:hover {
    background: var(--color-hover);
  }
  
  .message-row.selected {
    background: var(--color-selected);
  }
  
  .message-row.unread .sender-name,
  .message-row.unread .message-subject {
    font-weight: 600;
  }
  
  .message-star {
    width: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    padding-top: 2px;
  }
  
  .star-btn {
    background: none;
    border: none;
    font-size: 16px;
    cursor: pointer;
    padding: 2px;
    opacity: 0.3;
    transition: opacity 0.15s;
  }
  
  .star-btn:hover, .star-btn.starred {
    opacity: 1;
  }
  
  .message-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  
  .message-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  
  .sender-name {
    font-size: 14px;
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 70%;
  }
  
  .message-date {
    font-size: 12px;
    color: var(--color-text-secondary);
    white-space: nowrap;
    flex-shrink: 0;
  }
  
  .message-subject {
    font-size: 13px;
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  
  .message-preview {
    font-size: 12px;
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  
  .message-actions {
    display: none;
    gap: 4px;
    position: absolute;
    right: 16px;
    top: 50%;
    transform: translateY(-50%);
    background: var(--color-surface);
    padding: 2px;
  }
  
  .message-row:hover .message-actions {
    display: flex;
  }
  
  .msg-btn {
    background: none;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    padding: 4px 6px;
    font-size: 12px;
    cursor: pointer;
    color: var(--color-text-secondary);
    transition: all 0.15s;
  }
  
  .msg-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }
  
  .msg-btn.danger:hover {
    background: #fee2e2;
    color: #dc2626;
    border-color: #fca5a5;
  }
  
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  
  @media (max-width: 768px) {
    .message-row {
      flex-wrap: wrap;
      padding: 10px 12px;
    }
    .message-actions {
      position: static;
      display: flex;
      width: 100%;
      justify-content: flex-end;
      margin-top: 4px;
      background: none;
      padding: 0;
    }
    .search-box {
      max-width: 150px;
    }
  }
</style>
