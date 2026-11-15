/**
 * The two app-wide shortcuts that are not tied to the message list:
 *  - Ctrl/Cmd+K toggles the command palette, also while typing.
 *  - '?' shows the keyboard help, but only when not typing: in a text field
 *    (search box, palette input, Compose) '?' is just a character.
 */
export const KEYBOARD_HELP =
  'Ctrl+K palette · ? this help · n new · Ctrl+Enter send · r reply · a archive · d delete · s star · u read/unread · v move · / search · Esc close'

export type GlobalShortcut = 'palette' | 'help' | null

export function globalShortcut(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>, typing: boolean): GlobalShortcut {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') return 'palette'
  if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && !typing) return 'help'
  return null
}
