import { spawn } from "node:child_process";
import { MultiEmailError } from "./errors.mjs";

export const OAUTH_BROWSERS = Object.freeze(["default", "safari", "chrome"]);

export function normalizeOAuthBrowser(value = "default") {
  const browser = String(value || "default").trim().toLowerCase();
  if (!OAUTH_BROWSERS.includes(browser)) {
    throw new MultiEmailError(
      `Unsupported OAuth browser '${browser}'. Use default, safari, or chrome.`,
      "INVALID_BROWSER",
    );
  }
  return browser;
}

function browserArguments(browser, url) {
  if (browser === "safari") return ["-a", "Safari", url];
  if (browser === "chrome") return ["-a", "Google Chrome", url];
  return [url];
}

export function openOAuthBrowser(url, browserValue = "default", { spawnImpl = spawn } = {}) {
  const browser = normalizeOAuthBrowser(browserValue);
  return new Promise((resolve, reject) => {
    const child = spawnImpl("/usr/bin/open", browserArguments(browser, url), {
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("The selected browser could not be opened."));
    });
  });
}
