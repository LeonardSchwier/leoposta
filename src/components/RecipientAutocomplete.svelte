<script lang="ts">
  import { onMount } from 'svelte'
  import { createContactsCache, type Contact } from '../lib/contacts'
  import { ContactsAPI } from '../api/index'

  let {
    value = $bindable(''),
    placeholder = 'recipient@example.com',
    maxSuggestions = 8
  }: {
    value: string
    placeholder?: string
    maxSuggestions?: number
  } = $props()

  let input: HTMLInputElement

  const fetcher = {
    fetchBooks: async () => (await ContactsAPI.addressBooks()).addressBooks ?? [],
    fetchContacts: async (uri: string) => (await ContactsAPI.contacts(uri)).contacts ?? []
  }
  const cache = createContactsCache({ fetcher })

  let suggestions: Contact[] = $state([])
  let suggestionIndex = $state(-1)
  let debounce: ReturnType<typeof setTimeout> | null = null
  let blurTimer: ReturnType<typeof setTimeout> | null = null

  onMount(() => {
    void (async () => {
      try {
        const b = await fetcher.fetchBooks()
        if (b.length) {
          try {
            await cache.loadContacts(b[0].uri)
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
      refreshFromToken(value)
    })()
  })

  function activeToken(v: string): string {
    const parts = v.split(/[,\s;]+/)
    return (parts[parts.length - 1] ?? '').trim()
  }

  function refreshFromToken(v: string): void {
    const token = activeToken(v)
    if (!token) {
      suggestions = []
      suggestionIndex = -1
      return
    }
    suggestions = cache.matches(token, maxSuggestions)
    suggestionIndex = -1
  }

  function commit(text: string): void {
    const email = text.trim()
    const key = email.toLowerCase()
    if (!key) return
    const raw = value.split(/[,\s;]+/)
    const keep = raw
      .slice(0, Math.max(raw.length - 1, 0))
      .map((p) => p.trim())
      .filter((p) => p.length > 0 && p.toLowerCase() !== key)
    value = keep.length ? keep.join(', ') + ', ' + email : email
    if (input) input.value = value
    suggestions = []
    suggestionIndex = -1
  }

  function onInput(e: Event): void {
    value = (e.target as HTMLInputElement).value
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      refreshFromToken(value)
    }, 120)
  }

  function onKeyDown(e: KeyboardEvent): void {
    const open = suggestions.length > 0
    if (e.key === 'ArrowDown') {
      if (!open) return
      e.preventDefault()
      suggestionIndex = Math.min(suggestionIndex + 1, suggestions.length - 1)
      return
    }
    if (e.key === 'ArrowUp') {
      if (!open) return
      e.preventDefault()
      suggestionIndex = Math.max(suggestionIndex - 1, 0)
      return
    }
    if (e.key === 'Escape') {
      if (!open) return
      e.preventDefault()
      suggestions = []
      suggestionIndex = -1
      return
    }
    if (e.key === 'Tab') {
      if (!open) return
      e.preventDefault()
      commit(suggestions[Math.max(suggestionIndex, 0)].email)
      return
    }
    if (e.key === ',') {
      if (open) {
        commit(suggestions[Math.max(suggestionIndex, 0)].email)
      } else {
        commit(activeToken(value))
      }
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (open) {
        commit(suggestions[Math.max(suggestionIndex, 0)].email)
        return
      }
      const raw = activeToken(value)
      if (raw) commit(raw)
      return
    }
  }

  function onRowMouseDown(e: MouseEvent, c: Contact): void {
    e.preventDefault()
    commit(c.email)
  }

  function onBlur(): void {
    if (blurTimer) clearTimeout(blurTimer)
    blurTimer = setTimeout(() => {
      suggestions = []
      suggestionIndex = -1
    }, 150)
  }
</script>

<div class="ra">
  <input
    class="ra-input"
    bind:this={input}
    type="text"
    autocomplete="off"
    spellcheck={false}
    bind:value={value}
    placeholder={placeholder}
    oninput={onInput}
    onkeydown={onKeyDown}
    onblur={onBlur}
  />
  {#if suggestions.length}
    <div class="suggestions" role="listbox">
      {#each suggestions as c, i (c.uid)}
        <div
          class="suggestion"
          class:active={suggestionIndex === i}
          role="option"
          tabindex={-1}
          aria-selected={suggestionIndex === i ? 'true' : 'false'}
          onmousedown={(e) => onRowMouseDown(e, c)}
        >
          <span class="sug-name">{c.name}</span>
          <span class="sug-email">{c.email}</span>
          {#if c.org}
            <span class="sug-org">{c.org}</span>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .ra {
    position: relative;
  }
  .ra .suggestions {
    position: absolute;
    top: 100%;
    left: 0;
    width: 100%;
    margin-top: 4px;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
    z-index: 50;
    overflow: auto;
    max-height: 220px;
  }
  .ra .suggestion {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 8px 12px;
    cursor: pointer;
    font-size: 13px;
    color: var(--color-text);
    border-bottom: 1px solid var(--color-border);
  }
  .ra .suggestion:last-child {
    border-bottom: none;
  }
  .ra .suggestion.active,
  .ra .suggestion:hover {
    background: var(--color-selected);
  }
  .sug-name {
    font-weight: 500;
  }
  .sug-email {
    color: var(--color-text-secondary);
    font-size: 12px;
  }
  .sug-org {
    color: var(--color-text-secondary);
    font-size: 12px;
    margin-left: auto;
  }
</style>
