/**
 * Target factory. Local directories and S3-compatible object storage (OSS)
 * implement the same duck-typed provider interface.
 */

import { createLocalDirTarget } from './local-dir.js'
import { createOssTarget } from './oss.js'

export { blobKey, manifestKey, createLocalDirTarget } from './local-dir.js'
export { createOssTarget } from './oss.js'

/** Create the provider for a target configuration. */
export function createTarget(target) {
  if (!target || typeof target !== 'object') throw new Error('target is required')
  switch (target.kind) {
    case 'local':
      return createLocalDirTarget({ path: target.path, prefix: target.prefix })
    case 'oss':
      return createOssTarget({
        endpoint: target.endpoint,
        region: target.region,
        bucket: target.bucket,
        prefix: target.prefix,
        accessKeyId: target.accessKeyId,
        secretAccessKey: target.secretAccessKey,
      })
    default:
      throw new Error(`target kind not implemented yet: ${target.kind}`)
  }
}
