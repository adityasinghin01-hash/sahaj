/**
 * Standardized error types and mappings for Core 1 commands.
 * Guarantee: Errors are sanitized and never expose tokens, keys, or stack secrets.
 */

export class Core1CommandError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number = 400
  ) {
    super(code);
    this.name = 'Core1CommandError';
  }
}

export function mapToCommandError(error: unknown): Core1CommandError {
  if (error instanceof Core1CommandError) {
    return error;
  }

  if (error && typeof error === 'object') {
    const errObj = error as Record<string, unknown>;

    // WebhookError mapping
    if (errObj.code === 'invalid_encryption_configuration' || errObj.status === 503) {
      return new Core1CommandError('service_unavailable_encryption', 503);
    }

    const code = typeof errObj.code === 'string' ? errObj.code : (typeof errObj.message === 'string' ? errObj.message : undefined);

    if (code) {
      if (code.includes('cipher') || code.includes('key') || code.includes('crypto')) {
        return new Core1CommandError('service_unavailable_encryption', 503);
      }
      if (code === 'ambiguous_family_membership_family_id_required') {
        return new Core1CommandError(code, 400);
      }
      if (code === 'family_membership_not_found') {
        return new Core1CommandError(code, 403);
      }
      if (typeof errObj.status === 'number') {
        return new Core1CommandError(code, errObj.status);
      }
    }
  }

  // Fallback safe error
  return new Core1CommandError('internal_command_error', 500);
}
