<script lang="ts">
  import { store, getState } from '../store'
  
  let { onFolderSelect, onCompose, onSettings, onNewFolder, folders: apiFolders = [] } = $props()
  
  const activeFolder = $derived($store.activeFolder)
  const unreadCount = $derived($store.messages.filter(m => m.isUnread).length)
  
  const specialFolders = $derived([
    { id: 'inbox', name: 'Inbox', icon: '📥' },
    { id: 'sent', name: 'Sent', icon: '📤' },
    { id: 'drafts', name: 'Drafts', icon: '📝' },
    { id: 'flagged', name: 'Flagged', icon: '⭐' },
    { id: 'trash', name: 'Trash', icon: '🗑️' },
  ])
  
  const customFolders = $derived(
    (apiFolders || []).filter((f: any) => !f.specialUse)
  )
  
</script>

<aside class="sidebar">
  <div class="sidebar-header">
    <h1 class="logo">Mail</h1>
    <button class="compose-btn" onclick={onCompose}>
      <span class="compose-icon">✎</span>
      <span>Compose</span>
    </button>
  </div>
  
  <nav class="folder-list">
    <div class="section-label">Mailboxes</div>
    {#each specialFolders as folder (folder.id)}
      <button 
        class="folder-item"
        class:active={activeFolder === folder.id}
        onclick={() => onFolderSelect(folder.id)}
      >
        <span class="folder-icon">{folder.icon}</span>
        <span class="folder-name">{folder.name}</span>
        {#if folder.id === 'inbox' && unreadCount > 0}
          <span class="badge">{unreadCount}</span>
        {/if}
      </button>
    {/each}
    
    {#if customFolders.length > 0}
      <div class="section-label">Folders</div>
      {#each customFolders as folder (folder.id)}
        <button 
          class="folder-item custom"
          class:active={activeFolder === folder.id}
          onclick={() => onFolderSelect(folder.id)}
        >
          <span class="folder-icon">📁</span>
          <span class="folder-name">{folder.name}</span>
        </button>
      {/each}
    {/if}
  </nav>
  
  <div class="sidebar-footer">
    <button class="new-folder-btn" onclick={onNewFolder}>
      <span>＋</span>
      <span>New Folder</span>
    </button>
    <button class="settings-btn" onclick={onSettings}>
      <span>⚙️</span>
      <span>Settings</span>
    </button>
  </div>
</aside>

<style>
  .sidebar {
    width: 220px;
    background: var(--color-sidebar);
    border-right: 1px solid var(--color-border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  
  .sidebar-header {
    padding: 16px;
    border-bottom: 1px solid var(--color-border);
  }
  
  .logo {
    font-size: 18px;
    font-weight: 600;
    margin-bottom: 16px;
    color: var(--color-text);
  }
  
  .compose-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 10px 14px;
    background: var(--color-accent);
    color: white;
    border: none;
    border-radius: var(--radius-md);
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: background var(--transition);
  }
  
  .compose-btn:hover {
    background: var(--color-accent-hover);
  }
  
  .compose-icon {
    font-size: 16px;
  }
  
  .folder-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
  }
  
  .section-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 12px 8px 4px;
  }
  
  .folder-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 10px;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    font-size: 14px;
    color: var(--color-text);
    cursor: pointer;
    transition: background var(--transition);
    text-align: left;
    position: relative;
  }
  
  .folder-item:hover {
    background: var(--color-hover);
  }
  
  .folder-item.active {
    background: var(--color-selected);
    font-weight: 500;
  }
  
  .folder-item.custom {
    padding-left: 16px;
  }
  
  .folder-icon {
    font-size: 16px;
    width: 20px;
    text-align: center;
    flex-shrink: 0;
  }
  
  .folder-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  
  .badge {
    background: var(--color-accent);
    color: white;
    font-size: 11px;
    font-weight: 600;
    min-width: 20px;
    height: 20px;
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 6px;
    flex-shrink: 0;
  }
  
  .sidebar-footer {
    padding: 12px;
    border-top: 1px solid var(--color-border);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  
  .new-folder-btn, .settings-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 10px;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    font-size: 13px;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: background var(--transition);
    text-align: left;
  }
  
  .new-folder-btn:hover, .settings-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }
  
  @media (max-width: 768px) {
    .sidebar {
      width: 56px;
    }
    .logo, .folder-name, .compose-btn span:not(.compose-icon),
    .new-folder-btn span:not(:first-child), .settings-btn span:not(:first-child),
    .section-label {
      display: none;
    }
    .compose-btn {
      justify-content: center;
      padding: 10px;
    }
    .folder-item {
      justify-content: center;
      padding: 10px;
    }
    .badge {
      position: absolute;
      top: 4px;
      right: 4px;
      min-width: 16px;
      height: 16px;
      font-size: 9px;
    }
    .new-folder-btn, .settings-btn {
      justify-content: center;
      padding: 10px;
    }
  }
</style>
