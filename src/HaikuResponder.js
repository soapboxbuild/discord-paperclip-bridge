const Anthropic = require('@anthropic-ai/sdk')
const fs = require('fs')
const path = require('path')

const AGENTS_BASE = '/paperclip/instances/default/companies/bca4541f-fc58-48ce-84f0-7fa71df7c67c/agents'
const HINDSIGHT_URL = 'https://agent-memory.soapbox.build/mcp'

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
  const base = path.join(AGENTS_BASE, agentId, 'instructions')

  let identityContent = ''
  try {
    identityContent = fs.readFileSync(path.join(base, 'IDENTITY.md'), 'utf8')
  } catch {
    // no IDENTITY.md — degrade gracefully
  }

  let agentsContent = ''
  try {
    agentsContent = fs.readFileSync(path.join(base, 'AGENTS.md'), 'utf8').slice(0, 1000)
  } catch {
    // no AGENTS.md
  }

  if (!identityContent && !agentsContent) {
    return `You are ${agentName}, an AI agent at Soapbox.`
  }

  return (identityContent + agentsContent).slice(0, 2000)
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
  async recallConversationSummary(channelId) {
    const data = await hindsightCall('recall', { query: `conversation_summary_${channelId}` }, this.hindsightApiKey)
    return data ? extractText(data, 300) : ''
  }

  /**
   * Persist the rolling conversation summary for a channel to Hindsight.
   */
  async storeConversationSummary(channelId, summary) {
    await hindsightCall('sync_retain', { key: `conversation_summary_${channelId}`, content: summary }, this.hindsightApiKey)
  }

  /**
   * Summarise a single dropped exchange in 1-2 sentences, append to the existing
   * summary, persist to Hindsight, and return the new summary string.
   */
  async appendToSummary(channelId, droppedPair, existingSummary) {
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

    await this.storeConversationSummary(channelId, newSummary)
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
