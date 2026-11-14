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
  import { type Folder, store, getState, setFolders, setActiveFolder, selectMessage, setMessages, setUnreadCount, adjustUnseen, setError, setIsLoading, updateMessage, deleteMessage, clearCompose, setComposing, setComposeTo, setComposeCc, setComposeBcc, setComposeSubject, setComposeBody, setComposeDraft, bootstrapRefreshMode } from './store'
  import { startReply } from './lib/reply'
  import { startRefresh, stopRefresh } from './refresh'
  import { loadAccounts } from './lib/accountsBootstrap'
  import { loadMessageBody, keepLoadedBodies } from './lib/openMessage'
  import { ApiError, MailAPI } from './api'
  import MovePicker from './components/MovePicker.svelte'
  import { runMessageAction, hasFlag, type MessageAction } from './lib/messageActions'
  import { encodeBase64, type OutboundAttachment } from './lib/attachments'
  import { flushQueue, queueCount, QUEUE_CHANGED, cacheFolderList, cachedMessagesForFolder, putMessageCache, getMessageCache, clearMessageCache } from './lib/offlineQueue'
  import { beginSplitDrag } from './lib/splitHandle'
  import { specialFolderPath } from './lib/specialFolders'
  import { isSameOrBelow, movedPath } from './lib/folderTree'
  import { appendPage, createLatest, keepOlderPages, mergeRefreshed } from './lib/listSync'

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
    // Started offline: learn the accounts now (the refresh controller and
    // x-account need them; adopting one reloads the folder like a switch).
    if (!accountsReachable) {
      const { reachable } = await loadAccounts()
      accountsReachable = reachable
    }
    // Ask the outbox itself: the cached count may predate a message queued
    // while offline.
    queuedCount = await queueCount().catch(() => queuedCount)
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
      // Offline (PWA served from the SW cache) is an expected state with its
      // own banner in the list, not an error: keep the folders we have.
      if (navigator.onLine) console.error('Failed to load folders:', e)
    }
  }

  let offlineServing = $state(false)

  // Folder loads, searches and refreshes all write the message list; only the
  // newest may apply (see lib/listSync), so a slow answer for a folder the user
  // already left never replaces the folder on screen.
  const listLoads = createLatest()

  const PAGE = 50
  /** Messages in the folder on screen (server EXISTS); more than shown → "load more". */
  let listTotal = $state(0)
  let loadingMore = $state(false)

  /** `background`: a refresh of the folder on screen (no spinner, keep loaded bodies). */
  // Bumped when a message action starts and when it ends: a background
  // refresh that overlapped an action may carry the server state from before
  // it (the request reached the IMAP queue first) and would undo the
  // optimistic change on screen (a star, a removed row). Such an answer is
  // dropped; the IDLE push for the action's own change refreshes again.
  let actionEpoch = 0

  async function loadMessages(folder: string, { background = false } = {}) {
    const current = listLoads.begin()
    const epoch = actionEpoch
    if (!background) setIsLoading(true)
    try {
      const data = await MailAPI.messages(folder, PAGE)
      if (!current() || getState().activeFolder !== folder) return
      if (background && epoch !== actionEpoch) return
      if (data.messages) {
        // Rules moved or flagged new mail on the server: other folders' counts changed.
        if (data.ruleActions > 0) loadFolders()
        const total = typeof data.total === 'number' ? data.total : data.messages.length
        const prev = getState().messages
        // Bodies already opened are kept either way: the list response has none.
        setMessages(background ? mergeRefreshed(prev, keepOlderPages(prev, data.messages, total)) : keepLoadedBodies(prev, data.messages))
        listTotal = total
        setUnreadCount(data.messages.filter((m: any) =>
          !m.flags?.includes('\\Seen') && !m.flags?.includes('Seen')
        ).length)
        cacheFolderList(folder, data.messages).catch(() => {})
      }
      offlineServing = false
      setError(null)
    } catch (e: any) {
      if (!current()) return
      // Offline / server down: fall back to the local cache for this folder.
      const cached = await cachedMessagesForFolder(folder).catch(() => [] as any[])
      if (!current()) return
      listTotal = 0
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
      if (current()) setIsLoading(false)
    }
  }

  /** "Load more": append the next older page of the folder on screen. */
  async function loadMore() {
    if (loadingMore || searchQuery) return
    const folder = getState().activeFolder
    const current = listLoads.begin()
    loadingMore = true
    try {
      const data = await MailAPI.messages(folder, PAGE, getState().messages.length)
      if (!current() || !data.messages) return
      setMessages(appendPage(getState().messages, data.messages))
      // An empty page means everything is shown (e.g. messages were removed meanwhile).
      listTotal = data.messages.length === 0 ? getState().messages.length
        : typeof data.total === 'number' ? data.total : listTotal
    } catch (e) {
      if (current()) setError(e instanceof Error ? e.message : String(e))
    } finally {
      loadingMore = false
    }
  }

  let searchTimer: ReturnType<typeof setTimeout> | undefined

  function handleSearch(query: string) {
    clearTimeout(searchTimer)
    if (!query.trim()) {
      // Clearing the search goes back to the folder's own list.
      if (searchQuery) {
        searchQuery = ''
        loadMessages(getState().activeFolder)
      }
      return
    }
    searchQuery = query
    // One request once the user pauses typing, not one per keystroke.
    searchTimer = setTimeout(() => runSearch(query), 250)
  }

  async function runSearch(query: string) {
    const current = listLoads.begin()
    try {
      const data = await MailAPI.search(query, getState().activeFolder)
      if (!current() || searchQuery !== query) return
      if (data.messages) {
        setMessages(data.messages)
        if (getState().selectedMessageId && !data.messages.some((m: any) => m.id === getState().selectedMessageId)) selectMessage(null)
      }
      setError(null)
    } catch (e) {
      if (current()) setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** New mail / periodic tick: refresh what is on screen and the unread counts. */
  function refreshNow() {
    loadFolders()
    if (searchQuery) runSearch(searchQuery)
    else loadMessages(getState().activeFolder, { background: true })
  }

  function handleNewFolder() {
    const name = prompt('New folder name:')
    if (name?.trim()) {
      MailAPI.addFolder(name.trim()).then(() => loadFolders()).catch(e => setError(e.message))
    }
  }

  function handleNewSubFolder(parentId: string) {
    const parent = getState().folders.find(f => f.id === parentId)
    const name = prompt(`New subfolder in "${parent?.name || parentId}":`)
    if (name?.trim()) {
      MailAPI.addFolder(name.trim(), parentId).then(() => loadFolders()).catch(e => setError(e.message))
    }
  }

  /** Resolves to the folder's new path, or null when cancelled or refused. */
  async function handleRenameFolder(folder: Folder): Promise<string | null> {
    const current = folder.name || folder.id
    const name = prompt(`Rename folder "${current}" to:`, current)
    if (!name?.trim() || name.trim() === current) return null
    try {
      const { path } = await MailAPI.renameFolder(folder.id, name.trim())
      // The open folder (or one inside the renamed one) moved with it.
      const active = getState().activeFolder
      if (isSameOrBelow(active, folder.id, folder.delimiter)) {
        handleFolderSelect(movedPath(active, folder.id, path, folder.delimiter))
      }
      await loadFolders()
      return path
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return null
    }
  }

  function handleDeleteFolder(folder: Folder) {
    const hasChildren = getState().folders.some(f => f.id !== folder.id && isSameOrBelow(f.id, folder.id, folder.delimiter))
    const what = hasChildren ? 'its subfolders and all their messages' : 'all its messages'
    if (!confirm(`Delete folder "${folder.name || folder.id}" with ${what}? This cannot be undone.`)) return
    MailAPI.deleteFolder(folder.id).then(() => {
      // The open folder no longer exists: go back to the Inbox.
      if (isSameOrBelow(getState().activeFolder, folder.id, folder.delimiter)) handleFolderSelect('inbox')
      return loadFolders()
    }).catch(e => setError(e.message))
  }

  function handleFolderSelect(folder: string) {
    activeView = folder
    clearTimeout(searchTimer)
    searchQuery = ''
    if (folder === 'calendar') { appMode = 'calendar'; return }
    if (folder === 'contacts') { appMode = 'contacts'; return }
    appMode = 'mail'
    const folders = getState().folders
    const mapping: Record<string, string> = {
      'inbox': 'INBOX',
      'sent': specialFolderPath(folders, '\\Sent', 'Sent'),
      'drafts': specialFolderPath(folders, '\\Drafts', 'Drafts'),
      'trash': specialFolderPath(folders, '\\Trash', 'Trash'),
      'archive': specialFolderPath(folders, '\\Archive', 'Archive'),
      'flagged': 'INBOX'
    }
    const imapFolder = mapping[folder] || folder
    setActiveFolder(imapFolder)
    loadMessages(imapFolder)
  }

  // The draft is now in `folder` on the server: confirm it, refresh the folder
  // counts, and reload the list when that Drafts folder is the one on screen.
  function handleDraftSaved(folder: string) {
    showToast('Draft saved')
    loadFolders()
    if (getState().activeFolder === folder) loadMessages(folder)
  }

  // A mail was sent; if it was a reopened draft, Compose removed that draft:
  // refresh the Drafts list when it is on screen.
  function handleSent() {
    loadFolders()
    if (isDraftsFolder(getState().activeFolder)) loadMessages(getState().activeFolder)
  }

  function isDraftsFolder(folder: string): boolean {
    return folder === specialFolderPath(getState().folders, '\\Drafts', 'Drafts')
  }

  /** The user opened a message whose server copy is gone (another client deleted it). */
  function messageGone(id: string) {
    deleteMessage(id)
    showToast('That message no longer exists on the server')
    loadFolders()
  }

  // Reopen a draft from the Drafts mailbox in Compose with everything restored
  // (recipients incl. Bcc, subject, body, attachment bytes). Saving it again
  // replaces that server copy; sending it removes it (Compose, composeDraft).
  async function openDraft(id: string, folder: string) {
    selectMessage(null)
    try {
      const data = await MailAPI.message(id, folder)
      const attachments: OutboundAttachment[] = []
      for (const a of (data.attachments || []) as { id?: string, filename?: string, contentType?: string }[]) {
        if (!a.id) continue
        const res = await MailAPI.attachment(id, a.id, folder)
        if (!res.ok) throw new Error(`Could not load the attachment ${a.filename || ''} (${res.status})`)
        attachments.push({
          filename: a.filename || 'attachment',
          content: encodeBase64(await res.arrayBuffer()),
          contentType: a.contentType || 'application/octet-stream'
        })
      }
      clearCompose()
      setComposeTo(data.to || [])
      setComposeCc(data.cc || [])
      setComposeBcc(data.bcc || [])
      setComposeSubject(data.subject === '(No Subject)' ? '' : (data.subject || ''))
      setComposeBody(data.body || '')
      setComposeDraft({ uid: id, attachments })
      setComposing(true)
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) messageGone(id)
      else showToast('Could not open the draft: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  // `open`: the user clicked the message (vs. moving through the list with
  // the keyboard). A clicked draft opens in Compose.
  function handleSelectMessage(id: string, open = false) {
    const folder = getState().activeFolder
    if (open && isDraftsFolder(folder)) { void openDraft(id, folder); return }
    selectMessage(id)
    // Opening a message marks it read on the server (GET /message/:id), so
    // show it read right away, however it was opened (click, j/k, palette).
    const opened = getState().messages.find((m) => m.id === id)
    const wasUnread = !!opened && !hasFlag(opened, '\\Seen')
    if (opened && wasUnread) {
      updateMessage(id, { flags: [...(opened.flags || []), '\\Seen'] })
      adjustUnseen(folder, -1)
    }
    loadMessageBody(id, {
      fetchMessage: (mid, f) => MailAPI.message(mid, f),
      context: () => getState(),
      update: updateMessage,
      // Decrypted PGP plaintext must not outlive the unlocked key: it is never
      // written to the offline cache.
      cachePut: (f, mid, message) => message?.pgp?.decrypted
        ? Promise.resolve()
        : putMessageCache({ key: `${f}:${mid}`, folder: f, id: mid, message, full: true }),
      cacheGet: (f, mid) => getMessageCache(f, mid),
      // Deleted on the server (another client): drop the row and say so.
      onGone: messageGone
    }).then(() => {
      // Opening marked it \Seen on the server: the folder's unread count changed.
      if (wasUnread) loadFolders()
    })
  }

  // Message actions name the message they act on (lib/messageActions.ts); the
  // keyboard shortcuts act on the open message.
  function act(id: string, action: MessageAction) {
    actionEpoch++
    void runMessageAction(id, action, { notify: (t) => showToast(t), changed: () => { loadFolders() } }).then(() => {
      actionEpoch++
      // Moved/deleted (and not rolled back): one message fewer in this folder.
      if (!getState().messages.some((m) => m.id === id)) listTotal = Math.max(0, listTotal - 1)
    })
  }
  function actOnSelected(action: MessageAction) {
    const id = getState().selectedMessageId
    if (id) act(id, action)
  }

  let moveFor = $state<string | null>(null)
  function requestMove(id: string) { moveFor = id }

  function openCompose() {
    setComposing(true)
  }

  function handleReplyKeyboard() {
    const s = getState()
    const msg = s.messages.find(m => m.id === s.selectedMessageId)
    if (!msg) return
    void startReply(msg, 'reply')
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

    // Compose handles its own Escape (it asks before discarding unsaved text).
    if (isTyping(e)) return
    if (moveFor) return

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
        actOnSelected('archive')
        break
      case 'd':
      case 'Delete':
        e.preventDefault()
        actOnSelected('delete')
        break
      case 's':
        e.preventDefault()
        actOnSelected('toggleStar')
        break
      case 'u':
        e.preventDefault()
        actOnSelected('toggleRead')
        break
      case 'v':
        e.preventDefault()
        if (s.selectedMessageId) requestMove(s.selectedMessageId)
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
        showToast('? palette · n new · Ctrl+Enter send · r reply · a archive · d delete · s star · u read/unread · v move · / search · Esc close', 6000)
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
  // false until the account list arrived: avoids flashing the first-run
  // screen while it loads.
  let accountsLoaded = $state(false)
  // false while the start-up account list could not be fetched (offline).
  let accountsReachable = $state(true)
  $effect(() => {
    const current = $store.activeAccountId
    // The start-up account load adopts an account; that is not a switch (the
    // onMount load below fetches INBOX once).
    if (!accountsLoaded) { prevAccountId = current; return }
    if (current === prevAccountId) return
    const prev = prevAccountId
    prevAccountId = current
    if (current == null) {
      // Last account removed: nothing of it may stay on screen.
      setFolders([])
      setMessages([])
      selectMessage(null)
      return
    }
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
    loadAccounts().then(({ accounts, reachable }) => {
      // Seed the switch tracker first so the effect above does not load twice.
      prevAccountId = getState().activeAccountId
      accountsReachable = reachable
      accountsLoaded = true
      // Unreachable (offline PWA): load anyway, the list falls back to the
      // offline cache; the accounts are asked again once back online.
      if (accounts.length || !reachable) {
        loadFolders()
        loadMessages('INBOX')
      }
    })
    refreshQueueCount()
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', () => refreshQueueCount())
    window.addEventListener(QUEUE_CHANGED, refreshQueueCount)
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
    startRefresh(mode, refreshNow)
  })
</script>

<div class="app" style:--sidebar-w={sidebarWidth}>
        <Sidebar
        onFolderSelect={handleFolderSelect}
        onCompose={openCompose}
        onSettings={() => showSettings = true}
        onNewFolder={handleNewFolder}
        onNewSubFolder={handleNewSubFolder}
        onRenameFolder={handleRenameFolder}
        onDeleteFolder={handleDeleteFolder}
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
    {#if accountsLoaded && accountsReachable && $store.accounts.length === 0 && !$store.isComposing}
      <div class="first-run" data-testid="first-run">
        <h2>Welcome to Leoposta</h2>
        <p>No mail account is set up yet. Add your IMAP/SMTP account to read and send mail; calendar and contacts use the optional CalDAV/CardDAV address of the same account.</p>
        <button class="first-run-btn" onclick={() => showSettings = true}>Set up an account</button>
      </div>
    {:else if $store.isComposing}
      <Compose
        onClose={() => { setComposing(false); clearCompose() }}
        onDraftSaved={handleDraftSaved}
        onSent={handleSent}
      />
    {:else if appMode === 'calendar'}
      <Calendar showToast={showToast} />
    {:else if appMode === 'contacts'}
      <Contacts showToast={showToast} />
    {:else}
      <div class="content" class:has-selection={!!$store.selectedMessageId} style:--list-w={listWidth}>
        <MessageList
          onCompose={openCompose}
          onSelectMessage={(id) => handleSelectMessage(id, true)}
          onAction={act}
          onMoveRequest={requestMove}
          onSearch={handleSearch}
          searchQuery={searchQuery}
          hasMore={!searchQuery && $store.messages.length < listTotal}
          {loadingMore}
          onLoadMore={loadMore}
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
            onAction={act}
            onMoveRequest={requestMove}
            onEditDraft={isDraftsFolder($store.activeFolder) ? (id) => openDraft(id, $store.activeFolder) : undefined}
            onReply={handleReplyKeyboard}
          />
        {/if}
      </div>
    {/if}
  </main>

  {#if moveFor}
    <MovePicker
      folders={$store.folders}
      current={$store.activeFolder}
      onPick={(path) => { if (moveFor) act(moveFor, { moveTo: path }) }}
      onClose={() => { moveFor = null }}
    />
  {/if}

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

  .first-run {
    margin: auto;
    max-width: 440px;
    padding: 32px;
    text-align: center;
    color: var(--color-text-secondary);
  }
  .first-run h2 { color: var(--color-text); font-size: 20px; margin-bottom: 12px; }
  .first-run p { font-size: 14px; line-height: 1.5; margin-bottom: 20px; }
  .first-run-btn {
    padding: 10px 18px;
    border: none;
    border-radius: var(--radius-sm);
    background: var(--color-accent);
    color: var(--color-on-accent);
    font-size: 14px;
    cursor: pointer;
  }

  /* Phone widths: there is no room for list + preview side by side (the
     list keeps its 280px minimum and the preview was squeezed to a sliver,
     wrapping the body one letter per line). Show one pane at a time: the
     list, or the open message with its back button. */
  @media (max-width: 640px) {
    .content > .split-handle { display: none; }
    .content :global(.message-list-container) { width: 100%; min-width: 0; }
    .content.has-selection :global(.message-list-container) { display: none; }
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
    /* A status message, not a control: clicks go to what is underneath
       (it sits over the compose/message action bars for seconds). */
    pointer-events: none;
  }

  .queue-badge {
    position: fixed;
    bottom: 12px;
    right: 16px;
    background: var(--color-accent);
    color: var(--color-on-accent);
    padding: 6px 14px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    box-shadow: 0 4px 16px rgba(0,0,0,0.2);
    animation: toast-in 200ms ease-out;
    z-index: 200;
    pointer-events: none;
  }
</style>
