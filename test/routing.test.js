const { test } = require('node:test')
const assert = require('node:assert')
const { ChannelType } = require('discord.js')
const GatewayListener = require('../src/GatewayListener')

const SOPHIE_TOKEN = 'sophie-gateway-token'
const EARL_TOKEN = 'earl-bot-token'
const EARL_AGENT = 'earl-agent-id'
const SOPHIE_AGENT = 'sophie-agent-id'
const JPMAM_CHANNEL = '1516986453517926541'

function makeListener({ haikuResult }) {
  const haikuCalls = []
  const haikuResponder = {
    async respond(opts) { haikuCalls.push(opts); return haikuResult },
    async recallConversationSummary() { return '' },
    async appendToSummary(_c, _d, existing) { return existing },
  }
  const listener = new GatewayListener({
    token: SOPHIE_TOKEN,
    channelRoutes: {
      [JPMAM_CHANNEL]: { agentId: EARL_AGENT, token: EARL_TOKEN, name: 'JPMAM' },
    },
    dmAgentId: SOPHIE_AGENT,
    boardApprovalsChannelId: 'approvals-channel',
    paperclip: {},
    approvalPaperclip: {},
    conversationConfig: { expiryMinutes: 30, pollIntervalSeconds: 5, pollTimeoutSeconds: 300 },
    haikuResponder,
  })

  // Record every outbound send / typing instead of hitting Discord.
  const sends = []
  listener._sendAs = async (channelId, content, replyToMsgId, botToken) => {
    sends.push({ channelId, content, replyToMsgId, botToken })
  }
  const typing = []
  listener._typingAs = async (channelId, botToken) => { typing.push({ channelId, botToken }) }
  return { listener, sends, haikuCalls, typing }
}

// Fake the recent channel history that messages.fetch() would return,
// including Earl's prior check-in (a bot post the Haiku window never captures).
function fakeChannel(triggerId) {
  const history = new Map([
    ['m1', { id: 'm1', createdTimestamp: 1, author: { username: 'Earl' }, content: 'PM check-in: JPMAM — 4TH AND MADISON DECK was due today. Please advise or mark as delivered.' }],
    [triggerId, { id: triggerId, createdTimestamp: 2, author: { username: 'christopher_soapbox' }, content: 'Move to tomorrow' }],
  ])
  return {
    type: ChannelType.GuildText,
    sendTyping: async () => {},
    messages: { fetch: async () => history },
  }
}

function makeMsg(channelId, content) {
  const id = 'trigger-msg'
  return {
    id,
    channelId,
    content,
    author: { bot: false, id: 'christopher', username: 'christopher_soapbox' },
    guild: { id: 'guild' },
    channel: fakeChannel(id),
  }
}

test('routed customer channel replies with the routed agent\'s token (Earl, not Sophie)', async () => {
  const { listener, sends, typing } = makeListener({ haikuResult: { needsWork: false, reply: 'On it — moving the deck to tomorrow.' } })
  await listener._onMessage(makeMsg(JPMAM_CHANNEL, 'Move to tomorrow'))

  assert.equal(sends.length, 1, 'exactly one reply sent')
  assert.equal(sends[0].botToken, EARL_TOKEN, 'reply must use Earl\'s bot token, not the gateway/Sophie token')
  assert.equal(sends[0].channelId, JPMAM_CHANNEL)
  assert.equal(sends[0].replyToMsgId, 'trigger-msg', 'first chunk is a reply to the triggering message')
  assert.equal(typing[0]?.botToken, EARL_TOKEN, 'typing indicator must show as Earl, not Sophie')
})

test('Haiku receives recent channel history including the agent\'s own check-in', async () => {
  const { listener, haikuCalls } = makeListener({ haikuResult: { needsWork: false, reply: 'ok' } })
  await listener._onMessage(makeMsg(JPMAM_CHANNEL, 'Move to tomorrow'))

  assert.equal(haikuCalls.length, 1)
  const { channelHistory, agentId } = haikuCalls[0]
  assert.equal(agentId, EARL_AGENT, 'routed to Earl\'s agent id')
  assert.ok(Array.isArray(channelHistory) && channelHistory.length >= 1, 'channel history passed to Haiku')
  assert.ok(
    channelHistory.some(m => m.author === 'Earl' && /MADISON DECK/.test(m.content)),
    'Earl\'s check-in is included so "move to tomorrow" can be resolved',
  )
  assert.ok(!channelHistory.some(m => m.content === 'Move to tomorrow'), 'the triggering message is excluded from history')
})

test('work-needed in a customer channel posts the confirmation as Earl', async () => {
  const { listener, sends } = makeListener({ haikuResult: { needsWork: true, workDescription: 'move the deck due date to tomorrow', reply: 'Got it.' } })
  listener.paperclip = {
    createWorkTask: async () => ({ identifier: 'PRJ-3-9' }),
    wakeupAgent: async () => {},
  }
  await listener._onMessage(makeMsg(JPMAM_CHANNEL, 'Move to tomorrow'))

  assert.equal(sends.length, 1)
  assert.equal(sends[0].botToken, EARL_TOKEN, 'Tier-2 confirmation also posts as Earl')
  assert.match(sends[0].content, /kicked off/)
})

test('DMs still use the gateway (Sophie) token — no regression', async () => {
  const { listener, sends } = makeListener({ haikuResult: { needsWork: false, reply: 'hi' } })
  const dm = {
    id: 'dm-msg', channelId: 'dm-1', content: 'hello',
    author: { bot: false, id: 'christopher', username: 'christopher_soapbox' },
    guild: null,
    channel: { type: ChannelType.DM, sendTyping: async () => {}, messages: { fetch: async () => new Map() } },
  }
  await listener._onMessage(dm)

  assert.equal(sends.length, 1)
  assert.equal(sends[0].botToken, SOPHIE_TOKEN, 'DM reply uses the gateway/Sophie token')
})
