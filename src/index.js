const config = require('./config')
const PaperclipClient = require('./PaperclipClient')
const BridgeBot = require('./BridgeBot')
const ApprovalBot = require('./ApprovalBot')
const GatewayListener = require('./GatewayListener')

async function main() {
  console.log('Starting Discord ↔ Paperclip bridge...')

  const hasGateway = !!config.gatewayListener
  const hasLegacyBots = config.bots.length > 0 || !!config.approvalBot

  if (!hasGateway && !hasLegacyBots) {
    console.error('No bots configured. Set DISCORD_BOT_TOKEN_SOPHIE in .env (or legacy SOPHIE_DISCORD_TOKEN / BOARD_DISCORD_TOKEN).')
    process.exit(1)
  }

  const paperclip = new PaperclipClient(config.paperclip)

  // ── GatewayListener: single-token multi-channel routing (SOA-306) ────────
  if (hasGateway) {
    const approvalPaperclip = new PaperclipClient({
      ...config.paperclip,
      apiKey: config.gatewayListener.boardApiKey,
    })
    const listener = new GatewayListener({
      token: config.gatewayListener.token,
      channelRoutes: config.gatewayListener.channelRoutes,
      dmAgentId: config.gatewayListener.dmAgentId,
      boardApprovalsChannelId: config.gatewayListener.boardApprovalsChannelId,
      paperclip,
      approvalPaperclip,
      conversationConfig: config.conversation,
    })
    try {
      await listener.start()
      console.log('[gateway] Gateway listener started (Sophie + Earl + board-approvals)')
    } catch (err) {
      console.error('[gateway] Failed to start gateway listener:', err.message)
      process.exit(1)
    }
  }

  // ── Legacy per-bot approach (used when DISCORD_BOT_TOKEN_SOPHIE is absent) ─
  if (!hasGateway) {
    const bots = config.bots.map(botConfig => new BridgeBot({
      ...botConfig,
      paperclip,
      conversationConfig: config.conversation,
    }))

    await Promise.all(bots.map(async bot => {
      try {
        await bot.start()
        const channelInfo = bot.channelId ? `, listening on channel ${bot.channelId}` : ', DM-only mode'
        console.log(`[${bot.name}] Bot started${channelInfo}`)
      } catch (err) {
        console.error(`[${bot.name}] Failed to start:`, err.message)
      }
    }))

    if (config.approvalBot) {
      const boardPaperclip = new PaperclipClient({
        ...config.paperclip,
        apiKey: config.approvalBot.boardApiKey,
      })
      const approvalBot = new ApprovalBot({
        token: config.approvalBot.token,
        channelId: config.approvalBot.channelId,
        paperclip: boardPaperclip,
      })
      try {
        await approvalBot.start()
        console.log(`[board-approvals] Bot started, listening on channel ${config.approvalBot.channelId}`)
      } catch (err) {
        console.error(`[board-approvals] Failed to start:`, err.message)
      }
    }

    console.log(`Bridge running with ${config.bots.length} legacy bot(s)${config.approvalBot ? ' + approval bot' : ''}.`)
  }
}

main().catch(err => {
  console.error('Fatal startup error:', err)
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason)
})
