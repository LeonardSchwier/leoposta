import { describe, it, expect, vi, afterEach } from 'vitest'
import { ApiError, MailAPI } from '../api'
import { reloadMessage } from '../lib/pgp'

afterEach(() => vi.restoreAllMocks())

describe('reloadMessage (after unlocking the PGP key)', () => {
  it('a message deleted on the server meanwhile goes to onGone (drop the row + toast), like opening it', async () => {
    vi.spyOn(MailAPI, 'message').mockRejectedValue(new ApiError('message_not_found', 404))
    const onGone = vi.fn()
    await expect(reloadMessage('9', 'INBOX', onGone)).resolves.toBeUndefined()
    expect(onGone).toHaveBeenCalledWith('9')
  })
  it('other failures still reach the unlock form', async () => {
    vi.spyOn(MailAPI, 'message').mockRejectedValue(new ApiError('Command failed', 500))
    const onGone = vi.fn()
    await expect(reloadMessage('9', 'INBOX', onGone)).rejects.toThrow('Command failed')
    expect(onGone).not.toHaveBeenCalled()
  })
})
