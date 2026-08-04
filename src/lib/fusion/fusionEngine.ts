/**
 * @file fusionEngine.ts
 * @description Native Multi-Engine Fusion Orchestrator for OmniRoute.
 * Runs parallel search/reasoning engines (with per-engine fallbacks) and synthesizes raw results via a synthesizer model (with synthesizer fallback).
 */

import {
  getFusionStrategyByName,
  getFusionStrategies,
  type FusionStrategy,
  type FusionEngineItem,
} from "../db/fusionStrategies";
import * as log from "@/sse/utils/logger";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";

export function isFusionModel(modelStr: string): boolean {
  if (!modelStr) return false;
  if (modelStr.startsWith("fusion/")) return true;
  const strategy = getFusionStrategyByName(modelStr);
  return Boolean(strategy);
}

export function getAllFusionModelNames(): string[] {
  const strategies = getFusionStrategies(true);
  const names = new Set<string>();

  // Default virtual models
  names.add("fusion/web-research-pro");
  names.add("fusion/code-audit");
  names.add("fusion/deep-reasoning");

  for (const s of strategies) {
    names.add(s.name);
  }
  return Array.from(names);
}

interface EngineResult {
  engine: string;
  fallbackUsed?: string;
  success: boolean;
  content: string;
  latencyMs: number;
  error?: string;
}

async function callSingleEngine(
  engineModel: string,
  messages: any[],
  baseUrl: string,
  headers: Headers,
  timeoutMs = 45000
): Promise<EngineResult> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs); // Default 45s cutoff per engine

    const passHeaders: Record<string, string> = {
      "content-type": "application/json",
      "x-omniroute-fusion-internal": "true",
    };

    const authHeader = headers.get("authorization");
    if (authHeader) passHeaders["authorization"] = authHeader;

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: passHeaders,
      body: JSON.stringify({
        model: engineModel,
        messages: messages,
        stream: false,
        max_tokens: 2048,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const latencyMs = Date.now() - start;

    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      return {
        engine: engineModel,
        success: false,
        content: "",
        latencyMs,
        error: `HTTP ${res.status}: ${errText.slice(0, 200)}`,
      };
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "";
    return {
      engine: engineModel,
      success: true,
      content,
      latencyMs,
    };
  } catch (err: any) {
    return {
      engine: engineModel,
      success: false,
      content: "",
      latencyMs: Date.now() - start,
      error:
        err.name === "AbortError"
          ? `Timeout (${Math.round(timeoutMs / 1000)}s)`
          : err.message || "Failed request",
    };
  }
}

async function callSubEngineItem(
  item: FusionEngineItem,
  messages: any[],
  baseUrl: string,
  headers: Headers,
  timeoutMs = 45000,
  onProgress?: (evt: any) => void
): Promise<EngineResult> {
  const primaryModel = typeof item === "string" ? item : item.model;
  const fallbackModel = typeof item === "string" ? undefined : item.fallback;

  onProgress?.({ type: "engine_start", engine: primaryModel });

  const res = await callSingleEngine(primaryModel, messages, baseUrl, headers, timeoutMs);

  onProgress?.({
    type: "engine_done",
    engine: primaryModel,
    success: res.success,
    latency_ms: res.latencyMs,
    error: res.error,
  });

  if (res.success || !fallbackModel) {
    return res;
  }

  log.warn(
    "FUSION",
    `Engine '${primaryModel}' failed (${res.error}). Attempting fallback '${fallbackModel}'...`
  );
  onProgress?.({ type: "engine_start", engine: fallbackModel, isFallback: true });

  const fallbackRes = await callSingleEngine(fallbackModel, messages, baseUrl, headers, timeoutMs);
  fallbackRes.fallbackUsed = fallbackModel;
  fallbackRes.engine = `${primaryModel} ➔ ${fallbackModel}`;

  onProgress?.({
    type: "engine_done",
    engine: fallbackModel,
    success: fallbackRes.success,
    latency_ms: fallbackRes.latencyMs,
    error: fallbackRes.error,
    fallbackUsed: fallbackModel,
  });

  return fallbackRes;
}
export async function handleFusionChat(
  request: Request,
  body: any,
  modelStr: string
): Promise<Response> {
  const reqStart = Date.now();
  let strategy = getFusionStrategyByName(modelStr);

  if (!strategy && modelStr.startsWith("fusion/")) {
    strategy = {
      id: `dynamic_${Date.now()}`,
      name: modelStr,
      description: "Dynamic auto-configured fusion strategy",
      engines: ["sonar", "felo"],
      synthesizer: "paid-premium",
      systemPrompt: "Synthesize the multi-engine search results into a concise, accurate answer.",
      enabled: true,
    };
  }

  if (!strategy) {
    return errorResponse(
      HTTP_STATUS.NOT_FOUND,
      `Fusion strategy '${modelStr}' not found or disabled.`
    );
  }

  log.info(
    "FUSION",
    `Executing strategy '${strategy.name}' with ${strategy.engines.length} engines -> ${strategy.synthesizer}`
  );

  const host = request.headers.get("host") || "127.0.0.1:20128";
  const protocol = request.headers.get("x-forwarded-proto") || "http";
  const baseUrl = `${protocol}://${host}`;

  const messages = body.messages || [];
  const userQuery = messages.filter((m: any) => m.role === "user").pop()?.content || "";
  const timeoutMs = (strategy as any).engineTimeoutMs || 45000;
  const isStream = Boolean(body.stream);

  if (isStream) {
    const encoder = new TextEncoder();
    const activeStrategyName = strategy.name;

    const stream = new ReadableStream({
      async start(controller) {
        const sendEvent = (progressEvt: any) => {
          const chunk = {
            id: `chatcmpl-fusion-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: activeStrategyName,
            choices: [],
            fusion_progress: progressEvt,
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        };

        // Notify stream initialization & initial sub-engines list
        sendEvent({
          type: "start",
          strategy: activeStrategyName,
          engines: strategy!.engines.map((item) => (typeof item === "string" ? item : item.model)),
          synthesizer: strategy!.synthesizer,
        });

        // 1. Parallel execution across all sub-engines with live events
        const enginePromises = strategy!.engines.map((item) =>
          callSubEngineItem(item, messages, baseUrl, request.headers, timeoutMs, (evt) => {
            sendEvent(evt);
          })
        );

        const engineResults = await Promise.allSettled(enginePromises);
        const engineReports: EngineResult[] = engineResults.map((r, idx) => {
          if (r.status === "fulfilled") return r.value;
          const item = strategy!.engines[idx];
          const engName = typeof item === "string" ? item : item?.model || "unknown";
          return {
            engine: engName,
            success: false,
            content: "",
            latencyMs: 0,
            error: "Promise rejected",
          };
        });

        const validResults = engineReports.filter((r) => r.success && r.content.trim().length > 0);

        if (validResults.length === 0) {
          const errorDetails = engineReports.map((e) => `${e.engine}: ${e.error}`).join(" | ");
          sendEvent({
            type: "error",
            error: `All fusion sub-engines failed. Details: ${errorDetails}`,
          });
          controller.close();
          return;
        }

        const engineContextBlock = validResults
          .map((r) => `=== ENGINE: ${r.engine} (${r.latencyMs}ms) ===\n${r.content}\n`)
          .join("\n\n");

        const synthSystemPrompt =
          strategy!.systemPrompt ||
          "You are an expert multi-source synthesis engine. Integrate the findings from the multiple model sources provided below into a clear, unified, and accurate response.";

        const synthMessages = [
          { role: "system", content: synthSystemPrompt },
          {
            role: "user",
            content: `USER QUERY:\n${userQuery}\n\nMULTI-ENGINE RAW RESULTS:\n${engineContextBlock}\n\nPlease synthesize the results into a cohesive final response.`,
          },
        ];

        const synthHeaders: Record<string, string> = {
          "content-type": "application/json",
          "x-omniroute-fusion-internal": "true",
        };
        const authHeader = request.headers.get("authorization");
        if (authHeader) synthHeaders["authorization"] = authHeader;

        const invokeSynthesizer = async (model: string) => {
          return fetch(`${baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: synthHeaders,
            body: JSON.stringify({
              model: model,
              messages: synthMessages,
              stream: true,
              temperature: body.temperature ?? 0.3,
              max_tokens: body.max_tokens ?? 4096,
            }),
          });
        };

        let synthRes = await invokeSynthesizer(strategy!.synthesizer);
        let activeSynthesizerName = strategy!.synthesizer;

        if (!synthRes.ok && strategy!.synthesizerFallback) {
          log.warn(
            "FUSION",
            `Synthesizer '${strategy!.synthesizer}' failed. Attempting fallback '${strategy!.synthesizerFallback}'...`
          );
          const fbRes = await invokeSynthesizer(strategy!.synthesizerFallback);
          if (fbRes.ok) {
            synthRes = fbRes;
            activeSynthesizerName = `${strategy!.synthesizer} ➔ ${strategy!.synthesizerFallback}`;
          }
        }

        sendEvent({
          type: "synthesizer_start",
          synthesizer: activeSynthesizerName,
        });

        if (!synthRes.ok) {
          const errText = await synthRes.text().catch(() => "Synthesizer error");
          sendEvent({
            type: "error",
            error: `Synthesizer (${activeSynthesizerName}) failed: ${errText}`,
          });
          controller.close();
          return;
        }

        if (synthRes.body) {
          const reader = synthRes.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        }

        const totalMs = Date.now() - reqStart;
        sendEvent({
          type: "complete",
          total_ms: totalMs,
        });

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-fusion-strategy": activeStrategyName,
      },
    });
  }

  // Non-streaming execution path
  const enginePromises = strategy.engines.map((item) =>
    callSubEngineItem(item, messages, baseUrl, request.headers, timeoutMs)
  );

  const engineResults = await Promise.allSettled(enginePromises);
  const engineReports: EngineResult[] = engineResults.map((r, idx) => {
    if (r.status === "fulfilled") return r.value;
    const item = strategy!.engines[idx];
    const engName = typeof item === "string" ? item : item?.model || "unknown";
    return {
      engine: engName,
      success: false,
      content: "",
      latencyMs: 0,
      error: "Promise rejected",
    };
  });

  // 2. Synthesize results
  const validResults = engineReports.filter((r) => r.success && r.content.trim().length > 0);

  if (validResults.length === 0) {
    const errorDetails = engineReports.map((e) => `${e.engine}: ${e.error}`).join(" | ");
    return errorResponse(
      HTTP_STATUS.BAD_GATEWAY,
      `All fusion sub-engines failed. Details: ${errorDetails}`
    );
  }

  const engineContextBlock = validResults
    .map((r) => `=== ENGINE: ${r.engine} (${r.latencyMs}ms) ===\n${r.content}\n`)
    .join("\n\n");

  const synthSystemPrompt =
    strategy.systemPrompt ||
    "You are an expert multi-source synthesis engine. Integrate the findings from the multiple model sources provided below into a clear, unified, and accurate response.";

  const synthMessages = [
    { role: "system", content: synthSystemPrompt },
    {
      role: "user",
      content: `USER QUERY:\n${userQuery}\n\nMULTI-ENGINE RAW RESULTS:\n${engineContextBlock}\n\nPlease synthesize the results into a cohesive final response.`,
    },
  ];

  const synthStart = Date.now();
  const synthHeaders: Record<string, string> = {
    "content-type": "application/json",
    "x-omniroute-fusion-internal": "true",
  };
  const authHeader = request.headers.get("authorization");
  if (authHeader) synthHeaders["authorization"] = authHeader;

  const invokeSynthesizer = async (model: string) => {
    return fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: synthHeaders,
      body: JSON.stringify({
        model: model,
        messages: synthMessages,
        stream: isStream,
        temperature: body.temperature ?? 0.3,
        max_tokens: body.max_tokens ?? 4096,
      }),
    });
  };

  try {
    let synthRes = await invokeSynthesizer(strategy.synthesizer);
    let activeSynthesizerName = strategy.synthesizer;

    if (!synthRes.ok && strategy.synthesizerFallback) {
      log.warn(
        "FUSION",
        `Synthesizer '${strategy.synthesizer}' failed. Attempting fallback '${strategy.synthesizerFallback}'...`
      );
      const fbRes = await invokeSynthesizer(strategy.synthesizerFallback);
      if (fbRes.ok) {
        synthRes = fbRes;
        activeSynthesizerName = `${strategy.synthesizer} ➔ ${strategy.synthesizerFallback}`;
      }
    }

    const synthLatency = Date.now() - synthStart;
    const totalMs = Date.now() - reqStart;

    log.info(
      "FUSION",
      `Synthesis complete in ${synthLatency}ms via ${activeSynthesizerName} (Total Fusion Latency: ${totalMs}ms)`
    );

    if (!synthRes.ok) {
      const errText = await synthRes.text().catch(() => "Synthesizer error");
      return errorResponse(
        HTTP_STATUS.BAD_GATEWAY,
        `Synthesizer (${activeSynthesizerName}) failed: ${errText}`
      );
    }

    if (isStream) {
      const responseHeaders = new Headers(synthRes.headers);
      responseHeaders.set("x-fusion-strategy", strategy.name);
      responseHeaders.set("x-fusion-total-ms", totalMs.toString());
      return new Response(synthRes.body, {
        status: 200,
        headers: responseHeaders,
      });
    } else {
      const synthData = await synthRes.json();
      if (synthData && typeof synthData === "object") {
        synthData.fusion_metadata = {
          strategy: strategy.name,
          total_ms: totalMs,
          synthesizer_used: activeSynthesizerName,
          synthesizer_ms: synthLatency,
          engines: engineReports.map((e) => ({
            engine: e.engine,
            success: e.success,
            latency_ms: e.latencyMs,
            error: e.error,
          })),
        };
      }
      return new Response(JSON.stringify(synthData), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-fusion-strategy": strategy.name,
          "x-fusion-total-ms": totalMs.toString(),
        },
      });
    }
  } catch (err: any) {
    return errorResponse(HTTP_STATUS.SERVER_ERROR, `Fusion orchestration error: ${err.message}`);
  }
}
