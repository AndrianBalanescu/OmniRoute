/**
 * @file alibabaConsoleHarImport.ts
 * @description Pure, transport-free helpers that extract the Alibaba Model Studio
 * (Bailian) console session credential (`alibabaConsoleCookie` + optional
 * `alibabaConsoleSecToken`) from a DevTools HAR export or a pasted cURL command,
 * so the Add/Edit connection dialogs can offer one-click import instead of the
 * user hand-copying headers (see `HarImportButton.tsx`).
 *
 * The console free-tier quota API the browser calls
 * (`bailian-singapore-cs.alibabacloud.com` / `bailian.console.aliyun.com`) is
 * authenticated by the SSO session cookie (`login_aliyunid_ticket=...`, often a
 * full `Cookie:` header with several paired values) plus an anti-CSRF
 * `sec_token` body parameter. Both appear verbatim in any HAR entry or cURL
 * line recorded on a console page hosting the quota widget.
 *
 * No network calls here; everything operates on text already in the browser.
 * Alibaba session cookies are opaque (non-JWT) tickets, so unlike the m365
 * extractor there is no expiry hint; the quota panel surfaces lastSyncAt.
 */

/** Hosts that prove a HAR entry is an authenticated console request. */
export const ALIBABA_CONSOLE_HOSTS = [
  "bailian-singapore-cs.alibabacloud.com",
  "bailian.console.aliyun.com",
  "modelstudio.console.alibabacloud.com",
  "data.alibabacloud.com",
] as const;

export type AlibabaConsoleHarImportResult =
  | { ok: true; cookie: string; secToken: string | null }
  | { ok: false; error: string };

interface HarEntryLike {
  request?: {
    url?: unknown;
    headers?: Array<{ name?: unknown; value?: unknown }>;
    cookies?: Array<{ name?: unknown; value?: unknown }>;
    postData?: { text?: unknown };
  };
}

interface HarLike {
  log?: { entries?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toTrimmed(value: unknown): string | null {
  const s = asString(value);
  if (!s) return null;
  const trimmed = s.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isKnownConsoleHost(hostname: string): boolean {
  return ALIBABA_CONSOLE_HOSTS.some(
    (host) => hostname === host || hostname.endsWith(`.${host}`)
  );
}

/** Pull the SSO ticket out of a raw Cookie header string; null when absent. */
export function extractAlibabaTicketFromCookieHeader(cookieHeader: string): string | null {
  for (const pair of cookieHeader.split(";")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim().toLowerCase();
    const value = pair.slice(eq + 1).trim();
    if (name === "login_aliyunid_ticket" && value) return value;
  }
  return null;
}

function extractSecTokenFromBody(bodyText: string): string | null {
  const direct = /(?:^|[&?{\s,"])sec_token["'\s:=]+([A-Za-z0-9_%-]+)/.exec(bodyText);
  if (!direct?.[1]) return null;
  try {
    return decodeURIComponent(direct[1]);
  } catch {
    return direct[1];
  }
}

/**
 * Extract the Alibaba console session credential from raw HAR file text.
 *
 * Scans every entry in `log.entries` (keeping the LAST match — freshest session
 * wins, same rule as the m365 extractor) looking for a console-host request
 * that carries the SSO ticket either in a `Cookie` request header or in the
 * structured `cookies[]` list, plus an optional `sec_token` from request body
 * or URL query.
 */
export function extractAlibabaConsoleCredentialFromHar(
  harText: string
): AlibabaConsoleHarImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(harText);
  } catch {
    return { ok: false, error: "notJson" };
  }
  if (!isRecord(parsed)) return { ok: false, error: "notJson" };
  const har = parsed as HarLike;

  const entries = har.log?.entries;
  if (!Array.isArray(entries)) {
    return { ok: false, error: "noEntries" };
  }

  let matchedCookie: string | null = null;
  let matchedSecToken: string | null = null;

  for (const entry of entries as HarEntryLike[]) {
    const url = toTrimmed(entry?.request?.url);
    if (!url) continue;

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      continue;
    }
    if (!isKnownConsoleHost(parsedUrl.hostname)) continue;

    // 1) Cookie header (a "Copy as cURL" Cookie header also lands here).
    let cookieFromHeaders: string | null = null;
    for (const header of entry?.request?.headers ?? []) {
      const name = asString(header?.name)?.toLowerCase();
      if (name !== "cookie") continue;
      const value = asString(header?.value);
      if (value && extractAlibabaTicketFromCookieHeader(value)) {
        cookieFromHeaders = value;
      }
    }

    // 2) Structured cookies[] (some exporters split the header).
    let cookieFromList: string | null = null;
    const parts: string[] = [];
    let hasTicket = false;
    for (const cookie of entry?.request?.cookies ?? []) {
      const cookieName = asString(cookie?.name);
      const cookieValue = asString(cookie?.value);
      if (!cookieName || !cookieValue) continue;
      parts.push(`${cookieName}=${cookieValue}`);
      if (cookieName.toLowerCase() === "login_aliyunid_ticket") hasTicket = true;
    }
    if (hasTicket && parts.length > 0) {
      cookieFromList = parts.join("; ");
    }

    const entryCookie = cookieFromHeaders ?? cookieFromList;
    if (!entryCookie) continue;

    // Keep the last (freshest) console match.
    matchedCookie = entryCookie;

    // 3) sec_token from POST body, then URL query.
    if (!matchedSecToken) {
      const bodyText = toTrimmed(entry?.request?.postData?.text);
      if (bodyText) matchedSecToken = extractSecTokenFromBody(bodyText);
    }
    if (!matchedSecToken) {
      matchedSecToken = parsedUrl.searchParams.get("sec_token");
    }
  }

  if (!matchedCookie) {
    return { ok: false, error: "noConsoleSession" };
  }

  return { ok: true, cookie: matchedCookie, secToken: matchedSecToken };
}

/**
 * Extract the same credential from a pasted "Copy as cURL (bash)" command.
 *
 * Handles `-b/--cookie` (bare cookie string), `Cookie:` via `-H/--header`, the
 * request body (`-d/--data/--data-raw`, for `sec_token=...`), single/double
 * quoting and bash line continuations. The command URL must be a console host
 * — this keeps plain site cookies from being mistaken for quota credentials.
 */
export function extractAlibabaConsoleCredentialFromCurl(
  curlText: string
): AlibabaConsoleHarImportResult {
  const text = toTrimmed(curlText);
  if (!text || !/^curl[\s-]/i.test(text)) return { ok: false, error: "notCurl" };

  // Bash line continuations + escaped quotes inside double-quoted strings.
  const normalized = text.replace(/\\\r?\n\s*/g, " ").replace(/\\"/g, '"');

  const urlMatch = /https?:\/\/([A-Za-z0-9.-]+)/.exec(normalized);
  let hostOk = false;
  if (urlMatch?.[1]) {
    try {
      hostOk = isKnownConsoleHost(new URL(`https://${urlMatch[1]}/`).hostname);
    } catch {
      hostOk = false;
    }
  }
  if (!hostOk) return { ok: false, error: "notConsoleRequest" };

  let cookie: string | null = null;
  let secToken: string | null = null;

  // -b/--cookie <header-string>
  const cookieFlagRe = /(?:^|\s)(?:-b|--cookie)\s+(?:"([^"]*)"|'([^']*)')/g;
  for (const match of normalized.matchAll(cookieFlagRe)) {
    const value = (match[1] ?? match[2] ?? "").trim();
    if (value && extractAlibabaTicketFromCookieHeader(value)) cookie = value;
  }
  // --cookie=$'...' / -b '...' single-token form without quotes was covered;
  // also accept unquoted single-pair form: --cookie login_aliyunid_ticket=xyz
  if (!cookie) {
    const bare = /(?:^|\s)(?:-b|--cookie)\s+(login_aliyunid_ticket=[^\s'"]+)/.exec(normalized);
    if (bare?.[1]) cookie = bare[1];
  }

  // Cookie / sec_token headers
  const headerRe = /(?:^|\s)(?:-H|--header)\s+(?:"([^"]*)"|'([^']*)')/g;
  for (const match of normalized.matchAll(headerRe)) {
    const headerValue = (match[1] ?? match[2] ?? "").trim();
    if (/^cookie\s*:/i.test(headerValue)) {
      const value = headerValue.replace(/^cookie\s*:\s*/i, "").trim();
      if (extractAlibabaTicketFromCookieHeader(value)) cookie = value;
    }
    const secHeader = /^sec_token\s*:\s*(\S+)\s*$/i.exec(headerValue);
    if (secHeader?.[1]) secToken = secHeader[1];
  }

  // sec_token from the request body (-d/--data/--data-raw/--form) or query.
  if (!secToken) {
    const dataMatch = /(?:^|\s)(?:--data-raw|--data|-d|--form|-F)\s+(?:"([^"]*)"|'([^']*)')/.exec(
      normalized
    );
    const body = dataMatch?.[1] ?? dataMatch?.[2] ?? "";
    if (body) secToken = extractSecTokenFromBody(body);
  }
  if (!secToken) {
    const querySec = /[?&]sec_token=([A-Za-z0-9_%-]+)/.exec(normalized);
    if (querySec?.[1]) secToken = querySec[1];
  }

  if (!cookie) return { ok: false, error: "missingCookie" };

  return { ok: true, cookie, secToken };
}

/**
 * Build the providerSpecificData patch from a successful import. Split out for
 * unit testing and reuse by both modal import buttons.
 */
export function buildAlibabaConsoleProviderDataPatch(
  cookie: string,
  secToken: string | null
): Record<string, string> {
  const patch: Record<string, string> = { alibabaConsoleCookie: cookie };
  if (secToken) patch.alibabaConsoleSecToken = secToken;
  return patch;
}