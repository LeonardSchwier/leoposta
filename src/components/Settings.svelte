<script lang="ts">
  import { store, getState } from '../store'
  
  let { onClose } = $props()
  
  let accountName = $state('')
  let email = $state('')
  let imapHost = $state('imap.mailbox.org')
  let imapPort = $state('993')
  let imapTls = $state(true)
  let smtpHost = $state('smtp.mailbox.org')
  let smtpPort = $state('465')
  let smtpTls = $state(true)
  let password = $state('')
  let isLoading = $state(false)
  let error = $state('')
  
  function handleSave() {
    if (!email || !password) {
      error = 'Email and password are required'
      return
    }
    
    isLoading = true
    error = ''
    
    fetch('/api/account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: accountName || email.split('@')[0],
        email,
        imapHost,
        imapPort: parseInt(imapPort),
        imapTls,
        smtpHost,
        smtpPort: parseInt(smtpPort),
        smtpTls,
        password
      })
    })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        onClose()
      } else {
        error = data.error || 'Failed to save account'
      }
    })
    .catch(err => {
      error = err.message
    })
    .finally(() => {
      isLoading = false
    })
  }
  
  function handleDelete() {
    if (confirm('Remove account?')) {
      if (getState().activeAccountId) {
        getState().removeAccount(getState().activeAccountId)
      }
      onClose()
    }
  }
</script>

<div class="settings-overlay" onclick={onClose}>
  <div class="settings-modal" onclick={(e) => e.stopPropagation()}>
    <div class="modal-header">
      <h2>Account Settings</h2>
      <button class="close-btn" onclick={onClose}>✕</button>
    </div>
    
    <div class="modal-body">
      {#if error}
        <div class="error-banner">{error}</div>
      {/if}
      
      <div class="form-group">
        <label>Account Name</label>
        <input type="text" bind:value={accountName} placeholder="My Mail" />
      </div>
      
      <div class="form-group">
        <label>Email Address</label>
        <input type="email" bind:value={email} placeholder="you@example.com" />
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
    </div>
    
    <div class="modal-footer">
      {#if getState().activeAccountId}
        <button class="btn-danger" onclick={handleDelete}>Remove Account</button>
      {/if}
      <div class="footer-right">
        <button class="btn-secondary" onclick={onClose}>Cancel</button>
        <button class="btn-primary" onclick={handleSave} disabled={isLoading}>
          {#if isLoading}Saving...{:else}Save{/if}
        </button>
      </div>
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
  .form-group input[type="password"] {
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
</style>
