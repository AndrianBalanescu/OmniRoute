import { handleAudioSpeech } from "@omniroute/open-sse/handlers/audioSpeech.ts";
import { withInjectionGuard } from "@/middleware/promptInjectionGuard";
import {
  getProviderCredentialsWithQuotaPreflight,
  clearRecoveredProviderState,
} from "@/sse/services/auth";
import { parseSpeechModel, getSpeechProvider } from "@omniroute/open-sse/config/audioRegistry.ts";
import { resolveDynamicAudioProviders } from "@/app/api/v1/_shared/audioProviderNodes";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { v1AudioSpeechSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import {
  isAllRateLimitedCredentials,
  rateLimitedProviderResponse,
} from "@/app/api/v1/_shared/rateLimit";
import { attachOmniRouteMetaToResponse } from "@/domain/omnirouteResponseMeta";
import { calculateModalCost } from "@/lib/usage/costCalculator";
import { saveRequestUsage, saveCallLog } from "@/lib/usageDb";
import { generateRequestId } from "@/shared/utils/requestId";

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
 * POST /v1/audio/speech — text-to-speech
 * OpenAI TTS API compatible. Returns audio stream.
 */
async function postHandler(request, context) {
  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const validation = validateBody(v1AudioSpeechSchema, rawBody);
  if (isValidationFailure(validation)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, validation.error.message);
  }
  const body = validation.data;
  const startTime = Date.now();

  // Enforce API key policies (model restrictions + budget limits)
  const policy = await enforceApiKeyPolicy(request, body.model);
  if (policy.rejection) return policy.rejection;
  const apiKeyInfo = policy.apiKeyInfo;

  // Detect a combo name and divert to full speech combo execution, mirroring
  // the images route. Checks before parseSpeechModel so a combo name is never
  // rejected as an invalid `provider/model` id — /v1/models advertises these
  // names, so refusing them here made the catalogue dishonest.
  if (body.model && typeof body.model === "string" && !body.model.includes("/")) {
    const { getComboByName } = await import("@/lib/db/combos");
    const combo = await getComboByName(body.model);
    if (combo) {
      const { executeSpeechCombo } = await import("@omniroute/open-sse/services/speechCombo");
      return executeSpeechCombo(body.model, body, startTime);
    }
  }

  // Provider nodes eligible for speech: this route's own audio type plus general
  // chat/responses gateways. Remote hosts are opt-in (default OFF).
  const dynamicProviders = await resolveDynamicAudioProviders("/audio/speech", "audio-speech");

  const { provider, model: resolvedModel } = parseSpeechModel(body.model, dynamicProviders);
  if (!provider) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Invalid speech model: ${body.model}. Use format: provider/model`
    );
  }

  // Check provider config — hardcoded first, then dynamic
  const providerConfig =
    getSpeechProvider(provider) || dynamicProviders.find((dp) => dp.id === provider) || null;

  // Get credentials — skip for local providers (authType: "none")
  let credentials = null;
  if (providerConfig && providerConfig.authType !== "none") {
    const credentialKey = providerConfig.credentialProviderId || provider;
    credentials = await getProviderCredentialsWithQuotaPreflight(credentialKey);
    if (!credentials) {
      return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
    }
    if (isAllRateLimitedCredentials(credentials)) {
      return rateLimitedProviderResponse(provider, credentials);
    }
  }

  let response = await handleAudioSpeech({
    body,
    credentials,
    resolvedProvider: providerConfig,
    resolvedModel,
  });
  if (response?.ok) {
    await clearRecoveredProviderState(credentials);
    // TTS is billed per input character; attach cost telemetry without
    // touching the audio Content-Type / body (ADD-only headers).
    const characters = typeof body.input === "string" ? body.input.length : 0;
    const costUsd = await calculateModalCost("audio", provider, resolvedModel || body.model, {
      characters,
    });
    response = attachOmniRouteMetaToResponse(response, {
      provider,
      model: resolvedModel || body.model,
      costUsd,
      latencyMs: Date.now() - startTime,
      requestId: generateRequestId(),
    });

    // Persist to call_logs for real-time overview/request logs
    saveCallLog({
      method: "POST",
      path: "/v1/audio/speech",
      status: response.status || 200,
      model: `${provider}/${resolvedModel || body.model}`,
      provider,
      connectionId: (credentials as { connectionId?: string } | null)?.connectionId || undefined,
      duration: Date.now() - startTime,
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      requestBody: {
        model: body.model,
        input: typeof body.input === "string" ? body.input : undefined,
        voice: body.voice,
        response_format: body.response_format,
        speed: body.speed,
      },
      responseBody: { type: "audio", characters },
      apiKeyId: (apiKeyInfo as { id?: string } | null | undefined)?.id || undefined,
      apiKeyName: (apiKeyInfo as { name?: string } | null | undefined)?.name || undefined,
    }).catch(() => {});

    // Persist to usage_history so TTS traffic shows up in usage analytics and
    // the per-api-key usage counter (mirrors the chat/embedding paths). Billed
    // by input characters; tokens are 0 for audio.
    saveRequestUsage({
      provider,
      model: `${provider}/${resolvedModel || body.model}`,
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      inputCharacters: characters,
      status: "200",
      success: true,
      latencyMs: Date.now() - startTime,
      apiKeyId: (apiKeyInfo as { id?: string } | null | undefined)?.id || undefined,
      apiKeyName: (apiKeyInfo as { name?: string } | null | undefined)?.name || undefined,
      connectionId: (credentials as { connectionId?: string } | null)?.connectionId || undefined,
      endpoint: "/v1/audio/speech",
    }).catch((err) => {
      console.error("Failed to save TTS usage stats:", err.message);
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
      path: "/v1/audio/speech",
      status: response.status || 500,
      model: `${provider}/${resolvedModel || body.model}`,
      provider,
      connectionId: (credentials as { connectionId?: string } | null)?.connectionId || undefined,
      duration: Date.now() - startTime,
      requestBody: {
        model: body.model,
        input: typeof body.input === "string" ? body.input : undefined,
        voice: body.voice,
      },
      responseBody: errData,
      error: errMessage,
      apiKeyId: (apiKeyInfo as { id?: string } | null | undefined)?.id || undefined,
      apiKeyName: (apiKeyInfo as { name?: string } | null | undefined)?.name || undefined,
    }).catch(() => {});
  }
  return response;
}

export const POST = withInjectionGuard(postHandler);
