<script lang="ts">
  import { store } from '../store'
  import ContextMenu from './ContextMenu.svelte'
  import { get } from 'svelte/store'
  import { lang, t } from '../lib/i18n'

  let {
    onFolderSelect,
    onCompose,
    onSettings,
    onNewFolder,
    onNewSubFolder,
    onRenameFolder,
    onDeleteFolder,
    folders: apiFolders = [],
    activeView: activeViewProp = ''
  } = $props()

  type MenuItem = { label: string; icon?: string; action?: () => void; danger?: boolean; divider?: boolean }
  let menuPos = $state({ x: 0, y: 0 })
  let menuFolder = $state<any>(null)
  function showFolderMenu(e: MouseEvent, folder: any) {
    e.preventDefault()
    e.stopPropagation()
    menuPos = { x: e.clientX, y: e.clientY }
    menuFolder = folder
  }
  function closeMenu() { menuFolder = null }

  function folderItems(folder: any): MenuItem[] {
    const L = get(lang)
    return [
      { label: t(L, 'sidebar.menu.subfolder'), icon: '➕', action: () => onNewSubFolder?.(folder.id) },
      { label: t(L, 'sidebar.menu.rename'), icon: '✎', action: () => onRenameFolder?.(folder) },
      { divider: true, label: '', action: undefined },
      { label: t(L, 'sidebar.menu.delete'), icon: '🗑', danger: true, action: () => onDeleteFolder?.(folder) },
    ]
  }
  
  const activeFolder = $derived($store.activeFolder)
  function isUnread(m: any) {
    return !m.flags?.includes('\\Seen') && !m.flags?.includes('Seen')
  }
  const unreadCount = $derived($store.messages.filter(m => isUnread(m)).length)
  
  // Build folder tree — $derived tracks the `get(lang)` read so the
  // sidebar re-renders whenever the user switches language.
  const specialFolders = $derived.by(() => {
    const L = get(lang)
    return [
      { id: 'INBOX', name: t(L, 'sidebar.inbox'), icon: '📥' },
      { id: 'Sent', name: t(L, 'sidebar.sent'), icon: '📤' },
      { id: 'Drafts', name: t(L, 'sidebar.drafts'), icon: '📝' },
      { id: 'Archive', name: t(L, 'sidebar.archive'), icon: '📦' },
      { id: 'Junk', name: t(L, 'sidebar.junk'), icon: '🚫' },
      { id: 'Trash', name: t(L, 'sidebar.trash'), icon: '🗑️' },
    ]
  })

  const appItems = $derived.by(() => {
    const L = get(lang)
    return [
      { id: 'calendar', name: t(L, 'sidebar.calendar'), icon: '📅' },
      { id: 'contacts', name: t(L, 'sidebar.contacts'), icon: '👥' },
    ]
  })
  const activeId = $derived((activeViewProp as string) || '')
  function isAppActive(id: string) { return activeId === id }
  
  // Custom folders with hierarchy
  const customFolders = $derived((apiFolders || []).filter((f: any) => !f.specialUse))
  
  const topLevelFolders = $derived(
    customFolders.filter((f: any) => !f.parentId)
  )
  
  function getChildren(parentId: string) {
    return customFolders.filter((f: any) => f.parentId === parentId)
  }
  
  // Check if folder or any descendant is active
  function isFolderOrChildActive(folderId: string): boolean {
    if (activeFolder === folderId) return true
    const children = getChildren(folderId)
    return children.some(c => isFolderOrChildActive(c.id))
  }
  
  // Expand/collapse state
  const expandedFolders = $state(new Set<string>())
  
  function toggleFolder(folderId: string) {
    if (expandedFolders.has(folderId)) {
      expandedFolders.delete(folderId)
    } else {
      expandedFolders.add(folderId)
    }
    // Force reactivity
    expandedFolders.set = expandedFolders
  }
  
  function handleFolderClick(folderId: string, hasChildren: boolean) {
    if (hasChildren && !expandedFolders.has(folderId)) {
      toggleFolder(folderId)
    }
    onFolderSelect(folderId)
  }
  
</script>

<aside class="sidebar">
  <div class="sidebar-header">
    <h1 class="logo">Leoposta</h1>
    <button class="compose-btn" onclick={onCompose}>
      <span class="compose-icon">✎</span>
      <span>{t($lang, 'sidebar.compose')}</span>
    </button>
  </div>
  
  <nav class="folder-list">
    <div class="section-label">{t($lang, 'sidebar.apps')}</div>
    {#each appItems as app (app.id)}
      <button
        class="folder-item"
        class:active={isAppActive(app.id)}
        onclick={() => onFolderSelect(app.id)}
      >
        <span class="folder-icon">{app.icon}</span>
        <span class="folder-name">{app.name}</span>
      </button>
    {/each}

    <div class="section-label">{t($lang, 'sidebar.mailboxes')}</div>
    {#each specialFolders as folder (folder.id)}
      <button 
        class="folder-item"
        class:active={activeFolder === folder.id}
        onclick={() => onFolderSelect(folder.id)}
      >
        <span class="folder-icon">{folder.icon}</span>
        <span class="folder-name">{folder.name}</span>
        {#if folder.id === 'INBOX' && unreadCount > 0}
          <span class="badge">{unreadCount}</span>
        {/if}
      </button>
    {/each}
    
    {#if topLevelFolders.length > 0}
      <div class="section-label" oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); onNewFolder?.() }}>{t($lang, 'sidebar.folders')}</div>
      {#each topLevelFolders as folder (folder.id)}
        {@const children = getChildren(folder.id)}
        {@const hasChildren = children.length > 0}
        {@const isExpanded = expandedFolders.has(folder.id)}
        {@const isParentActive = isFolderOrChildActive(folder.id)}
        
        <div class="folder-group" class:expanded={isExpanded}>
          <div
            class="folder-row"
            class:active={activeFolder === folder.id}
            onclick={() => handleFolderClick(folder.id, hasChildren)}
            oncontextmenu={(e) => showFolderMenu(e, folder)}
          >
            {#if hasChildren}
              <span class="chevron">{isExpanded ? '▾' : '▸'}</span>
            {:else}
              <span class="chevron-placeholder"></span>
            {/if}
            <span class="folder-icon">📁</span>
            <span class="folder-name">{folder.name.replace(/^[0-9#]+\s+/, '')}</span>
          </div>
          
          {#if hasChildren && isExpanded}
            <div class="folder-children">
              {#each children as child (child.id)}
                {@const childChildren = getChildren(child.id)}
                <div
                  class="folder-row child"
                  class:active={activeFolder === child.id}
                  onclick={() => handleFolderClick(child.id, childChildren.length > 0)}
                  oncontextmenu={(e) => showFolderMenu(e, child)}
                >
                  <span class="chevron-placeholder"></span>
                  <span class="folder-icon">{childChildren.length > 0 ? (expandedFolders.has(child.id) ? '▾' : '▸') : ''}</span>
                  <span class="folder-name">{child.name}</span>
                </div>
                {#if childChildren.length > 0 && expandedFolders.has(child.id)}
                  <div class="folder-children">
                    {#each childChildren as gc (gc.id)}
                      <div
                        class="folder-row grandchild"
                        class:active={activeFolder === gc.id}
                        onclick={() => onFolderSelect(gc.id)}
                        oncontextmenu={(e) => showFolderMenu(e, gc)}
                      >
                        <span class="chevron-placeholder"></span>
                        <span class="folder-icon"></span>
                        <span class="folder-name">{gc.name}</span>
                      </div>
                    {/each}
                  </div>
                {/if}
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </nav>
  
  <div class="sidebar-footer">
    <button class="settings-btn" onclick={onSettings}>
      <span>⚙️</span>
      <span>{t($lang, 'sidebar.settings')}</span>
    </button>
  </div>

  {#if menuFolder}
    <ContextMenu
      x={menuPos.x}
      y={menuPos.y}
      items={folderItems(menuFolder)}
      onClose={closeMenu}
    />
  {/if}
</aside>

<style>
  .sidebar {
    width: 240px;
    background: var(--color-sidebar);
    border-right: 1px solid var(--color-border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  
  .sidebar-header {
    padding: 12px 12px 8px;
    border-bottom: 1px solid var(--color-border);
  }
  
  .logo {
    font-size: 17px;
    font-weight: 700;
    margin-bottom: 10px;
    color: var(--color-text);
    letter-spacing: -0.3px;
  }
  
  .compose-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    background: var(--color-accent);
    color: white;
    border: none;
    border-radius: var(--radius-md);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background var(--transition);
  }
  
  .compose-btn:hover {
    background: var(--color-accent-hover);
  }
  
  .folder-list {
    flex: 1;
    overflow-y: auto;
    padding: 4px 6px;
  }
  
  .section-label {
    font-size: 10px;
    font-weight: 600;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.6px;
    padding: 10px 8px 3px;
  }
  
  .folder-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 8px;
    background: transparent;
    border: none;
    border-radius: 6px;
    font-size: 13px;
    color: var(--color-text);
    cursor: pointer;
    transition: background 0.1s;
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
  
  .folder-icon {
    font-size: 14px;
    width: 18px;
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
    font-size: 10px;
    font-weight: 600;
    min-width: 18px;
    height: 18px;
    border-radius: 9px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 5px;
    flex-shrink: 0;
  }
  
  /* Custom folder tree */
  .folder-group {
    margin-bottom: 1px;
  }
  
  .folder-row {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    padding: 5px 8px;
    background: transparent;
    border: none;
    border-radius: 6px;
    font-size: 13px;
    color: var(--color-text);
    cursor: pointer;
    transition: background 0.1s;
    text-align: left;
  }
  
  .folder-row:hover {
    background: var(--color-hover);
  }
  
  .folder-row.active {
    background: var(--color-selected);
    font-weight: 500;
  }
  
  .folder-row.child {
    padding-left: 22px;
  }
  
  .folder-row.grandchild {
    padding-left: 36px;
  }
  
  .chevron {
    font-size: 10px;
    width: 12px;
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }
  
  .chevron-placeholder {
    width: 12px;
    flex-shrink: 0;
  }
  
  .folder-children {
    margin-left: 8px;
    border-left: 1px solid var(--color-border);
    padding-left: 2px;
  }
  
  .sidebar-footer {
    padding: 8px;
    border-top: 1px solid var(--color-border);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  
  .settings-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 8px;
    background: transparent;
    border: none;
    border-radius: 6px;
    font-size: 13px;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: background 0.1s;
    text-align: left;
  }
  
  .settings-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }
  
  @media (max-width: 768px) {
    .sidebar {
      width: 56px;
    }
    .logo, .folder-name, .compose-btn span:not(.compose-icon),
    .settings-btn span:not(:first-child), .section-label {
      display: none;
    }
    .compose-btn {
      justify-content: center;
      padding: 8px;
    }
    .folder-item {
      justify-content: center;
      padding: 8px;
    }
    .folder-row {
      justify-content: center;
      padding: 8px;
    }
    .badge {
      position: absolute;
      top: 3px;
      right: 3px;
      min-width: 14px;
      height: 14px;
      font-size: 9px;
    }
  }
</style>
