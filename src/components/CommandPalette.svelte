<script lang="ts">
  import { onMount } from 'svelte'

  export interface PaletteCommand {
    id: string
    label: string
    hint?: string
    icon?: string
    run: () => void
  }

  interface Props {
    commands: PaletteCommand[]
    onClose: () => void
  }

  let { commands, onClose }: Props = $props()

  let raw = $state('')
  let inputEl: HTMLInputElement | null = $state(null)
  let activeIndex = $state(0)

  // Fuzzy subsequence match on label (and hint). Returns a score or -1.
  function score(cmd: PaletteCommand, q: string): number {
    if (!q) return 0
    const needle = q.toLowerCase().replace(/\s+/g, '')
    const haystack = (cmd.label + ' ' + (cmd.hint || '')).toLowerCase().replace(/\s+/g, '')
    let i = 0
    let bonus = 0
    for (let j = 0; j < haystack.length && i < needle.length; j++) {
      if (haystack[j] === needle[i]) {
        i++
        bonus += 1
      }
    }
    if (i < needle.length) return -1
    // Prefer matches that start at the beginning.
    if (haystack.startsWith(needle)) bonus += needle.length
    return bonus
  }

  let filtered = $derived.by(() => {
    const q = raw.trim()
    if (!q) return commands
    return commands
      .map(c => ({ c, s: score(c, q) }))
      .filter(x => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 12)
      .map(x => x.c)
  })

  $effect(() => {
    if (activeIndex >= (filtered.length || 1)) activeIndex = 0
  })

  function run(cmd: PaletteCommand) {
    cmd.run()
    onClose()
  }

  function handleKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      activeIndex = Math.min(activeIndex + 1, Math.max(filtered.length - 1, 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      activeIndex = Math.max(activeIndex - 1, 0)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const c = filtered[activeIndex]
      if (c) run(c)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault()
      onClose()
    }
  }

  onMount(() => {
    requestAnimationFrame(() => {
      inputEl?.focus()
      inputEl?.select()
    })
  })
</script>

<div class="palette-backdrop" onclick={onClose} onkeydown={(e) => e.stopPropagation()}>
  <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette" onclick={e => e.stopPropagation()}>
    <div class="palette-input-row">
      <span class="palette-glyph" aria-hidden="true">⌘</span>
      <input
        class="palette-input"
        type="text"
        placeholder="Type a command…"
        bind:value={raw}
        bind:this={inputEl}
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={filtered.length ? `palette-opt-${activeIndex}` : undefined}
        onkeydown={handleKey}
        spellcheck="false"
        autocomplete="off"
      />
    </div>
    <div class="palette-list" role="listbox" id="palette-list">
      {#if filtered.length === 0}
        <div class="palette-empty">No matches</div>
      {:else}
        {#each filtered as cmd, i (cmd.id)}
          <button
            class="palette-item"
            class:active={i === activeIndex}
            id={`palette-opt-${i}`}
            role="option"
            aria-selected={i === activeIndex}
            onclick={() => run(cmd)}
            onmousemove={() => (activeIndex = i)}
          >
            {#if cmd.icon}<span class="palette-item-icon">{cmd.icon}</span>{/if}
            <span class="palette-item-label">{cmd.label}</span>
            {#if cmd.hint}<span class="palette-item-hint">{cmd.hint}</span>{/if}
          </button>
        {/each}
      {/if}
    </div>
    <div class="palette-footer">
      <span>↑↓ navigate</span><span>↵ run</span><span>esc close</span>
    </div>
  </div>
</div>

<style>
  .palette-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(20, 20, 20, 0.35);
    backdrop-filter: blur(2px);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 12vh;
    z-index: 300;
    animation: fade-in 120ms ease-out;
  }
  .palette {
    width: min(620px, 92vw);
    background: var(--color-bg, #fff);
    border: 1px solid var(--color-border, #e2dfd6);
    border-radius: 12px;
    box-shadow: 0 18px 60px rgba(0,0,0,0.28);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .palette-input-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--color-border, #e2dfd6);
  }
  .palette-glyph {
    color: var(--color-text-secondary, #71706a);
    font-size: 15px;
    width: 20px;
    text-align: center;
  }
  .palette-input {
    flex: 1;
    border: none;
    outline: none;
    font-size: 15px;
    background: transparent;
    color: var(--color-text, #232323);
    font-family: inherit;
  }
  .palette-input::placeholder { color: var(--color-text-secondary, #71706a); }
  .palette-list {
    max-height: 360px;
    overflow-y: auto;
    padding: 6px;
  }
  .palette-empty {
    padding: 18px;
    text-align: center;
    color: var(--color-text-secondary, #71706a);
    font-size: 13px;
  }
  .palette-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    text-align: left;
    border: none;
    background: transparent;
    font-size: 14px;
    color: var(--color-text, #232323);
    padding: 9px 10px;
    border-radius: 8px;
    cursor: pointer;
    font-family: inherit;
    outline: none;
  }
  .palette-item:hover { background: var(--color-hover, rgba(35,35,35,0.05)); }
  .palette-item.active { background: var(--color-accent-soft, rgba(63,95,86,0.12)); }
  .palette-item.active.palette-item { box-shadow: inset 0 0 0 1px var(--color-accent, #3f5f56); }
  .palette-item-icon { font-size: 15px; width: 20px; text-align: center; }
  .palette-item-label { flex: 1; }
  .palette-item-hint {
    color: var(--color-text-secondary, #71706a);
    font-size: 12px;
    white-space: nowrap;
  }
  .palette-footer {
    display: flex;
    gap: 16px;
    padding: 8px 16px;
    border-top: 1px solid var(--color-border, #e2dfd6);
    color: var(--color-text-secondary, #71706a);
    font-size: 11px;
  }
  @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
</style>
