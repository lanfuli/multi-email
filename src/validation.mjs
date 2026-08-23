import { MultiEmailError } from "./errors.mjs";

const ATEXT_SEGMENT = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+$/u;
const DNS_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;
const MICROSOFT_CLIENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const WELL_KNOWN_MICROSOFT_TENANTS = new Set(["common", "consumers", "organizations"]);

function invalid(message, code) {
  throw new MultiEmailError(message, code);
}

export function normalizeMailboxAddress(
  value,
  { field = "email address", code = "INVALID_MESSAGE" } = {},
) {
  if (typeof value !== "string") {
    invalid(`${field} must be a single canonical mailbox address.`, code);
  }

  const address = value.trim().toLowerCase();
  if (
    !address ||
    address.length > 254 ||
    /[^\x21-\x7e]/u.test(address) ||
    address.indexOf("@") <= 0 ||
    address.indexOf("@") !== address.lastIndexOf("@")
  ) {
    invalid(`${field} must be a single canonical mailbox address.`, code);
  }

  const [local, domain] = address.split("@");
  const localSegments = local.split(".");
  const domainLabels = domain.split(".");
  if (
    local.length > 64 ||
    domain.length > 253 ||
    localSegments.some((segment) => !ATEXT_SEGMENT.test(segment)) ||
    domainLabels.length < 2 ||
    domainLabels.some((label) => !DNS_LABEL.test(label))
  ) {
    invalid(`${field} must be a single canonical mailbox address.`, code);
  }

  return address;
}

export function normalizeMicrosoftClientId(
  value,
  { code = "INVALID_ARGUMENT" } = {},
) {
  const clientId = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!MICROSOFT_CLIENT_ID.test(clientId)) {
    invalid("Microsoft client ID must be a standard application GUID.", code);
  }
  return clientId;
}

export function normalizeMicrosoftTenant(
  value = "organizations",
  { code = "INVALID_ARGUMENT" } = {},
) {
  const tenant = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (WELL_KNOWN_MICROSOFT_TENANTS.has(tenant) || MICROSOFT_CLIENT_ID.test(tenant)) {
    return tenant;
  }

  const labels = tenant.split(".");
  if (
    tenant.length > 253 ||
    labels.length < 2 ||
    labels.some((label) => !DNS_LABEL.test(label))
  ) {
    invalid(
      "Microsoft tenant must be 'organizations', 'common', 'consumers', a tenant GUID, or a tenant domain.",
      code,
    );
  }
  return tenant;
}

export function googleProviderConfigured(provider) {
  return Boolean(
    provider &&
      typeof provider.clientId === "string" &&
      provider.clientId.trim() &&
      typeof provider.clientSecret === "string" &&
      provider.clientSecret.trim(),
  );
}

export function microsoftProviderConfigured(provider) {
  if (!provider?.clientId) return false;
  try {
    normalizeMicrosoftClientId(provider.clientId, { code: "INVALID_CONFIG" });
    normalizeMicrosoftTenant(provider.tenant || "organizations", { code: "INVALID_CONFIG" });
    return true;
  } catch {
    return false;
  }
}
