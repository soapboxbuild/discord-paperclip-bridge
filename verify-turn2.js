// Stage-1b: the confirmation turn. After Earl asks "the JPMAM deck, to June 20?",
// does "yes" trigger the WORK path (Tier-2)? No Discord writes.
const fs = require('fs')
for (const line of fs.readFileSync(process.argv[2], 'utf8').split('\n')) {
  const i = line.indexOf('=')
  if (i > 0) process.env[line.slice(0, i)] = line.slice(i + 1)
}
const HaikuResponder = require('./src/HaikuResponder')
const EARL = process.env.EARL_AGENT_ID || '97d41ad6-1ece-4870-92cb-0ae121c2eeb8'

const channelHistory = [
  { author: 'Earl', content: 'PM check-in: JPMAM — 4TH AND MADISON DECK was due today at 10:30 AM PDT and remains in Data Collection in our tracker — no completion evidence found. Still flagged At Risk. Christopher — please advise on status or mark as delivered.' },
  { author: 'christopher_soapbox', content: 'Move to tomorrow' },
  { author: 'Earl', content: 'I need clarification: do you want to move the JPMAM — 4TH AND MADISON DECK deadline to tomorrow (June 20)? Once you confirm, I can update the tracker.' },
]

async function run(label, userMessage) {
  const r = new HaikuResponder({
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    hindsightApiKey: process.env.HINDSIGHT_API_KEY,
    paperclipApiKey: process.env.PAPERCLIP_BOARD_API_KEY || process.env.PAPERCLIP_API_KEY,
  })
  const res = await r.respond({
    agentId: EARL, agentName: 'JPMAM', userMessage,
    channelId: '1516986453517926541', window: [], hindsightSummary: '', channelHistory,
  })
  console.log(`\n===== ${label}: "${userMessage}" =====`)
  console.log('needsWork:', res.needsWork)
  if (res.needsWork) console.log('workDescription:', res.workDescription)
  console.log('reply:', res.reply)
}

;(async () => {
  await run('confirmation', 'yes')
  await run('explicit confirmation', 'yes, move the deck deadline to June 20')
})().catch(e => { console.error('ERR', e); process.exit(1) })
