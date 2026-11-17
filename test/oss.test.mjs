import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOssTarget, inferOssRegion, normalizeOssEndpoint } from '../lib/core/targets/oss.js'
import { SyncEngine } from '../lib/core/engine.js'

test('OSS target infers the region from the endpoint host', () => {
  assert.equal(inferOssRegion('oss-cn-beijing.aliyuncs.com'), 'cn-beijing')
  assert.equal(inferOssRegion('oss-cn-hangzhou.aliyuncs.com'), 'cn-hangzhou')
  assert.equal(inferOssRegion('s3.us-east-1.amazonaws.com'), 'us-east-1')
  const provider = createOssTarget({
    endpoint: 'https://oss-cn-beijing.aliyuncs.com',
    bucket: 'demo-bucket',
    prefix: 'dsh-sync-v1',
    accessKeyId: 'AKID',
    secretAccessKey: 'SECRET',
  })
  assert.equal(provider.repoRoot, 'https://demo-bucket.oss-cn-beijing.aliyuncs.com/dsh-sync-v1')
})

test('OSS target validates endpoint, bucket and credentials', () => {
  assert.throws(() => normalizeOssEndpoint('http://oss-cn-hangzhou.aliyuncs.com'), /HTTPS/)
  assert.throws(() => normalizeOssEndpoint('not-a-url'), /URL/)
  assert.throws(() => createOssTarget({
    endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
    bucket: 'Bad_Bucket',
    accessKeyId: 'id',
    secretAccessKey: 'secret',
  }), /bucket/)
  assert.throws(() => createOssTarget({
    endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
    bucket: 'demo-bucket',
    accessKeyId: '',
    secretAccessKey: 'secret',
  }), /AccessKey ID/)
})

test('OSS target signs requests and lists objects under the prefix', async (t) => {
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    if (init.method === 'GET' && String(url).includes('list-type=2')) {
      return new Response([
        '<ListBucketResult>',
        '<IsTruncated>false</IsTruncated>',
        '<Contents><Key>dsh-sync-v1/meta.json</Key></Contents>',
        '<Contents><Key>dsh-sync-v1/blobs/aa/bb/abc</Key></Contents>',
        '</ListBucketResult>',
      ].join(''), { status: 200, headers: { 'content-type': 'application/xml' } })
    }
    return new Response('hello', { status: 200, headers: { 'content-length': '5' } })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const provider = createOssTarget({
    endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
    region: 'cn-hangzhou',
    bucket: 'demo-bucket',
    prefix: 'dsh-sync-v1',
    accessKeyId: 'AKID',
    secretAccessKey: 'SECRET',
  })
  assert.equal(provider.repoRoot, 'https://demo-bucket.oss-cn-hangzhou.aliyuncs.com/dsh-sync-v1')

  const buffer = await provider.get('meta.json')
  assert.equal(buffer.toString('utf8'), 'hello')
  assert.equal(calls[0].url, 'https://demo-bucket.oss-cn-hangzhou.aliyuncs.com/dsh-sync-v1/meta.json')
  assert.match(calls[0].init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/cn-hangzhou\/s3\/aws4_request/)

  const keys = await provider.list('')
  assert.deepEqual(keys, ['meta.json', 'blobs/aa/bb/abc'])
})

test('OSS probe surfaces the OSS error code and request id', async (t) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(
    '<Error><Code>AccessDenied</Code><Message>AccessDenied</Message><RequestId>REQ-1</RequestId></Error>',
    { status: 403, headers: { 'content-type': 'application/xml' } },
  )
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const provider = createOssTarget({
    endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
    region: 'cn-hangzhou',
    bucket: 'demo-bucket',
    prefix: 'dsh-sync-v1',
    accessKeyId: 'AKID',
    secretAccessKey: 'SECRET',
  })
  await assert.rejects(() => provider.probe(), (error) => {
    assert.match(error.message, /HTTP 403/)
    assert.match(error.message, /AccessDenied/)
    assert.match(error.message, /REQ-1/)
    return true
  })
})

test('OSS uploads report streaming byte progress', async (t) => {
  const originalFetch = globalThis.fetch
  let consumed = 0
  globalThis.fetch = async (url, init = {}) => {
    if (init.body && typeof init.body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of init.body) consumed += chunk.length
    }
    return new Response('', { status: 200 })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const provider = createOssTarget({
    endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
    region: 'cn-hangzhou',
    bucket: 'demo-bucket',
    prefix: 'dsh-sync-v1',
    accessKeyId: 'AKID',
    secretAccessKey: 'SECRET',
  })
  let reported = 0
  await provider.put('blobs/aa/bb/test', Buffer.alloc(200_000), {
    onProgress: (delta) => {
      reported += delta
    },
  })
  assert.equal(reported, 200_000)
  assert.equal(consumed, 200_000)
})

test('OSS targets keep the secret out of settings and report it as stored', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-sync-oss-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const engine = await new SyncEngine({
    dshHome: join(root, 'dsh-home'),
    agentsHome: join(root, 'agents-home'),
    stateRoot: join(root, 'state'),
  }).init()
  const [target] = await engine.upsertTarget({
    name: 'OSS',
    kind: 'oss',
    endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
    region: 'cn-hangzhou',
    bucket: 'demo-bucket',
    accessKeyId: 'AKID',
    secretAccessKey: 'TOP-SECRET',
  })
  assert.equal(target.kind, 'oss')
  const settings = await engine.getSettings()
  assert.equal(settings.targets[0].secretAccessKey, undefined)
  const secrets = await engine.store.loadSecrets()
  assert.equal(secrets.secrets[target.id].secretAccessKey, 'TOP-SECRET')
  const listed = await engine.listTargets()
  assert.equal(listed[0].secretAccessKey, undefined)
  assert.equal(listed[0].secretStored, true)
})
