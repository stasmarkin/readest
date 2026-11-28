export class CliError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

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
