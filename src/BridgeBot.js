const { Client, GatewayIntentBits, Events } = require('discord.js')
const ConversationManager = require('./ConversationManager')

const DISCORD_MSG_LIMIT = 1900 // leave room for safety margin under 2000

/**
 * One BridgeBot instance per Discord bot token.
 * Listens to a single dedicated channel and routes messages to a Paperclip agent.
 */
class BridgeBot {
  /**
   * @param {object} opts
   * @param {string} opts.name - Human name (e.g. "sophie")
   * @param {string} opts.token - Discord bot token
   * @param {string} opts.channelId - Discord channel ID this bot listens to
   * @param {string} opts.agentId - Paperclip agent ID to route messages to
   * @param {string} opts.displayName - Display name for log messages
   * @param {import('./PaperclipClient')} opts.paperclip
   * @param {object} opts.conversationConfig - { expiryMinutes, pollIntervalSeconds, pollTimeoutSeconds }
   */
  constructor({ name, token, channelId, agentId, displayName, paperclip, conversationConfig }) {
    this.name = name
    this.token = token
    this.channelId = channelId
    this.agentId = agentId
    this.displayName = displayName
    this.paperclip = paperclip
    this.pollIntervalMs = conversationConfig.pollIntervalSeconds * 1000
    this.pollTimeoutMs = conversationConfig.pollTimeoutSeconds * 1000

    this.conversations = new ConversationManager({ expiryMinutes: conversationConfig.expiryMinutes })

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    })

    this.client.once(Events.ClientReady, (c) => {
      console.log(`[${this.name}] Logged in as ${c.user.tag}`)
    })

    this.client.on(Events.MessageCreate, (msg) => this._onMessage(msg).catch(err => {
      console.error(`[${this.name}] Error handling message:`, err)
    }))
  }

  async start() {
    await this.client.login(this.token)
  }

  async _onMessage(msg) {
    // Only handle messages in the dedicated channel
    if (msg.channelId !== this.channelId) return
    // Ignore messages from bots (including ourselves)
    if (msg.author.bot) return

    const channelId = msg.channelId
    const userId = msg.author.id
    const username = msg.author.username
    const userMessage = msg.content.trim()

    if (!userMessage) return

    console.log(`[${this.name}] Received message from @${username}: ${userMessage.slice(0, 80)}...`)

    let conv = this.conversations.get(channelId, userId)

    if (conv && conv.awaitingResponse) {
      // Agent is still processing — queue the new message as a comment and update the thinking message
      console.log(`[${this.name}] Agent busy; queuing message for task ${conv.taskId}`)
      await this.paperclip.addUserMessage(conv.taskId, { username, message: userMessage })
      this.conversations.update(channelId, userId, {})
      if (conv.thinkingMessageId) {
        try {
          const channel = await this.client.channels.fetch(channelId)
          const thinkingMsg = await channel.messages.fetch(conv.thinkingMessageId)
          await thinkingMsg.edit(`🤔 Working on it... *(new messages queued)*`)
        } catch (_) {}
      }
      return
    }

    // Post the "thinking..." status as a reply to the user
    const thinkingMsg = await msg.reply(`🤔 Working on it...`)

    let taskId
    let lastCommentId = null

    if (conv) {
      // Continue existing conversation
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
      // Start a new conversation
      const channel = await this.client.channels.fetch(channelId)
      const channelName = channel.name || channelId

      const task = await this.paperclip.createConversationTask({
        agentId: this.agentId,
        channelName,
        guildId: channel.guildId,
        userId,
        username,
        message: userMessage,
      })
      taskId = task.id
      this.conversations.set(channelId, userId, {
        taskId,
        lastCommentId: null,
        awaitingResponse: true,
        thinkingMessageId: thinkingMsg.id,
      })

      console.log(`[${this.name}] Created Paperclip task ${task.identifier} for @${username}`)
    }

    // Poll for the agent's response in the background
    this._waitForResponse(channelId, userId, taskId, lastCommentId, thinkingMsg)
  }

  /**
   * Polls Paperclip for a response from the agent and edits the Discord thinking message.
   * Runs asynchronously — does not block new message handling.
   */
  async _waitForResponse(channelId, userId, taskId, lastCommentId, thinkingMsg) {
    const result = await this.paperclip.pollForResponse(
      taskId,
      this.agentId,
      lastCommentId,
      this.pollTimeoutMs,
      this.pollIntervalMs,
    )

    const conv = this.conversations.get(channelId, userId)

    if (!result) {
      // Timeout — post a helpful error
      console.warn(`[${this.name}] Timeout waiting for agent response on task ${taskId}`)
      await this._editOrReply(thinkingMsg, `⏱️ No response from ${this.displayName} yet — they may be busy. Try again in a moment.`)
      if (conv) this.conversations.update(channelId, userId, { awaitingResponse: false })
      return
    }

    // Post the agent's response
    const formatted = this._formatResponse(result.body)
    for (let i = 0; i < formatted.length; i++) {
      if (i === 0) {
        await this._editOrReply(thinkingMsg, formatted[i])
      } else {
        // Multiple chunks — send subsequent ones as new messages in the channel
        try {
          await thinkingMsg.channel.send(formatted[i])
        } catch (err) {
          console.error(`[${this.name}] Failed to send response chunk:`, err.message)
        }
      }
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
   * Edit a message if possible, otherwise reply in channel.
   */
  async _editOrReply(msg, content) {
    try {
      await msg.edit(content)
    } catch (err) {
      console.error(`[${this.name}] Could not edit thinking message:`, err.message)
      try {
        await msg.channel.send(content)
      } catch (e) {
        console.error(`[${this.name}] Could not send fallback message:`, e.message)
      }
    }
  }

  /**
   * Split long responses into Discord-safe chunks (≤1900 chars).
   * Tries to split on double newlines (paragraph boundaries) first.
   */
  _formatResponse(text) {
    if (text.length <= DISCORD_MSG_LIMIT) return [text]

    const chunks = []
    let remaining = text

    while (remaining.length > DISCORD_MSG_LIMIT) {
      // Try to break at a paragraph boundary
      const boundary = remaining.lastIndexOf('\n\n', DISCORD_MSG_LIMIT)
      const cutAt = boundary > 100 ? boundary : DISCORD_MSG_LIMIT
      chunks.push(remaining.slice(0, cutAt).trim())
      remaining = remaining.slice(cutAt).trim()
    }

    if (remaining) chunks.push(remaining)
    return chunks
  }
}

module.exports = BridgeBot
