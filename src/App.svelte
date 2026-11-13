<script lang="ts">
  import { onMount } from 'svelte'
  import './app.css'
  import Sidebar from './components/Sidebar.svelte'
  import MessageList from './components/MessageList.svelte'
  import MessageView from './components/MessageView.svelte'
  import Compose from './components/Compose.svelte'
  import CommandPalette from './components/CommandPalette.svelte'
  import { type PaletteCommand } from './components/CommandPalette.svelte'
  import Settings from './components/Settings.svelte'
  import Calendar from './components/Calendar.svelte'
  import Contacts from './components/Contacts.svelte'
  import { store, getState, setFolders, setActiveFolder, selectMessage, setMessages, setUnreadCount, setError, setIsLoading, updateMessage, deleteMessage, clearCompose, setComposing, setComposeTo, setComposeSubject, setComposeReplyTo, setComposeOriginalMessage, setComposeForward, bootstrapRefreshMode } from './store'
  import { startRefresh, stopRefresh } from './refresh'
  import { MailAPI } from './api'
  import { flushQueue, queueCount, cacheFolderList, cachedMessagesForFolder, putMessageCache, getMessageCache, clearMessageCache } from './lib/offlineQueue'
  import { beginSplitDrag } from './lib/splitHandle'

  let activeView = $state('inbox')
  let appMode = $state<'mail' | 'calendar' | 'contacts'>('mail')
  let showSettings = $state(false)
  let searchQuery = $state('')
  let toast = $state('')
  let queuedCount = $state(0)
  let showPalette = $state(false)

  const SPLIT_MIN = 280
  const SPLIT_MAX_FRAC = 0.8
  let listWidth = $state(localStorage.getItem('leoposta.listW') || '')

  function startSplitDrag(e: PointerEvent) {
    const handle = e.currentTarget as HTMLElement
    const container = handle.closest('.content') as HTMLElement | null
    if (!container) return
    // All drag bookkeeping lives in beginSplitDrag (src/lib/splitHandle.ts),
    // which ends the drag on pointerup / pointercancel / lostpointercapture /
    // window blur / a buttonless pointermove, so a release we never see
    // (e.g. over a native scrollbar) can't leave the column stuck to the
    // pointer.
    beginSplitDrag(e, {
      handle,
      container,
      min: SPLIT_MIN,
      maxFraction: SPLIT_MAX_FRAC,
      onResize: (w) => { listWidth = w + 'px' },
      onEnd: () => { try { localStorage.setItem('leoposta.listW', listWidth) } catch {} },
    })
  }

  const SIDEBAR_MIN = 180
  const SIDEBAR_MAX_FRAC = 0.4
  let sidebarWidth = $state(localStorage.getItem('leoposta.sidebarW') || '')

  // Same drag mechanics as the list/preview split, for the folder sidebar.
  function startSidebarDrag(e: PointerEvent) {
    const handle = e.currentTarget as HTMLElement
    const container = handle.closest('.app') as HTMLElement | null
    if (!container) return
    beginSplitDrag(e, {
      handle,
      container,
      min: SIDEBAR_MIN,
      maxFraction: SIDEBAR_MAX_FRAC,
      onResize: (w) => { sidebarWidth = w + 'px' },
      onEnd: () => { try { localStorage.setItem('leoposta.sidebarW', sidebarWidth) } catch {} },
    })
  }

  function togglePalette() {
    showPalette = !showPalette
  }

  // Open the palette in "search" mode (prefilled with 'go to').
  function openPaletteSearch() {
    if (showPalette) { showPalette = false; return }
    showPalette = true
    // Pre-fill the search after the palette input mounts.
    requestAnimationFrame(() => {
      setTimeout(() => {
        const input = document.querySelector<HTMLInputElement>('.palette .palette-input')
        if (input) {
          input.value = 'go to '
          input.dispatchEvent(new Event('input', { bubbles: true }))
          input.focus()
          // move caret to end
          const len = input.value.length
          input.setSelectionRange(len, len)
        }
      }, 0)
    })
  }

  function viewLabel(view: string): string {
    const map: Record<string, string> = {
      inbox: 'Inbox', sent: 'Sent', drafts: 'Drafts',
      trash: 'Trash', archive: 'Archive', flagged: 'Flagged',
      calendar: 'Calendar', contacts: 'Contacts',
    }
    return map[view] || view
  }

  let paletteCommands = $derived.by((): PaletteCommand[] => {
    const s = getState()
    const cmds: PaletteCommand[] = [
      { id: 'new', label: 'New Message', hint: 'n', icon: '✉', run: () => openCompose() },
      { id: 'settings', label: 'Open Settings', icon: '⚙', run: () => { showSettings = true } },
      { id: 'calendar', label: 'Go to Calendar', icon: '📅', run: () => handleFolderSelect('calendar') },
      { id: 'contacts', label: 'Go to Contacts', icon: '👥', run: () => handleFolderSelect('contacts') },
    ]
    const views = ['inbox', 'sent', 'drafts', 'trash', 'archive', 'flagged']
    for (const v of views) {
      cmds.push({ id: 'folder:' + v, label: 'Go to ' + viewLabel(v), icon: '📁', run: () => handleFolderSelect(v) })
    }
    for (const f of s.folders) {
      cmds.push({ id: 'folder:' + f.id, label: 'Go to ' + (f.name || f.id), icon: '📁', run: () => handleFolderSelect(f.id) })
    }
    const selected = s.selectedMessageId
    for (const m of s.messages.slice(0, 40)) {
      cmds.push({
        id: 'msg:' + m.id,
        label: m.subject || m.from || '(no subject)',
        hint: m.from || m.id,
        icon: selected === m.id ? '✓' : '✉',
        run: () => handleSelectMessage(m.id),
      })
    }
    return cmds
  })

  function showToast(msg: string, duration = 3000) {
    toast = msg
    setTimeout(() => { toast = '' }, duration)
  }

  function refreshQueueCount() {
    queueCount().then(c => queuedCount = c).catch(() => {})
  }

  async function handleOnline() {
    if (queuedCount > 0) {
      const { sent, failed } = await flushQueue()
      refreshQueueCount()
      if (sent > 0) showToast(`${sent} queued message${sent > 1 ? 's' : ''} sent`)
      if (failed > 0) showToast(`${failed} queued message${failed > 1 ? 's' : ''} failed`)
    }
    // Re-sync the current folder from the server now that we're back.
    if (offlineServing) {
      offlineServing = false
      setError(null)
      loadMessages(getState().activeFolder)
    }
  }

  async function loadFolders() {
    try {
      const data = await MailAPI.folders()
      if (data.folders) setFolders(data.folders)
    } catch (e) {
      console.error('Failed to load folders:', e)
    }
  }

  let offlineServing = $state(false)

  async function loadMessages(folder: string) {
    setIsLoading(true)
    try {
      const data = await MailAPI.messages(folder)
      if (data.messages) {
        setMessages(data.messages)
        setUnreadCount(data.messages.filter((m: any) =>
          !m.flags?.includes('\\Seen') && !m.flags?.includes('Seen')
        ).length)
        cacheFolderList(folder, data.messages).catch(() => {})
      }
      offlineServing = false
      setError(null)
    } catch (e: any) {
      // Offline / server down: fall back to the local cache for this folder.
      const cached = await cachedMessagesForFolder(folder).catch(() => [] as any[])
      if (cached.length) {
        setMessages(cached)
        setUnreadCount(0)
        offlineServing = true
        setError(`Offline — showing ${cached.length} cached message${cached.length === 1 ? '' : 's'}`)
      } else {
        setError(e.message)
        offlineServing = false
      }
    } finally {
      setIsLoading(false)
    }
  }

  async function handleSearch(query: string) {
    if (!query.trim()) {
      searchQuery = ''
      return
    }
    searchQuery = query
    try {
      const data = await MailAPI.search(query, getState().activeFolder)
      if (data.messages) setMessages(data.messages)
    } catch (e) {
      setError(e.message)
    }
  }

  function handleNewFolder() {
    const name = prompt('Folder name:')
    if (name?.trim()) {
      MailAPI.addFolder(name.trim()).then(() => loadFolders()).catch(e => setError(e.message))
    }
  }

  function handleNewSubFolder(parentId: string) {
    const name = prompt(`New subfolder under "${parentId}":`)
    if (name?.trim()) {
      MailAPI.addFolder(name.trim(), parentId).then(() => loadFolders()).catch(e => setError(e.message))
    }
  }

  function handleRenameFolder(folder: any) {
    const newPath = prompt(`Rename folder "${folder.name || folder.id}" (new full IMAP path):`, folder.id)
    if (!newPath?.trim() || newPath.trim() === folder.id) return
    MailAPI.renameFolder(folder.id, newPath.trim()).then(() => loadFolders()).catch(e => setError(e.message))
  }

  function handleDeleteFolder(folder: any) {
    if (!confirm(`Delete folder "${folder.name || folder.id}" and all its messages?`)) return
    MailAPI.deleteFolder(folder.id).then(() => loadFolders()).catch(e => setError(e.message))
  }

  function handleFolderSelect(folder: string) {
    activeView = folder
    searchQuery = ''
    if (folder === 'calendar') { appMode = 'calendar'; return }
    if (folder === 'contacts') { appMode = 'contacts'; return }
    appMode = 'mail'
    const mapping: Record<string, string> = {
      'inbox': 'INBOX',
      'sent': 'Sent',
      'drafts': 'Drafts',
      'trash': 'Trash',
      'archive': 'Archive',
      'flagged': 'INBOX'
    }
    const imapFolder = mapping[folder] || folder
    setActiveFolder(imapFolder)
    loadMessages(imapFolder)
  }

  function handleSelectMessage(id: string) {
    selectMessage(id)
    const folder = getState().activeFolder
    MailAPI.message(id, folder).then(data => {
      if (data) {
        putMessageCache({ key: `${folder}:${id}`, folder, id, message: data, full: true }).catch(() => {})
        updateMessage(id, {
          body: data.body,
          bodyHtml: data.bodyHtml,
          pgp: data.pgp,
          attachments: data.attachments,
          cc: data.cc,
          bcc: data.bcc
        })
      }
    }).catch(e => {
      // Offline: load the full message from the local cache (if it was ever opened).
      getMessageCache(folder, id).then(c => {
        if (c?.full && c.message) {
          updateMessage(id, {
            body: c.message.body,
            bodyHtml: c.message.bodyHtml,
            pgp: c.message.pgp,
            attachments: c.message.attachments,
            cc: c.message.cc,
            bcc: c.message.bcc
          })
        }
      }).catch(() => console.error('Failed to load message:', e))
    })
  }

  function handleDelete() {
    const id = getState().selectedMessageId
    if (!id) return
    const folder = getState().activeFolder
    MailAPI.delete(id, folder).then(() => {
      deleteMessage(id)
    }).catch(e => setError(e.message))
  }

  function handleArchive() {
    const id = getState().selectedMessageId
    if (!id) return
    const folder = getState().activeFolder
    MailAPI.move(id, folder, 'Archive').then(() => {
      deleteMessage(id)
    }).catch(e => setError(e.message))
  }

  function handleStar() {
    const id = getState().selectedMessageId
    if (!id) return
    const folder = getState().activeFolder
    const msg = getState().messages.find((m: any) => m.id === id)
    if (!msg) return
    const isFlagged = msg.flags?.includes('\\Flagged') || msg.flags?.includes('Flagged')
    const base = (msg.flags || []).filter((f: string) => f !== '\\Flagged' && f !== 'Flagged')
    const flags = isFlagged ? base : [...base, '\\Flagged']
    const add = isFlagged ? [] : ['\\Flagged']
    const remove = isFlagged ? ['\\Flagged'] : []
    MailAPI.setFlags(id, folder, add, remove).then(() => {
      updateMessage(id, { flags })
    }).catch(e => setError(e.message))
  }

  function openCompose() {
    setComposing(true)
  }

  function handleReplyKeyboard() {
    const s = getState()
    const msg = s.messages.find(m => m.id === s.selectedMessageId)
    if (!msg) return
    setComposeTo([msg.fromAddress || msg.from])
    setComposeSubject(`Re: ${msg.subject}`)
    setComposeReplyTo(msg.id)
    setComposeOriginalMessage(msg)
    setComposeForward(false)
    setComposing(true)
  }

  function isTyping(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return true
    if (getState().isComposing || showSettings) return true
    return false
  }

  function handleKeydown(e: KeyboardEvent) {
    const key = e.key.toLowerCase()
    // Command palette: Ctrl/Cmd+K. Works even while typing.
    if ((e.ctrlKey || e.metaKey) && key === 'k') {
      e.preventDefault()
      togglePalette()
      return
    }
    // '?' opens the palette in "go to" mode so users can discover it.
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && !(e.target as HTMLElement | null)?.closest?.('.palette')) {
      e.preventDefault()
      openPaletteSearch()
      return
    }
    const isN = key === 'n'
    const typing = isTyping(e)
    const wantsNewMessage = ((e.ctrlKey || e.metaKey) && isN) || (!typing && isN && !e.ctrlKey && !e.metaKey)
    if (wantsNewMessage && !getState().isComposing) {
      e.preventDefault()
      openCompose()
      return
    }

    if (isTyping(e)) {
      if (e.key === 'Escape' && getState().isComposing) {
        setComposing(false)
        clearCompose()
      }
      return
    }

    const s = getState()
    const msgs = s.messages
    if ((e.key === 'j' || e.key === 'k' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      if (msgs.length === 0) return
    }
    // While the palette is focused, keep the list-navigation keys for it.
    if (showPalette) return
    const idx = msgs.findIndex(m => m.id === s.selectedMessageId)

    switch (e.key) {
      case 'j':
      case 'ArrowDown': {
        e.preventDefault()
        const next = idx < msgs.length - 1 ? idx + 1 : 0
        handleSelectMessage(msgs[next].id)
        break
      }
      case 'k':
      case 'ArrowUp': {
        e.preventDefault()
        const prev = idx > 0 ? idx - 1 : msgs.length - 1
        handleSelectMessage(msgs[prev].id)
        break
      }
      case 'c':
        e.preventDefault()
        openCompose()
        break
      case 'r':
        e.preventDefault()
        handleReplyKeyboard()
        break
      case 'a':
        e.preventDefault()
        handleArchive()
        break
      case 'd':
      case 'delete':
        e.preventDefault()
        handleDelete()
        break
      case 's':
        e.preventDefault()
        handleStar()
        break
      case '/': {
        e.preventDefault()
        setTimeout(() => {
          const el = document.querySelector('[data-search-input]') as HTMLInputElement | null
          if (el) { el.focus({ preventScroll: true }); el.select() }
        }, 0)
        break
      }
      case '?':
        e.preventDefault()
        showToast('? palette · n new · Ctrl+Enter send · r reply · a archive · d delete · s star · / search · Esc close', 6000)
        break
      case 'Escape':
        e.preventDefault()
        if (s.selectedMessageId) selectMessage(null)
        break
      default:
        break
    }
  }

  // Reactive: when the user switches the active account in Settings, reset
  // to that account's INBOX and refetch. The tracker is a plain closure
  // variable (not $state) so writes inside this block don't re-trigger it —
  // the block only re-runs when $store.activeAccountId itself changes.
  // Skips the initial mount (tracker seeded from the same initial null),
  // so the onMount load below isn't double-fired.
  let prevAccountId = $store.activeAccountId
  $effect(() => {
    const current = $store.activeAccountId
    if (current === prevAccountId) return
    const prev = prevAccountId
    prevAccountId = current
    if (current == null) return
    const leavingFolder = getState().activeFolder
    activeView = 'inbox'
    searchQuery = ''
    setActiveFolder('INBOX')
    if (prev && leavingFolder) clearMessageCache(leavingFolder).catch(() => {})
    loadFolders()
    loadMessages('INBOX')
  })

  onMount(() => {
    bootstrapRefreshMode()
    loadFolders()
    loadMessages('INBOX')
    refreshQueueCount()
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', () => refreshQueueCount())
    window.addEventListener('keydown', handleKeydown)
    return () => stopRefresh()
  })

  // Refresh controller: react only to the three values that change the
  // controller's identity (mode, active account, app view). Reading
  // $store.* registers the whole store as a dep, so guard against unrelated
  // writes (selectMessage, setIsLoading, ...) re-running the effect and
  // churning the SSE/timer teardown+recreate. startRefresh is idempotent
  // per-mode (tears down any previous stream first), so no cleanup return
  // is needed here — a returned cleanup would be invoked by Svelte on every
  // unrelated re-run, killing the stream.
  let prevRefreshKey = ''
  $effect(() => {
    const mode = $store.refreshInterval
    const account = $store.activeAccountId
    const key = `${mode}|${account ?? ''}|${appMode}`
    if (key === prevRefreshKey) return
    prevRefreshKey = key
    if (mode === 'off' || account == null || appMode !== 'mail') {
      stopRefresh()
      return
    }
    startRefresh(mode, () => {
      loadMessages(getState().activeFolder).catch(() => {})
    })
  })
</script>

<div class="app" style:--sidebar-w={sidebarWidth}>
        <Sidebar
        activeFolder={activeView}
        onFolderSelect={handleFolderSelect}
        onCompose={openCompose}
        onSettings={() => showSettings = true}
        onNewFolder={handleNewFolder}
        folders={$store.folders}
        activeView={activeView}
      />
      <div
        class="split-handle sidebar-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize folder column"
        onpointerdown={startSidebarDrag}
      ></div>
  
  <main class="main">
    {#if $store.isComposing}
      <Compose
        onClose={() => { setComposing(false); clearCompose() }}
        onSent={() => { setComposing(false); clearCompose(); loadMessages(getState().activeFolder) }}
      />
    {:else if appMode === 'calendar'}
      <Calendar showToast={showToast} />
    {:else if appMode === 'contacts'}
      <Contacts showToast={showToast} />
    {:else}
      <div class="content" style:--list-w={listWidth}>
        <MessageList
          folder={activeView}
          onCompose={openCompose}
          onSelectMessage={handleSelectMessage}
          onDelete={handleDelete}
          onArchive={handleArchive}
          onStar={handleStar}
          onSearch={handleSearch}
          searchQuery={searchQuery}
          isLoading={$store.isLoading}
          error={$store.error}
        />
        <div
          class="split-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize list column"
          onpointerdown={startSplitDrag}
        ></div>
        {#if $store.selectedMessageId}
          <MessageView
            onDelete={handleDelete}
            onArchive={handleArchive}
            onStar={handleStar}
            onReply={handleReplyKeyboard}
          />
        {/if}
      </div>
    {/if}
  </main>

  {#if showPalette}
    <CommandPalette commands={paletteCommands} onClose={() => { showPalette = false }} />
  {/if}

  {#if showSettings}
    <Settings onClose={() => showSettings = false} />
  {/if}

  {#if toast}
    <div class="toast" data-testid="toast" role="status">{toast}</div>
  {/if}

  {#if queuedCount > 0 && !navigator.onLine}
    <div class="queue-badge">{queuedCount} queued · will send when online</div>
  {/if}
</div>

<style>
  .app {
    display: flex;
    height: 100vh;
    overflow: hidden;
  }
  
  .main {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  
  .content {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: row;
  }

  .split-handle {
    /* No negative margin: it used to straddle the list/preview boundary
       (`margin: 0 -3px`), which put its hit area right on top of the list's
       own vertical scrollbar (both sit flush against the same edge) — a
       click meant for the scrollbar thumb could resize the column instead
       of scrolling. It now sits entirely in its own flex slot, after the
       list, never overlapping the list's scrollable content. */
    width: 6px;
    min-width: 6px;
    cursor: col-resize;
    /* Without this, touch/pen presses get a pointercancel as soon as the
       browser decides to pan. */
    touch-action: none;
    background: var(--color-border);
    z-index: 10;
    transition: background 150ms ease;
  }
  .split-handle:hover,
  .split-handle:active {
    background: var(--color-accent);
    opacity: 0.55;
  }

  /* Below 768px the sidebar collapses to a fixed 56px icon rail. */
  @media (max-width: 768px) {
    .sidebar-handle { display: none; }
  }

  .toast {
    position: fixed;
    bottom: 28px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--color-text);
    color: var(--color-bg);
    padding: 10px 20px;
    border-radius: var(--radius-sm);
    font-size: 13px;
    font-weight: 500;
    box-shadow: 0 8px 24px rgba(0,0,0,0.25);
    animation: toast-in 200ms ease-out;
    z-index: 200;
    max-width: 90vw;
  }

  .queue-badge {
    position: fixed;
    bottom: 12px;
    right: 16px;
    background: var(--color-accent);
    color: #fff;
    padding: 6px 14px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    box-shadow: 0 4px 16px rgba(0,0,0,0.2);
    animation: toast-in 200ms ease-out;
    z-index: 200;
  }
</style>
