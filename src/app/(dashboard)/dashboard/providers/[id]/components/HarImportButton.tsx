"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  extractM365CredentialFromHar,
  describeHarImportExpiry,
  type M365HarImportResult,
} from "@/shared/utils/m365HarImport";
import {
  extractAlibabaConsoleCredentialFromHar,
  extractAlibabaConsoleCredentialFromCurl,
  type AlibabaConsoleHarImportResult,
} from "@/shared/utils/alibabaConsoleHarImport";
import { providerText, type ProviderMessageTranslator } from "../providerPageHelpers";

type HarImporter = (text: string) => M365HarImportResult;
type AlibabaImporter = (text: string) => AlibabaConsoleHarImportResult;

// One entry per web-session provider that can offer HAR import. Add a new
// key here (and its own extractor in src/shared/utils/) to support another
// provider — the button renders nothing for any provider not listed.
const HAR_IMPORTERS: Record<string, HarImporter> = {
  "copilot-m365-web": extractM365CredentialFromHar,
};

// Alibaba Model Studio connections take a console session (cookie + optional
// sec_token) instead of an apiKey; extractors return them separately and the
// modal's onImport patches providerSpecificData via the second callback type.
const ALIBABA_HAR_IMPORTERS: Record<string, AlibabaImporter> = {
  alibaba: extractAlibabaConsoleCredentialFromHar,
  "alibaba-cn": extractAlibabaConsoleCredentialFromHar,
};

const ALIBABA_CURL_IMPORTERS: Record<string, AlibabaImporter> = {
  alibaba: extractAlibabaConsoleCredentialFromCurl,
  "alibaba-cn": extractAlibabaConsoleCredentialFromCurl,
};

const isAlibabaImportProvider = (provider: string): boolean =>
  provider in ALIBABA_HAR_IMPORTERS;

const ERROR_MESSAGE_KEYS: Record<string, [string, string]> = {
  notJson: ["harImportErrorNotJson", "That file isn't valid JSON — is it really a .har export?"],
  noEntries: ["harImportErrorNoEntries", "This HAR has no network entries recorded."],
  notCurl: [
    "harImportErrorNotCurl",
    "That doesn't look like a cURL command — copy it with right-click → Copy → Copy as cURL (bash).",
  ],
  notConsoleRequest: [
    "alibabaConsoleImportErrorNotConsole",
    "This cURL command doesn't point at an Alibaba Model Studio console host.",
  ],
  missingCookie: [
    "alibabaConsoleImportErrorMissingCookie",
    "No login_aliyunid_ticket cookie found — make sure you're logged in to the console before copying the request.",
  ],
  noConsoleSession: [
    "alibabaConsoleImportErrorNoSession",
    "No logged-in console request found in this HAR. Open the Model Studio console (Free Quota page), then export the HAR.",
  ],
  noChathubUrl: [
    "harImportErrorNoChathubUrl",
    "No Copilot chat connection found in this HAR. Send at least one chat message in m365.cloud.microsoft before exporting.",
  ],
  unparsableUrl: [
    "harImportErrorUnparsableUrl",
    "Found the chat connection, but couldn't read its URL.",
  ],
  missingFields: [
    "harImportErrorMissingFields",
    "Found the chat connection, but the token was missing from it.",
  ],
};

const ALIBABA_ERROR_MESSAGE_KEYS = ERROR_MESSAGE_KEYS;

export interface HarImportButtonProps {
  provider: string;
  onImport: (apiKey: string) => void;
  /** Alibaba path: receives the extracted console session credential. */
  onImportAlibabaCredential?: (credential: { cookie: string; secToken: string | null }) => void;
}

export default function HarImportButton({
  provider,
  onImport,
  onImportAlibabaCredential,
}: HarImportButtonProps) {
  const t = useTranslations("providers") as ProviderMessageTranslator;
  const importer = HAR_IMPORTERS[provider];
  const alibabaImporter = ALIBABA_HAR_IMPORTERS[provider];
  const alibabaCurlImporter = ALIBABA_CURL_IMPORTERS[provider];
  const isAlibaba = isAlibabaImportProvider(provider);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const curlInputRef = useRef<HTMLTextAreaElement>(null);
  const [curlOpen, setCurlOpen] = useState(false);
  const [curlText, setCurlText] = useState("");
  const [state, setState] = useState<
    | { phase: "idle" }
    | { phase: "reading" }
    | { phase: "error"; message: string }
    | { phase: "success"; expiresAt: number | null }
    | { phase: "success-session"; detail: string }
  >({ phase: "idle" });

  if (!importer && !isAlibaba) return null;

  function reportAlibabaImport(result: AlibabaConsoleHarImportResult) {
    if (result.ok === false) {
      const [key, fallback] = ALIBABA_ERROR_MESSAGE_KEYS[result.error] ?? [
        "harImportErrorUnknown",
        "Couldn't extract a credential from that HAR file.",
      ];
      setState({ phase: "error", message: providerText(t, key, fallback) });
      return;
    }
    onImportAlibabaCredential?.({
      cookie: result.cookie,
      secToken: result.secToken,
    });
    const detail = result.secToken
      ? "Imported console cookie + sec_token."
      : "Imported console cookie (no sec_token found).";
    setState({ phase: "success-session", detail });
  }

  function handleSubmitCurl() {
    if (!alibabaCurlImporter) return;
    const result = alibabaCurlImporter(curlText);
    reportAlibabaImport(result);
    if (result.ok) {
      setCurlOpen(false);
      setCurlText("");
    }
  }

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setState({ phase: "reading" });
    let text: string;
    try {
      text = await file.text();
    } catch {
      setState({
        phase: "error",
        message: providerText(t, "harImportErrorReadFailed", "Couldn't read that file."),
      });
      return;
    }

    if (isAlibaba && alibabaImporter) {
      reportAlibabaImport(alibabaImporter(text));
      return;
    }

    if (!importer) return;
    const result = importer(text);
    if (result.ok === false) {
      const [key, fallback] = ERROR_MESSAGE_KEYS[result.error] ?? [
        "harImportErrorUnknown",
        "Couldn't extract a credential from that HAR file.",
      ];
      setState({ phase: "error", message: providerText(t, key, fallback) });
      return;
    }

    onImport(result.apiKey);
    setState({ phase: "success", expiresAt: result.expiresAt });
  }

  const expiry = state.phase === "success" ? describeHarImportExpiry(state.expiresAt) : null;
  const expiryText =
    expiry?.tone === "unknown"
      ? providerText(t, "harImportStatusUnknownExpiry", "Imported. Couldn't read its expiry.")
      : expiry?.tone === "bad"
        ? providerText(
            t,
            "harImportStatusExpired",
            "Imported, but this token already expired ({minutes}m ago) — export a fresh HAR.",
            { minutes: Math.abs(expiry.minutesRemaining ?? 0) }
          )
        : expiry?.tone === "warn"
          ? providerText(
              t,
              "harImportStatusExpiringSoon",
              "Imported — valid for only ~{minutes}m more.",
              { minutes: expiry.minutesRemaining ?? 0 }
            )
          : expiry?.tone === "ok"
            ? providerText(t, "harImportStatusValid", "Imported — valid for ~{minutes}m.", {
                minutes: expiry.minutesRemaining ?? 0,
              })
            : null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={state.phase === "reading"}
          data-testid="har-import-button"
          className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-xs font-medium text-text-main hover:bg-surface-hover disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
            upload_file
          </span>
          {state.phase === "reading"
            ? providerText(t, "harImportButtonBusy", "Importing…")
            : isAlibaba
              ? providerText(
                  t,
                  "alibabaConsoleImportHarLabel",
                  "Import .har (console session)"
                )
              : providerText(t, "harImportButtonLabel", "Import .har file")}
        </button>
        {isAlibaba && alibabaCurlImporter && (
          <button
            type="button"
            onClick={() => setCurlOpen((open) => !open)}
            data-testid="alibaba-curl-toggle"
            className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-xs font-medium text-text-main hover:bg-surface-hover"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
              content_paste
            </span>
            {providerText(t, "alibabaConsoleImportCurlLabel", "Paste cURL")}
          </button>
        )}
        <span className="text-xs text-text-muted">
          {isAlibaba
            ? providerText(
                t,
                "alibabaConsoleImportHint",
                "On the Model Studio console (Free Quota page): right-click any request → Copy → Copy as cURL, then paste here. Or export a .har from the Network tab."
              )
            : providerText(
                t,
                "harImportButtonHint",
                "Export from DevTools Network tab after sending at least one chat message."
              )}
        </span>
        <input
          ref={fileInputRef}
          type="file"
          accept=".har,application/json"
          data-testid="har-import-input"
          className="hidden"
          onChange={(event) => {
            void handleFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </div>
      {isAlibaba && curlOpen && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-border/50 bg-surface/20 p-3">
          <textarea
            ref={curlInputRef}
            value={curlText}
            onChange={(event) => setCurlText(event.target.value)}
            placeholder="curl 'https://bailian-singapore-cs.alibabacloud.com/data/api.json?...' -H 'cookie: login_aliyunid_ticket=…' --data 'sec_token=…'"
            rows={4}
            data-testid="alibaba-curl-input"
            className="w-full rounded border border-border bg-surface px-2 py-1.5 font-mono text-xs text-text-main outline-none focus:border-primary"
            spellCheck={false}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSubmitCurl}
              disabled={!curlText.trim()}
              data-testid="alibaba-curl-submit"
              className="rounded bg-primary px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
            >
              {providerText(t, "alibabaConsoleImportCurlSubmit", "Import session")}
            </button>
          </div>
        </div>
      )}
      {state.phase === "error" && (
        <p className="text-xs text-red-600 dark:text-red-400" data-testid="har-import-error">
          {state.message}
        </p>
      )}
      {state.phase === "success-session" && (
        <p
          className="text-xs text-emerald-700 dark:text-emerald-300"
          data-testid="har-import-status"
        >
          {state.detail}
        </p>
      )}
      {state.phase === "success" && expiryText && (
        <p
          className={
            expiry?.tone === "bad"
              ? "text-xs text-red-600 dark:text-red-400"
              : expiry?.tone === "warn"
                ? "text-xs text-amber-700 dark:text-amber-300"
                : "text-xs text-emerald-700 dark:text-emerald-300"
          }
          data-testid="har-import-status"
        >
          {expiryText}
        </p>
      )}
    </div>
  );
}
