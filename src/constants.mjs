export const APP_NAME = "codex-multi-email";
export const APP_VERSION = "0.1.0";
export const CONFIG_VERSION = 2;
export const KEYCHAIN_SERVICE = "io.github.lanfuli.multi-email";
export const LEGACY_KEYCHAIN_SERVICE = "com.openai.codex.multi-email";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.modify",
];

export const MICROSOFT_SCOPES = [
  "User.Read",
  "Mail.ReadWrite",
  "Mail.Send",
];

export const DEFAULT_SAFETY = Object.freeze({
  maxSearchResults: 25,
  maxWriteBatch: 25,
  maxRecipients: 20,
  sendApprovalTtlSeconds: 300,
});
