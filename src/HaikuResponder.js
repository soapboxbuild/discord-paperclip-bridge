const Anthropic = require('@anthropic-ai/sdk')
const fs = require('fs')
const path = require('path')

const AGENTS_BASE = '/paperclip/instances/default/companies/bca4541f-fc58-48ce-84f0-7fa71df7c67c/agents'
const HINDSIGHT_URL = 'https://agent-memory.soapbox.build/mcp'

async function recallHindsight(query, apiKey) {
  try {
    const res = await fetch(HINDSIGHT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        method: 'tools/call',
        params: { name: 'recall', arguments: { query, bank_id: 'soapbox' } },
      }),
    })
    if (!res.ok) return ''
    const data = await res.json()
    const text = data?.result?.content?.[0]?.text || ''
    return text.slice(0, 1200)
  } catch {
    return ''
  }
}

function loadAgentSystemPrompt(agentId, agentName) {
  try {
    const p = path.join(AGENTS_BASE, agentId, 'instructions', 'AGENTS.md')
    const content = fs.readFileSync(p, 'utf8')
    return content.slice(0, 2000)
  } catch {
    return `You are ${agentName}, an AI agent at Soapbox.`
  }
}

class HaikuResponder {
  constructor({ anthropicApiKey, hindsightApiKey }) {
    this.client = new Anthropic({ apiKey: anthropicApiKey })
    this.hindsightApiKey = hindsightApiKey
  }

  async respond({ agentId, agentName, userMessage }) {
    const [systemBase, hindsightCtx] = await Promise.all([
      Promise.resolve(loadAgentSystemPrompt(agentId, agentName)),
      recallHindsight(userMessage, this.hindsightApiKey),
    ])

    const systemPrompt = [
      systemBase,
      hindsightCtx ? `\n\n## Recent context from team memory:\n${hindsightCtx}` : '',
      '\n\nYou are responding to a Discord message from Christopher. Be concise and direct.',
      ' If you need to create a task, do work, run code, or take any action beyond a conversational reply,',
      ' end your response with exactly: [WORK_NEEDED] followed by a one-sentence description of the work to initiate.',
    ].join('')

    const msg = await this.client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: systemPrompt,
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
