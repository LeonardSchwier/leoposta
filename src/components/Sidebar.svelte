<script lang="ts">
  import { store } from '../store'
  import ContextMenu from './ContextMenu.svelte'
  import { specialFolderPath } from '../lib/specialFolders'
  import {
    buildFolderTree,
    loadExpanded,
    saveExpanded,
    toggleExpanded,
    renameExpanded,
    type FolderNode
  } from '../lib/folderTree'

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
  let menuItems = $state<MenuItem[] | null>(null)
  function showMenu(e: MouseEvent, items: MenuItem[]) {
    e.preventDefault()
    e.stopPropagation()
    menuPos = { x: e.clientX, y: e.clientY }
    menuItems = items
  }
  function closeMenu() { menuItems = null }

  const newFolderItem: MenuItem = { label: 'New Folder', icon: '📁', action: () => onNewFolder?.() }

  function folderItems(folder: any): MenuItem[] {
    return [
      newFolderItem,
      { label: 'New Subfolder', icon: '➕', action: () => newSubFolder(folder) },
      { label: 'Rename', icon: '✎', action: () => renameFolder(folder) },
      { divider: true, label: '', action: undefined },
      { label: 'Delete Folder', icon: '🗑', danger: true, action: () => onDeleteFolder?.(folder) },
    ]
  }

  // The parent is expanded so the new subfolder is visible once the list reloads.
  function newSubFolder(folder: any) {
    if (!expandedFolders.has(folder.id)) toggleFolder(folder.id)
    onNewSubFolder?.(folder.id)
  }

  // onRenameFolder resolves to the folder's new path (or null when cancelled);
  // the folder and its children keep their expanded state under the new path.
  async function renameFolder(folder: any) {
    const to = await onRenameFolder?.(folder)
    if (typeof to === 'string' && to && to !== folder.id) {
      expandedFolders = renameExpanded(expandedFolders, folder.id, to, folder.delimiter)
      saveExpanded(expandedFolders)
    }
  }
  
  const activeFolder = $derived($store.activeFolder)
  function isUnread(m: any) {
    return !m.flags?.includes('\\Seen') && !m.flags?.includes('Seen')
  }
  const unreadCount = $derived($store.messages.filter(m => isUnread(m)).length)
  
  // Build folder tree
  const specialFolders = $derived([
    // Special-use mailboxes open the server's real path (e.g. INBOX.Drafts,
    // [Gmail]/Drafts, a localized name); they are hidden from the custom list.
    { id: 'INBOX', name: 'Inbox', icon: '📥' },
    { id: specialFolderPath(apiFolders, '\\Sent', 'Sent'), name: 'Sent', icon: '📤' },
    { id: specialFolderPath(apiFolders, '\\Drafts', 'Drafts'), name: 'Drafts', icon: '📝' },
    { id: specialFolderPath(apiFolders, '\\Archive', 'Archive'), name: 'Archive', icon: '📦' },
    { id: specialFolderPath(apiFolders, '\\Junk', 'Junk'), name: 'Junk', icon: '🚫' },
    { id: specialFolderPath(apiFolders, '\\Trash', 'Trash'), name: 'Trash', icon: '🗑️' },
  ])

  const appItems = $derived([
    { id: 'calendar', name: 'Calendar', icon: '📅' },
    { id: 'contacts', name: 'Contacts', icon: '👥' },
  ])
  const activeId = $derived((activeViewProp as string) || '')
  function isAppActive(id: string) { return activeId === id }
  
  // Custom folders with hierarchy (lib/folderTree handles "/" and "." delimiters
  // and lifts children of INBOX, which is listed above as a mailbox, to roots).
  const customFolders = $derived((apiFolders || []).filter((f: any) => !f.specialUse))
  const folderTree = $derived(buildFolderTree<any>(customFolders))

  // Expand/collapse state. A Set inside $state is not deeply reactive in
  // Svelte 5 (only plain objects and arrays are proxied), so mutating it in
  // place never re-rendered the tree. Reassign a fresh Set, and persist it.
  let expandedFolders = $state<Set<string>>(loadExpanded())

  function toggleFolder(folderId: string) {
    expandedFolders = toggleExpanded(expandedFolders, folderId)
    saveExpanded(expandedFolders)
  }

  function displayName(node: FolderNode<any>): string {
    const n: string = node.folder.name || node.id
    return node.depth === 0 ? n.replace(/^[0-9#]+\s+/, '') : n
  }

  function isAncestorOfActive(node: FolderNode<any>): boolean {
    return node.children.some((c) => c.id === activeFolder || isAncestorOfActive(c))
  }

  function openFolder(node: FolderNode<any>) {
    // \Noselect parents hold no messages and cannot be SELECTed: they only
    // expand/collapse.
    if (node.folder.noselect) {
      if (node.children.length > 0) toggleFolder(node.id)
      return
    }
    onFolderSelect(node.id)
  }
</script>

{#snippet folderNode(node: FolderNode<any>)}
  {@const hasChildren = node.children.length > 0}
  {@const isExpanded = hasChildren && expandedFolders.has(node.id)}
  <li
    class="folder-node"
    role="treeitem"
    aria-selected={activeFolder === node.id}
    aria-expanded={hasChildren ? isExpanded : undefined}
  >
    <div
      class="folder-row"
      class:active={activeFolder === node.id}
      class:ancestor-active={!isExpanded && isAncestorOfActive(node)}
      style:padding-left="{4 + node.depth * 14}px"
      oncontextmenu={(e) => showMenu(e, folderItems(node.folder))}
      role="presentation"
    >
      {#if hasChildren}
        <button
          type="button"
          class="folder-toggle"
          aria-expanded={isExpanded}
          aria-label="{isExpanded ? 'Collapse' : 'Expand'} {displayName(node)}"
          onclick={(e) => { e.stopPropagation(); toggleFolder(node.id) }}
        >
          <svg class="chevron" class:open={isExpanded} viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      {:else}
        <span class="chevron-placeholder"></span>
      {/if}
      <button
        type="button"
        class="folder-open"
        class:noselect={node.folder.noselect}
        title={node.id}
        onclick={() => openFolder(node)}
      >
        <span class="folder-icon" aria-hidden="true">{isExpanded ? '📂' : '📁'}</span>
        <span class="folder-name">{displayName(node)}</span>
      </button>
    </div>
    {#if isExpanded}
      <ul class="folder-children" role="group">
        {#each node.children as child (child.id)}
          {@render folderNode(child)}
        {/each}
      </ul>
    {/if}
  </li>
{/snippet}

<aside class="sidebar">
  <div class="sidebar-header">
    <h1 class="logo">Leoposta</h1>
    <button class="compose-btn" onclick={onCompose}>
      <span class="compose-icon">✎</span>
      <span>Compose</span>
    </button>
  </div>
  
  <nav class="folder-list">
    <div class="section-label">Apps</div>
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

    <div class="section-label">Mailboxes</div>
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
    
    <!-- Always shown: it is where the first custom folder gets created. -->
    <div class="section-label section-label-row" role="presentation" oncontextmenu={(e) => showMenu(e, [newFolderItem])}>
      <span>Folders</span>
      <button type="button" class="section-add" title="New folder" aria-label="New folder" onclick={() => onNewFolder?.()}>+</button>
    </div>
    {#if folderTree.length > 0}
      <ul class="folder-tree" role="tree" aria-label="Folders">
        {#each folderTree as node (node.id)}
          {@render folderNode(node)}
        {/each}
      </ul>
    {/if}
  </nav>
  
  <div class="sidebar-footer">
    <button class="settings-btn" onclick={onSettings}>
      <span>⚙️</span>
      <span>Settings</span>
    </button>
  </div>

  {#if menuItems}
    <ContextMenu
      x={menuPos.x}
      y={menuPos.y}
      items={menuItems}
      onClose={closeMenu}
    />
  {/if}
</aside>

<style>
  .sidebar {
    /* --sidebar-w is set by App.svelte's resize handle. */
    width: var(--sidebar-w, 240px);
    flex-shrink: 0;
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
  
  .section-label-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .section-add {
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--color-text-secondary);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
  }

  .section-add:hover {
    background: var(--color-border);
    color: var(--color-text);
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
  .folder-tree,
  .folder-children {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .folder-node {
    margin-bottom: 1px;
  }

  .folder-row {
    display: flex;
    align-items: center;
    gap: 2px;
    width: 100%;
    padding: 0 8px 0 4px;
    border-radius: 6px;
    font-size: 13px;
    color: var(--color-text);
    transition: background 0.1s;
  }

  .folder-row:hover {
    background: var(--color-hover);
  }

  .folder-row.active {
    background: var(--color-selected);
    font-weight: 500;
  }

  .folder-row.ancestor-active .folder-name {
    font-weight: 500;
  }

  .folder-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    flex-shrink: 0;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .folder-toggle:hover {
    background: var(--color-border);
    color: var(--color-text);
  }

  .folder-toggle:focus-visible,
  .folder-open:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: -2px;
  }

  .chevron {
    transition: transform 150ms ease-in-out;
  }

  .chevron.open {
    transform: rotate(90deg);
  }

  .chevron-placeholder {
    width: 20px;
    flex-shrink: 0;
  }

  .folder-open {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    padding: 5px 0;
    background: transparent;
    border: none;
    border-radius: 4px;
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }

  .folder-open.noselect {
    color: var(--color-text-secondary);
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
      /* beats the inline per-depth indent */
      padding: 4px !important;
    }
    .folder-open {
      flex: 0 0 auto;
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
