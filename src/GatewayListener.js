const { Client, GatewayIntentBits, Events, ChannelType, Partials } = require('discord.js')
const ConversationManager = require('./ConversationManager')

const DISCORD_MSG_LIMIT = 1900
const APPROVAL_POLL_INTERVAL_MS = 60_000

// Multi-word triggers must come before their single-word prefixes to prevent partial matches
const APPROVE_TRIGGERS = ['go ahead', 'looks good', 'approved', 'approve', 'yes', 'y', 'ok', 'sure']
const REJECT_TRIGGERS = ['not yet', 'hold on', 'rejected', 'reject', 'nope', 'no', 'n']

/**
 * Single Discord Gateway WebSocket listener that routes messages to multiple Paperclip agents.
 *
 * Routing:
 *  - DMs → dmAgentId (Sophie)
 *  - Guild channel in channelRoutes → mapped agent
 *  - boardApprovalsChannelId → inline approval resolution
 *
 * Uses one bot token (DISCORD_BOT_TOKEN_SOPHIE) for all channels.
 * discord.js handles Gateway reconnection automatically.
 */
class GatewayListener {
  /**
   * Send a Discord message using a specific bot token (not the main client).
   * This ensures each agent responds with their own bot identity.
   */
  async _sendAs(channelId, content, replyToMsgId, botToken) {
    const token = botToken || this.token
    const body = { content: content.slice(0, 1900) }
    if (replyToMsgId) body.message_reference = { message_id: replyToMsgId }
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      // Fallback to main client if agent token fails
      const channel = await this.client.channels.fetch(channelId).catch(() => null)
      if (channel) await channel.send(body.content).catch(() => {})
    }
  }

  /**
   * @param {object} opts
   * @param {string} opts.token - Discord bot token
   * @param {Object.<string,{agentId:string,name:string}>} opts.channelRoutes - channelId → agent
   * @param {string} opts.dmAgentId - Paperclip agent ID for DMs
   * @param {string} opts.boardApprovalsChannelId - Discord channel ID for #board-approvals
   * @param {import('./PaperclipClient')} opts.paperclip - For agent tasks/conversations
   * @param {import('./PaperclipClient')} opts.approvalPaperclip - For approval resolution (board API key)
   * @param {object} opts.conversationConfig - { expiryMinutes, pollIntervalSeconds, pollTimeoutSeconds }
   */
  constructor({ token, channelRoutes, dmAgentId, boardApprovalsChannelId, paperclip, approvalPaperclip, conversationConfig, haikuResponder = null }) {
    this.token = token
    this.channelRoutes = channelRoutes
    this.dmAgentId = dmAgentId
    this.boardApprovalsChannelId = boardApprovalsChannelId
    this.paperclip = paperclip
    this.approvalPaperclip = approvalPaperclip
    this.pollIntervalMs = conversationConfig.pollIntervalSeconds * 1000
    this.pollTimeoutMs = conversationConfig.pollTimeoutSeconds * 1000
    this.haikuResponder = haikuResponder

    this.conversations = new ConversationManager({ expiryMinutes: conversationConfig.expiryMinutes })

    this.pendingApprovals = []
    this.notifiedIds = new Set()

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    })

    this.client.once(Events.ClientReady, async (c) => {
      console.log(`[gateway] Logged in as ${c.user.tag}`)
      const routes = Object.entries(this.channelRoutes).map(([id, r]) => `#${r.name}(${id})`).join(', ')
      console.log(`[gateway] Routing: DMs→${dmAgentId.slice(0, 8)}, channels: ${routes}, approvals: ${boardApprovalsChannelId}`)
      await this._checkForNewApprovals()
      setInterval(() => this._checkForNewApprovals().catch(err => {
        console.error('[gateway] Approval poll error:', err.message)
      }), APPROVAL_POLL_INTERVAL_MS)
    })

    this.client.on(Events.MessageCreate, (msg) => this._onMessage(msg).catch(err => {
      console.error('[gateway] Error handling message:', err)
    }))
  }

  async start() {
    await this.client.login(this.token)
  }

  async _onMessage(msg) {
    if (msg.author.bot) return

    const isDM = msg.channel.type === ChannelType.DM || !msg.guild

    if (isDM) {
      return this._handleAgentMessage(msg, this.dmAgentId, 'Sophie', true, null)
    }

    if (msg.channelId === this.boardApprovalsChannelId) {
      return this._handleApproval(msg)
    }

    const route = this.channelRoutes[msg.channelId]
    if (route) {
      return this._handleAgentMessage(msg, route.agentId, route.name, false, route)
    }
    // Ignore messages in channels not in the routing table
  }

  /**
   * Fetch recent channel messages for conversational context, INCLUDING posts
   * from agent bots (e.g. Earl's status check-ins). The Haiku sliding window only
   * holds prior Haiku exchanges and never the agent's own proactive posts, so
   * without this a reply like "move to tomorrow" has nothing to resolve against.
   * Returns oldest-first, excluding the triggering message.
   */
  async _fetchChannelHistory(msg, limit = 8) {
    try {
      const fetched = await msg.channel.messages.fetch({ limit: limit + 1 })
      return [...fetched.values()]
        .filter(m => m.id !== msg.id && (m.content || '').trim())
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .slice(-limit)
        .map(m => ({ author: m.author.username, content: m.content.slice(0, 400) }))
    } catch (err) {
      console.error('[gateway] Failed to fetch channel history:', err.message)
      return []
    }
  }

  // ── Agent message handling ────────────────────────────────────────────────

  async _handleAgentMessage(msg, agentId, agentName, isDM, route = null) {
    const channelId = msg.channelId
    const userId = msg.author.id
    const username = msg.author.username
    const userMessage = msg.content.trim()
    // Respond with the routed agent's own bot identity (e.g. Earl in a customer
    // channel). DMs and unrouted channels keep the gateway token (Sophie).
    const botToken = route?.token || this.token

    if (!userMessage) return

    console.log(`[gateway:${agentName}] Received ${isDM ? 'DM' : 'message'} from @${username}: ${userMessage.slice(0, 80)}`)

    // ── Tier 1 / Tier 2: Haiku fast response ──────────────────────────────
    if (this.haikuResponder) {
      msg.channel.sendTyping().catch(() => {})

      // Fetch conversation window + Hindsight summary before calling Haiku.
      // Also pull recent channel history so the agent can see its own prior
      // posts (e.g. Earl's check-in) that the Haiku window never captures.
      const window = this.conversations.getWindow(channelId)
      const channelHistory = isDM ? [] : await this._fetchChannelHistory(msg)
      let hindsightSummary = this.conversations.getCachedSummary(channelId)
      if (hindsightSummary === null) {
        hindsightSummary = await this.haikuResponder.recallConversationSummary(channelId, agentId)
        this.conversations.setCachedSummary(channelId, hindsightSummary)
      }

      let haikuResult = null
      try {
        haikuResult = await this.haikuResponder.respond({
          agentId,
          agentName,
          userMessage,
          channelId,
          window,
          channelHistory,
          hindsightSummary,
        })
      } catch (err) {
        console.error(`[gateway:${agentName}] Haiku error, falling back to full agent:`, err.message)
      }

      if (haikuResult && !haikuResult.needsWork) {
        // Tier 1: pure conversational reply — post as the routed agent's identity
        const chunks = this._formatResponse(haikuResult.reply)
        for (let i = 0; i < chunks.length; i++) {
          await this._sendAs(channelId, chunks[i], i === 0 ? msg.id : null, botToken)
        }
        this._updateWindow(channelId, userMessage, haikuResult.reply, agentId)
        return
      }

      if (haikuResult && haikuResult.needsWork) {
        // Tier 2: create Paperclip work task + wake agent
        const workDesc = haikuResult.workDescription || `Discord message from @${username}`
        try {
          const task = await this.paperclip.createWorkTask({
            agentId,
            title: `Discord: ${userMessage.slice(0, 80)}`,
            description: [
              `**Discord ${isDM ? 'DM' : 'message'} from @${username}:**`,
              '',
              userMessage,
              '',
              '---',
              '',
              `*Work initiated via Haiku tier. Request: ${workDesc}*`,
            ].join('\n'),
          })
          await this.paperclip.wakeupAgent(agentId).catch(err => {
            console.error(`[gateway:${agentName}] Failed to wake agent after Tier 2:`, err.message)
          })
          const confirmText = haikuResult.reply
            ? `${haikuResult.reply}\n\nOn it — I've kicked off: ${workDesc}. I'll update you when done. (${task.identifier})`
            : `On it — I've kicked off: ${workDesc}. I'll update you when done. (${task.identifier})`
          await this._sendAs(channelId, confirmText, msg.id, botToken)
          this._updateWindow(channelId, userMessage, confirmText, agentId)
        } catch (err) {
          console.error(`[gateway:${agentName}] Failed to create work task:`, err.message)
          await this._sendAs(channelId, `⚠️ Could not queue work: ${err.message}`, msg.id, botToken)
        }
        return
      }
      // Haiku threw — fall through to full-agent flow below
    }

    // ── Full agent run (fallback / when Haiku disabled) ────────────────────
    let conv = this.conversations.get(channelId, userId)

    if (conv && conv.awaitingResponse) {
      console.log(`[gateway:${agentName}] Agent busy; queuing message for task ${conv.taskId}`)
      await this.paperclip.addUserMessage(conv.taskId, { username, message: userMessage })
      this.conversations.update(channelId, userId, {})
      if (conv.thinkingMessageId) {
        try {
          const channel = await this.client.channels.fetch(channelId)
          const thinkingMsg = await channel.messages.fetch(conv.thinkingMessageId)
          await thinkingMsg.edit('🤔 Working on it... *(new messages queued)*')
        } catch (_) {}
      }
      return
    }

    await this._sendAs(channelId, '🤔 Working on it...', msg.id, botToken)
    const thinkingMsg = { channel: msg.channel, edit: async () => {}, delete: async () => {} }
    let taskId
    let lastCommentId = null

    if (conv) {
      taskId = conv.taskId
      lastCommentId = conv.lastCommentId
      const comment = await this.paperclip.addUserMessage(taskId, { username, message: userMessage })
      lastCommentId = comment.id
      this.conversations.update(channelId, userId, {
        awaitingResponse: true,
        thinkingMessageId: thinkingMsg.id,
        lastCommentId,
      })
    } else {
      let task
      if (isDM) {
        task = await this.paperclip.createDMConversationTask({ agentId, userId, username, message: userMessage })
      } else {
        const channel = await this.client.channels.fetch(channelId)
        task = await this.paperclip.createConversationTask({
          agentId,
          channelName: channel.name || channelId,
          guildId: channel.guildId,
          userId,
          username,
          message: userMessage,
        })
      }
      taskId = task.id
      this.conversations.set(channelId, userId, {
        taskId,
        lastCommentId: null,
        awaitingResponse: true,
        thinkingMessageId: thinkingMsg.id,
      })
      console.log(`[gateway:${agentName}] Created task ${task.identifier} for @${username}`)
    }

    this._waitForResponse(channelId, userId, agentId, agentName, taskId, lastCommentId, thinkingMsg, botToken)
  }

  async _waitForResponse(channelId, userId, agentId, agentName, taskId, lastCommentId, thinkingMsg, botToken) {
    const result = await this.paperclip.pollForResponse(
      taskId,
      agentId,
      lastCommentId,
      this.pollTimeoutMs,
      this.pollIntervalMs,
    )

    const conv = this.conversations.get(channelId, userId)

    if (!result) {
      console.warn(`[gateway:${agentName}] Timeout waiting for response on task ${taskId}`)
      await this._sendAs(channelId, `⏱️ No response from ${agentName} yet — they may be busy. Try again in a moment.`, null, botToken)
      if (conv) this.conversations.update(channelId, userId, { awaitingResponse: false })
      return
    }

    const chunks = this._formatResponse(result.body)
    for (let i = 0; i < chunks.length; i++) {
      await this._sendAs(channelId, chunks[i], null, botToken)
    }

    if (conv) {
      this.conversations.update(channelId, userId, {
        awaitingResponse: false,
        lastCommentId: result.lastCommentId,
        thinkingMessageId: null,
      })
    }
  }

  /**
   * Add a Haiku exchange to the sliding window and fire-and-forget Hindsight summarisation
   * when a pair is dropped from the window.
   */
  _updateWindow(channelId, userMsg, agentReply, agentId = null) {
    const dropped = this.conversations.addToWindow(channelId, userMsg, agentReply)
    if (dropped) {
      const existing = this.conversations.getCachedSummary(channelId) || ''
      this.haikuResponder.appendToSummary(channelId, dropped, existing, agentId)
        .then(newSummary => this.conversations.setCachedSummary(channelId, newSummary))
        .catch(err => console.error('[gateway] Failed to store conversation summary:', err.message))
    }
  }

  _formatResponse(text) {
    if (text.length <= DISCORD_MSG_LIMIT) return [text]
    const chunks = []
    let remaining = text
    while (remaining.length > DISCORD_MSG_LIMIT) {
      const boundary = remaining.lastIndexOf('\n\n', DISCORD_MSG_LIMIT)
      const cutAt = boundary > 100 ? boundary : DISCORD_MSG_LIMIT
      chunks.push(remaining.slice(0, cutAt).trim())
      remaining = remaining.slice(cutAt).trim()
    }
    if (remaining) chunks.push(remaining)
    return chunks
  }

  // ── Approval handling ─────────────────────────────────────────────────────

  /**
   * Parse approve/reject commands from #board-approvals.
   * Returns null if the message is not a command.
   */
  _parseApprovalCommand(text) {
    const trimmed = text.trim()
    const lower = trimmed.toLowerCase()
    let action, rest

    for (const trigger of APPROVE_TRIGGERS) {
      if (lower === trigger || lower.startsWith(trigger + ' ') || lower.startsWith(trigger + '-')) {
        action = 'approve'
        rest = trimmed.slice(trigger.length).trim()
        break
      }
    }
    if (!action) {
      for (const trigger of REJECT_TRIGGERS) {
        if (lower === trigger || lower.startsWith(trigger + ' ') || lower.startsWith(trigger + '-')) {
          action = 'reject'
          rest = trimmed.slice(trigger.length).trim()
          break
        }
      }
    }
    if (!action) return null

    const numberPrefix = rest.match(/^(\d+)(?:\s*-\s*|\s+)(.+)$/)
    const bareNumber = rest.match(/^(\d+)$/)
    const uuidPrefix = rest.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\s*-\s*|\s+)?(.*)$/i)

    if (numberPrefix) return { action, index: parseInt(numberPrefix[1], 10) - 1, idOrNull: null, note: numberPrefix[2].trim() }
    if (bareNumber) return { action, index: parseInt(bareNumber[1], 10) - 1, idOrNull: null, note: '' }
    if (uuidPrefix) return { action, index: null, idOrNull: uuidPrefix[1], note: (uuidPrefix[2] || '').trim() }
    const note = rest.startsWith('- ') ? rest.slice(2).trim() : rest
    return { action, index: null, idOrNull: null, note }
  }

  _approvalTitle(a) {
    return a.payload?.title || a.payload?.name || a.id
  }

  async _handleApproval(msg) {
    const parsed = this._parseApprovalCommand(msg.content)
    if (!parsed) return

    await this._refreshPendingApprovals()

    if (this.pendingApprovals.length === 0) {
      await msg.reply('There are no pending board approvals right now.')
      return
    }

    const { action, note } = parsed
    let targetIndex

    if (parsed.idOrNull) {
      const idx = this.pendingApprovals.findIndex(a => a.id === parsed.idOrNull)
      if (idx === -1) {
        await msg.reply(`❓ No pending approval found with ID \`${parsed.idOrNull}\`.`)
        return
      }
      targetIndex = idx
    } else if (parsed.index !== null) {
      if (parsed.index < 0 || parsed.index >= this.pendingApprovals.length) {
        await msg.reply(`❓ No approval #${parsed.index + 1}. There are ${this.pendingApprovals.length} pending.`)
        return
      }
      targetIndex = parsed.index
    } else {
      targetIndex = 0
    }

    const approval = this.pendingApprovals[targetIndex]
    const title = this._approvalTitle(approval)
    const noteClause = note ? ` with note: "${note}"` : ''
    const ackText = action === 'approve'
      ? `✅ Approved: **${title}**${noteClause}. Sophie is on it.`
      : `❌ Rejected: **${title}**${noteClause}. Sophie is on it.`
    await msg.reply(ackText)

    try {
      if (action === 'approve') {
        await this.approvalPaperclip.approveApproval(approval.id, note)
      } else {
        await this.approvalPaperclip.rejectApproval(approval.id, note)
      }
      this.pendingApprovals.splice(targetIndex, 1)
      this.notifiedIds.delete(approval.id)
      await this.approvalPaperclip.wakeupAgent(this.dmAgentId).catch(err => {
        console.error('[gateway] Failed to wake Sophie after approval:', err.message)
      })
    } catch (err) {
      console.error(`[gateway] Failed to ${action} approval ${approval.id}:`, err.message)
      await msg.reply(`⚠️ Failed to ${action}: ${err.message}`)
    }
  }

  async _refreshPendingApprovals() {
    try {
      const approvals = await this.approvalPaperclip.getPendingApprovals()
      this.pendingApprovals = approvals.sort((a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )
      console.log(`[gateway] ${this.pendingApprovals.length} pending approval(s)`)
    } catch (err) {
      console.error('[gateway] Failed to refresh pending approvals:', err.message)
    }
  }

  async _checkForNewApprovals() {
    await this._refreshPendingApprovals()

    const currentIds = new Set(this.pendingApprovals.map(a => a.id))
    for (const id of this.notifiedIds) {
      if (!currentIds.has(id)) this.notifiedIds.delete(id)
    }

    const newApprovals = this.pendingApprovals.slice().reverse().filter(a => !this.notifiedIds.has(a.id))
    if (newApprovals.length === 0) return

    let channel
    try {
      channel = await this.client.channels.fetch(this.boardApprovalsChannelId)
    } catch (err) {
      console.error('[gateway] Cannot fetch #board-approvals for notifications:', err.message)
      return
    }

    for (const approval of newApprovals) {
      try {
        const summary = approval.payload?.summary || approval.payload?.description || ''
        const lines = [`📋 Approval needed: ${this._approvalTitle(approval)}`]
        if (summary) lines.push(summary)
        lines.push('', 'Reply yes or no.')
        await channel.send(lines.join('\n'))
        this.notifiedIds.add(approval.id)
      } catch (err) {
        console.error(`[gateway] Failed to post approval notification for ${approval.id}:`, err.message)
      }
    }
  }
}

module.exports = GatewayListener
