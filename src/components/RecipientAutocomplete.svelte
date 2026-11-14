<script lang="ts">
  import { onMount } from 'svelte'
  import { createContactsCache, type Contact } from '../lib/contacts'
  import { ContactsAPI } from '../api/index'
  import { segments, splitRecipients, recipientAddress } from '../lib/recipients'

  let {
    value = $bindable(''),
    id = undefined,
    placeholder = 'recipient@example.com',
    maxSuggestions = 8
  }: {
    value: string
    id?: string
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
  let cacheReady = $state(false)
  let debounce: ReturnType<typeof setTimeout> | null = null
  let blurTimer: ReturnType<typeof setTimeout> | null = null

  onMount(() => {
    void (async () => {
      try {
        // Every address book, not just the first one.
        const b = await fetcher.fetchBooks()
        await Promise.allSettled(b.map((book: { uri: string }) => cache.loadContacts(book.uri)))
      } catch {
        /* ignore */
      }
      cacheReady = true
    })()
  })

  $effect(() => {
    if (!cacheReady) return
    const v = value
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      refreshFromToken(v)
    }, 120)
  })

  // The recipient being typed: the text after the last top-level "," or ";"
  // (a display name may contain spaces, so whitespace does not split).
  function activeToken(v: string): string {
    const { parts } = segments(v)
    return (parts[parts.length - 1] ?? '').trim()
  }

  // What to match contacts against: the address part once "<" was typed.
  function searchText(token: string): string {
    const lt = token.lastIndexOf('<')
    return (lt === -1 ? token : token.slice(lt + 1)).replace(/>$/, '').trim()
  }

  function refreshFromToken(v: string): void {
    const token = searchText(activeToken(v))
    if (!token) {
      suggestions = []
      suggestionIndex = -1
      return
    }
    const taken = new Set(splitRecipients(v).map((p) => recipientAddress(p).toLowerCase()))
    suggestions = cache
      .matches(token, maxSuggestions)
      .filter((c) => !taken.has(c.email.toLowerCase()))
    suggestionIndex = -1
  }

  // Replace the recipient being typed with `text`, keeping the earlier ones
  // exactly as typed (display names included) and dropping a duplicate address.
  function commit(text: string): void {
    const email = text.trim()
    const key = recipientAddress(email).toLowerCase()
    if (!key) return
    const { parts } = segments(value)
    const keep = parts
      .slice(0, Math.max(parts.length - 1, 0))
      .map((p) => p.trim())
      .filter((p) => p.length > 0 && recipientAddress(p).toLowerCase() !== key)
    value = keep.length ? keep.join(', ') + ', ' + email : email
    if (input) input.value = value
    suggestions = []
    suggestionIndex = -1
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
      // A "," inside quotes or <...> belongs to the name being typed.
      if (segments(value).open) return
      if (open) {
        commit(suggestions[Math.max(suggestionIndex, 0)].email)
      } else {
        commit(activeToken(value))
      }
      return
    }
    if (e.key === 'Enter') {
      if (open) {
        e.preventDefault()
        commit(suggestions[Math.max(suggestionIndex, 0)].email)
        suggestions = []
        suggestionIndex = -1
        return
      }
      const raw = activeToken(value)
      if (raw) {
        e.preventDefault()
        commit(raw)
        suggestions = []
        suggestionIndex = -1
      }
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
    {id}
    bind:this={input}
    type="text"
    autocomplete="off"
    spellcheck={false}
    bind:value={value}
    placeholder={placeholder}
    onkeydown={onKeyDown}
    onblur={onBlur}
  />
  {#if suggestions.length}
    <div class="suggestions" role="listbox">
      {#each suggestions as c, i (c.email)}
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
