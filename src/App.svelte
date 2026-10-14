<script lang="ts">
  import { onMount } from 'svelte'
  import './app.css'
  import Sidebar from './components/Sidebar.svelte'
  import MessageList from './components/MessageList.svelte'
  import MessageView from './components/MessageView.svelte'
  import Compose from './components/Compose.svelte'
  import Settings from './components/Settings.svelte'
  import { store, getState, setFolders, setActiveFolder, selectMessage, setMessages, setUnreadCount, setError, setIsLoading, updateMessage, deleteMessage, clearCompose } from './store'
  import { MailAPI } from './api'

  let activeView = $state('inbox')
  let showSettings = $state(false)
  let showCompose = $state(false)
  let searchQuery = $state('')

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
    const flags = isFlagged
      ? msg.flags.filter((f: string) => f !== '\\Flagged' && f !== 'Flagged')
      : [...(msg.flags || []), '\\Flagged']
    MailAPI.setFlags(id, folder, flags).then(() => {
      updateMessage(id, { flags })
    }).catch(e => setError(e.message))
  }

  onMount(() => {
    loadFolders()
    loadMessages('INBOX')
  })
</script>

<div class="app">
  <Sidebar 
    activeFolder={activeView}
    onFolderSelect={handleFolderSelect}
    onCompose={() => showCompose = true}
    onSettings={() => showSettings = true}
    onNewFolder={handleNewFolder}
    folders={$store.folders}
  />
  
  <main class="main">
    {#if showCompose}
      <Compose 
        onClose={() => { showCompose = false; clearCompose() }}
        onSent={() => { showCompose = false; clearCompose(); loadMessages(getState().activeFolder) }}
      />
    {:else}
      <div class="content">
        <MessageList 
          folder={activeView}
          onCompose={() => showCompose = true}
          onSelectMessage={handleSelectMessage}
          onDelete={handleDelete}
          onArchive={handleArchive}
          onStar={handleStar}
          onSearch={handleSearch}
          searchQuery={searchQuery}
          isLoading={$store.isLoading}
          error={$store.error}
        />
      </div>
    {/if}
    
    {#if $store.selectedMessageId && !showCompose}
      <MessageView 
        onDelete={handleDelete}
        onArchive={handleArchive}
        onStar={handleStar}
      />
    {/if}
  </main>
  
  {#if showSettings}
    <Settings onClose={() => showSettings = false} />
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
  }
</style>
