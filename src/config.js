require('dotenv').config()

function required(name) {
  const val = process.env[name]
  if (!val) throw new Error(`Missing required env var: ${name}`)
  return val
}

function optional(name, fallback = null) {
  return process.env[name] || fallback
}


/**
 * Fetch all text channels in the Customers Discord category and add them as Earl routes.
 * Called at startup so new customers Earl creates are automatically included.
 */
async function fetchCustomerChannelRoutes(sophieToken, guildId, customersCategoryId, earlAgentId, earlToken) {
  try {
    const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
      headers: { Authorization: `Bot ${sophieToken}` }
    })
    if (!res.ok) return {}
    const channels = await res.json()
    const routes = {}
    for (const ch of channels) {
      if (ch.type === 0 && ch.parent_id === customersCategoryId) {
        routes[ch.id] = { agentId: earlAgentId, token: earlToken, name: ch.name }
      }
    }
    console.log(`[config] Discovered ${Object.keys(routes).length} customer channels for Earl`)
    return routes
  } catch (err) {
    console.error('[config] Failed to fetch customer channels:', err.message)
    return {}
  }
}

module.exports = {
  paperclip: {
    apiUrl: optional('PAPERCLIP_API_URL', 'https://org.soapbox.build'),
    apiKey: required('PAPERCLIP_API_KEY'),
    companyId: required('PAPERCLIP_COMPANY_ID'),
  },

  // ── Gateway listener (SOA-306, updated SOA-372) ─────────────────────────────
  // Sophie's token only. Routes DMs to Sophie, #sophie-ceo to Sophie, and
  // #board-approvals to the inline approval handler.
  // Angie/Earl/Paradh now use dedicated BridgeBot instances (see perAgentBots).
  gatewayListener: optional('DISCORD_BOT_TOKEN_SOPHIE') ? {
    token: optional('DISCORD_BOT_TOKEN_SOPHIE'),
    dmAgentId: optional('SOPHIE_AGENT_ID', '573ff2a4-0623-4fcd-ac8e-51d7b11d29c8'),
    boardApprovalsChannelId: optional('BOARD_APPROVALS_CHANNEL_ID', '1516994726320930836'),
    channelRoutes: {
      [optional('CHANNEL_1517198555922563082') || '1517198555922563082']: {
        agentId: '97d41ad6-1ece-4870-92cb-0ae121c2eeb8',
        token: optional('EARL_BOT_TOKEN'),
        name: 'AvalonBay',
      },
      [optional('CHANNEL_1517198550759506072') || '1517198550759506072']: {
        agentId: '97d41ad6-1ece-4870-92cb-0ae121c2eeb8',
        token: optional('EARL_BOT_TOKEN'),
        name: 'Calgary Board of Education',
      },
      [optional('CHANNEL_1516986450548232213') || '1516986450548232213']: {
        agentId: '97d41ad6-1ece-4870-92cb-0ae121c2eeb8',
        token: optional('EARL_BOT_TOKEN'),
        name: 'Clarion Partners',
      },
      [optional('CHANNEL_1517198525341896734') || '1517198525341896734']: {
        agentId: '97d41ad6-1ece-4870-92cb-0ae121c2eeb8',
        token: optional('EARL_BOT_TOKEN'),
        name: 'Cortland',
      },
      [optional('CHANNEL_1517198513325478029') || '1517198513325478029']: {
        agentId: '97d41ad6-1ece-4870-92cb-0ae121c2eeb8',
        token: optional('EARL_BOT_TOKEN'),
        name: 'Greystar',
      },
      [optional('CHANNEL_1517198538940088462') || '1517198538940088462']: {
        agentId: '97d41ad6-1ece-4870-92cb-0ae121c2eeb8',
        token: optional('EARL_BOT_TOKEN'),
        name: 'Jonathan Rose',
      },
      [optional('CHANNEL_1516986453517926541') || '1516986453517926541']: {
        agentId: '97d41ad6-1ece-4870-92cb-0ae121c2eeb8',
        token: optional('EARL_BOT_TOKEN'),
        name: 'JPMAM',
      },
      [optional('CHANNEL_1517198533504270376') || '1517198533504270376']: {
        agentId: '97d41ad6-1ece-4870-92cb-0ae121c2eeb8',
        token: optional('EARL_BOT_TOKEN'),
        name: 'Kennedy Wilson',
      },
      [optional('CHANNEL_1517198545021698048') || '1517198545021698048']: {
        agentId: '97d41ad6-1ece-4870-92cb-0ae121c2eeb8',
        token: optional('EARL_BOT_TOKEN'),
        name: 'Schneider Electric',
      },
      [optional('CHANNEL_1516986451684888639') || '1516986451684888639']: {
        agentId: '97d41ad6-1ece-4870-92cb-0ae121c2eeb8',
        token: optional('EARL_BOT_TOKEN'),
        name: 'Stoneweg',
      },
      [optional('CHANNEL_1517198519860072539') || '1517198519860072539']: {
        agentId: '97d41ad6-1ece-4870-92cb-0ae121c2eeb8',
        token: optional('EARL_BOT_TOKEN'),
        name: 'Tishman',
      },
      [optional('CHANNEL_1517031349389885473') || '1517031349389885473']: {
        agentId: '97d41ad6-1ece-4870-92cb-0ae121c2eeb8',
        token: optional('EARL_BOT_TOKEN'),
        name: 'UDR',
      },

      [optional('MONET_CHANNEL_ID') || '1517555043363061854']: {
        agentId: optional('MONET_AGENT_ID') || 'd18113b6-de86-4fa7-8709-b7448504d3c9',
        token: optional('MONET_BOT_TOKEN'),
        name: 'Monet',
      },
      [optional('DEVI_CHANNEL_ID') || '1517556376426119168']: {
        agentId: optional('DEVI_AGENT_ID') || '2cd583a6-4b6c-4043-94ae-cc6794493c56',
        token: optional('DEVI_BOT_TOKEN'),
        name: 'Devi',
      },
      [optional('DESI_CHANNEL_ID') || '1517369742569115778']: {
        agentId: optional('DESI_AGENT_ID') || 'a76788fe-f9fb-4b60-9a95-d5bc2079bb58',
        token: optional('DESI_BOT_TOKEN'),
        name: 'Desi',
      },
      [optional('SOPHIE_CHANNEL_ID' || '1516986529162072208']: {
        agentId: optional('SOPHIE_AGENT_ID') || '573ff2a4-0623-4fcd-ac8e-51d7b11d29c8',
        token: optional('DISCORD_BOT_TOKEN_SOPHIE'),
        name: 'Sophie',
      },
    },
    boardApiKey: optional('PAPERCLIP_BOARD_API_KEY') || required('PAPERCLIP_API_KEY'),
  } : null,

  // ── Per-agent channel bots (SOA-372) ─────────────────────────────────────
  // Each agent gets their own BridgeBot using their own bot token, listening
  // only to their dedicated channel. This ensures each agent responds with
  // their own Discord identity (bot name/avatar) rather than Sophie's.
  perAgentBots: [
    {
      name: 'angie',
      displayName: 'Angie',
      token: optional('ANGIE_BOT_TOKEN'),
      channelId: optional('ANGIE_CHANNEL_ID', '1517300227357409300'),
      agentId: optional('ANGIE_AGENT_ID', '2d259ea5-9446-4c5e-911d-bbe03ec532db'),
    },
    {
      name: 'earl',
      displayName: 'Earl',
      token: optional('EARL_BOT_TOKEN'),
      channelId: optional('EARL_CHANNEL_ID', '1516986742035447829'),
      agentId: optional('EARL_AGENT_ID', '97d41ad6-1ece-4870-92cb-0ae121c2eeb8'),
    },
    {
      name: 'paradh',
      displayName: 'Paradh',
      token: optional('PARADH_BOT_TOKEN'),
      channelId: optional('PARADH_CHANNEL_ID', '1517300899389903089'),
      agentId: optional('PARADH_AGENT_ID', 'defdd30b-a5cc-42db-82c2-0c39571e350a'),
    },
  ].filter(b => b.token),

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

  // ── Per-agent DM bots (SOA-156) ──────────────────────────────────────────
  // Each agent can have their own Discord bot for direct DMs from Christopher.
  // Set DISCORD_BOT_TOKEN_{NAME} to enable that agent's DM bot.
  // Sophie is excluded — her DMs are handled by the gateway listener above.
  dmBots: [
    { name: 'angie',  displayName: 'Angie',  agentId: '2d259ea5-9446-4c5e-911d-bbe03ec532db', token: optional('DISCORD_BOT_TOKEN_ANGIE') },
    { name: 'sakka',  displayName: 'Sakka',  agentId: 'c4aeda5e-6cc3-461a-bab8-503637daf97d', token: optional('DISCORD_BOT_TOKEN_SAKKA') },
    { name: 'earl',   displayName: 'Earl',   agentId: '97d41ad6-1ece-4870-92cb-0ae121c2eeb8', token: optional('DISCORD_BOT_TOKEN_EARL') },
    { name: 'finn',   displayName: 'Finn',   agentId: '0da30f03-b5c6-42ca-a841-f1851b23f7c3', token: optional('DISCORD_BOT_TOKEN_FINN') },
    { name: 'mike',   displayName: 'Mike',   agentId: 'a55656e7-5183-418f-ad1f-2323cd82dbb2', token: optional('DISCORD_BOT_TOKEN_MIKE') },
    { name: 'desi',   displayName: 'Desi',   agentId: 'a76788fe-f9fb-4b60-9a95-d5bc2079bb58', token: optional('DISCORD_BOT_TOKEN_DESI') },
    { name: 'ari',    displayName: 'Ari',    agentId: 'edae8ea0-df1b-4992-9117-ce1f5a3cf78e', token: optional('DISCORD_BOT_TOKEN_ARI') },
    { name: 'devi',   displayName: 'Devi',   agentId: '2cd583a6-4b6c-4043-94ae-cc6794493c56', token: optional('DISCORD_BOT_TOKEN_DEVI') },
    { name: 'monet',  displayName: 'Monet',  agentId: 'd18113b6-de86-4fa7-8709-b7448504d3c9', token: optional('DISCORD_BOT_TOKEN_MONET') },
    { name: 'paradh', displayName: 'Paradh', agentId: 'defdd30b-a5cc-42db-82c2-0c39571e350a', token: optional('DISCORD_BOT_TOKEN_PARADH') },
    { name: 'leon',   displayName: 'Leon',   agentId: 'ac30abc9-6dc3-426b-8726-23680a925450', token: optional('DISCORD_BOT_TOKEN_LEON') },
    { name: 'vera',   displayName: 'Vera',   agentId: '86b85112-3d7d-46b6-9d15-be9dbcfce31b', token: optional('DISCORD_BOT_TOKEN_VERA') },
  ].filter(b => b.token),

  // ── Haiku conversational tier (SOA-349) ──────────────────────────────────
  // When both keys are set, incoming Discord messages get a fast Haiku reply
  // instead of spinning up a full Paperclip agent run.
  haiku: {
    anthropicApiKey: optional('ANTHROPIC_API_KEY'),
    hindsightApiKey: optional('HINDSIGHT_API_KEY'),
    enabled: !!optional('ANTHROPIC_API_KEY'),
  },

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
module.exports.fetchCustomerChannelRoutes = fetchCustomerChannelRoutes
