export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// A request that breaks a trading or banking rule. Always a 400 with a
// machine-readable code so the UI can show the reason.
export class RuleError extends HttpError {
  constructor(code, message) {
    super(400, code, message);
  }
}
