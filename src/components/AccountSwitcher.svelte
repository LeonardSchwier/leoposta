<script lang="ts">
  // Shown in the sidebar when more than one account is configured. Changing
  // it sets the active account; App.svelte reloads folders and mail for it,
  // and every API call (including Send) is scoped to it via x-account.
  import { store, setActiveAccount } from '../store'
</script>

{#if $store.accounts.length > 1}
  <label class="acct-switch">
    <span class="sr-only">Account</span>
    <select aria-label="Account" value={$store.activeAccountId} onchange={(e) => setActiveAccount((e.currentTarget as HTMLSelectElement).value)}>
      {#each $store.accounts as a (a.id)}
        <option value={a.id}>{a.name && a.name !== a.email ? `${a.name} <${a.email}>` : a.email}</option>
      {/each}
    </select>
  </label>
{/if}

<style>
  .acct-switch { display: block; margin: 8px 0 4px; }
  .acct-switch select {
    width: 100%; padding: 6px 8px; font-size: 12px;
    border: 1px solid var(--color-border); border-radius: var(--radius-sm);
    background: var(--color-bg); color: var(--color-text);
  }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  @media (max-width: 768px) { .acct-switch { display: none; } }
</style>
