/**
 * @file alibaba-console-har-import.test.ts
 * @description Unit tests for the Alibaba Model Studio console session import
 * extractors (HAR + cURL paste) in src/shared/utils/alibabaConsoleHarImport.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  extractAlibabaConsoleCredentialFromHar,
  extractAlibabaConsoleCredentialFromCurl,
  extractAlibabaTicketFromCookieHeader,
  buildAlibabaConsoleProviderDataPatch,
  ALIBABA_CONSOLE_HOSTS,
} from "../../src/shared/utils/alibabaConsoleHarImport.ts";

const TICKET = "b3f2c1a9_SSO_TICKET_0123456789";
const FULL_COOKIE = `cna=abc123; login_aliyunid_ticket=${TICKET}; t=deadbeef; csrf=xyz`;
const SEC_TOKEN = "sec_abcDEF123-_token";
const CONSOLE_URL = `https://${ALIBABA_CONSOLE_HOSTS[0]}/data/api.json?action=IntlBroadScopeAspnGateway&product=sfm_bailian`;

function harWithEntries(entries: unknown[]): string {
  return JSON.stringify({ log: { entries } });
}

// ---------------------------------------------------------------------------
// Cookie header parsing
// ---------------------------------------------------------------------------

test("extractAlibabaTicketFromCookieHeader finds the SSO ticket among pairs", () => {
  assert.equal(extractAlibabaTicketFromCookieHeader(FULL_COOKIE), TICKET);
  assert.equal(extractAlibabaTicketFromCookieHeader("login_aliyunid_ticket=only"), "only");
  assert.equal(extractAlibabaTicketFromCookieHeader("other=1; two=2"), null);
  assert.equal(extractAlibabaTicketFromCookieHeader("login_aliyunid_ticket="), null);
});

test("extractAlibabaTicketFromCookieHeader keeps value with = inside", () => {
  assert.equal(
    extractAlibabaTicketFromCookieHeader("login_aliyunid_ticket=a=b==c"),
    "a=b==c"
  );
});

// ---------------------------------------------------------------------------
// HAR extraction
// ---------------------------------------------------------------------------

test("extracts cookie + sec_token from a console request entry (Cookie header + body)", () => {
  const har = harWithEntries([
    {
      request: {
        url: CONSOLE_URL,
        headers: [{ name: "Cookie", value: FULL_COOKIE }],
        postData: { text: `action=IntlBroadScopeAspnGateway&sec_token=${SEC_TOKEN}&product=sfm_bailian` },
      },
    },
  ]);
  const result = extractAlibabaConsoleCredentialFromHar(har);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.cookie, FULL_COOKIE);
  assert.equal(result.secToken, SEC_TOKEN);
});

test("accepts structured cookies[] entries when headers are absent", () => {
  const har = harWithEntries([
    {
      request: {
        url: CONSOLE_URL,
        cookies: [
          { name: "cna", value: "abc" },
          { name: "login_aliyunid_ticket", value: TICKET },
        ],
      },
    },
  ]);
  const result = extractAlibabaConsoleCredentialFromHar(har);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.cookie, `cna=abc; login_aliyunid_ticket=${TICKET}`);
  assert.equal(result.secToken, null);
});

test("takes sec_token from query when the body has none", () => {
  const har = harWithEntries([
    {
      request: {
        url: `${CONSOLE_URL}&sec_token=${SEC_TOKEN}`,
        headers: [{ name: "cookie", value: `login_aliyunid_ticket=${TICKET}` }],
      },
    },
  ]);
  const result = extractAlibabaConsoleCredentialFromHar(har);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.cookie, `login_aliyunid_ticket=${TICKET}`);
  assert.equal(result.secToken, SEC_TOKEN);
});

test("picks the LAST console entry (freshest session wins)", () => {
  const oldTicket = `login_aliyunid_ticket=OLD`;
  const newTicket = `login_aliyunid_ticket=NEW`;
  const har = harWithEntries([
    {
      request: {
        url: CONSOLE_URL,
        headers: [{ name: "Cookie", value: oldTicket }],
      },
    },
    { request: { url: "https://unrelated.example/api" } },
    {
      request: {
        url: CONSOLE_URL,
        headers: [{ name: "Cookie", value: newTicket }],
      },
    },
  ]);
  const result = extractAlibabaConsoleCredentialFromHar(har);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.cookie, newTicket);
});

test("ignores login pages on non-console Alibaba hosts", () => {
  const har = harWithEntries([
    {
      request: {
        url: "https://www.alibabacloud.com/help?sec_token=x",
        headers: [{ name: "Cookie", value: `login_aliyunid_ticket=${TICKET}` }],
      },
    },
  ]);
  const result = extractAlibabaConsoleCredentialFromHar(har);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "noConsoleSession");
});

test("returns notJson / noEntries for malformed HARs", () => {
  assert.equal(extractAlibabaConsoleCredentialFromHar("not json{").ok, false);
  const result = extractAlibabaConsoleCredentialFromHar(JSON.stringify({ log: {} }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "noEntries");
});

test("returns noConsoleSession when console entries lack the ticket", () => {
  const har = harWithEntries([
    {
      request: {
        url: CONSOLE_URL,
        headers: [{ name: "Cookie", value: "cna=only; t=x" }],
      },
    },
  ]);
  const result = extractAlibabaConsoleCredentialFromHar(har);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "noConsoleSession");
});

// ---------------------------------------------------------------------------
// cURL extraction
// ---------------------------------------------------------------------------

test("extracts cookie from -H Cookie header and sec_token from --data-raw", () => {
  const curl = `curl 'https://${ALIBABA_CONSOLE_HOSTS[0]}/data/api.json?action=IntlBroadScopeAspnGateway&product=sfm_bailian&api=zeldaEasy.bailian-commerce.freeTrial.queryFreeTierQuotaAsyn' \\
  -H 'accept: application/json' \\
  -H 'cookie: ${FULL_COOKIE}' \\
  --data-raw 'action=IntlBroadScopeAspnGateway&product=sfm_bailian&sec_token=${SEC_TOKEN}&ticket=...'`;
  const result = extractAlibabaConsoleCredentialFromCurl(curl);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.cookie, FULL_COOKIE);
  assert.equal(result.secToken, SEC_TOKEN);
});

test("extracts cookie from single-quoted --header form", () => {
  const curl = `curl 'https://bailian.console.aliyun.com/x' -H 'Cookie: login_aliyunid_ticket=${TICKET}'`;
  const result = extractAlibabaConsoleCredentialFromCurl(curl);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(
    result.cookie,
    `Cookie: login_aliyunid_ticket=${TICKET}`.replace(/^Cookie:\s*/i, "")
  );
  assert.equal(result.secToken, null);
});

test("extracts cookie from -b/--cookie flag", () => {
  const curl = `curl 'https://${ALIBABA_CONSOLE_HOSTS[0]}/data/api.json' -b 'login_aliyunid_ticket=${TICKET}'`;
  const result = extractAlibabaConsoleCredentialFromCurl(curl);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.cookie, `login_aliyunid_ticket=${TICKET}`);
});

test("extracts sec_token from sec_token header", () => {
  const curl = `curl 'https://${ALIBABA_CONSOLE_HOSTS[0]}/x' -H 'Cookie: login_aliyunid_ticket=${TICKET}' -H 'sec_token: ${SEC_TOKEN}'`;
  const result = extractAlibabaConsoleCredentialFromCurl(curl);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.secToken, SEC_TOKEN);
});

test("rejects non-console hosts (notConsoleRequest)", () => {
  const curl = `curl 'https://evil.example.com/steal' -H 'Cookie: login_aliyunid_ticket=${TICKET}'`;
  const result = extractAlibabaConsoleCredentialFromCurl(curl);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "notConsoleRequest");
});

test("rejects non-curl input", () => {
  assert.equal(extractAlibabaConsoleCredentialFromCurl("GET / HTTP/1.1").ok, false);
  assert.equal(extractAlibabaConsoleCredentialFromCurl("").ok, false);
});

test("reports missingCookie when a console cURL has no ticket", () => {
  const curl = `curl 'https://${ALIBABA_CONSOLE_HOSTS[0]}/x' -H 'accept: application/json'`;
  const result = extractAlibabaConsoleCredentialFromCurl(curl);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "missingCookie");
});

// ---------------------------------------------------------------------------
// Provider-data patch builder
// ---------------------------------------------------------------------------

test("buildAlibabaConsoleProviderDataPatch omits secToken when null", () => {
  assert.deepEqual(buildAlibabaConsoleProviderDataPatch(FULL_COOKIE, null), {
    alibabaConsoleCookie: FULL_COOKIE,
  });
  assert.deepEqual(buildAlibabaConsoleProviderDataPatch(FULL_COOKIE, SEC_TOKEN), {
    alibabaConsoleCookie: FULL_COOKIE,
    alibabaConsoleSecToken: SEC_TOKEN,
  });
});