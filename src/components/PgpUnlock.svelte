<script lang="ts">
  // The actionable part of the PGP banner: asks for the passphrase while the
  // key is locked, explains a missing key, and offers "Lock" once decrypted.
  import type { MailMessage } from '../store'
  import { getState } from '../store'
  import { pgpUnlock, pgpLock, reloadMessage } from '../lib/pgp'

  let { msg }: { msg: MailMessage } = $props()

  let passphrase = $state('')
  let busy = $state(false)
  let error = $state('')

  const locked = $derived(!!msg.pgp && !msg.pgp.decrypted && msg.pgp.error === 'pgp_locked')
  const noKey = $derived(!!msg.pgp && !msg.pgp.decrypted && msg.pgp.error === 'pgp_no_key')

  async function unlock(e: Event) {
    e.preventDefault()
    if (busy) return
    busy = true
    error = ''
    try {
      await pgpUnlock(passphrase)
      passphrase = ''
      await reloadMessage(msg.id, msg.folder || getState().activeFolder)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  async function lock() {
    if (busy) return
    busy = true
    error = ''
    try { await pgpLock() } catch (err) { error = err instanceof Error ? err.message : String(err) } finally { busy = false }
  }
</script>

{#if msg.pgp?.decrypted}
  <div class="pgp-actions-row">
    <button type="button" class="pgp-lock-btn" onclick={lock} disabled={busy}>🔒 Lock key</button>
    {#if error}<span class="pgp-unlock-err" role="alert">{error}</span>{/if}
  </div>
{:else if locked}
  <form class="pgp-unlock" onsubmit={unlock}>
    <label for="pgp-pass-{msg.id}">Your private key is locked. Enter its passphrase to read this message.</label>
    <div class="pgp-unlock-row">
      <input id="pgp-pass-{msg.id}" type="password" autocomplete="off" bind:value={passphrase} placeholder="Key passphrase" disabled={busy} />
      <button type="submit" disabled={busy || !passphrase}>{busy ? 'Unlocking…' : 'Unlock'}</button>
    </div>
    {#if error}<p class="pgp-unlock-err" role="alert">{error}</p>{/if}
  </form>
{:else if noKey}
  <p class="pgp-help">No OpenPGP private key is set up for this account. Add its private key in <b>Settings → PGP</b> to read this message.</p>
{:else if msg.pgp && !msg.pgp.decrypted}
  <p class="pgp-help">This message could not be decrypted with your key: {msg.pgp.error}</p>
{/if}

<style>
  .pgp-unlock { margin: 10px 0 0 26px; display: flex; flex-direction: column; gap: 6px; }
  .pgp-unlock label { font-size: 13px; color: var(--color-text); }
  .pgp-unlock-row { display: flex; gap: 8px; }
  .pgp-unlock-row input {
    flex: 1; max-width: 320px; padding: 6px 10px; font-size: 13px;
    border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-bg); color: var(--color-text);
  }
  .pgp-unlock-row button, .pgp-lock-btn {
    padding: 6px 12px; font-size: 13px; border-radius: var(--radius-sm); cursor: pointer;
    border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-text);
  }
  .pgp-unlock-row button:disabled, .pgp-lock-btn:disabled { opacity: .6; cursor: default; }
  .pgp-unlock-err { color: var(--color-danger); font-size: 12px; margin: 0; }
  .pgp-help { margin: 8px 0 0 26px; color: var(--color-text-secondary); font-size: 12px; }
  .pgp-actions-row { margin: 8px 0 0 26px; display: flex; gap: 10px; align-items: center; }
</style>
