<script lang="ts">
  import { store, getState, selectMessage, setComposeTo, setComposeSubject, setComposeReplyTo, setComposeOriginalMessage, setComposing, setComposeForward, updateMessage, setComposeCc } from '../store'
  import ContextMenu from './ContextMenu.svelte'
  import { computeVirtualRange } from '../lib/virtualList'

  let { onCompose, onSelectMessage, onDelete, onArchive, onStar, onSearch, searchQuery = '', isLoading = false, error = null } = $props()

  // Virtualisation: pure math lives in lib/virtualList.ts (unit-tested).
  // The math assumes a constant row height — enforced in the .message-row
  // CSS (height: 64px, overflow: hidden). ROW_HEIGHT is the single source
  // of truth passed to the pure helper.
  const ROW_HEIGHT = 64
  let scrollEl: HTMLDivElement | undefined = $state()
  let scrollState = $state({ scrollTop: 0, viewportHeight: 400 })
  function measureScroll() { scrollState = { scrollTop: scrollEl?.scrollTop ?? 0, viewportHeight: scrollEl?.clientHeight ?? 400 } }
  $effect(() => {
    measureScroll()
    const el = scrollEl
    if (!el) return
    const ro = new ResizeObserver(measureScroll)
    ro.observe(el)
    el.addEventListener('scroll', measureScroll, { passive: true })
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', measureScroll)
    }
  })
  const messages = $derived($store.messages)
  const virtual = $derived(computeVirtualRange({ totalItems: messages.length, viewportHeight: scrollState.viewportHeight, scrollTop: scrollState.scrollTop, itemHeight: ROW_HEIGHT }))
  const slice = $derived(messages.slice(virtual.startIndex, virtual.endIndex))

  type MenuItem = { label: string; icon?: string; action?: () => void; danger?: boolean; divider?: boolean }
  let menuPos = $state({ x: 0, y: 0 })
  let menuFor = $state<any>(null)
  function showMenu(e: MouseEvent, message: any) {
    e.preventDefault()
    e.stopPropagation()
    menuPos = { x: e.clientX, y: e.clientY }
    menuFor = message
  }
  function closeMenu() { menuFor = null }

  function isOwnEmail(addr: string) {
    const s = getState()
    const acc = s.accounts.find(a => a.id === s.activeAccountId)
    if (!acc) return false
    return addr.toLowerCase() === acc.email.toLowerCase()
  }
  function extractEmail(v: any): string {
    if (!v) return ''
    const s = Array.isArray(v) ? v.join(', ') : String(v)
    const m = s.match(/[\w.+-]+@[\w.-]+\.\w+/)
    return m ? m[0] : s
  }
  function handleReplyAll(message: any) {
    const from = extractEmail(message.fromAddress || message.from)
    const toList = (Array.isArray(message.to) ? message.to : [message.to]).map(extractEmail).filter(e => e && !isOwnEmail(e))
    const ccList = (Array.isArray(message.cc) ? message.cc : [message.cc]).map(extractEmail).filter(e => e && !isOwnEmail(e))
    const recipients = Array.from(new Set([...toList, ...ccList]))
    if (recipients.length === 0) recipients.push(from)
    setComposeTo(recipients)
    setComposeCc([])
    setComposeSubject(`Re: ${message.subject}`)
    setComposeReplyTo(message.id)
    setComposeOriginalMessage(message)
    setComposing(true)
  }

  function menuItems(message: any): MenuItem[] {
    return [
      { label: 'Reply', icon: '↩', action: () => handleReply(message) },
      { label: 'Reply All', icon: '↩↩', action: () => handleReplyAll(message) },
      { label: 'Forward', icon: '⪡', action: () => handleForward(message) },
      { label: 'Archive', icon: '⬇', action: () => onArchive?.() },
      { divider: true, label: '', action: undefined },
      { label: 'Delete', icon: '✕', danger: true, action: () => onDelete?.() },
    ]
  }
  
  function formatDate(dateStr: string) {
    if (!dateStr) return ''
    const date = new Date(dateStr)
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    const days = Math.floor(diff / (1000 * 60 * 60 * 24))
    if (days === 0) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    if (days === 1) return 'Yesterday'
    if (days < 7) return date.toLocaleDateString([], { weekday: 'short' })
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }
  
  function isRead(message: any) {
    return message.flags?.includes('\\Seen') || message.flags?.includes('Seen')
  }
  function isFlagged(message: any) {
    return message.flags?.includes('\\Flagged') || message.flags?.includes('Flagged')
  }
  function getPreview(message: any): string {
    if (message.body) return message.body.substring(0, 100)
    if (message.bodyHtml) return message.bodyHtml.replace(/<[^>]*>/g, '').substring(0, 100)
    if (message.attachments?.length) return '📎 ' + message.attachments.length + ' attachment(s)'
    return ''
  }
  
  function handleSelect(message: any) {
    selectMessage(message.id)
    if (onSelectMessage) onSelectMessage(message.id)
    const flags = message.flags || []
    if (!flags.includes('\\Seen') && !flags.includes('Seen')) {
      updateMessage(message.id, { flags: [...flags, '\\Seen'] })
    }
  }
  function handleReply(message: any) {
    const from = extractEmail(message.fromAddress || message.from)
    setComposeTo([from].filter(Boolean))
    setComposeSubject(`Re: ${message.subject}`)
    setComposeReplyTo(message.id)
    setComposeOriginalMessage(message)
    setComposing(true)
  }
  function handleForward(message: any) {
    setComposeTo([])
    setComposeSubject(`Fwd: ${message.subject}`)
    setComposeForward(true)
    setComposeOriginalMessage(message)
    setComposing(true)
  }
</script>

<div class="message-list-container">
  <div class="list-header">
    <h2 class="folder-title">
      {searchQuery ? `"${searchQuery}"` : $store.activeFolder}
    </h2>
    <div class="search-box">
      <input
        type="text"
        placeholder="Search…"
        value={searchQuery}
        oninput={(e) => onSearch?.((e.target as HTMLInputElement).value)}
        class="search-input"
        data-search-input
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
      <p>Loading…</p>
    </div>
  {:else if $store.messages.length === 0}
    <div class="empty-state">
      <div class="empty-icon">📭</div>
      <h3>{searchQuery ? 'No results' : 'No messages'}</h3>
    </div>
  {:else}
    <div class="message-list" role="listbox" aria-label="Messages" tabindex="-1" bind:this={scrollEl}>
      <div class="virtual-spacer" style={`height:${virtual.paddingTop}px`}></div>
      {#each slice as message (message.id)}
        <div
          class="message-row"
          class:unread={!isRead(message)}
          class:selected={$store.selectedMessageId === message.id}
          role="option"
          aria-selected={$store.selectedMessageId === message.id}
          onclick={() => handleSelect(message)}
          oncontextmenu={(e) => showMenu(e, message)}
        >
          <div class="message-star">
            <button 
              class="star-btn"
              class:starred={isFlagged(message)}
              title={isFlagged(message) ? 'Unstar' : 'Star'}
              onclick={(e) => { e.stopPropagation(); onStar?.() }}
            >
              {#if isFlagged(message)}★{:else}☆{/if}
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
            <button class="msg-btn" title="Forward" onclick={() => handleForward(message)}>⪡</button>
            <button class="msg-btn" title="Archive" onclick={() => onArchive?.()}>⬇</button>
            <button class="msg-btn danger" title="Delete" onclick={() => onDelete?.()}>✕</button>
          </div>
        </div>
      {/each}
      <div class="virtual-spacer" style={`height:${virtual.paddingBottom}px`}></div>
    </div>
  {/if}

  {#if menuFor}
    <ContextMenu
      x={menuPos.x}
      y={menuPos.y}
      items={menuItems(menuFor)}
      onClose={closeMenu}
    />
  {/if}
</div>

<style>
  .message-list-container {
    width: 40%;
    min-width: 300px;
    border-right: 1px solid var(--color-border);
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  
  .list-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface);
  }
  
  .folder-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--color-text);
    white-space: nowrap;
  }
  
  .search-box {
    flex: 1;
    max-width: 260px;
  }
  
  .search-input {
    width: 100%;
    padding: 5px 10px;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-text);
    font-size: 12px;
    outline: none;
  }
  
  .search-input:focus {
    border-color: var(--color-accent);
  }
  
  .actions {
    display: flex;
    gap: 6px;
    margin-left: auto;
  }
  
  .action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-size: 14px;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: all 0.1s;
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
    gap: 12px;
    color: var(--color-text-secondary);
    font-size: 13px;
  }
  
  .spinner {
    width: 24px;
    height: 24px;
    border: 2px solid var(--color-border);
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
    gap: 6px;
    color: var(--color-text-secondary);
    font-size: 14px;
  }
  
  .empty-icon {
    font-size: 40px;
    opacity: 0.4;
  }
  
  .error-state {
    padding: 12px;
    text-align: center;
  }
  
   .error-text {
    color: var(--color-danger);
    font-size: 13px;
   }
  
  .message-list {
    flex: 1;
    overflow-y: auto;
    position: relative;
  }

  .virtual-spacer {
    width: 100%;
    flex-shrink: 0;
  }

  .message-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 7px 12px;
    border-bottom: 1px solid var(--color-border);
    cursor: pointer;
    transition: background 0.08s;
    position: relative;
    height: 64px;
    overflow: hidden;
    box-sizing: border-box;
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
    width: 22px;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    flex-shrink: 0;
    padding-top: 1px;
  }
  
  .star-btn {
    background: none;
    border: none;
    font-size: 14px;
    cursor: pointer;
    padding: 1px;
    opacity: 0.25;
    transition: opacity 0.1s;
    color: var(--color-text);
  }
  
  .star-btn:hover, .star-btn.starred {
    opacity: 1;
  }
   .star-btn.starred {
    color: var(--color-star);
   }
  
  .message-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
    overflow: hidden;
  }
  
  .message-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  
  .sender-name {
    font-size: 13px;
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 65%;
  }
  
  .message-date {
    font-size: 11px;
    color: var(--color-text-secondary);
    white-space: nowrap;
    flex-shrink: 0;
  }
  
  .message-subject {
    font-size: 12px;
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  
  .message-preview {
    font-size: 11px;
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  
  .message-actions {
    display: none;
    gap: 3px;
    position: absolute;
    right: 12px;
    top: 50%;
    transform: translateY(-50%);
    background: var(--color-surface);
    padding: 2px;
    border-radius: 6px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  }
  
  .message-row:hover .message-actions {
    display: flex;
  }
  
  .msg-btn {
    background: none;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    padding: 2px 5px;
    font-size: 11px;
    cursor: pointer;
    color: var(--color-text-secondary);
    transition: all 0.1s;
  }
  
  .msg-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }
  
   .msg-btn.danger:hover {
    background: var(--danger-bg);
    color: var(--color-danger);
    border-color: var(--color-border);
   }
  
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  
  @media (max-width: 768px) {
    .message-row {
      padding: 6px 10px;
      height: 64px;
    }
    .message-actions {
      display: none;
    }
    .search-box {
      max-width: 120px;
    }
  }
</style>
