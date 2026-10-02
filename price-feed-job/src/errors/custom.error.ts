/** An error that carries the HTTP status and the commercetools error code to answer with. */
export class CustomError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code = 'General',
    readonly extensionExtraInfo?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'CustomError';
  }
}

/** 401 — an inbound caller that did not present the shared secret. */
export class Unauthorized extends CustomError {
  constructor(message = 'Unauthorized') {
    super(401, message, 'Unauthorized');
  }
}
