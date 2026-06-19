// Stage-1 live verification: real HaikuResponder, real Earl prompt + Hindsight,
// NO Discord writes. Compares old behavior (no channel history) vs the fix.
const fs = require('fs')
for (const line of fs.readFileSync(process.argv[2], 'utf8').split('\n')) {
  const i = line.indexOf('=')
  if (i > 0) process.env[line.slice(0, i)] = line.slice(i + 1)
}
const HaikuResponder = require('./src/HaikuResponder')

const EARL = process.env.EARL_AGENT_ID || '97d41ad6-1ece-4870-92cb-0ae121c2eeb8'

// The actual recent #jpmam messages (Earl's bot posts + the trigger).
const channelHistory = [
  { author: 'Sophie', content: 'Status update: JPMAM — 4TH AND MADISON DECK (PRJ-3) is currently in Data Collection and due tomorrow, June 19. We are on track.' },
  { author: 'Earl', content: "Heads up: JPMAM — 4TH AND MADISON DECK is due today (2026-06-19 at 10:30 AM PDT) and is still showing as In Data Collection in our tracker. I've flagged it At Risk. Christopher — please confirm if this has been delivered or if there's a delay." },
  { author: 'Earl', content: 'PM check-in: JPMAM — 4TH AND MADISON DECK was due today at 10:30 AM PDT and remains in Data Collection in our tracker — no completion evidence found. Still flagged At Risk. Christopher — please advise on status or mark as delivered.' },
]

async function run(label, opts) {
  const r = new HaikuResponder({
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    hindsightApiKey: process.env.HINDSIGHT_API_KEY,
    paperclipApiKey: process.env.PAPERCLIP_BOARD_API_KEY || process.env.PAPERCLIP_API_KEY,
  })
  const res = await r.respond({
    agentId: EARL,
    agentName: 'JPMAM',
    userMessage: 'Move to tomorrow',
    channelId: '1516986453517926541',
    window: [],
    hindsightSummary: '',
    ...opts,
  })
  console.log(`\n========== ${label} ==========`)
  console.log('needsWork:', res.needsWork)
  if (res.needsWork) console.log('workDescription:', res.workDescription)
  console.log('reply:', res.reply)
}

;(async () => {
  await run('BEFORE FIX (no channel history)', { channelHistory: [] })
  await run('AFTER FIX (with channel history)', { channelHistory })
})().catch(e => { console.error('ERR', e); process.exit(1) })
