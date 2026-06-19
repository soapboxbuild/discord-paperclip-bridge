const config = require('./config')
const PaperclipClient = require('./PaperclipClient')
const BridgeBot = require('./BridgeBot')
const ApprovalBot = require('./ApprovalBot')
const GatewayListener = require('./GatewayListener')
const HaikuResponder = require('./HaikuResponder')

async function main() {
  console.log('Starting Discord ↔ Paperclip bridge...')

  const hasGateway = !!config.gatewayListener
  const hasLegacyBots = config.bots.length > 0 || !!config.approvalBot
  const hasPerAgentBots = config.perAgentBots.length > 0

  if (!hasGateway && !hasLegacyBots && !hasPerAgentBots) {
    console.error('No bots configured. Set DISCORD_BOT_TOKEN_SOPHIE in .env (or legacy SOPHIE_DISCORD_TOKEN / BOARD_DISCORD_TOKEN).')
    process.exit(1)
  }

  const paperclip = new PaperclipClient(config.paperclip)

  const haikuResponder = config.haiku.enabled
    ? new HaikuResponder({
        anthropicApiKey: config.haiku.anthropicApiKey,
        hindsightApiKey: config.haiku.hindsightApiKey,
        paperclipApiKey: config.gatewayListener?.boardApiKey ?? config.paperclip.apiKey,
      })
    : null
  if (haikuResponder) {
    console.log('[haiku] HaikuResponder enabled' + (config.haiku.hindsightApiKey ? ' (with Hindsight)' : ' (no Hindsight key)'))
  }

  // ── GatewayListener: Sophie's token — DMs, #sophie-ceo, #board-approvals ──
  // Dynamically add all customer channels (Customers category) to Earl's routes
  if (config.gatewayListener) {
    const { fetchCustomerChannelRoutes } = require('./config')
    const customerRoutes = await fetchCustomerChannelRoutes(
      config.gatewayListener.token,
      process.env.GUILD_ID || '1513704643350233158',
      process.env.CUSTOMERS_CATEGORY_ID || '1516986449856172114',
      '97d41ad6-1ece-4870-92cb-0ae121c2eeb8',
      process.env.EARL_BOT_TOKEN
    )
    Object.assign(config.gatewayListener.channelRoutes, customerRoutes)
  }

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
      haikuResponder,
    })
    try {
      await listener.start()
      console.log('[gateway] Gateway listener started (Sophie + DMs + board-approvals)')
    } catch (err) {
      console.error('[gateway] Failed to start gateway listener:', err.message)
      process.exit(1)
    }
  }

  // ── Per-agent channel bots (SOA-372) ─────────────────────────────────────
  // Each agent uses their own bot token so they appear with their own
  // Discord identity (name/avatar) rather than Sophie's.
  if (hasPerAgentBots) {
    for (const botConfig of config.perAgentBots) {
      const bot = new BridgeBot({
        ...botConfig,
        paperclip,
        conversationConfig: config.conversation,
        haikuResponder,
      })
      try {
        await bot.start()
        console.log(`[${botConfig.name}] Channel bot started, listening on channel ${botConfig.channelId}`)
      } catch (err) {
        console.error(`[${botConfig.name}] Failed to start channel bot:`, err.message)
      }
    }
    console.log(`[channel-bots] ${config.perAgentBots.length} per-agent channel bot(s) started`)
  }

  // ── Per-agent DM bots (SOA-156) ─────────────────────────────────────────
  // Run alongside the gateway listener. Each agent's own bot routes DMs to that agent.
  if (config.dmBots.length > 0) {
    for (const botConfig of config.dmBots) {
      const bot = new BridgeBot({
        ...botConfig,
        channelId: null,
        paperclip,
        conversationConfig: config.conversation,
        haikuResponder,
      })
      try {
        await bot.start()
        console.log(`[${botConfig.name}] DM bot started`)
      } catch (err) {
        console.error(`[${botConfig.name}] Failed to start DM bot:`, err.message)
      }
    }
    console.log(`[dm-bots] ${config.dmBots.length} per-agent DM bot(s) started`)
  }

  // ── Legacy per-bot approach (used when DISCORD_BOT_TOKEN_SOPHIE is absent) ─
  if (!hasGateway) {
    const bots = config.bots.map(botConfig => new BridgeBot({
      ...botConfig,
      paperclip,
      conversationConfig: config.conversation,
      haikuResponder,
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
