/** Error type carrying a stable machine-readable code for API envelopes. */
export class SyncError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'SyncError'
    this.code = code
  }
}
