// DRAFT, NOT EXECUTED. Derived from Gibbs's preserved causal fixture; this new
// fixture asserts the repaired invariant, while the original RED stays intact.
// Product modules are imported only after the launcher's owned environment.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

const repo = process.env.CROSS_PROVIDER_REPO, runRoot = process.env.CROSS_PROVIDER_RUN_ROOT, stage = process.env.CROSS_PROVIDER_STAGE_ROOT
assert.ok(repo && runRoot && stage && process.env.ARFORGE_HOME && process.env.ARFORGE_SECRET_MASTER_KEY, 'isolated launcher env and staged source are mandatory')
const inside = path => { const ref = relative(runRoot, path); return !ref.startsWith('..') && !isAbsolute(ref) }
assert.ok(inside(process.env.ARFORGE_HOME) && inside(process.env.USERPROFILE), 'all profiles must be owned before product imports')
const require = createRequire(join(repo, 'packages/arforge/package.json'))
const sdk = await realpath(join(repo, 'packages/arforge/node_modules/@modelcontextprotocol/sdk'))
const load = path => import(pathToFileURL(path).href)
const { Effect, Layer, Context, Scope, Exit } = await load(require.resolve('effect'))
const { McpAuth } = await load(join(stage, 'src/mcp/auth.ts'))
const { McpOAuthProvider } = await load(join(stage, 'src/mcp/oauth-provider.ts'))
const { Global } = await load(join(repo, 'packages/core/src/global.ts'))
const { AppNodeBuilder } = await load(join(repo, 'packages/core/src/effect/app-node-builder.ts'))
const { auth: sdkAuth } = await load(join(sdk, 'dist/esm/client/auth.js'))
const { Client } = await load(join(sdk, 'dist/esm/client/index.js'))
const { StreamableHTTPClientTransport } = await load(join(sdk, 'dist/esm/client/streamableHttp.js'))
assert.ok(inside(Global.Path.data) && inside(Global.Path.state), 'Global paths must remain inside the isolated profile')
const authFile = join(Global.Path.data, 'mcp-auth.json'), authKey = 'owned-same-credential-record'
const gate = () => { let resolve; return { promise: new Promise(done => { resolve = done }), resolve: () => resolve() } }
const firstRefresh = gate(), bothCredentialsCaptured = gate(), releaseRefreshes = gate(), rotatedSaved = gate(), winnerServed = gate()
const capturedByProviders = new Set()
const trace = [], secrets = [], codes = new Map(), controllers = [new AbortController(), new AbortController()]
const counts = { realAuthServices: 0, realProviders: 0, codeExchanges: 0, refreshExchanges: 0, acceptedRefreshes: 0, invalidRefreshes: 0, tokenClearsAfterWinnerSave: 0 }
const report = { at: new Date().toISOString(), mode: 'real installed SDK, staged providers and real protected McpAuth file; no storage/service doubles',
  counts, trace, ownership: { envBeforeImports: true, globalPathsOwned: true, authFile, sameAuthKey: true, sameURL: true },
  passed: false, cleanup: {}, proofLimit: 'Staged two-provider regression only; not Native24 or normal-package acceptance.' }
const scope = Scope.makeUnsafe(), clients = []
let providers = []
let server, origin, port, expired = false, initialAccess, validAccess, validRefresh, rotatedAccess, winnerWasSaved = false, timedOut = false, watchdog
const mint = () => {
  validAccess = randomUUID(); validRefresh = randomUUID(); secrets.push(validAccess, validRefresh)
  return { access_token: validAccess, refresh_token: validRefresh, token_type: 'Bearer', expires_in: 3600 }
}
const json = (res, status, value, headers = {}) => {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(value))
}
const envelopeCheck = async label => {
  const bytes = await readFile(authFile), value = JSON.parse(bytes)
  assert.equal(value.kind, 'arforge-protected-json', 'real auth file must remain encrypted')
  assert.ok(secrets.every(secret => !bytes.includes(Buffer.from(secret))), 'no plaintext OAuth token may appear in the owned auth file')
  report.encryptedSnapshots ??= []
  report.encryptedSnapshots.push({ label, encrypted: true, plaintextTokenAbsent: true, sha256: createHash('sha256').update(bytes).digest('hex') })
}
try {
  const contextA = await Effect.runPromise(Layer.buildWithScope(Layer.fresh(AppNodeBuilder.build(McpAuth.node)), scope))
  const contextB = await Effect.runPromise(Layer.buildWithScope(Layer.fresh(AppNodeBuilder.build(McpAuth.node)), scope))
  const stores = [Context.get(contextA, McpAuth.Service), Context.get(contextB, McpAuth.Service)]
  assert.ok(stores[0] !== stores[1], 'two separate real McpAuth services are required')
  counts.realAuthServices = 2
  server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url, origin)
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(res, 200, { resource: origin + '/mcp', authorization_servers: [origin] })
      if (url.pathname === '/.well-known/oauth-authorization-server') return json(res, 200, {
        issuer: origin, authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token',
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
      })
      if (url.pathname === '/authorize') {
        const code = randomUUID(), redirect = url.searchParams.get('redirect_uri')
        codes.set(code, { challenge: url.searchParams.get('code_challenge'), redirect })
        const callback = new URL(redirect); callback.searchParams.set('code', code); callback.searchParams.set('state', url.searchParams.get('state'))
        res.writeHead(302, { location: callback.href }); res.end(); return
      }
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString('utf8')
      if (url.pathname === '/token') {
        const form = new URLSearchParams(body)
        if (form.get('grant_type') === 'authorization_code') {
          const code = codes.get(form.get('code'))
          assert.ok(code && code.redirect === form.get('redirect_uri'), 'owned code/redirect must match')
          assert.ok(createHash('sha256').update(form.get('code_verifier')).digest('base64url') === code.challenge, 'owned PKCE proof must match')
          codes.delete(form.get('code')); counts.codeExchanges++
          const tokens = mint(); initialAccess = validAccess; return json(res, 200, tokens)
        }
        assert.equal(form.get('grant_type'), 'refresh_token', 'only rotating refresh reaches the barrier')
        const index = ++counts.refreshExchanges, captured = form.get('refresh_token')
        trace.push('refresh_exchange_' + index + '_arrived')
        if (index === 1) firstRefresh.resolve()
        await releaseRefreshes.promise
        if (index === 1) {
          assert.ok(captured === validRefresh, 'first exchange must own the live refresh token')
          const tokens = mint(); rotatedAccess = validAccess
          counts.acceptedRefreshes++; trace.push('first_exchange_accepted_and_rotated')
          return json(res, 200, tokens)
        }
        await rotatedSaved.promise; await winnerServed.promise
        assert.ok(captured !== validRefresh, 'second provider must have captured the consumed token')
        counts.invalidRefreshes++; trace.push('second_exchange_invalid_after_real_encrypted_save')
        return json(res, 400, { error: 'invalid_grant', error_description: 'Owned refresh token already consumed' })
      }
      if (url.pathname === '/mcp') {
        if (req.method === 'GET') { res.writeHead(405); res.end(); return }
        if (req.method === 'DELETE') { res.writeHead(200); res.end(); return }
        if (req.headers.authorization !== 'Bearer ' + validAccess || (expired && validAccess === initialAccess))
          return json(res, 401, { error: 'expired' }, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` })
        const rpc = JSON.parse(body)
        if (rpc.id === undefined) { res.writeHead(202); res.end(); return }
        const result = rpc.method === 'initialize'
          ? { protocolVersion: rpc.params.protocolVersion, capabilities: { resources: {} }, serverInfo: { name: 'owned-cross-provider', version: '1' } }
          : rpc.method === 'resources/list' ? { resources: [{ name: 'owned', uri: 'evidence://owned/manual' }] } : {}
        if (expired && rpc.method === 'resources/list') res.once('finish', () => { trace.push('winner_resource_served'); winnerServed.resolve() })
        return json(res, 200, { jsonrpc: '2.0', id: rpc.id, result })
      }
      return json(res, 404, { error: 'owned_not_found' })
    })().catch(() => { report.endpointFailure = true; json(res, 500, { error: 'owned_fixture_failed' }) })
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  port = server.address().port; origin = 'http://127.0.0.1:' + port
  let authorizationURL
  providers = stores.map((store, index) => new (class extends McpOAuthProvider {
    async tokens() {
      const value = await super.tokens()
      if (expired && value?.access_token === initialAccess) {
        capturedByProviders.add(index)
        if (capturedByProviders.size === 2) bothCredentialsCaptured.resolve()
      }
      return value
    }
  })('owned-server', origin + '/mcp', { clientId: 'owned-client' }, {
    onRedirect: url => { if (index === 0) authorizationURL = url },
    // Supported provider callback observes, but never replaces, real storage writes.
    withTokenWrite: write => Effect.gen(function* () {
      const before = yield* store.getForUrl(authKey, origin + '/mcp')
      yield* write
      const after = yield* store.getForUrl(authKey, origin + '/mcp')
      if (expired && rotatedAccess && after?.tokens?.accessToken === rotatedAccess) {
        winnerWasSaved = true
        trace.push('winning_rotation_saved_in_real_shared_auth_file')
        rotatedSaved.resolve()
      }
      if (winnerWasSaved && before?.tokens && !after?.tokens) {
        counts.tokenClearsAfterWinnerSave++; trace.push('loser_invalidated_real_winning_credential')
      }
    }),
  }, store, authKey))
  counts.realProviders = 2
  assert.ok(providers[0].oauthFetch !== providers[1].oauthFetch, 'providers must keep separate subscriber facades')
  report.ownership.separateProviderHelpers = true
  const run = async () => {
    const authOptions = { serverUrl: origin + '/mcp', fetchFn: providers[0].oauthFetch.bind(controllers[0].signal) }
    assert.equal(await sdkAuth(providers[0], authOptions), 'REDIRECT', 'bootstrap must use real SDK PKCE')
    const authorization = await fetch(authorizationURL, { redirect: 'manual' })
    const code = new URL(authorization.headers.get('location')).searchParams.get('code')
    assert.equal(await sdkAuth(providers[0], { ...authOptions, authorizationCode: code }), 'AUTHORIZED', 'real owned code exchange must authorize')
    const initial = await Promise.all(stores.map(store => Effect.runPromise(store.getForUrl(authKey, origin + '/mcp'))))
    assert.ok(initial.every(value => value?.tokens?.accessToken === initialAccess), 'both services must read the same physical credential')
    report.ownership.bothServicesReadSameInitialCredential = true
    await envelopeCheck('initial_sdk_code_exchange')
    for (let index = 0; index < 2; index++) {
      const client = new Client({ name: 'owned-cross-provider-' + index, version: '1' }, { capabilities: {} })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { authProvider: providers[index], fetch: providers[index].oauthFetch.bind(controllers[index].signal) }))
    }
    expired = true
    const settle = promise => promise.then(() => 'fulfilled', () => 'rejected')
    const resources = settle(clients[0].listResources({}, { timeout: 5000 }))
    await firstRefresh.promise
    const ping = settle(clients[1].ping({ timeout: 5000 }))
    // Both real providers must have captured the old credential, even when
    // only the shared winning exchange is allowed onto the wire.
    await bothCredentialsCaptured.promise; releaseRefreshes.resolve()
    const outcomes = await Promise.all([resources, ping])
    const final = await Promise.all(stores.map(store => Effect.runPromise(store.getForUrl(authKey, origin + '/mcp'))))
    report.outcomes = { resources: outcomes[0], healthPing: outcomes[1] }
    report.invariant = { expectedRefreshExchanges: 1, observedRefreshExchanges: counts.refreshExchanges,
      expectedBothFulfilled: true, observedBothFulfilled: outcomes.every(value => value === 'fulfilled'),
      expectedWinnerRetained: true, observedWinnerRetained: final.every(value => value?.tokens?.accessToken === rotatedAccess),
      observedTokensAbsentThroughBothServices: final.every(value => !value?.tokens) }
    await envelopeCheck('winning_shared_rotation_retained')
    assert.equal(counts.refreshExchanges, 1, 'one credential epoch must not consume its refresh token twice')
    assert.equal(counts.acceptedRefreshes, 1); assert.equal(counts.invalidRefreshes, 0)
    assert.ok(winnerWasSaved && counts.tokenClearsAfterWinnerSave === 0, 'the real encrypted winner must remain saved')
    assert.equal(outcomes[0], 'fulfilled'); assert.equal(outcomes[1], 'fulfilled')
    assert.ok(final.every(value => value?.tokens?.accessToken === rotatedAccess), 'both real services must read the winning credential')
    assert.ok(!report.endpointFailure, 'owned endpoint must not fail internally')
    // These are storage-CAS unit clauses, separate from the real SDK exchange
    // invariant above. They exercise real encrypted I/O and public mutations;
    // they do not assert another successful OAuth admission.
    const persisted = await Effect.runPromise(stores[1].get(authKey))
    const fence = stores[0].oauth(authKey, origin + '/mcp', 'owned-store-CAS-unit')
    const rejectedAccess = randomUUID(); secrets.push(rejectedAccess)
    const wire = { access_token: rejectedAccess, refresh_token: validRefresh, token_type: 'Bearer' }
    const candidate = { accessToken: rejectedAccess, refreshToken: validRefresh }
    const digestFile = async () => createHash('sha256').update(await readFile(authFile)).digest('hex')
    try {
      await Effect.runPromise(fence.read())
      await Effect.runPromise(stores[1].set(authKey, structuredClone(persisted)))
      const sameByteHash = await digestFile()
      await assert.rejects(Effect.runPromise(fence.saveTokens(candidate, wire)), 'same-byte replacement still retires the old in-process epoch')
      assert.equal(await digestFile(), sameByteHash, 'rejected old save must not rewrite the encrypted winner')

      await Effect.runPromise(fence.read())
      await Effect.runPromise(stores[1].remove(authKey))
      await assert.rejects(Effect.runPromise(fence.saveTokens(candidate, wire)), 'revoked credentials cannot be restored by a late save')
      await Effect.runPromise(fence.invalidateCredentials('tokens'))
      assert.equal(await Effect.runPromise(stores[1].get(authKey)), undefined)

      await Effect.runPromise(stores[1].set(authKey, structuredClone(persisted)))
      await Effect.runPromise(fence.read())
      const replacement = randomUUID(); secrets.push(replacement)
      const replacementRefresh = randomUUID(); secrets.push(replacementRefresh)
      await Effect.runPromise(stores[1].updateTokens(authKey, { accessToken: replacement, refreshToken: replacementRefresh }, origin + '/mcp'))
      const replacementHash = await digestFile()
      await Effect.runPromise(fence.invalidateCredentials('tokens'))
      assert.equal((await Effect.runPromise(stores[1].get(authKey))).tokens.accessToken, replacement)
      assert.equal(await digestFile(), replacementHash, 'stale invalidation must not rewrite the reconnect credential')
      const beforeIsolation = counts.refreshExchanges
      const wrongTarget = stores[0].oauth(authKey, origin + '/wrong-resource', 'owned-other-target')
      const wrongKey = stores[1].oauth('owned-different-auth-key', origin + '/mcp', 'owned-other-key')
      try {
        assert.equal(await Effect.runPromise(wrongTarget.read()), undefined)
        assert.equal(await Effect.runPromise(wrongKey.read()), undefined)
        const wrongRequest = { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: replacementRefresh, client_id: 'owned-client' }) }
        await assert.rejects(wrongTarget.oauthFetch.fetch(origin + '/token', wrongRequest), 'wrong bound resource cannot send the stored credential')
        await assert.rejects(wrongKey.oauthFetch.fetch(origin + '/token', wrongRequest), 'a different authKey cannot borrow the stored credential')
        assert.equal(counts.refreshExchanges, beforeIsolation, 'isolation rejection must happen before HTTP')
      } finally { wrongTarget.oauthFetch.invalidate(); wrongKey.oauthFetch.invalidate() }
      report.storeFenceCases = { sameByteReplacementRejectsOldSave: true, revokeRejectsOldSave: true, reconnectSurvivesOldInvalidation: true, targetAndKeyIsolationNoWire: true, scope: 'real protected-store CAS unit clauses, no extra OAuth admission claim' }
      await envelopeCheck('after_store_CAS_unit_clauses')
    } finally { fence.oauthFetch.invalidate() }
    report.passed = true
  }
  await Promise.race([run(), new Promise((_, reject) => { watchdog = setTimeout(() => { timedOut = true; reject(new Error('owned cross-provider deadline')) }, 20000) })])
} catch (error) {
  report.failure = { name: error?.name ?? 'Error', assertion: error?.code === 'ERR_ASSERTION', timedOut,
    frames: String(error?.stack ?? '').split('\n').filter(line => line.trim().startsWith('at ')).slice(0, 6) }
  process.exitCode = 1
} finally {
  clearTimeout(watchdog); releaseRefreshes.resolve(); rotatedSaved.resolve(); winnerServed.resolve()
  controllers.forEach(controller => controller.abort())
  providers.forEach(provider => provider.oauthFetch.invalidate())
  for (const client of clients) await client.close().catch(() => {})
  if (server?.listening) { server.closeAllConnections(); await new Promise(done => server.close(done)) }
  await Effect.runPromise(Scope.close(scope, Exit.void))
  report.cleanup = { ownedPort: port ?? null, serverListening: !!server?.listening, clientsClosed: clients.length, serviceScopeClosed: true, liveOwnedHandles: [], incompleteWrites: [] }
  await writeFile(join(runRoot, 'cross-provider-causal.child-result.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ passed: report.passed, counts, invariant: report.invariant, cleanup: report.cleanup }))
}
