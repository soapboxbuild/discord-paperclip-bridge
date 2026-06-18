/**
 * Tracks active Discord ↔ Paperclip conversations.
 *
 * Each conversation maps a (channelId, userId) pair to a Paperclip task.
 * Conversations expire after configurable idle time.
 */
class ConversationManager {
  constructor({ expiryMinutes }) {
    this.expiryMs = expiryMinutes * 60 * 1000
    // key: `${channelId}:${userId}` → ConversationState
    this.active = new Map()
    // Run cleanup every 5 minutes
    this._cleanupInterval = setInterval(() => this._cleanup(), 5 * 60 * 1000)
    this._cleanupInterval.unref()
  }

  /**
   * @typedef {Object} ConversationState
   * @property {string} taskId - Paperclip issue ID
   * @property {string|null} lastCommentId - Cursor for comment polling
   * @property {number} lastActivity - Unix ms timestamp
   * @property {boolean} awaitingResponse - Whether we're currently polling for a response
   * @property {string|null} thinkingMessageId - Discord message ID of the "thinking..." status
   */

  /**
   * Returns the active conversation for this user in this channel, or null if expired/absent.
   * @returns {ConversationState|null}
   */
  get(channelId, userId) {
    const key = `${channelId}:${userId}`
    const conv = this.active.get(key)
    if (!conv) return null
    if (Date.now() - conv.lastActivity > this.expiryMs) {
      this.active.delete(key)
      return null
    }
    return conv
  }

  /**
   * Register or replace the active conversation for this user in this channel.
   */
  set(channelId, userId, state) {
    const key = `${channelId}:${userId}`
    this.active.set(key, { ...state, lastActivity: Date.now() })
  }

  /**
   * Update fields on an existing conversation (touches lastActivity).
   */
  update(channelId, userId, patch) {
    const key = `${channelId}:${userId}`
    const conv = this.active.get(key)
    if (conv) {
      this.active.set(key, { ...conv, ...patch, lastActivity: Date.now() })
    }
  }

  /**
   * Remove a conversation (e.g. after the task is closed).
   */
  delete(channelId, userId) {
    this.active.delete(`${channelId}:${userId}`)
  }

  _cleanup() {
    const now = Date.now()
    for (const [key, conv] of this.active) {
      if (now - conv.lastActivity > this.expiryMs) {
        this.active.delete(key)
      }
    }
  }
}

module.exports = ConversationManager
