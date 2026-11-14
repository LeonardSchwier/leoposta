/**
 * Loading the full body of the message the user opened.
 *
 * The list only carries envelopes, so opening a message fetches it. Three
 * things go wrong without care:
 *  - A slow answer can arrive after the user moved to another folder or
 *    account. UIDs are only unique per mailbox, so a late answer for INBOX
 *    uid 1 would land on Archive uid 1: the pane shows the wrong mail. An
 *    answer is applied only while the folder and account it was asked for
 *    are still the ones on screen.
 *  - A message deleted on the server (another client, a filter) answers 404.
 *    The caller drops the row and tells the user (a toast; App.svelte
 *    messageGone), the same as a message action on a gone message.
 *  - Offline, the last full copy from the local cache is shown.
 */
import type { MailMessage } from '../store'

/** Fields that only exist once a message has been opened. */
export type LoadedFields = Pick<MailMessage, 'body' | 'bodyHtml' | 'pgp' | 'attachments' | 'cc' | 'bcc' | 'bodyLoaded' | 'loadError'>

export interface OpenMessageDeps {
  fetchMessage: (id: string, folder: string) => Promise<any>
  context: () => { activeFolder: string; activeAccountId: string | null }
  update: (id: string, patch: Partial<MailMessage>) => void
  cachePut?: (folder: string, id: string, message: any) => Promise<void>
  cacheGet?: (folder: string, id: string) => Promise<any | undefined>
  /** A 404 (deleted on the server): the app drops the row and tells the user. */
  onGone: (id: string) => void
}

function loadedFields(data: any): LoadedFields {
  return {
    body: data.body ?? '',
    bodyHtml: data.bodyHtml ?? '',
    pgp: data.pgp ?? undefined,
    attachments: data.attachments ?? [],
    cc: data.cc,
    bcc: data.bcc,
    bodyLoaded: true,
    loadError: undefined
  }
}

export async function loadMessageBody(id: string, deps: OpenMessageDeps): Promise<void> {
  // Copy the values: getState() can hand back an object that later changes.
  const { activeFolder, activeAccountId } = deps.context()
  const asked = { activeFolder, activeAccountId }
  const stillCurrent = () => {
    const now = deps.context()
    return now.activeFolder === asked.activeFolder && now.activeAccountId === asked.activeAccountId
  }
  const folder = asked.activeFolder
  try {
    const data = await deps.fetchMessage(id, folder)
    if (!data || !stillCurrent()) return
    deps.cachePut?.(folder, id, data).catch(() => {})
    deps.update(id, { ...loadedFields(data), ...(Array.isArray(data.flags) ? { flags: data.flags } : {}) })
  } catch (e) {
    if (!stillCurrent()) return
    const status = (e as { status?: number })?.status
    if (status === 404) { deps.onGone(id); return }
    const cached = await deps.cacheGet?.(folder, id).catch(() => undefined)
    if (!stillCurrent()) return
    if (cached?.full && cached.message) {
      deps.update(id, loadedFields(cached.message))
      return
    }
    deps.update(id, {
      bodyLoaded: true,
      loadError: `The message could not be loaded: ${e instanceof Error ? e.message : String(e)}`
    })
  }
}

/** A refreshed list keeps the bodies of messages already opened (the list
 * response has none), so a refresh never blanks the message on screen. */
export function keepLoadedBodies(previous: MailMessage[], next: MailMessage[]): MailMessage[] {
  const loaded = new Map<string, MailMessage>()
  for (const m of previous) if (m.bodyLoaded && !m.loadError) loaded.set(`${m.folder}\u0000${m.id}`, m)
  if (loaded.size === 0) return next
  return next.map((m) => {
    const old = loaded.get(`${m.folder}\u0000${m.id}`)
    if (!old) return m
    return { ...m, body: old.body, bodyHtml: old.bodyHtml, pgp: old.pgp, attachments: old.attachments, cc: old.cc, bcc: old.bcc, bodyLoaded: true }
  })
}
