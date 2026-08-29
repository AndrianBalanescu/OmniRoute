// Allow large audio/video file uploads — 5min for processing large files (up to 2GB)
export const maxDuration = 300;
import { handleAudioTranscription } from "@omniroute/open-sse/handlers/audioTranscription.ts";
import {
  getProviderCredentialsWithQuotaPreflight,
  clearRecoveredProviderState,
} from "@/sse/services/auth";
import {
  parseTranscriptionModel,
  getTranscriptionProvider,
  audioModelAliasCandidates,
  findAlternateAudioProvider,
  listAlternateAudioModelIds,
  missingAudioProviderCredentialsMessage,
  AUDIO_TRANSCRIPTION_PROVIDERS,
} from "@omniroute/open-sse/config/audioRegistry.ts";
import { resolveDynamicAudioProviders } from "@/app/api/v1/_shared/audioProviderNodes";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import {
  isAllRateLimitedCredentials,
  rateLimitedProviderResponse,
} from "@/app/api/v1/_shared/rateLimit";
import { attachOmniRouteMetaToResponse } from "@/domain/omnirouteResponseMeta";
import { generateRequestId } from "@/shared/utils/requestId";
import { getComboByName, getCombos, getDatabaseSettings } from "@/lib/localDb";
import { handleComboChat } from "@omniroute/open-sse/services/combo.ts";
import { log } from "@omniroute/open-sse/utils/logger.ts";
import { getAudioDurationSeconds } from "@omniroute/open-sse/utils/audioDuration.ts";
import { calculateModalCost } from "@/lib/usage/costCalculator";
import { saveRequestUsage, saveCallLog } from "@/lib/usageDb";

/**
 * Copy a multipart body, swapping only the `model` field. Combo fan-out needs one
 * body per target, and the uploaded file part is reused as-is (a Blob can be read
 * more than once).
 */
function withModel(formData: FormData, modelStr: string): FormData {
  const next = new FormData();
  for (const [key, value] of formData.entries()) {
    if (key === "model") continue;
    next.append(key, value as string | Blob);
  }
  next.set("model", modelStr);
  return next;
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * Transcribe with one concrete `provider/model` string. Split out of POST so combo
 * fan-out can invoke it once per target.
 */
async function transcribeWithModel(
  formData: FormData,
  modelStr: string,
  startTime: number,
  apiKeyInfo?: { id?: string; name?: string } | null
): Promise<Response> {
  // Provider nodes eligible for transcription: this route's own audio type plus
  // general chat/responses gateways. Remote hosts are opt-in (default OFF).
  const dynamicProviders = await resolveDynamicAudioProviders(
    "/audio/transcriptions",
    "audio-transcriptions"
  );

  const parsed = parseTranscriptionModel(modelStr, dynamicProviders);
  let provider = parsed.provider;
  let resolvedModel = parsed.model;
  if (!provider) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Invalid transcription model: ${modelStr}. Use format: provider/model`
    );
  }

  // Check provider config — hardcoded first, then dynamic
  let providerConfig =
    getTranscriptionProvider(provider) || dynamicProviders.find((dp) => dp.id === provider) || null;

  // Get credentials — skip for local providers (authType: "none").
  // A dynamic node is addressed by its prefix but stores connections under the node
  // id, so credentials must be looked up under `credentialProviderId` when present.
  let credentials = null;
  if (providerConfig && providerConfig.authType !== "none") {
    const credentialKey = providerConfig.credentialProviderId || provider;
    // NOTE: the 2nd arg of this helper is `excludeConnectionId`, not "use this
    // connection" — a combo target's connectionId must never be passed here.
    credentials = await getProviderCredentialsWithQuotaPreflight(credentialKey);
    // Prefix match wins (`deepgram/nova-3` → native Deepgram). If that
    // provider has no credentials, retry gateways that list the same nested
    // model id (e.g. OpenRouter's `deepgram/nova-3`).
    if (!credentials) {
      const candidates = audioModelAliasCandidates(modelStr, provider, resolvedModel);
      const alternate = findAlternateAudioProvider(
        AUDIO_TRANSCRIPTION_PROVIDERS,
        provider,
        candidates
      );
      if (alternate) {
        const alternateCredentials = await getProviderCredentialsWithQuotaPreflight(
          alternate.provider
        );
        if (alternateCredentials && !isAllRateLimitedCredentials(alternateCredentials)) {
          provider = alternate.provider;
          resolvedModel = alternate.model;
          providerConfig = alternate.config;
          credentials = alternateCredentials;
        }
      }
    }
    if (!credentials) {
      const candidates = audioModelAliasCandidates(modelStr, provider, resolvedModel);
      return errorResponse(
        HTTP_STATUS.BAD_REQUEST,
        missingAudioProviderCredentialsMessage(
          provider,
          listAlternateAudioModelIds(AUDIO_TRANSCRIPTION_PROVIDERS, provider, candidates)
        )
      );
    }
    if (isAllRateLimitedCredentials(credentials)) {
      return rateLimitedProviderResponse(provider, credentials);
    }
  }

  let response = await handleAudioTranscription({
    formData,
    credentials,
    resolvedProvider: providerConfig,
    resolvedModel,
  });
  if (response?.ok) {
    await clearRecoveredProviderState(credentials);
    // Extract real audio duration from the uploaded file (WAV exact, MP3
    // best-effort) so per-second pricing/usage is possible — the multipart
    // upload carries no duration header, which previously forced cost 0 and
    // left STT untracked in usage analytics.
    const file = formData.get("file");
    const seconds =
      file instanceof Blob ? await getAudioDurationSeconds(file).catch(() => null) : null;
    const costUsd = await calculateModalCost("audio", provider, resolvedModel || modelStr, {
      ...(seconds != null ? { seconds } : {}),
    });

    // No text body available from the multipart upload, but duration is — attach
    // ADD-only meta headers without touching the response body.
    response = attachOmniRouteMetaToResponse(response, {
      provider,
      model: resolvedModel || modelStr,
      costUsd,
      latencyMs: Date.now() - startTime,
      requestId: generateRequestId(),
    });

    // Persist to call_logs for real-time overview/request logs
    const resClone = response.clone();
    const resData = (await resClone.json().catch(() => ({}))) as Record<string, unknown>;
    const responseSeconds =
      typeof resData?.duration === "number" && resData.duration > 0
        ? resData.duration
        : Array.isArray(resData?.segments) && resData.segments.length > 0
          ? (resData.segments[resData.segments.length - 1] as { end?: number })?.end
          : null;
    const finalSeconds =
      seconds != null && seconds > 0
        ? seconds
        : typeof responseSeconds === "number" && responseSeconds > 0
          ? responseSeconds
          : null;

    saveCallLog({
      method: "POST",
      path: "/v1/audio/transcriptions",
      status: response.status || 200,
      model: `${provider}/${resolvedModel || modelStr}`,
      provider,
      connectionId: (credentials as { connectionId?: string } | null)?.connectionId || undefined,
      duration: Date.now() - startTime,
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      requestBody: {
        model: modelStr,
        prompt: typeof formData.get("prompt") === "string" ? formData.get("prompt") : undefined,
        language:
          typeof formData.get("language") === "string" ? formData.get("language") : undefined,
        response_format:
          typeof formData.get("response_format") === "string"
            ? formData.get("response_format")
            : undefined,
        temperature:
          typeof formData.get("temperature") === "string" ? formData.get("temperature") : undefined,
        filename: file instanceof Blob ? (file as { name?: string }).name : undefined,
        duration_seconds: finalSeconds,
      },
      responseBody: resData,
      apiKeyId: apiKeyInfo?.id || undefined,
      apiKeyName: apiKeyInfo?.name || undefined,
    }).catch(() => {});

    // Persist to usage_history so STT traffic shows up in usage analytics and
    // the per-api-key usage counter. Billed by audio seconds; tokens are 0.
    saveRequestUsage({
      provider,
      model: `${provider}/${resolvedModel || modelStr}`,
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      durationSeconds: finalSeconds,
      status: "200",
      success: true,
      latencyMs: Date.now() - startTime,
      apiKeyId: apiKeyInfo?.id || undefined,
      apiKeyName: apiKeyInfo?.name || undefined,
      connectionId: (credentials as { connectionId?: string } | null)?.connectionId || undefined,
      endpoint: "/v1/audio/transcriptions",
    }).catch((err) => {
      console.error("Failed to save STT usage stats:", err.message);
    });
  } else if (response) {
    const errClone = response.clone();
    const errData = await errClone.json().catch(() => ({}));
    const errMessage =
      (errData as { error?: { message?: string } })?.error?.message ||
      (errData as { message?: string })?.message ||
      `HTTP ${response.status}`;
    saveCallLog({
      method: "POST",
      path: "/v1/audio/transcriptions",
      status: response.status || 500,
      model: `${provider}/${resolvedModel || modelStr}`,
      provider,
      connectionId: (credentials as { connectionId?: string } | null)?.connectionId || undefined,
      duration: Date.now() - startTime,
      requestBody: {
        model: modelStr,
        prompt: typeof formData.get("prompt") === "string" ? formData.get("prompt") : undefined,
        language:
          typeof formData.get("language") === "string" ? formData.get("language") : undefined,
      },
      responseBody: errData,
      error: errMessage,
      apiKeyId: apiKeyInfo?.id || undefined,
      apiKeyName: apiKeyInfo?.name || undefined,
    }).catch(() => {});
  }
  return response;
}

/**
 * POST /v1/audio/transcriptions — transcribe audio files
 * OpenAI Whisper API compatible (multipart/form-data)
 */
export async function POST(request) {
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid multipart form data");
  }

  const startTime = Date.now();

  const model = formData.get("model");
  if (!model) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }
  const modelStr = String(model);

  // Enforce API key policies (model restrictions + budget limits)
  const policy = await enforceApiKeyPolicy(request, modelStr);
  if (policy.rejection) return policy.rejection;
  const apiKeyInfo = policy.apiKeyInfo as { id?: string; name?: string } | null;

  // A bare name (no "/") may be a combo. /v1/models advertises combos, and chat and
  // embeddings both resolve them — resolving here too keeps the catalog honest and
  // frees callers from hardcoding a provider's internal model id.
  if (!modelStr.includes("/")) {
    try {
      const combo = await getComboByName(modelStr);
      if (combo) {
        let allCombos: Awaited<ReturnType<typeof getCombos>> = [];
        try {
          allCombos = await getCombos();
        } catch {}
        let settings = {};
        try {
          settings = getDatabaseSettings();
        } catch {}

        return handleComboChat({
          body: { model: modelStr } as any,
          combo: combo as any,
          handleSingleModel: async (_reqBody: any, targetModelStr: string) =>
            transcribeWithModel(
              withModel(formData, targetModelStr),
              targetModelStr,
              startTime,
              apiKeyInfo
            ),
          isModelAvailable: undefined,
          log,
          settings,
          allCombos: allCombos as any,
          relayOptions: undefined,
          signal: undefined,
        } as any);
      }
    } catch (err) {
      log.error("AUDIO", `Combo resolution failed for ${modelStr}: ${err}`);
    }
  }

  return transcribeWithModel(formData, modelStr, startTime, apiKeyInfo);
}
