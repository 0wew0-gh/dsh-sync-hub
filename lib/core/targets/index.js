/**
 * Target factory. v0.1 implements the local directory backend; WebDAV and
 * S3-compatible backends plug into the same duck-typed interface later.
 */

import { createLocalDirTarget } from './local-dir.js'

export { blobKey, manifestKey, createLocalDirTarget } from './local-dir.js'

/** Create the provider for a target configuration. */
export function createTarget(target) {
  if (!target || typeof target !== 'object') throw new Error('target is required')
  switch (target.kind) {
    case 'local':
      return createLocalDirTarget({ path: target.path, prefix: target.prefix })
    default:
      throw new Error(`target kind not implemented yet: ${target.kind}`)
  }
}
