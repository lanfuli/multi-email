const DIAGNOSTIC_STATUSES = new Set([
  "ok",
  "not_authorized",
  "invalid_credential",
  "reauthorization_required",
  "insufficient_scopes",
  "identity_mismatch",
  "provider_policy_blocked",
  "provider_unavailable",
  "runtime_error",
  "configuration_error",
]);
const DIAGNOSTIC_RUNTIME_CODES = new Set([
  "INVALID_PROVIDER_RESPONSE",
  "KEYCHAIN_READ_FAILED",
  "OAUTH_RUNTIME_ERROR",
  "RUNTIME_INTEGRITY_ERROR",
  "UNSUPPORTED_OPERATION",
]);

function triState(value) {
  return value === true ? true : value === false ? false : null;
}

function safeErrorCode(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const code = String(value);
  return /^[A-Z0-9][A-Z0-9_-]{0,63}$/u.test(code) ? code : fallback;
}

function diagnosticErrorFallback(provider) {
  if (provider === "google") return "GOOGLE_PROFILE_FAILED";
  if (provider === "microsoft") return "MICROSOFT_PROFILE_FAILED";
  return "PROVIDER_DIAGNOSIS_FAILED";
}

export function executableCommand(command) {
  const prefix = "multi-email ";
  if (!command.startsWith(prefix)) return command;
  return `${command} (or node ./scripts/multi-email ${command.slice(prefix.length)} from a Git clone)`;
}

export function providerSetupCommand(provider, { configExists = true } = {}) {
  if (provider === "microsoft") {
    return executableCommand(
      configExists
        ? "multi-email set-microsoft-client <application-guid>"
        : "multi-email init --microsoft-client-id <application-guid> --microsoft-tenant organizations",
    );
  }
  return executableCommand("multi-email init --google-client-json <desktop-oauth.json>");
}

function diagnosticNextStep(account, status) {
  switch (status) {
    case "ok":
      return "none (ready)";
    case "not_authorized":
    case "invalid_credential":
    case "reauthorization_required":
    case "insufficient_scopes":
    case "identity_mismatch":
      return executableCommand(`multi-email auth ${account.alias}`);
    case "runtime_error":
      return executableCommand("multi-email self-test");
    case "provider_policy_blocked":
      return account.provider === "google"
        ? `Review the Google OAuth app access and test-user policy; then run ${executableCommand("multi-email setup")}`
        : `Review Microsoft Entra consent and Conditional Access policy; then run ${executableCommand("multi-email setup")}`;
    case "configuration_error":
      return providerSetupCommand(account.provider);
    case "provider_unavailable":
    default:
      return executableCommand(`multi-email doctor ${account.alias}`);
  }
}

export function diagnosticRecord(account, input = {}) {
  const claimedStatus = DIAGNOSTIC_STATUSES.has(input?.status)
    ? input.status
    : "provider_unavailable";
  const credentialPresent = triState(input?.credential_present);
  const tokenValid = triState(input?.token_valid);
  const identityVerified = triState(input?.identity_verified);
  const scopesValid = triState(input?.scopes_valid);
  const healthVerified =
    credentialPresent === true &&
    tokenValid === true &&
    identityVerified === true &&
    scopesValid === true;
  const inconsistentReady =
    claimedStatus === "ok" &&
    (!healthVerified || ![null, undefined, ""].includes(input?.error_code));
  const status = inconsistentReady ? "runtime_error" : claimedStatus;
  const credentialSource = ["profile", "legacy"].includes(input?.credential_source)
    ? input.credential_source
    : null;
  const verifiedEmail =
    status === "ok" && healthVerified ? account.email : null;
  const errorFallback =
    input?.error_code === null || input?.error_code === undefined || input?.error_code === ""
      ? null
      : diagnosticErrorFallback(account.provider);

  return {
    type: "account",
    alias: account.alias,
    provider: account.provider,
    expected_email: account.email,
    verified_email: verifiedEmail,
    credential_present: credentialPresent,
    token_valid: tokenValid,
    identity_verified: identityVerified,
    scopes_valid: scopesValid,
    credential_source: credentialSource,
    legacy_migration_pending: input?.legacy_migration_pending === true,
    status,
    error_code: inconsistentReady
      ? "INVALID_PROVIDER_DIAGNOSTIC"
      : safeErrorCode(input?.error_code, errorFallback),
    next_step: diagnosticNextStep(account, status),
  };
}

export function unexpectedDiagnosticRecord(account, error) {
  const runtimeFailure =
    error instanceof TypeError || DIAGNOSTIC_RUNTIME_CODES.has(String(error?.code || ""));
  return diagnosticRecord(account, {
    status: runtimeFailure ? "runtime_error" : "provider_unavailable",
    error_code: runtimeFailure
      ? "PROVIDER_DIAGNOSTIC_RUNTIME_ERROR"
      : "PROVIDER_DIAGNOSIS_FAILED",
  });
}

export function doctorSummaryRecord(status, nextStep) {
  return {
    type: "summary",
    alias: null,
    provider: null,
    expected_email: null,
    verified_email: null,
    credential_present: null,
    token_valid: null,
    identity_verified: null,
    scopes_valid: null,
    credential_source: null,
    legacy_migration_pending: false,
    status,
    error_code: null,
    next_step: nextStep,
  };
}
