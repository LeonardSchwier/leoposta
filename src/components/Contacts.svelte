<script lang="ts">
  import { onMount } from 'svelte'
  import { ContactsAPI } from '../api'
  import { contactToVCF } from '../lib/vcf'

  let { showToast } = $props()

  interface Book { uri: string; name: string; canWrite?: boolean }
  let books = $state<Book[]>([])
  let currentBook = $state<Book | null>(null)
  let contacts = $state<any[]>([])
  let loading = $state(false)
  let busy = $state(false)
  let err = $state('')
  let q = $state('')
  let selectedUid = $state<string | null>(null)
  let showEditor = $state(false)
  let editingUid = $state<string | null>(null)
  let fName = $state('')
  let fEmail = $state('')
  let fPhone = $state('')
  let fOrg = $state('')

  async function loadBooks() {
    try {
      const data = await ContactsAPI.addressBooks()
      books = data.addressBooks || data.calendars || []
      if (books.length && !currentBook) currentBook = books[0]
      if (currentBook && !books.find(b => b.uri === currentBook!.uri)) currentBook = books[0] || null
    } catch (e: any) { err = e.message }
  }

  async function loadContacts(search?: string) {
    if (!currentBook) return
    try {
      loading = true
      const data = await ContactsAPI.contacts(currentBook.uri, search)
      contacts = data.contacts || []
    } catch (e: any) { err = e.message } finally { loading = false }
  }

  function openCreate() {
    editingUid = null
    fName = ''; fEmail = ''; fPhone = ''; fOrg = ''
    showEditor = true
  }

  function openEdit(c: any) {
    selectedUid = c.uid
    editingUid = c.uid
    fEmail = (c.emails && c.emails[0]) || c.email || ''
    fPhone = (c.phones && c.phones[0]) || c.phone || ''
    fOrg = c.org || c.organization || ''
    fName = c.name || c.displayName || ''
    showEditor = true
  }

  async function saveContact() {
    if (!currentBook) return
    if (!fName.trim() && !fEmail.trim() && !fPhone.trim()) { showToast('Add a name, email, or phone'); return }
    try {
      busy = true
      const uid = editingUid || (fEmail.trim() || fName.trim().toLowerCase().replace(/\s+/g, '_'))
      const vcf = contactToVCF(fName, fEmail, fPhone, fOrg, uid)
      await ContactsAPI.saveContact(currentBook.uri, vcf)
      showEditor = false
      await loadContacts(q)
      showToast(editingUid ? 'Contact updated' : 'Contact created')
    } catch (e: any) { showToast(e.message, 5000) } finally { busy = false }
  }

  async function deleteContact(uid: string) {
    if (!currentBook) return
    if (!confirm('Delete this contact?')) return
    try {
      busy = true
      await ContactsAPI.deleteContact(currentBook.uri, uid)
      selectedUid = null
      await loadContacts(q)
      showToast('Contact deleted')
    } catch (e: any) { showToast(e.message, 5000) } finally { busy = false }
  }

  function handleImportVcf(file: File) {
    const reader = new FileReader()
    reader.onload = async () => {
      const vcf = String(reader.result || '')
      if (!currentBook) return
      try {
        busy = true
        await ContactsAPI.importVCF(currentBook.uri, vcf)
        await loadContacts(q)
        showToast('Contacts imported')
      } catch (e: any) { showToast(e.message, 5000) } finally { busy = false }
    }
    reader.readAsText(file)
  }

  function importVcf(e: Event) {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (file) handleImportVcf(file)
    input.value = ''
  }

  let debounce: any
  function onSearch() {
    clearTimeout(debounce)
    debounce = setTimeout(() => loadContacts(q), 250)
  }

  onMount(() => { loadBooks().then(() => loadContacts()) })

  function initial(name: string): string {
    const n = (name || '').trim()
    const parts = n.split(/\s+/)
    if (parts.length >= 2) return (parts[0][0] || '') + (parts[1][0] || '')
    return n.slice(0, 1)
  }
</script>

<section class="contacts">
  <aside class="c-side">
    <div class="c-side-head">
      <h2>Address Books</h2>
      <button class="add-c" onclick={openCreate}>+ New contact</button>
    </div>
    <div class="c-list">
      {#each books as book (book.uri)}
        <button class="c-item" class:active={currentBook?.uri === book.uri} onclick={() => { currentBook = book; loadContacts(q) }}>
          <span class="c-ico">👤</span>
          <span class="c-name">{book.name}</span>
        </button>
      {/each}
      {#if books.length === 0}<p class="empty">No address books found.</p>{/if}
    </div>
    <div class="c-import">
      <label class="import-btn">
        Import .vcf
        <input type="file" accept=".vcf,text/vcard" onchange={importVcf} disabled={busy} />
      </label>
    </div>
  </aside>

  <div class="c-main">
    <header class="c-top">
      <input class="search" type="search" placeholder="Search contacts" bind:value={q} oninput={onSearch} data-search-input />
    </header>

    {#if err}
      <div class="c-err"><span>{err}</span><button onclick={loadContacts}>Retry</button></div>
    {/if}

    <div class="c-body">
      {#if loading}
        <p class="hint">Loading…</p>
      {:else if contacts.length === 0}
        <p class="hint">No contacts here yet. Add one or import a .vcf file.</p>
      {:else}
        {#each contacts as c (c.uid)}
          {@const name = c.name || c.displayName || (c.emails && c.emails[0]) || '(unnamed)'}
          <div class="row" class:sel={selectedUid === c.uid} onclick={() => openEdit(c)}>
            <span class="av" class:unknown={!(c.emails || c.email)}>{initial(name) || '?'}</span>
            <div class="meta">
              <div class="nm">{name}</div>
              <div class="d1">{(c.emails && c.emails[0]) || c.email || ''}</div>
              <div class="d2">{(c.phones && c.phones[0]) || c.phone || ''}</div>
            </div>
            <button class="del" onclick={(e) => { e.stopPropagation(); deleteContact(c.uid) }} title="Delete contact" aria-label={`Delete contact ${c.name || c.uid}`}>🗑</button>
          </div>
        {/each}
      {/if}
    </div>
  </div>

  {#if showEditor}
    <div class="modal-back" onclick={(e) => { if (e.target === e.currentTarget) showEditor = false }} role="dialog">
      <div class="modal">
        <h4>{editingUid ? 'Edit contact' : 'New contact'}</h4>
        <label><span>Name</span><input type="text" bind:value={fName} placeholder="Jane Appleseed" /></label>
        <label><span>Email</span><input type="email" bind:value={fEmail} placeholder="jane@example.com" /></label>
        <label><span>Phone</span><input type="tel" bind:value={fPhone} placeholder="+1 555 0100" /></label>
        <label><span>Organization</span><input type="text" bind:value={fOrg} /></label>
        <div class="actions">
          {#if editingUid}<button class="danger" onclick={() => { showEditor = false; deleteContact(editingUid!) }}>Delete</button>{/if}
          <span class="spacer"></span>
          <button class="ghost" onclick={() => showEditor = false}>Cancel</button>
          <button class="primary" onclick={saveContact} disabled={busy}>{editingUid ? 'Save changes' : 'Create'}</button>
        </div>
      </div>
    </div>
  {/if}
</section>

<style>
  .contacts { display: flex; flex: 1; overflow: hidden; height: 100%; }
  .c-side { width: 220px; background: var(--color-sidebar); border-right: 1px solid var(--color-border); display: flex; flex-direction: column; }
  .c-side-head { padding: 12px 12px 8px; display: flex; flex-direction: column; gap: 8px; }
  .c-side-head h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--color-text-secondary); margin: 0 0 4px; font-weight: 700; }
  .add-c { background: var(--color-accent); color: #fff; border: none; padding: 7px 12px; border-radius: var(--radius-sm); font-weight: 600; font-size: 12px; cursor: pointer; }
  .add-c:hover { background: var(--color-accent-hover); }
  .c-list { flex: 1; overflow-y: auto; padding: 4px 8px; }
  .c-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 8px; border: none; background: transparent; color: var(--color-text); border-radius: 6px; font-size: 13px; cursor: pointer; text-align: left; margin-bottom: 2px; }
  .c-item:hover { background: var(--color-hover); }
  .c-item.active { background: var(--color-selected); font-weight: 500; }
  .c-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { font-size: 12px; color: var(--color-text-secondary); padding: 8px; }
  .c-import { padding: 10px; border-top: 1px solid var(--color-border); }
  .import-btn { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border: 1px dashed var(--color-border); border-radius: 6px; font-size: 12px; color: var(--color-text-secondary); cursor: pointer; font-weight: 500; }
  .import-btn:hover { border-color: var(--color-accent); color: var(--color-accent); }
  .import-btn input { display: none; }

  .c-main { flex: 1; overflow: hidden; display: flex; flex-direction: column; background: var(--color-bg); }
  .c-top { padding: 12px 16px; border-bottom: 1px solid var(--color-border); }
  .search { width: 100%; max-width: 420px; padding: 8px 14px; border: 1px solid var(--color-border); border-radius: 999px; font-size: 13px; background: var(--color-bg-secondary); color: var(--color-text); }
  .search:focus { outline: none; border-color: var(--color-accent); }
  .c-err { background: var(--danger-bg); color: var(--color-danger); padding: 10px 18px; font-size: 13px; display: flex; gap: 12px; align-items: center; justify-content: space-between; }
  .c-err button { background: var(--color-danger); color: #fff; border: none; padding: 5px 10px; border-radius: 4px; font-size: 12px; }
  .c-body { flex: 1; overflow-y: auto; padding: 6px; }
  .hint { text-align: center; color: var(--color-text-secondary); font-size: 13px; padding: 40px 16px; }
  .row { display: flex; align-items: center; gap: 12px; padding: 8px 10px; border-radius: 8px; cursor: pointer; }
  .row:hover { background: var(--color-hover); }
  .row.sel { background: var(--color-selected); }
  .av { width: 38px; height: 38px; border-radius: 50%; background: var(--color-accent); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 600; flex: 0 0 auto; }
  .av.unknown { background: var(--color-border); color: var(--color-text-secondary); }
  .meta { flex: 1; min-width: 0; }
  .nm { font-size: 14px; font-weight: 500; color: var(--color-text); }
  .d1, .d2 { font-size: 12px; color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .del { background: transparent; border: none; font-size: 14px; cursor: pointer; padding: 6px; border-radius: 6px; opacity: 0.6; }
  .del:hover { opacity: 1; background: var(--color-hover); }

  .modal-back { position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 150; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .modal { background: var(--color-bg); border-radius: 14px; padding: 18px 20px 14px; width: min(460px, 92vw); max-height: 90vh; overflow-y: auto; box-shadow: 0 18px 60px rgba(0,0,0,0.35); border: 1px solid var(--color-border); }
  .modal h4 { font-size: 15px; font-weight: 700; margin: 0 0 12px; }
  .modal label { display: block; margin-bottom: 10px; font-size: 12px; color: var(--color-text-secondary); font-weight: 600; }
  .modal input { display: block; width: 100%; margin-top: 4px; padding: 8px 10px; border: 1px solid var(--color-border); border-radius: 6px; font-size: 13px; background: var(--color-bg); color: var(--color-text); }
  .modal input:focus { outline: none; border-color: var(--color-accent); }
  .actions { display: flex; gap: 8px; margin-top: 6px; }
  .actions .spacer { flex: 1; }
  .actions button { padding: 8px 14px; border-radius: 6px; font-size: 13px; font-weight: 500; cursor: pointer; border: 1px solid var(--color-border); background: var(--color-bg-secondary); color: var(--color-text); }
  .actions .primary { background: var(--color-accent); color: #fff; border-color: var(--color-accent); }
  .actions .primary:hover { background: var(--color-accent-hover); }
  .actions .danger { background: transparent; color: var(--color-danger); border-color: var(--color-danger); }
  .actions .ghost { background: transparent; }
</style>
