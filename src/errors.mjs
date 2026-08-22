export class MultiEmailError extends Error {
  constructor(message, code = "MULTI_EMAIL_ERROR", details = undefined) {
    super(message);
    this.name = "MultiEmailError";
    this.code = code;
    this.details = details;
  }
}

export function publicError(error) {
  if (error instanceof MultiEmailError) {
    return { error: error.message, code: error.code, details: error.details };
  }

  return {
    error: "The email provider request failed. Check the local server log for details.",
    code: "PROVIDER_ERROR",
  };
}
