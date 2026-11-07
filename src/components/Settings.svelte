<script lang="ts">
  import { apiFetch, AccountAPI, setActiveAccountEmail } from '../api'
  import {
    store, getState, setAccounts, setActiveAccount
  } from '../store'
  import type { MailAccount } from '../store'
  import { RULE_FIELDS, RULE_OPERATORS, RULE_ACTIONS } from '../lib/rules'
  import type { Rule } from '../lib/rules'

  let { onClose } = $props()
  const accounts = $derived($store.accounts)

  let email = $state('')
  let accountName = $state('')
  let imapHost = $state('imap.example.com')
  let imapPort = $state('993')
  let imapTls = $state(true)
  let smtpHost = $state('smtp.example.com')
  let smtpPort = $state('465')
  let smtpTls = $state(true)
  let password = $state('')
  let isLoading = $state(false)
  let error = $state('')
  // id of the account being edited; null => adding a new one
  let editingId = $state<string | null>(null)

  function resetForm() {
    email = ''; accountName = ''
    imapHost = 'imap.example.com'; imapPort = '993'; imapTls = true
    smtpHost = 'smtp.example.com'; smtpPort = '465'; smtpTls = true
    password = ''; editingId = null; error = ''
  }

  function startEdit(a: MailAccount) {
    editingId = a.id
    email = a.email
    accountName = a.name
    imapHost = a.imapHost; imapPort = String(a.imapPort); imapTls = a.imapTls
    smtpHost = a.smtpHost; smtpPort = String(a.smtpPort); smtpTls = a.smtpTls
    password = ''
    const s = a.signature
    if (s) { sigEnabled = s.enabled; sigText = s.text || ''; sigPosition = s.position === 'after_quote' ? 'after_quote' : 'standard' }
    error = ''
  }

  // ---- Signature ----
  let sigEnabled = $state(false)
  let sigText = $state('')
  let sigPosition = $state<'standard' | 'after_quote'>('standard')
  
  // ---- PGP ----
  let pgpPrivate = $state('')
  let pgpPublic = $state('')
  let pgpPassphrase = $state('')
  let pgpLoading = $state(false)
  let pgpMsg = $state('')
  let pgpErr = $state('')

  let activeTab = $state<'account' | 'rules'>('account')

  // ---- Rules ----
  let rules: Rule[] = $state([])
  let rulesMsg = $state('')
  let rulesErr = $state('')
  let rulesLoading = $state(false)

  async function loadRules() {
    try {
      const r = await apiFetch('/api/rules')
      const d = await r.json()
      rules = Array.isArray(d.rules) ? d.rules : []
    } catch { /* no rules yet */ }
  }

  function addRule() {
    rules = [...rules, { enabled: true, conditions: [{ field: 'from', operator: 'contains', value: '' }], action: { type: 'flag' } }]
  }

  function removeRule(index: number) {
    rules = rules.filter((_, i) => i !== index)
  }

  async function saveRules() {
    rulesLoading = true
    rulesMsg = ''
    rulesErr = ''
    try {
      const r = await apiFetch('/api/rules', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules })
      })
      const d = await r.json()
      if (d.success) rulesMsg = `Saved ${rules.length} rule${rules.length === 1 ? '' : 's'}`
      else rulesErr = d.error || 'Failed to save rules'
    } catch (e: any) {
      rulesErr = e.message
    }
    rulesLoading = false
  }

  $effect(() => {
    if (activeTab === 'rules') loadRules().catch(() => {})
  })

  async function loadAccounts() {
    try {
      const saved = await AccountAPI.list()
      const list = Array.isArray(saved) ? saved : []
      setAccounts(list)
    } catch { /* backend not running or no accounts */ }
  }
  $effect(() => { loadAccounts().catch(() => {}) })

  async function pgpStatus() {
    const r = await apiFetch('/api/pgp/status')
    return r.json()
  }

  async function handlePgpSave() {
    if (!pgpPrivate && !pgpPublic) { pgpErr = 'Paste a private key (or at least a public key)'; return }
    pgpLoading = true; pgpErr = ''; pgpMsg = ''
    try {
      const r = await apiFetch('/api/pgp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ privateAsc: pgpPrivate, publicAsc: pgpPublic, passphrase: pgpPassphrase })
      })
      const d = await r.json()
      if (d.success) { pgpMsg = 'PGP key saved'; pgpPrivate = ''; pgpPublic = ''; pgpPassphrase = '' }
      else pgpErr = d.error || 'failed'
    } catch (e) { pgpErr = e.message }
    pgpLoading = false
  }

  async function handlePgpDelete() {
    if (!confirm('Remove stored PGP keys?')) return
    await apiFetch('/api/pgp', { method: 'DELETE' })
    pgpPrivate = ''; pgpPublic = ''; pgpPassphrase = ''; pgpErr = ''; pgpMsg = 'PGP keys removed'
  }

  $effect(() => {
    apiFetch('/api/pgp/status').then(r => r.json()).then(s => {
      if (s && (s.hasPrivateKey || s.hasPublicKey || s.hasPassphrase)) {
        pgpMsg = `PGP ready: private=${!!s.hasPrivateKey}, public=${!!s.hasPublicKey}, passphrase=${!!s.hasPassphrase}`
      }
    }).catch(() => {})
  })

  function handleSave() {
    if (!email) { error = 'Email is required'; return }
    if (!editingId && !password) { error = 'Password is required for a new account'; return }

    isLoading = true
    error = ''

    const payload: Record<string, unknown> = {
      name: accountName || email.split('@')[0],
      email,
      imapHost,
      imapPort: parseInt(imapPort) || 993,
      imapTls,
      smtpHost,
      smtpPort: parseInt(smtpPort) || 465,
      smtpTls,
      imapUser: email,
      smtpUser: email,
      signature: { enabled: sigEnabled, text: sigText, position: sigPosition }
    }
    if (password) { payload.imapPass = password; payload.smtpPass = password }

    const op = editingId ? AccountAPI.update(email, payload) : AccountAPI.add(payload)

    op
      .then(async () => {
        const saved = await AccountAPI.list()
        setAccounts(Array.isArray(saved) ? saved : [])
        if (!editingId) {
          const added = $store.accounts.find(a => a.email.toLowerCase() === email.toLowerCase())
          if (added) setActiveAccount(added.id)
        }
        resetForm()
        onClose()
      })
      .catch(err => { error = err.message })
      .finally(() => { isLoading = false })
  }

  function handleAdd() {
    resetForm()
  }

  function handleRemove(id: string) {
    const acc = getState().accounts.find(a => a.id === id)
    if (!acc || !confirm(`Remove ${acc.email}?`)) return
    AccountAPI.remove(acc.email)
      .then(async () => {
        const saved = await AccountAPI.list()
        setAccounts(Array.isArray(saved) ? saved : [])
        if (getState().activeAccountId === id) {
          const next = $store.accounts[0]
          if (next) setActiveAccount(next.id)
          else setActiveAccountEmail(null)
        }
      })
      .catch(err => { error = err.message })
  }
</script>

<div class="settings-overlay" onclick={onClose}>
  <div class="settings-modal" onclick={(e) => e.stopPropagation()}>
    <div class="modal-header">
      <h2>Settings</h2>
      <button class="close-btn" onclick={onClose}>✕</button>
    </div>

    <div class="settings-tabs">
      <button class={activeTab === 'account' ? 'tab active' : 'tab'} onclick={() => activeTab = 'account'}>Account</button>
      <button class={activeTab === 'rules' ? 'tab active' : 'tab'} onclick={() => activeTab = 'rules'}>Rules</button>
    </div>
    
    <div class="modal-body">
      {#if error}
        <div class="error-banner">{error}</div>
      {/if}

      {#if activeTab === 'rules'}
        <p class="hint">Rules run on every message fetch. The first matching rule wins.</p>
        {#if rulesMsg}<div class="error-banner" style="background:rgba(52,199,89,0.1);border-color:var(--color-success);color:var(--color-success)">{rulesMsg}</div>{/if}
        {#if rulesErr}<div class="error-banner">{rulesErr}</div>{/if}

        {#each rules as rule, i (i)}
          <div class="rule-card">
            <div class="rule-row">
              <label class="rule-toggle">
                <input type="checkbox" bind:checked={rule.enabled} />
                <span>Enabled</span>
              </label>
              <button class="btn-secondary btn-tiny" onclick={() => removeRule(i)}>Remove</button>
            </div>
            {#each rule.conditions as cond, ci (ci)}
              <div class="rule-cond">
                <select bind:value={cond.field}>
                  {#each RULE_FIELDS as f (f.value)}<option value={f.value}>{f.label}</option>{/each}
                </select>
                <select bind:value={cond.operator}>
                  {#each RULE_OPERATORS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
                </select>
                <input type="text" bind:value={cond.value} placeholder="value" />
                <button class="btn-tiny" onclick={() => rule.conditions = rule.conditions.filter((_, j) => j !== ci)} title="Remove condition">✕</button>
              </div>
            {/each}
            <button class="btn-secondary btn-tiny" onclick={() => rule.conditions = [...rule.conditions, { field: 'subject', operator: 'contains', value: '' }]}>+ Add condition</button>
            <div class="rule-action">
              <span class="rule-arrow">→</span>
              <select bind:value={rule.action.type}>
                {#each RULE_ACTIONS as a (a.value)}<option value={a.value}>{a.label}</option>{/each}
              </select>
              {#if rule.action.type !== 'flag'}
                <input type="text" bind:value={rule.action.value} placeholder={rule.action.type === 'move' ? 'folder path' : 'label name'} />
              {/if}
            </div>
          </div>
        {/each}

        <div class="pgp-actions">
          <button class="btn-primary" onclick={addRule}>+ Add rule</button>
          <button class="btn-secondary" onclick={saveRules} disabled={rulesLoading}>
            {#if rulesLoading}Saving...{:else}Save rules{/if}
          </button>
        </div>
       {:else if activeTab === 'account'}
       {#if accounts.length}
         <div class="acct-list-sec">
           <h3>Accounts</h3>
           <div class="acct-list">
             {#each accounts as a (a.id)}
               <div class="acct-row" class:active={a.id === $store.activeAccountId}>
                 <div class="acct-info">
                   <div class="acct-name">{a.name || a.email}{a.id === $store.activeAccountId ? ' · active' : ''}</div>
                   <div class="acct-email">{a.email}</div>
                 </div>
                 <div class="acct-actions">
                   <button class="btn-tiny" onclick={() => startEdit(a)}>Edit</button>
                   <button class="btn-tiny btn-tiny-danger" onclick={() => handleRemove(a.id)}>Remove</button>
                 </div>
               </div>
             {/each}
           </div>
           <div class="acct-actions-row">
             {#if editingId}<button class="btn-secondary btn-tiny" onclick={resetForm}>+ New account</button>{/if}
           </div>
         </div>
       {:else}
         <p class="hint">No accounts configured yet. Add one below.</p>
       {/if}

       <div class="form-section">
         <h3>{editingId ? 'Edit account' : 'Add account'}</h3>
       </div>
       <div class="form-group">
         <label>Account Name</label>
         <input type="text" bind:value={accountName} placeholder="My Mail" />
       </div>
       <div class="form-group">
         <label>Email Address</label>
          <input type="email" bind:value={email} placeholder="you@example.com" disabled={!!editingId} />
       </div>
      
      <div class="form-section">
        <h3>IMAP (Incoming)</h3>
        <div class="form-row">
          <div class="form-group">
            <label>Server</label>
            <input type="text" bind:value={imapHost} />
          </div>
          <div class="form-group">
            <label>Port</label>
            <input type="number" bind:value={imapPort} />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group checkbox">
            <label>
              <input type="checkbox" bind:checked={imapTls} />
              <span>Use SSL/TLS</span>
            </label>
          </div>
        </div>
      </div>
      
      <div class="form-section">
        <h3>SMTP (Outgoing)</h3>
        <div class="form-row">
          <div class="form-group">
            <label>Server</label>
            <input type="text" bind:value={smtpHost} />
          </div>
          <div class="form-group">
            <label>Port</label>
            <input type="number" bind:value={smtpPort} />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group checkbox">
            <label>
              <input type="checkbox" bind:checked={smtpTls} />
              <span>Use SSL/TLS</span>
            </label>
          </div>
        </div>
      </div>
      
      <div class="form-section">
        <h3>Preferences</h3>
        <div class="form-group checkbox">
          <label>
            <input type="checkbox" bind:checked={$store.threadGrouping} />
            <span>Group messages by thread</span>
          </label>
        </div>
      </div>
      
      <div class="form-group">
        <label>Password</label>
        <input type="password" bind:value={password} placeholder="••••••••" />
      </div>

      <div class="form-section">
        <h3>Signature</h3>
        <div class="form-group checkbox">
          <label>
            <input type="checkbox" bind:checked={sigEnabled} />
            <span>Append signature to new mail</span>
          </label>
        </div>
        <div class="form-group">
          <label>Signature text</label>
          <textarea rows="3" bind:value={sigText} placeholder="Best regards&#10;Leo" spellcheck="true"></textarea>
        </div>
        <div class="form-group">
          <label>Position in replies</label>
          <select bind:value={sigPosition}>
            <option value="standard">Above the quoted message</option>
            <option value="after_quote">Below the quoted message</option>
          </select>
        </div>
      </div>

      <div class="divider"></div>
      <h3 class="section-title">🔐 PGP / S/MIME — import your private key to decrypt encrypted mail</h3>
      <p class="hint">Paste your OpenPGP <b>private</b> key (armored, <code>-----BEGIN PGP PRIVATE KEY-----</code>). Optionally paste a public key and a passphrase if the private key is protected.</p>
      <div class="form-group">
        <label>Private key (armored)</label>
        <textarea rows="6" bind:value={pgpPrivate} placeholder="-----BEGIN PGP PRIVATE KEY----- ... -----END PGP PRIVATE KEY-----" spellcheck="false"></textarea>
      </div>
      <div class="form-group">
        <label>Public key (optional)</label>
        <textarea rows="4" bind:value={pgpPublic} placeholder="-----BEGIN PGP PUBLIC KEY----- ... -----END PGP PUBLIC KEY-----" spellcheck="false"></textarea>
      </div>
      <div class="form-group">
        <label>Passphrase (optional)</label>
        <input type="password" bind:value={pgpPassphrase} placeholder="Used to unlock your private key" />
      </div>
      <div class="pgp-status" role="status">
        {#if pgpErr}<span class="pgp-err">{pgpErr}</span>{/if}
        {#if pgpMsg}<span class="pgp-ok">{pgpMsg}</span>{/if}
      </div>
      <div class="pgp-actions">
        <button class="btn-primary" onclick={handlePgpSave} disabled={pgpLoading}>
          {#if pgpLoading}Saving...{:else}Save PGP key{/if}
        </button>
        <button class="btn-secondary" onclick={handlePgpDelete}>Remove</button>
      </div>
      {/if}
    </div>

    <div class="modal-footer">
      {#if activeTab === 'account'}
        <div class="footer-right">
          <button class="btn-secondary" onclick={onClose}>Done</button>
          <button class="btn-primary" onclick={handleSave} disabled={isLoading}>
            {#if isLoading}Saving...{:else}{editingId ? 'Update' : 'Add Account'}{/if}
          </button>
        </div>
      {:else}
        <div class="footer-right">
          <button class="btn-secondary" onclick={onClose}>Close</button>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .settings-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  
  .settings-modal {
    width: 480px;
    max-height: 80vh;
    background: var(--color-bg);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  
  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 20px 24px;
    border-bottom: 1px solid var(--color-border);
  }
  
  .modal-header h2 {
    font-size: 18px;
    font-weight: 600;
    color: var(--color-text);
  }
  
  .close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    font-size: 16px;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: background var(--transition);
  }
  
  .close-btn:hover {
    background: var(--color-hover);
  }
  
  .modal-body {
    flex: 1;
    overflow-y: auto;
    padding: 20px 24px;
  }
  
  .error-banner {
    padding: 12px 16px;
    background: rgba(255, 59, 48, 0.1);
    border: 1px solid var(--color-danger);
    border-radius: var(--radius-sm);
    color: var(--color-danger);
    font-size: 14px;
    margin-bottom: 16px;
  }
  
  .form-group {
    margin-bottom: 16px;
  }
  
  .form-group label {
    display: block;
    font-size: 13px;
    font-weight: 500;
    color: var(--color-text-secondary);
    margin-bottom: 6px;
  }
  
  .form-group input[type="text"],
  .form-group input[type="email"],
  .form-group input[type="number"],
  .form-group input[type="password"],
  .form-group select {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    font-size: 14px;
    color: var(--color-text);
    background: var(--color-bg);
  }
  
  .form-group input:focus {
    outline: none;
    border-color: var(--color-accent);
  }
  
  .form-section {
    margin: 20px 0;
    padding-top: 16px;
    border-top: 1px solid var(--color-border);
  }
  
  .form-section h3 {
    font-size: 14px;
    font-weight: 600;
    color: var(--color-text);
    margin-bottom: 12px;
  }
  
  .form-row {
    display: flex;
    gap: 12px;
  }
  
  .form-row .form-group {
    flex: 1;
  }
  
  .form-group.checkbox label {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
  }
  
  .form-group.checkbox input[type="checkbox"] {
    width: 16px;
    height: 16px;
    accent-color: var(--color-accent);
  }
  
  .modal-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 24px;
    border-top: 1px solid var(--color-border);
    background: var(--color-bg-secondary);
  }
  
  .btn-danger {
    padding: 8px 16px;
    background: transparent;
    border: 1px solid var(--color-danger);
    border-radius: var(--radius-sm);
    font-size: 14px;
    color: var(--color-danger);
    cursor: pointer;
    transition: all var(--transition);
  }
  
  .btn-danger:hover {
    background: rgba(255, 59, 48, 0.1);
  }
  
  .footer-right {
    display: flex;
    gap: 8px;
  }
  
  .btn-secondary {
    padding: 8px 16px;
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    font-size: 14px;
    color: var(--color-text);
    cursor: pointer;
    transition: all var(--transition);
  }
  
  .btn-secondary:hover {
    background: var(--color-hover);
  }
  
  .btn-primary {
    padding: 8px 16px;
    background: var(--color-accent);
    border: none;
    border-radius: var(--radius-sm);
    font-size: 14px;
    font-weight: 500;
    color: white;
    cursor: pointer;
    transition: background var(--transition);
  }
  
  .btn-primary:hover {
    background: var(--color-accent-hover);
  }
  
  .btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .divider {
    height: 1px;
    background: var(--color-border);
    margin: 24px 0 16px;
  }

  .section-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--color-text);
    margin-bottom: 8px;
  }

  .hint {
    font-size: 12px;
    color: var(--color-text-secondary);
    margin-bottom: 12px;
    line-height: 1.5;
  }

  .hint code {
    background: var(--color-bg-secondary);
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 11px;
  }

  textarea {
    width: 100%;
    padding: 8px 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-bg);
    color: var(--color-text);
    font-size: 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    line-height: 1.4;
    resize: vertical;
  }

  .pgp-status {
    min-height: 20px;
    margin-top: 8px;
    font-size: 13px;
  }

  .pgp-err {
    color: var(--color-danger);
  }

  .pgp-ok {
    color: var(--color-success);
  }

  .pgp-actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }

  .settings-tabs {
    display: flex;
    gap: 4px;
    padding: 12px 24px 0;
    border-bottom: 1px solid var(--color-border);
  }

  .settings-tabs .tab {
    padding: 8px 14px;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--color-text-secondary);
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition);
  }

  .settings-tabs .tab.active {
    color: var(--color-accent);
    border-bottom-color: var(--color-accent);
  }

  .rule-card {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: 12px;
    margin-bottom: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .rule-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .rule-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--color-text);
    cursor: pointer;
  }

  .rule-toggle input {
    accent-color: var(--color-accent);
  }

  .rule-cond {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .rule-cond select,
  .rule-cond input {
    flex: 1;
    min-width: 0;
    padding: 6px 8px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-bg);
    color: var(--color-text);
    font-size: 12px;
  }

  .rule-cond select {
    flex: 0 0 auto;
    width: auto;
    max-width: 140px;
  }

  .rule-action {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .rule-action select {
    padding: 6px 8px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-bg);
    color: var(--color-text);
    font-size: 12px;
  }

  .rule-action input {
    flex: 1;
    padding: 6px 8px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-bg);
    color: var(--color-text);
    font-size: 12px;
  }

  .rule-arrow {
    color: var(--color-text-secondary);
    font-weight: 600;
  }

  .btn-tiny {
    padding: 4px 10px;
    font-size: 12px;
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    color: var(--color-text);
    cursor: pointer;
  }

  .btn-tiny-danger {
    color: var(--color-danger, #e5534b);
    border-color: color-mix(in srgb, var(--color-danger, #e5534b) 40%, var(--color-border));
  }
  .btn-tiny-danger:hover {
    background: color-mix(in srgb, var(--color-danger, #e5534b) 10%, transparent);
  }

  .acct-list-sec {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-bottom: 16px;
  }
  .acct-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .acct-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    gap: 8px;
  }
  .acct-row.active {
    border-color: var(--color-accent, #3478f6);
    background: color-mix(in srgb, var(--color-accent, #3478f6) 8%, transparent);
  }
  .acct-info {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .acct-name {
    font-weight: 600;
    font-size: 14px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .acct-email {
    font-size: 12px;
    color: var(--color-text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .acct-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .acct-actions-row {
    display: flex;
    justify-content: flex-start;
  }
</style>
