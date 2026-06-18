const { Client, GatewayIntentBits, Events } = require('discord.js')

/**
 * Handles approve/reject commands in #board-approvals.
 *
 * Approve triggers (case-insensitive, matched at start of message):
 *   yes, y, approve, approved, ok, sure, go ahead, looks good
 *
 * Reject triggers (case-insensitive, matched at start of message):
 *   no, n, reject, rejected, nope, not yet, hold on
 *
 * Commands supported:
 *   yes [note]               — approve single pending approval (most recent)
 *   no [note]                — reject single pending approval (most recent)
 *   yes 2 [- note]           — approve the 2nd pending approval by position
 *   no 1 - note              — reject the 1st with decisionNote
 *   approve <uuid> [- note]  — resolve by full approval ID
 *
 * When multiple approvals are pending and no position/ID is given, the bot
 * lists them numbered and waits for a targeted command.
 *
 * Bare yes/no resolves the MOST RECENTLY POSTED pending approval (index 0).
 * Pending approvals are always sorted most-recent-first.
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
      const approvals = await this.paperclip.getPendingApprovals()
      // Sort most-recent-first so index 0 is always the latest approval
      this.pendingApprovals = approvals.sort((a, b) => {
        const aTime = new Date(a.createdAt).getTime()
        const bTime = new Date(b.createdAt).getTime()
        return bTime - aTime
      })
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

    // Multi-word triggers listed before single-word ones to prevent partial matches
    const approveTriggers = ['go ahead', 'looks good', 'approved', 'approve', 'yes', 'y', 'ok', 'sure']
    const rejectTriggers = ['not yet', 'hold on', 'rejected', 'reject', 'nope', 'no', 'n']

    let action, rest

    for (const trigger of approveTriggers) {
      if (lower === trigger || lower.startsWith(trigger + ' ') || lower.startsWith(trigger + '-')) {
        action = 'approve'
        rest = trimmed.slice(trigger.length).trim()
        break
      }
    }

    if (!action) {
      for (const trigger of rejectTriggers) {
        if (lower === trigger || lower.startsWith(trigger + ' ') || lower.startsWith(trigger + '-')) {
          action = 'reject'
          rest = trimmed.slice(trigger.length).trim()
          break
        }
      }
    }

    if (!action) return null

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
    // Strip a leading "- " separator so "yes - looks great" → note "looks great"
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
        const yesWord = action === 'approve' ? 'yes' : 'no'
        await msg.reply(
          `There are **${this.pendingApprovals.length}** pending approvals (newest first):\n${list}\n\n` +
          `Reply with \`${yesWord} 1\` or \`${yesWord} 2 - your note\` to target a specific one.`
        )
        return
      }
      targetIndex = 0
    }

    const approval = this.pendingApprovals[targetIndex]
    const title = this._approvalTitle(approval)

    // Immediate ack before resolving
    const noteClause = note ? ` with note: "${note}"` : ''
    const ackText = action === 'approve'
      ? `✅ Got it — approved${noteClause}. Sophie is on it.`
      : `❌ Got it — rejected${noteClause}. Sophie is on it.`
    await msg.reply(ackText)

    try {
      if (action === 'approve') {
        await this.paperclip.approveApproval(approval.id, note)
      } else {
        await this.paperclip.rejectApproval(approval.id, note)
      }
      this.pendingApprovals.splice(targetIndex, 1)
      await this.paperclip.wakeupAgent('573ff2a4-0623-4fcd-ac8e-51d7b11d29c8').catch(err => {
        console.error('[board-approvals] Failed to wake Sophie:', err.message)
      })
    } catch (err) {
      console.error(`[board-approvals] Failed to ${action} approval ${approval.id}:`, err.message)
      await msg.reply(`⚠️ Failed to ${action}: ${err.message}`)
    }
  }
}

module.exports = ApprovalBot
