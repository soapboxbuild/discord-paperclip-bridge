const { Client, GatewayIntentBits, Events } = require('discord.js')

/**
 * Handles approve/reject commands in #board-approvals.
 *
 * Commands supported:
 *   approve [note]           — approve single pending approval (optionally with note)
 *   reject [note]            — reject single pending approval
 *   approve 2 [- note]       — approve the 2nd pending approval by position
 *   reject 1 - note          — reject the 1st with decisionNote
 *   approve <uuid> [- note]  — resolve by full approval ID
 *
 * When multiple approvals are pending and no position/ID is given, the bot
 * lists them numbered and waits for a targeted command.
 */
class ApprovalBot {
  /**
   * @param {object} opts
   * @param {string} opts.token - Discord bot token
   * @param {string} opts.channelId - #board-approvals channel ID
   * @param {import('./PaperclipClient')} opts.paperclip - PaperclipClient instance (board API key)
   */
  constructor({ token, channelId, paperclip }) {
    this.token = token
    this.channelId = channelId
    this.paperclip = paperclip
    // In-memory ordered list, rebuilt on startup and refreshed before each command
    this.pendingApprovals = []

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    })

    this.client.once(Events.ClientReady, async (c) => {
      console.log(`[board-approvals] Logged in as ${c.user.tag}`)
      await this._refreshPendingApprovals()
    })

    this.client.on(Events.MessageCreate, (msg) => this._onMessage(msg).catch(err => {
      console.error(`[board-approvals] Error handling message:`, err)
    }))
  }

  async start() {
    await this.client.login(this.token)
  }

  _approvalTitle(approval) {
    return approval.payload?.title || approval.payload?.name || approval.id
  }

  async _refreshPendingApprovals() {
    try {
      this.pendingApprovals = await this.paperclip.getPendingApprovals()
      console.log(`[board-approvals] ${this.pendingApprovals.length} pending approval(s)`)
    } catch (err) {
      console.error(`[board-approvals] Failed to refresh pending approvals:`, err.message)
    }
  }

  /**
   * Parse an approve/reject command.
   * Returns null if the message is not a command.
   * Returns { action, index, idOrNull, note } where:
   *   - action: 'approve' | 'reject'
   *   - index: 0-based number, or null if not specified
   *   - idOrNull: approval UUID if specified, else null
   *   - note: optional decision note string
   */
  _parseCommand(text) {
    const trimmed = text.trim()
    const lower = trimmed.toLowerCase()

    let action, rest
    if (lower.startsWith('approve')) {
      action = 'approve'
      rest = trimmed.slice(7).trim()
    } else if (lower.startsWith('reject')) {
      action = 'reject'
      rest = trimmed.slice(6).trim()
    } else {
      return null
    }

    // Leading number: "2", "2 - note", "2 note"
    const numberPrefix = rest.match(/^(\d+)(?:\s*-\s*|\s+)(.+)$/)
    const bareNumber = rest.match(/^(\d+)$/)
    // UUID: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" optionally followed by " - note" or " note"
    const uuidPrefix = rest.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\s*-\s*|\s+)?(.*)$/i)

    if (numberPrefix) {
      return { action, index: parseInt(numberPrefix[1], 10) - 1, idOrNull: null, note: numberPrefix[2].trim() }
    }
    if (bareNumber) {
      return { action, index: parseInt(bareNumber[1], 10) - 1, idOrNull: null, note: '' }
    }
    if (uuidPrefix) {
      return { action, index: null, idOrNull: uuidPrefix[1], note: (uuidPrefix[2] || '').trim() }
    }
    // No number/UUID — rest is a plain note for a single-approval context
    // Strip a leading "- " separator so "approve - looks good" → note "looks good"
    const note = rest.startsWith('- ') ? rest.slice(2).trim() : rest
    return { action, index: null, idOrNull: null, note }
  }

  async _onMessage(msg) {
    if (msg.channelId !== this.channelId) return
    if (msg.author.bot) return

    const parsed = this._parseCommand(msg.content)
    if (!parsed) return

    const { action, note } = parsed

    // Always refresh before resolving so positional index is accurate
    await this._refreshPendingApprovals()

    if (this.pendingApprovals.length === 0) {
      await msg.reply('There are no pending board approvals right now.')
      return
    }

    // Resolve target approval
    let targetIndex = null

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
      // No target specified
      if (this.pendingApprovals.length > 1) {
        const list = this.pendingApprovals
          .map((a, i) => `**${i + 1}.** ${this._approvalTitle(a)}`)
          .join('\n')
        await msg.reply(
          `There are **${this.pendingApprovals.length}** pending approvals:\n${list}\n\n` +
          `Reply with \`${action} 1\` or \`${action} 2 - your note\` to target a specific one.`
        )
        return
      }
      targetIndex = 0
    }

    const approval = this.pendingApprovals[targetIndex]
    const title = this._approvalTitle(approval)

    try {
      if (action === 'approve') {
        await this.paperclip.approveApproval(approval.id, note)
        await msg.reply(`✅ **Approved:** *${title}*${note ? ` — ${note}` : ''}`)
      } else {
        await this.paperclip.rejectApproval(approval.id, note)
        await msg.reply(`❌ **Rejected:** *${title}*${note ? ` — ${note}` : ''}`)
      }
      this.pendingApprovals.splice(targetIndex, 1)
    } catch (err) {
      console.error(`[board-approvals] Failed to ${action} approval ${approval.id}:`, err.message)
      await msg.reply(`⚠️ Failed to ${action}: ${err.message}`)
    }
  }
}

module.exports = ApprovalBot
