const config = require('./config')
const PaperclipClient = require('./PaperclipClient')
const BridgeBot = require('./BridgeBot')

async function main() {
  console.log('Starting Discord ↔ Paperclip bridge...')

  if (config.bots.length === 0) {
    console.error('No bots configured. Set SOPHIE_DISCORD_TOKEN and SOPHIE_CHANNEL_ID in .env')
    process.exit(1)
  }

  const paperclip = new PaperclipClient(config.paperclip)

  const bots = config.bots.map(botConfig => new BridgeBot({
    ...botConfig,
    paperclip,
    conversationConfig: config.conversation,
  }))

  await Promise.all(bots.map(async bot => {
    try {
      await bot.start()
      console.log(`[${bot.name}] Bot started, listening on channel ${bot.channelId}`)
    } catch (err) {
      console.error(`[${bot.name}] Failed to start:`, err.message)
      // Don't crash the whole process — other bots can still run
    }
  }))

  console.log(`Bridge running with ${bots.length} bot(s).`)
}

main().catch(err => {
  console.error('Fatal startup error:', err)
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason)
})
