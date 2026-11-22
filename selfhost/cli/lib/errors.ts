export class CliError extends Error {
  exitCode: number;
  /** A write failed in a way that may still have applied it: the caller cannot tell. */
  uncertain = false;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

/** The error as one whose write may have applied; auth errors stay as they are (exit 3). */
export const markUncertain = (e: unknown): unknown => {
  if (e instanceof AuthRequiredError) return e;
  const err = e instanceof CliError ? e : new CliError(e instanceof Error ? e.message : String(e));
  err.uncertain = true;
  return err;
};

export class UsageError extends CliError {
  constructor(message: string) {
    super(message, 2);
    this.name = 'UsageError';
  }
}

export class AuthRequiredError extends CliError {
  constructor(message = 'login required: run readest login') {
    super(message, 3);
    this.name = 'AuthRequiredError';
  }
}
