import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { install } from '../src/host/integrations.js'
import { fakeContext } from './fake-ctx.js'

const NOW = Date.parse('2026-10-19T08:00:00Z')
const tick = () => new Promise(resolve => setImmediate(resolve))
const until = async (check) => {
  for (const end = Date.now() + 2_000; Date.now() < end;) {
    if (check()) return
    await tick()
  }
  throw new Error('condition did not settle')
}
const sign = (secret, text) => createHmac('sha256', secret).update(text).digest('hex')

function response() {
  const result = { status: 0, headers: {}, body: '' }
  return {
    result,
    writeHead(status, headers = {}) {
      result.status = status
      result.headers = headers
    },
    end(chunk = '') {
      result.body = Buffer.from(chunk).toString('utf8')
    },
  }
}

function request(body, headers = {}, path = '/api/integrations/github/g1') {
  const req = Readable.from([Buffer.from(body)])
  req.method = 'POST'
  req.url = path
  req.headers = headers
  return req
}

function setup({ outbound, maxBodyBytes } = {}) {
  const state = {
    bots: {
      chief: { id: 'chief', name: 'Chief', sessionId: 'chief' },
      writer: { id: 'writer', name: 'Writer', sessionId: 'writer' },
    },
    rooms: { room: { id: 'room', name: 'Build', members: ['chief', 'writer'] } },
    integrations: { items: {}, deliveries: [] },
    revision: 0,
  }
  const routes = []
  const secrets = new Map()
  const delivered = []
  const fetched = []
  const warnings = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
    getOrigin: () => 'https://bot.example',
  }
  const ctx = fakeContext({ services: { webServer } })
  ctx.sessions = { flush: async () => {} }
  const sessions = {
    chief: { id: 'chief' },
    writer: { id: 'writer' },
    room: { id: 'room' },
  }
  const groupOwners = new Map()
  const rt = {
    ctx,
    state,
    config: {
      integrations: {
        now: () => NOW,
        ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
        fetch: async (url, init) => {
          fetched.push({ url, init })
          if (outbound !== undefined) return outbound(url, init)
          return { ok: true, status: 200, json: async () => ({ ok: true }) }
        },
      },
    },
    load: async () => {},
    save: async () => { state.revision += 1 },
    readOnly: () => undefined,
    loadSecrets: async () => {},
    secretValue: name => secrets.get(name),
    secretEndpoint: async (endpoint, body) => {
      assert.equal(endpoint, 'secret-set')
      secrets.set(body.name, body.value)
      return { name: body.name }
    },
    redactSecrets: text => {
      let value = String(text)
      for (const [name, secret] of secrets) value = value.replaceAll(secret, `[secret:${name}]`)
      return value
    },
    warn: (...args) => { warnings.push(args.join(' ')) },
    botOf: id => state.bots[id],
    roomOf: id => state.rooms[id],
    chatOf: id => state.bots[id]?.sessionId ?? id,
    selfOf: id => groupOwners.get(id)?.botId ?? (state.bots[id] ? id : undefined),
    isMain: id => id === 'chief',
    findBot: ref => Object.values(state.bots).find(bot => bot.name.toLowerCase() === String(ref).toLowerCase()),
    findRooms: ref => Object.values(state.rooms).filter(room => room.name.toLowerCase() === String(ref).toLowerCase()),
    ensureCapabilities: async () => {},
    resolveAgent: async sessionId => ({
      session: sessions[sessionId],
      followup(message) { delivered.push({ sessionId, message }) },
    }),
    groupOwners,
    roomInbox: new Map(),
  }
  install(rt)
  return { rt, ctx, state, routes, secrets, delivered, fetched, warnings }
}

async function save(env, input) {
  return env.rt.integrationEndpoint('integration-save', {
    targetKind: 'bot',
    target: 'chief',
    enabled: true,
    name: 'Inbox',
    ...input,
  })
}

async function call(env, req) {
  const res = response()
  await env.rt.integrationHandleRequest(req, res)
  return res.result
}

function emit(env, sessionId, event) {
  for (const listener of env.ctx.listeners.get('session/event') ?? []) listener({ id: sessionId }, event)
}

test('GitHub integrations verify the raw body, filter, deduplicate, and keep secrets out of state', async () => {
  const env = setup()
  const item = await save(env, {
    provider: 'github',
    secret: 'github-webhook-secret',
    events: 'issues, pull_request',
    repos: 'zp-innovation/DeepSeek-Bot',
  })
  assert.equal(item.ready, true)
  assert.equal(item.endpoint, `https://bot.example/api/integrations/github/${item.id}`)
  assert.ok(!JSON.stringify(env.rt.integrationView()).includes('github-webhook-secret'))
  assert.equal(env.routes[0].kind, 'prefix')
  assert.equal(env.routes[0].path, '/api/integrations')

  const body = JSON.stringify({
    action: 'opened',
    repository: { full_name: 'zp-innovation/DeepSeek-Bot' },
    sender: { login: 'octo' },
    pull_request: { number: 42, title: 'Harden webhook ingress', body: 'Please review this.', html_url: 'https://github.com/zp-innovation/DeepSeek-Bot/pull/42' },
  })
  const headers = {
    'content-type': 'application/json',
    'x-hub-signature-256': `sha256=${sign('github-webhook-secret', body)}`,
    'x-github-delivery': 'delivery-1',
    'x-github-event': 'pull_request',
  }
  assert.equal((await call(env, request(body, headers, `/api/integrations/github/${item.id}`))).status, 202)
  assert.equal(env.delivered.length, 1)
  assert.equal(env.delivered[0].message.source.kind, 'integration')
  assert.equal(env.delivered[0].message.source.provider, 'github')
  assert.match(env.delivered[0].message.content[0].text, /UNTRUSTED EVENT DATA/)
  assert.match(env.delivered[0].message.content[0].text, /Harden webhook ingress/)

  assert.equal((await call(env, request(body, headers, `/api/integrations/github/${item.id}`))).status, 202)
  assert.equal(env.delivered.length, 1)
  const invalid = await call(env, request(body, { ...headers, 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` }, `/api/integrations/github/${item.id}`))
  assert.equal(invalid.status, 401)
})

test('GitHub filters and malformed requests fail closed', async () => {
  const env = setup({ maxBodyBytes: 150 })
  const item = await save(env, {
    provider: 'github',
    secret: 'github-webhook-secret',
    events: 'issues',
    repos: 'owner/other',
  })
  const body = JSON.stringify({
    action: 'opened',
    repository: { full_name: 'owner/repo' },
    issue: { number: 1, title: 'Filtered', body: 'x'.repeat(240) },
  })
  const headers = {
    'content-type': 'application/json',
    'x-hub-signature-256': `sha256=${sign('github-webhook-secret', body)}`,
    'x-github-delivery': 'delivery-filter',
    'x-github-event': 'issues',
  }
  const tooLarge = await call(env, request(body, headers, `/api/integrations/github/${item.id}`))
  assert.equal(tooLarge.status, 413)
  assert.equal(env.delivered.length, 0)

  const small = JSON.stringify({ action: 'opened', repository: { full_name: 'owner/repo' }, issue: { title: 'No' } })
  const smallHeaders = {
    ...headers,
    'x-hub-signature-256': `sha256=${sign('github-webhook-secret', small)}`,
    'x-github-delivery': 'delivery-2',
  }
  assert.equal((await call(env, request(small, smallHeaders, `/api/integrations/github/${item.id}`))).status, 202)
  assert.equal(env.delivered.length, 0)
  assert.equal(env.state.integrations.deliveries.at(-1).status, 'ignored')

  const wrongType = await call(env, request(small, { ...smallHeaders, 'content-type': 'text/plain' }, `/api/integrations/github/${item.id}`))
  assert.equal(wrongType.status, 415)
})

test('Slack answers URL verification and rejects stale signatures', async () => {
  const env = setup()
  const item = await save(env, {
    provider: 'slack',
    signingSecret: 'slack-signing-secret',
    botToken: 'xoxb-secret-token',
    events: 'app_mention',
    channels: 'C1',
  })
  const challengeBody = JSON.stringify({ type: 'url_verification', challenge: 'challenge-123' })
  const timestamp = String(Math.floor(NOW / 1000))
  const challengeHeaders = {
    'content-type': 'application/json',
    'x-slack-request-timestamp': timestamp,
    'x-slack-signature': `v0=${sign('slack-signing-secret', `v0:${timestamp}:${challengeBody}`)}`,
  }
  const challenge = await call(env, request(challengeBody, challengeHeaders, `/api/integrations/slack/${item.id}`))
  assert.equal(challenge.status, 200)
  assert.deepEqual(JSON.parse(challenge.body), { challenge: 'challenge-123' })

  const stale = String(Math.floor((NOW - 6 * 60_000) / 1000))
  const staleSignature = `v0=${sign('slack-signing-secret', `v0:${stale}:${challengeBody}`)}`
  const rejected = await call(env, request(challengeBody, {
    ...challengeHeaders,
    'x-slack-request-timestamp': stale,
    'x-slack-signature': staleSignature,
  }, `/api/integrations/slack/${item.id}`))
  assert.equal(rejected.status, 401)
})

test('Slack replies go back to the originating thread', async () => {
  const env = setup()
  const item = await save(env, {
    provider: 'slack',
    signingSecret: 'slack-signing-secret',
    botToken: 'xoxb-secret-token',
    events: 'app_mention',
    channels: 'C1',
  })
  const timestamp = String(Math.floor(NOW / 1000))
  const body = JSON.stringify({
    type: 'event_callback',
    event_id: 'Ev123',
    event: {
      type: 'app_mention',
      channel: 'C1',
      channel_type: 'channel',
      user: 'U1',
      text: '<@UBOT> investigate the failing test',
      ts: '171.000',
      thread_ts: '170.000',
    },
  })
  const headers = {
    'content-type': 'application/json',
    'x-slack-request-timestamp': timestamp,
    'x-slack-signature': `v0=${sign('slack-signing-secret', `v0:${timestamp}:${body}`)}`,
  }
  assert.equal((await call(env, request(body, headers, `/api/integrations/slack/${item.id}`))).status, 202)
  assert.equal(env.delivered.length, 1)
  const source = env.delivered[0].message.source
  emit(env, 'chief', { type: 'turn/start', data: { turn: 1 } })
  emit(env, 'chief', { type: 'user/message', data: { source, content: env.delivered[0].message.content } })
  emit(env, 'chief', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'The test failure is in parser.test.js.' }] } } })
  emit(env, 'chief', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await until(() => env.fetched.length === 1)
  const posted = JSON.parse(env.fetched[0].init.body)
  assert.equal(posted.channel, 'C1')
  assert.equal(posted.thread_ts, '170.000')
  assert.match(posted.text, /parser\.test\.js/)
  assert.equal(env.fetched[0].init.headers.authorization, 'Bearer xoxb-secret-token')
  await until(() => env.state.integrations.deliveries.at(-1).status === 'completed')
  assert.ok(!JSON.stringify(env.state).includes('xoxb-secret-token'))
  const tested = await env.rt.integrationEndpoint('integration-test', { id: item.id })
  assert.equal(tested.lastDelivery.event, 'test')
  assert.match(JSON.parse(env.fetched[1].init.body).text, /integration test/)
})

test('group integrations aggregate one completed round and reply through the provider', async () => {
  const env = setup()
  const item = await save(env, {
    provider: 'slack',
    targetKind: 'room',
    target: 'room',
    signingSecret: 'slack-signing-secret',
    botToken: 'xoxb-secret-token',
    events: 'app_mention',
    channels: 'C2',
  })
  const timestamp = String(Math.floor(NOW / 1000))
  const body = JSON.stringify({
    type: 'event_callback',
    event_id: 'EvGroup',
    event: { type: 'app_mention', channel: 'C2', user: 'U2', text: 'review the release', ts: '200.000' },
  })
  const headers = {
    'content-type': 'application/json',
    'x-slack-request-timestamp': timestamp,
    'x-slack-signature': `v0=${sign('slack-signing-secret', `v0:${timestamp}:${body}`)}`,
  }
  await call(env, request(body, headers, `/api/integrations/slack/${item.id}`))
  const source = env.delivered[0].message.source
  emit(env, 'room', { type: 'turn/start', data: { turn: 1 } })
  emit(env, 'room', { type: 'user/message', data: { source, content: [{ type: 'text', text: 'review the release' }] } })
  emit(env, 'room', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'relay turn' }] } } })
  emit(env, 'room', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await tick()
  assert.equal(env.fetched.length, 0)
  const queued = [{ text: 'review the release', integration: source.integration }]
  env.rt.roomInbox.set('room', queued)
  assert.equal(queued.length, 1)
  assert.deepEqual(queued[0].integration, source.integration)
  await env.rt.integrationGroupFinished(env.state.rooms.room, {
    replies: [
      { botId: 'chief', name: 'Chief', text: 'The release notes are accurate.' },
      { botId: 'writer', name: 'Writer', text: 'One migration step is missing.' },
    ],
  }, queued)
  await until(() => env.fetched.length === 1)
  assert.match(JSON.parse(env.fetched[0].init.body).text, /Chief: The release notes are accurate\.[\s\S]*Writer: One migration step is missing\./)
})

test('generic IM uses timestamped HMAC, filters conversations, and refuses non-HTTPS outbound URLs', async () => {
  const env = setup()
  await assert.rejects(save(env, {
    provider: 'im',
    signingSecret: 'im-webhook-secret',
    outboundUrl: 'http://example.com/hook',
  }), /https:\/\//)
  const item = await save(env, {
    provider: 'im',
    signingSecret: 'im-webhook-secret',
    outboundUrl: 'https://example.com/hook',
    outboundToken: 'im-token',
    conversations: 'conv-1',
  })
  const timestamp = String(Math.floor(NOW / 1000))
  const body = JSON.stringify({ id: 'm1', conversationId: 'conv-1', user: { id: 'u1', name: 'Ada' }, text: 'summarize this incident' })
  const headers = {
    'content-type': 'application/json',
    'x-ds-bot-timestamp': timestamp,
    'x-ds-bot-signature': `sha256=${sign('im-webhook-secret', `${timestamp}.${body}`)}`,
    'x-ds-bot-delivery': 'm1',
  }
  assert.equal((await call(env, request(body, headers, `/api/integrations/im/${item.id}`))).status, 202)
  assert.equal(env.delivered.length, 1)
  const source = env.delivered[0].message.source
  emit(env, 'chief', { type: 'user/message', data: { source, content: env.delivered[0].message.content } })
  emit(env, 'chief', { type: 'turn/start', data: { turn: 2 } })
  emit(env, 'chief', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Incident summary ready.' }] } } })
  emit(env, 'chief', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await until(() => env.fetched.length === 1)
  assert.equal(env.fetched[0].url, 'https://example.com/hook')
  assert.equal(env.fetched[0].init.headers.authorization, 'Bearer im-token')
  assert.deepEqual(JSON.parse(env.fetched[0].init.body), {
    type: 'message',
    replyTo: 'm1',
    conversationId: 'conv-1',
    text: 'Incident summary ready.',
  })
})

test('disabled, unknown, and deleted integration targets do not expose endpoints', async () => {
  const env = setup()
  const item = await save(env, {
    provider: 'github',
    secret: 'github-webhook-secret',
    enabled: false,
  })
  const body = JSON.stringify({ action: 'opened', repository: { full_name: 'o/r' } })
  const headers = {
    'content-type': 'application/json',
    'x-hub-signature-256': `sha256=${sign('github-webhook-secret', body)}`,
    'x-github-delivery': 'disabled-1',
    'x-github-event': 'issues',
  }
  assert.equal((await call(env, request(body, headers, `/api/integrations/github/${item.id}`))).status, 404)
  env.rt.cleanupIntegrationsForTarget('bot', 'chief')
  assert.equal(Object.keys(env.state.integrations.items).length, 0)
  assert.equal(env.state.integrations.deliveries.length, 0)
})
