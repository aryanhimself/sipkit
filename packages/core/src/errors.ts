/** Machine-readable error codes thrown by the Softphone public API. */
export type SoftphoneErrorCode =
  | 'NOT_READY' // plugins still initialising / failed to initialise
  | 'NOT_STARTED' // start() has not been called (or stop() was)
  | 'DESTROYED' // destroy() was called
  | 'MISSING_CREDENTIALS' // username / websocketUrls / domain not configured
  | 'NOT_REGISTERED'
  | 'NO_ACTIVE_CALL'
  | 'CALL_NOT_FOUND'
  | 'MAX_LINES'
  | 'INVALID_STATE'
  | 'INVALID_NUMBER'
  | 'INVALID_ARGUMENT'
  | 'NOT_SUPPORTED'
  | 'DEVICE_NOT_FOUND'
  | 'PLUGIN_ERROR'
  | 'ENGINE_ERROR';

/** Typed error thrown by every public Softphone method. */
export class SoftphoneError extends Error {
  constructor(
    public readonly code: SoftphoneErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SoftphoneError';
  }
}

/** Type guard, optionally narrowing to a specific code. */
export function isSoftphoneError(
  error: unknown,
  code?: SoftphoneErrorCode,
): error is SoftphoneError {
  return error instanceof SoftphoneError && (code === undefined || error.code === code);
}

/** Wrap an arbitrary engine failure in a SoftphoneError (pass-through if already typed). */
export function toEngineError(error: unknown, action: string): SoftphoneError {
  if (error instanceof SoftphoneError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new SoftphoneError('ENGINE_ERROR', `${action} failed: ${detail}`, { cause: error });
}
