const WINDOW_SIZE = 8

/**
 * Tracks active Discord ↔ Paperclip conversations.
 *
 * Each conversation maps a (channelId, userId) pair to a Paperclip task.
 * Conversations expire after configurable idle time.
 *
 * Also maintains a per-channel sliding window of the last 8 Haiku message pairs
 * for conversational context, plus a cached Hindsight conversation summary.
 */
class ConversationManager {
  constructor({ expiryMinutes }) {
    this.expiryMs = expiryMinutes * 60 * 1000
    // key: `${channelId}:${userId}` → ConversationState
    this.active = new Map()
    // key: channelId → Array<{user: string, agent: string}> (max WINDOW_SIZE)
    this.channelWindows = new Map()
    // key: channelId → string|'' (null = not yet fetched from Hindsight)
    this.channelSummaries = new Map()
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

  // ── Sliding window (per channel, for Haiku context) ─────────────────────

  /**
   * Returns the current conversation window for this channel (up to WINDOW_SIZE pairs).
   * @returns {Array<{user: string, agent: string}>}
   */
  getWindow(channelId) {
    return this.channelWindows.get(channelId) || []
  }

  /**
   * Add a message pair to the channel window.
   * If the window is full (WINDOW_SIZE), the oldest pair is dropped and returned.
   * @returns {{user: string, agent: string}|null} dropped pair, or null if window was not full
   */
  addToWindow(channelId, userMsg, agentReply) {
    const window = this.channelWindows.get(channelId) || []
    let dropped = null
    if (window.length >= WINDOW_SIZE) {
      dropped = window.shift()
    }
    window.push({ user: userMsg, agent: agentReply })
    this.channelWindows.set(channelId, window)
    return dropped
  }

  // ── Hindsight conversation summary cache ─────────────────────────────────

  /**
   * Returns the cached Hindsight summary for this channel.
   * null = not yet fetched from Hindsight (caller should fetch and then setCachedSummary).
   * '' = fetched but empty.
   */
  getCachedSummary(channelId) {
    const val = this.channelSummaries.get(channelId)
    return val !== undefined ? val : null
  }

  setCachedSummary(channelId, summary) {
    this.channelSummaries.set(channelId, summary)
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
