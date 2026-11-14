<script lang="ts">
  import { store, selectMessage, updateMessage } from '../store'
  import { startReply } from '../lib/reply'
  import ContextMenu from './ContextMenu.svelte'
  import { computeVirtualRange } from '../lib/virtualList'
  import { hasFlag, isSpecialFolder, type MessageAction } from '../lib/messageActions'
  import { formatListDate } from '../lib/listDate'

  // onAction(id, action) / onMoveRequest(id): every row action names its own
  // message, so starring or right-clicking a row that is not the open one acts
  // on that row (lib/messageActions.ts).
  let { onCompose, onSelectMessage, onAction, onMoveRequest, onSearch, onLoadMore, hasMore = false, loadingMore = false, searchQuery = '', isLoading = false, error = null }: {
    onCompose?: () => void
    onSelectMessage?: (id: string) => void
    onAction?: (id: string, action: MessageAction) => void
    onMoveRequest?: (id: string) => void
    onSearch?: (q: string) => void
    onLoadMore?: () => void
    hasMore?: boolean
    loadingMore?: boolean
    searchQuery?: string
    isLoading?: boolean
    error?: string | null
  } = $props()

  // Virtualisation: pure math lives in lib/virtualList.ts (unit-tested).
  // The math assumes a constant row height — enforced in the .message-row
  // CSS (height: 64px, overflow: hidden). ROW_HEIGHT is the single source
  // of truth passed to the pure helper.
  const ROW_HEIGHT = 76
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

  function menuItems(message: any): MenuItem[] {
    const id = message.id
    const folders = $store.folders
    const folder = $store.activeFolder
    const inJunk = isSpecialFolder(folders, folder, '\\Junk', 'Junk')
    const inArchive = isSpecialFolder(folders, folder, '\\Archive', 'Archive')
    const inTrash = isSpecialFolder(folders, folder, '\\Trash', 'Trash')
    const items: MenuItem[] = [
      { label: 'Reply', icon: '↩', action: () => void startReply(message, 'reply') },
      { label: 'Reply All', icon: '↩↩', action: () => void startReply(message, 'replyAll') },
      { label: 'Forward', icon: '⪡', action: () => void startReply(message, 'forward') },
      { divider: true, label: '', action: undefined },
      isRead(message)
        ? { label: 'Mark as Unread', icon: '●', action: () => onAction?.(id, 'unread') }
        : { label: 'Mark as Read', icon: '○', action: () => onAction?.(id, 'read') },
      isFlagged(message)
        ? { label: 'Unstar', icon: '☆', action: () => onAction?.(id, 'unstar') }
        : { label: 'Star', icon: '★', action: () => onAction?.(id, 'star') },
      { divider: true, label: '', action: undefined },
      { label: 'Move to…', icon: '📁', action: () => onMoveRequest?.(id) },
    ]
    if (!inArchive) items.push({ label: 'Archive', icon: '📦', action: () => onAction?.(id, 'archive') })
    items.push(inJunk
      ? { label: 'Not Junk', icon: '📥', action: () => onAction?.(id, 'notJunk') }
      : { label: 'Mark as Junk', icon: '🚫', action: () => onAction?.(id, 'junk') })
    items.push({ divider: true, label: '', action: undefined })
    items.push({ label: inTrash ? 'Delete Permanently' : 'Delete', icon: '✕', danger: true, action: () => onAction?.(id, 'delete') })
    return items
  }
  
  const formatDate = (dateStr: string) => formatListDate(dateStr)
  
  function isRead(message: any) { return hasFlag(message, '\\Seen') }
  function isFlagged(message: any) { return hasFlag(message, '\\Flagged') }
  // IMAP keywords (labels set by rules or other clients); not system flags or
  // the bookkeeping keywords clients set ($Forwarded, $MDNSent, Junk, ...).
  const HIDDEN_KEYWORDS = new Set(['$forwarded', '$mdnsent', '$junk', '$notjunk', 'junk', 'nonjunk', 'notjunk', '$phishing', '$submitpending', '$submitted'])
  function labelsOf(message: any): string[] {
    return (message.flags || []).filter((f: string) => !f.startsWith('\\') && !HIDDEN_KEYWORDS.has(f.toLowerCase()))
  }
  function getPreview(message: any): string {
    if (message.snippet) return message.snippet
    if (message.body) return message.body.substring(0, 100)
    if (message.bodyHtml) return message.bodyHtml.replace(/<[^>]*>/g, '').substring(0, 100)
    if (message.attachments?.length) return '📎 ' + message.attachments.length + ' attachment(s)'
    return ''
  }
  
  function handleSelect(message: any) {
    selectMessage(message.id)
    // App marks it read (locally and in the folder's unread count).
    if (onSelectMessage) onSelectMessage(message.id)
  }
  // Roving tabindex: Tab reaches the list once (on the selected row, or the
  // first one), Enter/Space opens the focused row.
  function rowTabIndex(id: string): 0 | -1 {
    const sel = $store.selectedMessageId
    const anchor = sel && messages.some((m: any) => m.id === sel) ? sel : messages[0]?.id
    return id === anchor ? 0 : -1
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
          tabindex={rowTabIndex(message.id)}
          onclick={() => handleSelect(message)}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSelect(message) } }}
          oncontextmenu={(e) => showMenu(e, message)}
        >
          <div class="message-star">
            <button
              class="star-btn"
              class:starred={isFlagged(message)}
              title={isFlagged(message) ? 'Unstar' : 'Star'}
              aria-label={isFlagged(message) ? 'Unstar' : 'Star'}
              aria-pressed={isFlagged(message) ? 'true' : 'false'}
              onclick={(e) => { e.stopPropagation(); onAction?.(message.id, isFlagged(message) ? 'unstar' : 'star') }}
            >
              {#if isFlagged(message)}★{:else}☆{/if}
            </button>
          </div>
          <div class="message-info">
            <div class="message-top">
              <span class="sender-name">{message.from || message.fromAddress || '(no sender)'}</span>
              {#if message.hasAttachment || message.attachments?.length}
                <span class="attachment-flag" role="img" aria-label="Has attachments" title="Has attachments">📎</span>
              {/if}
              <span class="message-date">{formatDate(message.date)}</span>
            </div>
            <div class="message-subject">
              {#each labelsOf(message) as label (label)}<span class="label-chip">{label}</span>{/each}
              {message.subject || '(no subject)'}
            </div>
            <div class="message-preview">{getPreview(message)}</div>
          </div>
        </div>
      {/each}
      <div class="virtual-spacer" style={`height:${virtual.paddingBottom}px`}></div>
      {#if hasMore}
        <button type="button" class="load-more" disabled={loadingMore} onclick={() => onLoadMore?.()}>
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      {/if}
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
    width: var(--list-w, 40%);
    min-width: 280px;
    border-right: none;
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
  
  /* A 1px border tint alone is too faint to find the keyboard focus. */
  .search-input:focus {
    border-color: var(--color-accent);
    box-shadow: 0 0 0 1px var(--color-accent);
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

  .load-more {
    display: block;
    width: calc(100% - 24px);
    margin: 8px 12px 12px;
    padding: 8px;
    border: 1px solid var(--color-border, #ddd);
    border-radius: 6px;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .load-more:disabled { opacity: 0.6; cursor: default; }

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
     height: 76px;
     overflow: hidden;
     box-sizing: border-box;
  }
  
  .label-chip {
    display: inline-block;
    margin-right: 6px;
    padding: 0 6px;
    border-radius: 999px;
    background: var(--color-hover);
    color: var(--color-text-secondary);
    font-size: 11px;
    font-weight: 500;
    line-height: 16px;
  }
  .message-row:hover {
    background: var(--color-hover);
  }
  
  .message-row.selected {
    background: var(--color-selected);
  }
  /* Inset: the list clips overflow, so the global 2px outside ring would be cut off. */
  .message-row:focus-visible {
    outline-offset: -2px;
  }
  
  .message-row.unread .sender-name,
  .message-row.unread .message-subject {
    font-weight: 600;
  }
  
   .message-star {
    width: 44px;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    flex-shrink: 0;
    padding: 10px 0;
    box-sizing: border-box;
  }

  .star-btn {
    background: none;
    border: none;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    cursor: pointer;
    padding: 0;
    /* Dimmed but still a visible control: 0.6 keeps the outline glyph at
       >= 3:1 (WCAG 1.4.11) on the row, hover and selected backgrounds. */
    opacity: 0.6;
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
  
  .attachment-flag {
    margin-left: auto;
    padding: 0 4px;
    font-size: 11px;
    flex-shrink: 0;
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
  
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  
    @media (max-width: 768px) {
    .message-row {
      padding: 6px 10px;
      height: 76px;
    }
    .message-star {
      width: 44px;
      padding: 8px 0;
    }
    .star-btn { width: 22px; height: 22px; font-size: 15px; }
    .search-box {
      max-width: 120px;
    }
  }
</style>
