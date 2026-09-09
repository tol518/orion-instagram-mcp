export class InstagramError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}
export function safeError(error: unknown) {
  if (error instanceof InstagramError)
    return {
      success: false as const,
      error: {
        code: error.code,
        message: error.message,
        ...(error.retryAfterSeconds
          ? { retry_after_seconds: error.retryAfterSeconds }
          : {}),
      },
    };
  return {
    success: false as const,
    error: {
      code: "INTERNAL_ERROR",
      message:
        "Operation failed. Consult the operator audit log using the action ID.",
    },
  };
}
export function requireCondition(
  value: unknown,
  code: string,
  message: string,
): asserts value {
  if (!value) throw new InstagramError(code, message);
}
