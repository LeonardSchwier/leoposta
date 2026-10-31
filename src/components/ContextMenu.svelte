<script lang="ts">
  interface MenuItem {
    label: string
    icon?: string
    action?: () => void
    danger?: boolean
    divider?: boolean
  }
  let {
    x = 0,
    y = 0,
    items = [],
    onClose
  }: {
    x?: number
    y?: number
    items?: MenuItem[]
    onClose?: () => void
  } = $props()

  function handleGlobalClick(e: MouseEvent) {
    const target = e.target as HTMLElement
    if (target && (target.closest('.context-menu'))) {
      return
    }
    onClose?.()
  }

  function handleKey(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose?.()
  }

  $effect(() => {
    window.addEventListener('click', handleGlobalClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('click', handleGlobalClick)
      window.removeEventListener('keydown', handleKey)
    }
  })
</script>

<div
  class="context-menu"
  style="left: {Math.min(x, (typeof window !== 'undefined' ? window.innerWidth - 220 : 1200))}px; top: {Math.min(y, (typeof window !== 'undefined' ? window.innerHeight - (items.length * 34 + 20) : 720))}px"
>
  {#each items as item, i (i)}
    {#if item.divider}
      <div class="context-menu-divider"></div>
    {:else}
      <button
        class="context-menu-item"
        class:danger={item.danger}
        onclick={() => {
          item.action?.()
          onClose?.()
        }}
      >
        {#if item.icon}<span class="item-icon">{item.icon}</span>{/if}
        <span class="item-label">{item.label}</span>
      </button>
    {/if}
  {/each}
</div>

<style>
  .context-menu {
    position: fixed;
    z-index: 9999;
    min-width: 200px;
    max-width: 280px;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 10px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.15);
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 1px;
    background-image: linear-gradient(180deg, rgba(255,255,255,0) 0%, rgba(0,0,0,0) 100%);
  }

  .context-menu-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 10px;
    background: transparent;
    border: none;
    border-radius: 7px;
    color: var(--color-text);
    font-size: 13px;
    cursor: pointer;
    text-align: left;
    transition: background 0.1s;
    width: 100%;
  }

  .context-menu-item:hover {
    background: var(--color-hover);
  }

  .context-menu-item.danger {
    color: var(--color-danger);
  }

  .context-menu-item.danger:hover {
    background: var(--danger-bg);
  }

  .item-icon {
    font-size: 15px;
    width: 20px;
    text-align: center;
    flex-shrink: 0;
  }

  .item-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .context-menu-divider {
    height: 1px;
    background: var(--color-border);
    margin: 4px 6px;
  }
</style>
