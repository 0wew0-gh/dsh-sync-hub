/**
 * S3-compatible object storage target (Aliyun OSS, with the S3 endpoint).
 *
 * The object layout matches the local-dir target: `<prefix>/meta.json`,
 * `<prefix>/manifests/...`, `<prefix>/blobs/...`. Requests use AWS Signature
 * V4 against the bucket's virtual-hosted S3 endpoint, which OSS accepts through
 * its S3 compatibility layer.
 */

import { createHash, createHmac } from 'node:crypto'
import { Readable } from 'node:stream'
import { normalizeObjectPrefix } from '../paths.js'

const REQUEST_TIMEOUT_MS = 30_000

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest()
}

/** Percent-encode one path segment following AWS canonical rules. */
function uriEncode(value) {
  let encoded = ''
  for (const byte of Buffer.from(String(value), 'utf8')) {
    const char = String.fromCharCode(byte)
    if (
      (byte >= 0x30 && byte <= 0x39)
      || (byte >= 0x41 && byte <= 0x5a)
      || (byte >= 0x61 && byte <= 0x7a)
      || char === '-'
      || char === '.'
      || char === '_'
      || char === '~'
    ) {
      encoded += char
    } else {
      encoded += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }
  return encoded
}

function canonicalQuery(pairs) {
  return pairs
    .map(([key, value]) => [uriEncode(key), uriEncode(value)])
    .sort((left, right) => (
      left[0] === right[0] ? (left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0) : (left[0] < right[0] ? -1 : 1)
    ))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
}

function signingKey(secret, date, region, service) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request')
}

function signV4({ method, host, path, query, headers, payloadHash, region, accessKeyId, secretAccessKey }) {
  const amzDate = new Date().toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, '')
  const canonicalHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    canonicalHeaders[name.toLowerCase()] = String(value).trim().replace(/\s+/g, ' ')
  }
  canonicalHeaders.host = host
  canonicalHeaders['x-amz-date'] = amzDate
  canonicalHeaders['x-amz-content-sha256'] = payloadHash
  const signedHeaders = Object.keys(canonicalHeaders).sort()
  const headerBlock = signedHeaders.map((name) => `${name}:${canonicalHeaders[name]}\n`).join('')
  const canonicalRequest = `${method}\n${path}\n${canonicalQuery(query)}\n${headerBlock}\n${signedHeaders.join(';')}\n${payloadHash}`
  const scope = `${amzDate.slice(0, 8)}/${region}/s3/aws4_request`
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256Hex(Buffer.from(canonicalRequest, 'utf8'))}`
  const signature = hmac(signingKey(secretAccessKey, amzDate.slice(0, 8), region, 's3'), Buffer.from(stringToSign, 'utf8')).toString('hex')
  return {
    amzDate,
    headers: {
      ...headers,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`,
    },
  }
}

function decodeXml(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function xmlValues(text, tag) {
  const values = []
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g')
  let match
  while ((match = pattern.exec(text)) !== null) values.push(decodeXml(match[1]))
  return values
}

function headerDate(headers) {
  const value = headers.get('last-modified') || headers.get('date')
  const time = value ? Date.parse(value) : NaN
  return Number.isFinite(time) ? time : Date.now()
}

/** Extract the OSS/S3 error code and message from an XML error body. */
async function responseErrorDetail(response) {
  let text = ''
  try {
    text = await response.text()
  } catch {
    text = ''
  }
  const pick = (tag) => {
    const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)
    return match ? decodeXml(match[1]) : ''
  }
  const parts = []
  const code = pick('Code')
  const message = pick('Message')
  const requestId = pick('RequestId') || response.headers.get('x-oss-request-id') || response.headers.get('x-amz-request-id')
  if (code) parts.push(code)
  if (message) parts.push(message)
  if (requestId) parts.push('RequestId ' + requestId)
  if (parts.length === 0 && text.trim()) parts.push(text.trim().slice(0, 300))
  return parts.join(' · ')
}

function failureMessage(action, key, response, detail) {
  const target = key ? ` ${key}` : ''
  return `OSS ${action}${target} 失败：HTTP ${response.status}${detail ? '（' + detail + '）' : ''}`
}

export function normalizeOssEndpoint(endpoint) {
  let parsed
  try {
    parsed = new URL(String(endpoint || '').trim())
  } catch {
    throw new Error('OSS endpoint 必须是合法的绝对 URL（例如 https://oss-cn-hangzhou.aliyuncs.com）')
  }
  if (parsed.protocol !== 'https:') throw new Error('OSS endpoint 必须使用 HTTPS')
  if (parsed.username || parsed.password) throw new Error('OSS endpoint 不能包含账号密码')
  return parsed
}

/** Infer the SigV4 region from common OSS/S3 endpoint hosts. */
export function inferOssRegion(hostname) {
  const host = String(hostname || '').toLowerCase()
  const oss = /(?:^|\.)oss-([a-z0-9-]+)\.aliyuncs\.com$/.exec(host)
  if (oss) return oss[1]
  const s3 = /(?:^|\.)s3[.-]([a-z0-9-]+)\.amazonaws\.com$/.exec(host)
  if (s3 && s3[1] !== 'amazonaws') return s3[1]
  return ''
}

/** Create a provider backed by an OSS bucket (S3-compatible API). */
export function createOssTarget({ endpoint, region, bucket, prefix = '', accessKeyId, secretAccessKey }) {
  const parsed = normalizeOssEndpoint(endpoint)
  const normalizedBucket = typeof bucket === 'string' ? bucket.trim() : ''
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(normalizedBucket)) {
    throw new Error('OSS bucket 名称不合法')
  }
  if (typeof accessKeyId !== 'string' || accessKeyId.trim() === '') throw new Error('OSS AccessKey ID 不能为空')
  if (typeof secretAccessKey !== 'string' || secretAccessKey === '') throw new Error('OSS AccessKey Secret 不能为空')
  const regionName = typeof region === 'string' && region.trim()
    ? region.trim()
    : (inferOssRegion(parsed.hostname) || 'cn-hangzhou')
  const bucketInHost = parsed.hostname.toLowerCase().startsWith(normalizedBucket + '.')
  const host = bucketInHost ? parsed.hostname : `${normalizedBucket}.${parsed.hostname}`
  const basePath = parsed.pathname.replace(/\/+$/, '')
  const objectPrefix = normalizeObjectPrefix(prefix)
  const root = `https://${host}`

  const keyPath = (key) => {
    const segments = objectPrefix ? objectPrefix.split('/') : []
    if (key) segments.push(...String(key).split('/'))
    return `${basePath}/${segments.map(uriEncode).join('/')}`
  }

  async function request(method, key, { query = [], body, headers = {}, bodyFactory, payloadHash } = {}) {
    const hash = payloadHash ?? sha256Hex(body ?? Buffer.alloc(0))
    const path = key === null ? `${basePath || '/'}` : keyPath(key)
    // OSS only treats an AWS SigV4 request as S3-compatible when this header is
    // present; without it OSS validates the signature as an OSS signature.
    const requestHeaders = { 'x-oss-s3-compat': 'true', ...headers }
    const signed = signV4({
      method,
      host,
      path: path || '/',
      query,
      headers: requestHeaders,
      payloadHash: hash,
      region: regionName,
      accessKeyId: accessKeyId.trim(),
      secretAccessKey,
    })
    let lastError
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const url = `${root}${path}${query.length ? '?' + canonicalQuery(query) : ''}`
        const attemptBody = bodyFactory ? bodyFactory() : body
        const response = await fetch(url, {
          method,
          headers: signed.headers,
          body: attemptBody,
          signal: controller.signal,
          ...(bodyFactory ? { duplex: 'half' } : {}),
        })
        if (response.status >= 500 && attempt === 0) {
          lastError = new Error(`HTTP ${response.status}`)
          continue
        }
        return response
      } catch (error) {
        lastError = error
        if (attempt === 1) {
          throw new Error(`OSS 请求失败：${error instanceof Error && error.name === 'AbortError' ? '超时' : error}`)
        }
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastError
  }

  // Lazily loaded list of blob keys; one ListObjects sweep replaces thousands
  // of per-blob HEAD requests during a sync.
  let blobIndex = null
  const api = {
    kind: 'oss',
    root,
    repoRoot: `${root}${basePath}/${objectPrefix}`,
    prefix: objectPrefix,

    async probe() {
      const response = await request('HEAD', null)
      if (response.ok) return { ok: true, detail: `${normalizedBucket} 可访问` }
      // HeadBucket needs GetBucketInfo permission, while a sync only needs
      // ListObjects. Fall back to a one-key listing and treat success as reachable.
      let detail = ''
      try {
        const listResponse = await request('GET', null, { query: [['list-type', '2'], ['max-keys', '1']] })
        if (listResponse.ok) {
          return { ok: true, detail: `${normalizedBucket} 可访问（ListObjects 已验证）` }
        }
        detail = await responseErrorDetail(listResponse)
        if (!detail) detail = await responseErrorDetail(response)
      } catch {
        detail = ''
      }
      if (response.status === 403) {
        throw new Error(
          'OSS 拒绝访问：HTTP 403'
          + (detail ? '（' + detail + '）' : '')
          + '；bucket=' + normalizedBucket + ' endpoint=' + host
          + '；请检查 AccessKey/Secret、bucket 权限与 endpoint/region',
        )
      }
      if (response.status === 404) {
        throw new Error(
          'OSS 找不到 bucket：' + normalizedBucket
          + '（endpoint=' + host + '）'
          + (detail ? '（' + detail + '）' : ''),
        )
      }
      throw new Error(failureMessage('连接', '', response, detail))
    },

    async head(key) {
      if (String(key).startsWith('blobs/')) {
        if (!blobIndex) {
          try {
            const keys = await api.list('blobs')
            blobIndex = new Set(keys.filter((item) => item.startsWith('blobs/')))
          } catch {
            blobIndex = new Set()
          }
        }
        if (blobIndex.has(key)) return { size: 0, mtimeMs: Date.now() }
        return undefined
      }
      const response = await request('HEAD', key)
      if (response.status === 404) return undefined
      if (!response.ok) throw new Error(failureMessage('HEAD', key, response, await responseErrorDetail(response)))
      return {
        size: Number(response.headers.get('content-length')) || 0,
        mtimeMs: headerDate(response.headers),
      }
    },

    async get(key) {
      const response = await request('GET', key)
      if (response.status === 404) return undefined
      if (!response.ok) throw new Error(failureMessage('GET', key, response, await responseErrorDetail(response)))
      return Buffer.from(await response.arrayBuffer())
    },

    async put(key, buffer, options = {}) {
      const headers = { 'content-type': 'application/octet-stream' }
      let bodyFactory
      if (typeof options.onProgress === 'function') {
        headers['content-length'] = String(buffer.length)
        const report = options.onProgress
        let used = false
        bodyFactory = () => {
          let offset = 0
          const shouldReport = !used
          used = true
          return new Readable({
            read() {
              if (offset >= buffer.length) {
                this.push(null)
                return
              }
              const size = Math.min(64 * 1024, buffer.length - offset)
              const chunk = buffer.subarray(offset, offset + size)
              offset += size
              if (shouldReport) report(chunk.length)
              this.push(chunk)
            },
          })
        }
      }
      const response = await request('PUT', key, {
        body: bodyFactory ? undefined : buffer,
        bodyFactory,
        payloadHash: sha256Hex(buffer),
        headers,
      })
      if (!response.ok) throw new Error(failureMessage('PUT', key, response, await responseErrorDetail(response)))
      blobIndex?.add(key)
      return { ok: true }
    },

    async remove(key) {
      const response = await request('DELETE', key)
      if (!response.ok && response.status !== 404) {
        throw new Error(failureMessage('DELETE', key, response, await responseErrorDetail(response)))
      }
      blobIndex?.delete(key)
    },

    async list(prefixKey) {
      const basePrefix = objectPrefix ? `${objectPrefix}/` : ''
      const wanted = `${basePrefix}${prefixKey ? String(prefixKey).replace(/^\/+/, '') : ''}`
      const out = []
      let token = ''
      for (let page = 0; page < 1000; page += 1) {
        const query = [['list-type', '2'], ['prefix', wanted], ['max-keys', '1000']]
        if (token) query.push(['continuation-token', token])
        const response = await request('GET', null, { query })
        if (!response.ok) throw new Error(failureMessage('LIST', wanted, response, await responseErrorDetail(response)))
        const text = await response.text()
        for (const raw of xmlValues(text, 'Key')) {
          if (!raw.startsWith(basePrefix)) continue
          const relative = raw.slice(basePrefix.length)
          if (relative && !relative.endsWith('/')) out.push(relative)
        }
        const truncated = /<IsTruncated>true<\/IsTruncated>/.test(text)
        const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(text)
        token = next ? decodeXml(next[1]) : ''
        if (!truncated || !token) break
      }
      return out
    },
  }
  return api
}
