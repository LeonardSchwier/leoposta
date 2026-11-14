<script lang="ts">
  import { onMount } from 'svelte'
  import type { Folder } from '../store'
  import { moveTargets } from '../lib/moveTargets'

  // "Move to…" folder chooser. Lists every mailbox that can hold mail (not
  // \Noselect parents) except the one the message is in, nested folders with
  // their full path. onPick(path) receives the real IMAP path.
  let { folders, current, onPick, onClose }: {
    folders: Folder[]
    current: string
    onPick: (path: string) => void
    onClose: () => void
  } = $props()

  let filter = $state('')
  let input: HTMLInputElement | undefined = $state()
  const targets = $derived(moveTargets(folders, current, filter))

  function pick(path: string) {
    onPick(path)
    onClose()
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    } else if (e.key === 'Enter' && targets.length > 0) {
      e.preventDefault()
      pick(targets[0].path)
    }
  }

  onMount(() => { input?.focus() })
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="picker-back" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) onClose() }}>
  <div class="picker" role="dialog" aria-modal="true" aria-label="Move to folder" tabindex="-1" onkeydown={onKey}>
    <h3>Move to folder</h3>
    <input bind:this={input} bind:value={filter} placeholder="Filter folders…" aria-label="Filter folders" />
    <ul class="targets">
      {#each targets as t (t.path)}
        <li>
          <button type="button" class="target" style:padding-left="{10 + t.depth * 14}px" title={t.path} onclick={() => pick(t.path)}>
            {t.label}
          </button>
        </li>
      {:else}
        <li class="none">No folder matches</li>
      {/each}
    </ul>
    <div class="actions">
      <button type="button" class="btn-secondary" onclick={onClose}>Cancel</button>
    </div>
  </div>
</div>

<style>
  .picker-back {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1100;
  }
  .picker {
    width: min(360px, calc(100vw - 32px));
    max-height: min(520px, calc(100vh - 48px));
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 14px;
    background: var(--color-bg);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.35);
  }
  h3 { margin: 0; font-size: 15px; font-weight: 600; }
  input {
    padding: 6px 10px;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-surface);
    color: var(--color-text);
    font-size: 13px;
  }
  .targets { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1; }
  .target {
    display: block;
    width: 100%;
    text-align: left;
    padding: 7px 10px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--color-text);
    font-size: 13px;
    cursor: pointer;
  }
  .target:hover, .target:focus-visible { background: var(--color-hover); outline: none; }
  .none { padding: 8px 10px; color: var(--color-text-secondary); font-size: 13px; }
  .actions { display: flex; justify-content: flex-end; }
  .btn-secondary {
    padding: 6px 14px;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: transparent;
    color: var(--color-text);
    cursor: pointer;
  }
</style>
