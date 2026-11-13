import { writable } from 'svelte/store'
import { get } from 'svelte/store'
import { setActiveAccountEmail } from '../api'
import { loadPersistedRefreshMode, saveRefreshMode } from '../refresh'
import type { Signature } from '../lib/signature'
import type { RefreshMode } from '../refresh'

export interface MailMessage {
  id: string
  threadId?: string
  from: string
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  body: string
  bodyHtml?: string
  pgp?: {
    encrypted?: boolean
    decrypted?: boolean
    signed?: boolean
    verified?: boolean
    signer?: string
    error?: string
    isKey?: boolean
    armored?: string
  }
  date: string
  flags: string[]
  attachments?: Attachment[]
  folder: string
  headers: Record<string, string>
}

export interface Attachment {
  /** Download id. Absent in the message list (it only has IMAP body-structure
   * parts) and for attachments of a PGP-decrypted message; present once the
   * message has been opened. */
  id?: string
  filename: string
  contentType: string
  size: number
  contentId?: string
}

export interface MailAccount {
  id: string
  name: string
  email: string
  imapHost: string
  imapPort: number
  imapTls: boolean
  imapUser: string
  imapPass: string
  smtpHost: string
  smtpPort: number
  smtpTls: boolean
  smtpUser: string
  smtpPass: string
  signature: Signature
  davUrl?: string
  davUser?: string
  davPass?: string
}

export interface Folder {
  id: string
  name: string
  parentId?: string
  specialUse?: string
}

export interface State {
  accounts: MailAccount[]
  activeAccountId: string | null
  folders: Folder[]
  activeFolder: string
  searchQuery: string
  messages: MailMessage[]
  selectedMessageId: string | null
  unreadCount: number
  isComposing: boolean
  composeTo: string[]
  composeCc: string[]
  composeBcc: string[]
  composeSubject: string
  composeBody: string
  composeAttachments: Attachment[]
  composeScheduled: string | null
  composeReplyTo: string | null
  composeForward: boolean
  composeOriginalMessage: MailMessage | null
  isLoading: boolean
  error: string | null
  threadGrouping: boolean
  refreshInterval: RefreshMode
}

const initialState: State = {
  accounts: [],
  activeAccountId: null,
  folders: [],
  activeFolder: 'INBOX',
  searchQuery: '',
  messages: [],
  selectedMessageId: null,
  unreadCount: 0,
  isComposing: false,
  composeTo: [],
  composeCc: [],
  composeBcc: [],
  composeSubject: '',
  composeBody: '',
  composeAttachments: [],
  composeScheduled: null,
  composeReplyTo: null,
  composeForward: false,
  composeOriginalMessage: null,
  isLoading: false,
  error: null,
  threadGrouping: true,
  refreshInterval: 'instant',
}

export const store = writable<State>(initialState)

// Actions (use setState for updates)
function syncActiveHeader() {
  const s = get(store)
  const active = s.accounts.find(a => a.id === s.activeAccountId) ?? null
  setActiveAccountEmail(active?.email ?? null)
}

export function setActiveAccount(id: string | null) {
  store.update(s => ({ ...s, activeAccountId: id }))
  syncActiveHeader()
}
export function addAccount(account: MailAccount) {
  store.update(s => ({ ...s, accounts: [...s.accounts, account], activeAccountId: account.id }))
  syncActiveHeader()
}
export function setAccounts(accounts: MailAccount[]) {
  store.update(s => ({
    ...s,
    accounts,
    activeAccountId: s.activeAccountId && accounts.some(a => a.id === s.activeAccountId)
      ? s.activeAccountId
      : (accounts[0]?.id ?? null)
  }))
  syncActiveHeader()
}
export function updateAccount(account: MailAccount) {
  store.update(s => ({
    ...s,
    accounts: s.accounts.map(a => (a.id === account.id ? account : a))
  }))
  syncActiveHeader()
}
export function removeAccount(id: string) {
  store.update(s => ({
    ...s,
    accounts: s.accounts.filter(a => a.id !== id),
    activeAccountId: s.activeAccountId === id ? null : s.activeAccountId
  }))
  syncActiveHeader()
}

/** Convenience selector for the currently-active account object. */
export function getActiveAccount(): MailAccount | null {
  const s = get(store)
  return s.accounts.find(a => a.id === s.activeAccountId) ?? null
}
export function setFolders(folders: Folder[]) {
  store.update(s => ({ ...s, folders }))
}
export function setActiveFolder(folder: string) {
  store.update(s => ({ ...s, activeFolder: folder, messages: [], selectedMessageId: null }))
}
export function selectMessage(id: string | null) {
  store.update(s => ({ ...s, selectedMessageId: id }))
}
export function setMessages(messages: MailMessage[]) {
  store.update(s => ({ ...s, messages }))
}
export function addMessage(message: MailMessage) {
  store.update(s => ({ ...s, messages: [message, ...s.messages] }))
}
export function updateMessage(id: string, updates: Partial<MailMessage>) {
  store.update(s => ({
    ...s,
    messages: s.messages.map(m => m.id === id ? { ...m, ...updates } : m)
  }))
}
export function deleteMessage(id: string) {
  store.update(s => ({
    ...s,
    messages: s.messages.filter(m => m.id !== id),
    selectedMessageId: s.selectedMessageId === id ? null : s.selectedMessageId
  }))
}
export function setComposing(composing: boolean) {
  store.update(s => ({ ...s, isComposing: composing }))
}
export function setComposeTo(to: string[]) {
  store.update(s => ({ ...s, composeTo: to }))
}
export function setComposeCc(cc: string[]) {
  store.update(s => ({ ...s, composeCc: cc }))
}
export function setComposeBcc(bcc: string[]) {
  store.update(s => ({ ...s, composeBcc: bcc }))
}
export function setComposeSubject(subject: string) {
  store.update(s => ({ ...s, composeSubject: subject }))
}
export function setComposeBody(body: string) {
  store.update(s => ({ ...s, composeBody: body }))
}
export function setComposeScheduled(date: string | null) {
  store.update(s => ({ ...s, composeScheduled: date }))
}
export function setComposeReplyTo(messageId: string | null) {
  store.update(s => ({ ...s, composeReplyTo: messageId }))
}
export function setComposeForward(forward: boolean) {
  store.update(s => ({ ...s, composeForward: forward }))
}

export function setRefreshInterval(mode: RefreshMode) {
  store.update(s => ({ ...s, refreshInterval: mode }))
  saveRefreshMode(mode)
}

export function bootstrapRefreshMode() {
  setRefreshInterval(loadPersistedRefreshMode())
}
export function setComposeOriginalMessage(message: MailMessage | null) {
  store.update(s => ({ ...s, composeOriginalMessage: message }))
}
export function setUnreadCount(count: number) {
  store.update(s => ({ ...s, unreadCount: count }))
}
export function setIsLoading(loading: boolean) {
  store.update(s => ({ ...s, isLoading: loading }))
}
export function setError(error: string | null) {
  store.update(s => ({ ...s, error }))
}
export function clearCompose() {
  store.update(s => ({
    ...s,
    composeTo: [],
    composeCc: [],
    composeBcc: [],
    composeSubject: '',
    composeBody: '',
    composeAttachments: [],
    composeScheduled: null,
    composeReplyTo: null,
    composeForward: false,
    composeOriginalMessage: null
  }))
}
export function setThreadGrouping(enabled: boolean) {
  store.update(s => ({ ...s, threadGrouping: enabled }))
}
// Non-reactive getter for use in event handlers
export function getState(): State {
  return get(store)
}
