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

  // One entry per bot. Add new bots here as tokens become available (SOA-156).
  // Filter out entries without tokens so the service starts with whatever is configured.
  bots: [
    {
      name: 'sophie',
      token: optional('SOPHIE_DISCORD_TOKEN'),
      channelId: optional('SOPHIE_CHANNEL_ID'),
      agentId: optional('SOPHIE_AGENT_ID', '573ff2a4-0623-4fcd-ac8e-51d7b11d29c8'),
      displayName: 'Sophie',
    },
    // Future bots from SOA-156 — add env vars when tokens are provisioned:
    // { name: 'earl', token: optional('EARL_DISCORD_TOKEN'), channelId: optional('EARL_CHANNEL_ID'), agentId: optional('EARL_AGENT_ID'), displayName: 'Earl' },
  ].filter(b => b.token && b.channelId),

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
