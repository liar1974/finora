export type AppErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'conflict'
  | 'external_service'
  | 'not_implemented'
  | 'unsupported_format';

export class AppError extends Error {
  constructor(
    public readonly code: AppErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) return new AppError('invalid_input', error.message);
  return new AppError('invalid_input', 'Invalid input');
}
