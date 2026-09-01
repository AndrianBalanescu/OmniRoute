/**
 * Model-id resolution helpers shared by the model test runner and the provider
 * pages. The provider detail UI addresses models by their DISPLAY alias
 * (e.g. "ali/qwen3.8-max" for provider id "alibaba"), while request routing
 * and the live catalog expect the bare leaf id (or a "<providerId>/..." string
 * the gateway can strip itself). A leading segment equal to the provider id OR
 * any of its registered aliases is routing noise and must be shed before the
 * id is re-prefixed for a test call.
 */
import {
  getProviderByAlias,
  PROVIDER_CONNECTION_FAMILY_ALIASES,
} from "@/shared/constants/providers";

function providerAliasesFor(providerId: string): Set<string> {
  const aliases = new Set<string>([providerId]);
  try {
    const provider = getProviderByAlias(providerId);
    if (provider?.alias) aliases.add(provider.alias);
  } catch {
    // registry unavailable — fall back to id-only matching
  }
  for (const family of PROVIDER_CONNECTION_FAMILY_ALIASES[providerId] || []) {
    aliases.add(family);
  }
  return aliases;
}

/**
 * Strip a leading routing segment from a model id when that segment is the
 * provider id or one of its aliases. "alibaba/ali/qwen3.8-max" ->
 * "qwen3.8-max" for provider "alibaba"; unrelated namespaces are preserved.
 */
export function resolveAliasPrefixedModelId(providerId: string, modelId: string): string {
  const aliases = providerAliasesFor(providerId);
  let out = modelId.trim();
  let changed = true;
  while (changed && out.includes("/")) {
    changed = false;
    const slashIdx = out.indexOf("/");
    const head = out.slice(0, slashIdx);
    if (aliases.has(head)) {
      out = out.slice(slashIdx + 1);
      changed = true;
    }
  }
  return out;
}

/** Last path segment of a model id (lowercased), used for timeout heuristics. */
export function getModelLeafId(modelId: string): string {
  const segments = modelId.trim().toLowerCase().split("/").filter(Boolean);
  return segments[segments.length - 1] || "";
}
