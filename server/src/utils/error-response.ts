export function errorResponse(message: string, errorType: string) {
  return {
    success: false as const,
    error_type: errorType,
    message,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Canonical HTTP-status → `error_type` mapping. Single source of truth: routes
 * reach it through `errorHandler` in utils/async-handler.ts rather than keeping
 * their own copies, which drift.
 */
export function errorTypeForStatus(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return 'validation_error';
    case 403:
      return 'authorization_error';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    default:
      return 'server_error';
  }
}
