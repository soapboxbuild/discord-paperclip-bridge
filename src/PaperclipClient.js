const fetch = require('node-fetch')

class PaperclipClient {
  constructor({ apiUrl, apiKey, companyId }) {
    this.apiUrl = apiUrl
    this.apiKey = apiKey
    this.companyId = companyId
  }

  _headers() {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    }
  }

  async _post(path, body) {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`POST ${path} failed ${res.status}: ${text}`)
    return JSON.parse(text)
  }

  async _patch(path, body) {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method: 'PATCH',
      headers: this._headers(),
      body: JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`PATCH ${path} failed ${res.status}: ${text}`)
    return JSON.parse(text)
  }

  async _get(path) {
    const res = await fetch(`${this.apiUrl}${path}`, {
      headers: this._headers(),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`GET ${path} failed ${res.status}: ${text}`)
    return JSON.parse(text)
  }

  /**
   * Create a new conversation task assigned to a Paperclip agent.
   * The task description makes clear that this is a Discord conversation
   * and that the agent should reply via a comment.
   */
  async createConversationTask({ agentId, channelName, guildId, userId, username, message }) {
    const description = [
      '## Discord Message',
      '',
      `**Channel:** #${channelName}`,
      `**From:** @${username} (${userId})`,
      `**Guild:** ${guildId}`,
      '',
      '---',
      '',
      message,
      '',
      '---',
      '',
      '*This message came from Discord. Please reply conversationally by posting a comment on this task.*',
      '*Your comment will be automatically posted back to the Discord channel.*',
      '*Keep responses concise — this is a live chat interface.*',
    ].join('\n')

    return this._post(`/api/companies/${this.companyId}/issues`, {
      title: `[Discord] Chat with @${username} in #${channelName}`,
      description,
      assigneeAgentId: agentId,
      status: 'todo',
    })
  }

  /**
   * Create a new conversation task for a Discord DM.
   */
  async createDMConversationTask({ agentId, userId, username, message }) {
    const description = [
      '## Discord Direct Message',
      '',
      `**From:** @${username} (${userId})`,
      '',
      '---',
      '',
      message,
      '',
      '---',
      '',
      '*This message came via Discord DM. Please reply conversationally by posting a comment on this task.*',
      '*Your comment will be automatically sent back as a DM.*',
      '*Keep responses concise — this is a live chat interface.*',
    ].join('\n')

    return this._post(`/api/companies/${this.companyId}/issues`, {
      title: `[Discord DM] Chat with @${username}`,
      description,
      assigneeAgentId: agentId,
      status: 'todo',
    })
  }

  /**
   * Add a follow-up user message as a comment to an existing conversation task.
   */
  async addUserMessage(taskId, { username, message }) {
    const body = `**Discord message from @${username}:**\n\n${message}`
    return this._post(`/api/issues/${taskId}/comments`, { body })
  }

  /**
   * Get new comments since a cursor comment ID.
   * Returns an array of comment objects sorted oldest-first.
   */
  async getNewComments(taskId, afterCommentId) {
    let path = `/api/issues/${taskId}/comments?order=asc`
    if (afterCommentId) path += `&after=${encodeURIComponent(afterCommentId)}`
    return this._get(path)
  }

  /**
   * Poll for a response comment from a specific agent.
   * Resolves with the latest agent comment body, or null on timeout.
   *
   * @param {string} taskId
   * @param {string} agentId - The agent whose comments count as responses
   * @param {string|null} lastCommentId - Cursor; only look at comments after this
   * @param {number} timeoutMs - Max time to wait
   * @param {number} intervalMs - Poll interval
   * @param {function} [onNewAgentComment] - Called each time a new agent comment arrives
   */
  async pollForResponse(taskId, agentId, lastCommentId, timeoutMs, intervalMs, onNewAgentComment) {
    const deadline = Date.now() + timeoutMs
    let cursor = lastCommentId

    while (Date.now() < deadline) {
      await sleep(intervalMs)

      let comments
      try {
        comments = await this.getNewComments(taskId, cursor)
      } catch (err) {
        console.error(`[poll] Failed to get comments for task ${taskId}:`, err.message)
        continue
      }

      // Advance cursor regardless of author so we don't re-read user messages
      if (comments.length > 0) {
        cursor = comments[comments.length - 1].id
      }

      const agentComments = comments.filter(c => c.authorAgentId === agentId)
      if (agentComments.length > 0) {
        if (onNewAgentComment) {
          for (const c of agentComments) await onNewAgentComment(c.body, cursor)
        }
        return { body: agentComments[agentComments.length - 1].body, lastCommentId: cursor }
      }
    }

    return null
  }

  /**
   * Get all pending board approvals, ordered by creation date.
   * Always returns an array regardless of API envelope format.
   */
  async getPendingApprovals() {
    const data = await this._get(`/api/companies/${this.companyId}/approvals?status=pending`)
    return Array.isArray(data) ? data : (data.approvals || data.items || data.data || [])
  }

  /**
   * Approve a board approval.
   * @param {string} id - Approval ID
   * @param {string} decisionNote - Optional note from the approver
   */
  async approveApproval(id, decisionNote) {
    return this._post(`/api/approvals/${id}/approve`, { decisionNote: decisionNote || '' })
  }

  /**
   * Reject a board approval.
   * @param {string} id - Approval ID
   * @param {string} decisionNote - Optional note from the approver
   */
  async rejectApproval(id, decisionNote) {
    return this._post(`/api/approvals/${id}/reject`, { decisionNote: decisionNote || '' })
  }

  /**
   * Create a work task assigned to a Paperclip agent (Tier 2 from Haiku self-initiation).
   */
  async createWorkTask({ agentId, title, description }) {
    return this._post(`/api/companies/${this.companyId}/issues`, {
      title,
      description,
      assigneeAgentId: agentId,
      status: 'todo',
    })
  }

  /**
   * Wake a Paperclip agent by ID.
   * @param {string} agentId
   * @param {object} [payload] optional context payload (e.g. { reason, approvalId, title })
   */
  async wakeupAgent(agentId, payload = {}) {
    return this._post(`/api/agents/${agentId}/wakeup`, payload)
  }

  /**
   * Mark a conversation task as done.
   */
  async closeTask(taskId) {
    try {
      await this._patch(`/api/issues/${taskId}`, { status: 'done', comment: 'Discord conversation closed (idle timeout).' })
    } catch (err) {
      console.error(`[paperclip] Failed to close task ${taskId}:`, err.message)
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = PaperclipClient

