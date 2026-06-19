const Anthropic = require('@anthropic-ai/sdk')
const fs = require('fs')
const path = require('path')

const AGENTS_BASE = '/paperclip/instances/default/companies/bca4541f-fc58-48ce-84f0-7fa71df7c67c/agents'
const HINDSIGHT_URL = 'https://agent-memory.soapbox.build/mcp'
const INSTRUCTIONS_CACHE_TTL_MS = 60_000

// Ordered list of files to load; any other .md files are appended alphabetically
const PRIORITY_FILES = ['IDENTITY.md', 'AGENTS.md', 'PERMISSIONS.md', 'TOOLS.md', 'NOTION_DATABASES.md']
// 3000 tokens × ~4 chars/token
const MAX_PROMPT_CHARS = 12_000
// Minimum chars of AGENTS.md always preserved even under budget pressure
const AGENTS_MIN_CHARS = 500

// { agentId -> { content: string, expiresAt: number } }
const instructionsCache = new Map()

async function hindsightCall(method, args, apiKey) {
  if (!apiKey) return null
  try {
    const res = await fetch(HINDSIGHT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        method: 'tools/call',
        params: { name: method, arguments: { bank_id: 'soapbox', ...args } },
      }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

function extractText(data, maxLen) {
  const content = data?.result?.content
  if (!Array.isArray(content)) return ''
  return content.filter(c => c.type === 'text').map(c => c.text || '').join('\n').slice(0, maxLen)
}

function loadAgentSystemPrompt(agentId, agentName) {
  const now = Date.now()
  const cached = instructionsCache.get(agentId)
  if (cached && now < cached.expiresAt) {
    return cached.content
  }

  const base = path.join(AGENTS_BASE, agentId, 'instructions')

  // Read priority files
  const fileContents = {}
  for (const fname of PRIORITY_FILES) {
    try {
      fileContents[fname] = fs.readFileSync(path.join(base, fname), 'utf8')
    } catch {
      fileContents[fname] = ''
    }
  }

  // Read any other .md files alphabetically
  let extraFiles = []
  try {
    const allFiles = fs.readdirSync(base)
    extraFiles = allFiles
      .filter(f => f.endsWith('.md') && !PRIORITY_FILES.includes(f))
      .sort()
      .map(f => { try { return fs.readFileSync(path.join(base, f), 'utf8') } catch { return '' } })
      .filter(s => s.length > 0)
  } catch {
    // directory not readable
  }

  const identity = fileContents['IDENTITY.md']
  const agents = fileContents['AGENTS.md']

  if (!identity && !agents && extraFiles.length === 0) {
    const fallback = `You are ${agentName}, an AI agent at Soapbox.`
    instructionsCache.set(agentId, { content: fallback, expiresAt: now + INSTRUCTIONS_CACHE_TTL_MS })
    return fallback
  }

  // Fixed parts (everything except AGENTS.md): always included in full
  const fixedParts = [
    fileContents['PERMISSIONS.md'],
    fileContents['TOOLS.md'],
    fileContents['NOTION_DATABASES.md'],
    ...extraFiles,
  ].filter(s => s.length > 0)

  // Budget for AGENTS.md = MAX_PROMPT_CHARS minus identity and fixed parts (with separators)
  const separatorCost = fixedParts.length * 2  // '\n\n' per part
  const fixedLength = identity.length + separatorCost + fixedParts.reduce((sum, s) => sum + s.length, 0)
  const agentsBudget = Math.max(AGENTS_MIN_CHARS, MAX_PROMPT_CHARS - fixedLength)
  const agentsTruncated = agents.slice(0, agentsBudget)

  // Concatenate in canonical order: IDENTITY, AGENTS (truncated), then fixed parts
  const allParts = [identity, agentsTruncated, ...fixedParts].filter(s => s.length > 0)
  const content = allParts.join('\n\n').slice(0, MAX_PROMPT_CHARS)

  instructionsCache.set(agentId, { content, expiresAt: now + INSTRUCTIONS_CACHE_TTL_MS })
  return content
}

class HaikuResponder {
  constructor({ anthropicApiKey, hindsightApiKey }) {
    this.client = new Anthropic({ apiKey: anthropicApiKey })
    this.hindsightApiKey = hindsightApiKey
  }

  /**
   * Fetch the stored conversation summary for a channel from Hindsight.
   * Returns '' if not found or on error.
   */
  async recallConversationSummary(channelId, agentId = null) {
    const query = agentId
      ? `discord_${agentId}_summary_${channelId}`
      : `conversation_summary_${channelId}`
    const data = await hindsightCall('recall', { query }, this.hindsightApiKey)
    return data ? extractText(data, 300) : ''
  }

  /**
   * Persist the rolling conversation summary for a channel to Hindsight.
   * Tags with agent_id so the Paperclip agent can recall Discord context on next task wake.
   */
  async storeConversationSummary(channelId, summary, agentId = null) {
    const key = agentId
      ? `discord_${agentId}_summary_${channelId}`
      : `conversation_summary_${channelId}`
    const args = { key, content: summary }
    if (agentId) args.tags = [`agent_id:${agentId}`]
    await hindsightCall('sync_retain', args, this.hindsightApiKey)
  }

  /**
   * Summarise a single dropped exchange in 1-2 sentences, append to the existing
   * summary, persist to Hindsight, and return the new summary string.
   */
  async appendToSummary(channelId, droppedPair, existingSummary, agentId = null) {
    let exchangeSummary = ''
    try {
      const msg = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        system: 'Summarize the following exchange in 1-2 sentences, capturing key topics and decisions.',
        messages: [{ role: 'user', content: `User: ${droppedPair.user}\nAgent: ${droppedPair.agent}` }],
      })
      exchangeSummary = msg.content[0]?.text?.trim() || ''
    } catch (err) {
      console.error('[HaikuResponder] Failed to summarize exchange:', err.message)
      return existingSummary
    }

    if (!exchangeSummary) return existingSummary

    const newSummary = existingSummary
      ? `${existingSummary}\n${exchangeSummary}`.slice(-1500)
      : exchangeSummary

    await this.storeConversationSummary(channelId, newSummary, agentId)
    return newSummary
  }

  /**
   * Generate a Haiku reply for an incoming message.
   *
   * @param {object} opts
   * @param {string} opts.agentId
   * @param {string} opts.agentName
   * @param {string} opts.userMessage
   * @param {string} [opts.channelId]
   * @param {Array<{user:string,agent:string}>} [opts.window] last N message pairs
   * @param {string} [opts.hindsightSummary] earlier-conversation summary from Hindsight
   */
  async respond({ agentId, agentName, userMessage, channelId = null, window = [], hindsightSummary = '' }) {
    const [systemBase, hindsightCtx] = await Promise.all([
      Promise.resolve(loadAgentSystemPrompt(agentId, agentName)),
      hindsightCall('recall', { query: userMessage }, this.hindsightApiKey).then(d => d ? extractText(d, 1200) : ''),
    ])

    const parts = [systemBase]

    if (hindsightCtx) {
      parts.push(`\n\nHindsight context:\n${hindsightCtx}`)
    }

    if (hindsightSummary) {
      parts.push(`\n\nEarlier in this conversation:\n${hindsightSummary.slice(0, 300)}`)
    }

    if (window.length > 0) {
      const historyLines = window.map(p => `Christopher: ${p.user}\n${agentName}: ${p.agent}`).join('\n')
      parts.push(`\n\nRecent conversation:\n${historyLines}`)
    }

    parts.push(
      '\n\nYou are responding to a Discord message from Christopher. Be concise and direct.',
      ' If you need to create a task, do work, run code, or take any action beyond a conversational reply,',
      ' end your response with exactly: [WORK_NEEDED] followed by a one-sentence description of the work to initiate.',
    )

    const msg = await this.client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: parts.join(''),
      messages: [{ role: 'user', content: userMessage }],
    })

    const text = msg.content[0]?.text || ''
    const workMatch = text.match(/\[WORK_NEEDED\]\s*([\s\S]*)$/)
    if (workMatch) {
      return {
        needsWork: true,
        workDescription: workMatch[1].trim(),
        reply: text.replace(/\[WORK_NEEDED\][\s\S]*$/, '').trim(),
      }
    }
    return { needsWork: false, reply: text.trim() }
  }
}

module.exports = HaikuResponder
