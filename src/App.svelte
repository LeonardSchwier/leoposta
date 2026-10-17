<script lang="ts">
  import { onMount } from 'svelte'
  import './app.css'
  import Sidebar from './components/Sidebar.svelte'
  import MessageList from './components/MessageList.svelte'
  import MessageView from './components/MessageView.svelte'
  import Compose from './components/Compose.svelte'
  import Settings from './components/Settings.svelte'
  import { store, getState, setFolders, setActiveFolder, selectMessage, setMessages, setUnreadCount, setError, setIsLoading, updateMessage, deleteMessage, clearCompose, setComposing, setComposeTo, setComposeSubject, setComposeReplyTo, setComposeOriginalMessage, setComposeForward } from './store'
  import { MailAPI } from './api'
  import { flushQueue, queueCount } from './lib/offlineQueue'

  let activeView = $state('inbox')
  let showSettings = $state(false)
  let searchQuery = $state('')
  let toast = $state('')
  let queuedCount = $state(0)

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
  }

  async function loadFolders() {
    try {
      const data = await MailAPI.folders()
      if (data.folders) setFolders(data.folders)
    } catch (e) {
      console.error('Failed to load folders:', e)
    }
  }

  async function loadMessages(folder: string) {
    try {
      setIsLoading(true)
      const data = await MailAPI.messages(folder)
      if (data.messages) {
        setMessages(data.messages)
        setUnreadCount(data.messages.filter((m: any) => 
          !m.flags?.includes('\\Seen') && !m.flags?.includes('Seen')
        ).length)
      }
    } catch (e) {
      setError(e.message)
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

  function handleFolderSelect(folder: string) {
    activeView = folder
    searchQuery = ''
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
        updateMessage(id, {
          body: data.body,
          bodyHtml: data.bodyHtml,
          attachments: data.attachments,
          cc: data.cc,
          bcc: data.bcc
        })
      }
    }).catch(e => console.error('Failed to load message:', e))
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
    if (isTyping(e)) {
      if (e.key === 'Escape' && getState().isComposing) {
        setComposing(false)
        clearCompose()
      }
      return
    }

    const s = getState()
    const msgs = s.messages
    if (e.key === 'j' || e.key === 'k' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (msgs.length === 0) return
    }
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
        showToast('j/k or ↑/↓ navigate · c new · r reply · a archive · d delete · s star · / search · Esc close', 6000)
        break
      case 'Escape':
        e.preventDefault()
        if (s.selectedMessageId) selectMessage(null)
        break
      default:
        break
    }
  }

  onMount(() => {
    loadFolders()
    loadMessages('INBOX')
    refreshQueueCount()
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', () => refreshQueueCount())
    window.addEventListener('keydown', handleKeydown)
  })
</script>

<div class="app">
        <Sidebar
        activeFolder={activeView}
        onFolderSelect={handleFolderSelect}
        onCompose={openCompose}
        onSettings={() => showSettings = true}
        onNewFolder={handleNewFolder}
        folders={$store.folders}
      />
  
  <main class="main">
    {#if $store.isComposing}
      <Compose
        onClose={() => { setComposing(false); clearCompose() }}
        onSent={() => { setComposing(false); clearCompose(); loadMessages(getState().activeFolder) }}
      />
    {:else}
      <div class="content">
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
