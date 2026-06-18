require('dotenv').config()

function required(name) {
  const val = process.env[name]
  if (!val) throw new Error(`Missing required env var: ${name}`)
  return val
}

function optional(name, fallback = null) {
  return process.env[name] || fallback
}

module.exports = {
  paperclip: {
    apiUrl: optional('PAPERCLIP_API_URL', 'https://org.soapbox.build'),
    apiKey: required('PAPERCLIP_API_KEY'),
    companyId: required('PAPERCLIP_COMPANY_ID'),
  },

  // ── Gateway listener (SOA-306) ──────────────────────────────────────────────
  // Single Discord client using DISCORD_BOT_TOKEN_SOPHIE. Routes DMs to Sophie,
  // #sophie and #earl-assistant to their respective agents, and #board-approvals
  // to the inline approval handler. Preferred over the legacy per-bot approach.
  gatewayListener: optional('DISCORD_BOT_TOKEN_SOPHIE') ? {
    token: optional('DISCORD_BOT_TOKEN_SOPHIE'),
    dmAgentId: optional('SOPHIE_AGENT_ID', '573ff2a4-0623-4fcd-ac8e-51d7b11d29c8'),
    boardApprovalsChannelId: optional('BOARD_APPROVALS_CHANNEL_ID', '1516994726320930836'),
    channelRoutes: {
      [optional('SOPHIE_CHANNEL_ID') || '1516986529162072208']: {
        agentId: optional('SOPHIE_AGENT_ID') || '573ff2a4-0623-4fcd-ac8e-51d7b11d29c8',
        name: 'Sophie',
      },
      [optional('EARL_CHANNEL_ID') || '1516986742035447829']: {
        agentId: optional('EARL_AGENT_ID') || '97d41ad6-1ece-4870-92cb-0ae121c2eeb8',
        name: 'Earl',
      },
    },
    boardApiKey: optional('PAPERCLIP_BOARD_API_KEY') || required('PAPERCLIP_API_KEY'),
  } : null,

  // ── Legacy per-bot approach (kept for backward compatibility) ────────────
  // Used when DISCORD_BOT_TOKEN_SOPHIE is absent but SOPHIE_DISCORD_TOKEN is set.
  // Approval bot for #board-approvals — handles approve/reject commands from Christopher.
  approvalBot: optional('BOARD_DISCORD_TOKEN') ? {
    token: optional('BOARD_DISCORD_TOKEN'),
    channelId: optional('BOARD_APPROVALS_CHANNEL_ID', '1516994726320930836'),
    boardApiKey: optional('PAPERCLIP_BOARD_API_KEY') || required('PAPERCLIP_API_KEY'),
  } : null,

  // One entry per legacy bot. Only used when gatewayListener is not configured.
  bots: [
    {
      name: 'sophie',
      token: optional('SOPHIE_DISCORD_TOKEN'),
      channelId: optional('SOPHIE_CHANNEL_ID'),
      agentId: optional('SOPHIE_AGENT_ID', '573ff2a4-0623-4fcd-ac8e-51d7b11d29c8'),
      displayName: 'Sophie',
    },
  ].filter(b => b.token),

  // Conversation management
  conversation: {
    // Minutes before an idle conversation is closed and a new task is created
    expiryMinutes: parseInt(optional('CONVERSATION_EXPIRY_MINUTES', '30'), 10),
    // Seconds between polls for agent response
    pollIntervalSeconds: parseInt(optional('POLL_INTERVAL_SECONDS', '5'), 10),
    // Maximum seconds to wait for an agent response before posting a timeout
    pollTimeoutSeconds: parseInt(optional('POLL_TIMEOUT_SECONDS', '300'), 10),
  },
}
