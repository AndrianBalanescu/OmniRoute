"use client";

import { useState, useEffect, useMemo } from "react";
import { matchesSearch } from "@/shared/utils/turkishText";

interface FusionEngineStep {
  model: string;
  fallback?: string;
}

type FusionEngineItem = string | FusionEngineStep;

interface FusionStrategy {
  id: string;
  name: string;
  description: string;
  engines: FusionEngineItem[];
  synthesizer: string;
  synthesizerFallback?: string;
  systemPrompt?: string;
  enabled: boolean;
}

interface CatalogModel {
  id: string;
  owned_by?: string;
  type?: string;
}

export interface LiveEngineProgress {
  engine: string;
  status: "pending" | "running" | "online" | "error";
  latencyMs?: number;
  error?: string;
  fallbackUsed?: string;
  startTime?: number;
}

export interface LiveSynthesizerProgress {
  synthesizer: string;
  status: "idle" | "running" | "complete" | "error";
  latencyMs?: number;
  error?: string;
  startTime?: number;
}

interface ModelProbeState {
  status: "testing" | "online" | "error";
  ms?: number;
  error?: string;
}

function normalizeEngineItem(item: FusionEngineItem): FusionEngineStep {
  if (typeof item === "string") {
    return { model: item };
  }
  return item;
}

export function FusionStudioClient() {
  const [strategies, setStrategies] = useState<FusionStrategy[]>([]);
  const [catalogModels, setCatalogModels] = useState<CatalogModel[]>([]);
  const [loading, setLoading] = useState(true);

  // Active Strategy Editing State
  const [editing, setEditing] = useState<Partial<FusionStrategy> | null>(null);

  // Model Probe Test State
  const [probingModels, setProbingModels] = useState<Record<string, ModelProbeState>>({});

  // Model Picker Modal State
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<{
    type: "engine_primary" | "engine_fallback" | "synthesizer_primary" | "synthesizer_fallback";
    engineIndex?: number;
  } | null>(null);
  const [pickerSearch, setPickerSearch] = useState("");
  const [pickerCategory, setPickerCategory] = useState<string>("all");

  // Live Playground State
  const [testPrompt, setTestPrompt] = useState("");
  const [selectedStrategyName, setSelectedStrategyName] = useState("");
  const [testRunning, setTestRunning] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const [liveEngines, setLiveEngines] = useState<Record<string, LiveEngineProgress>>({});
  const [liveSynthesizer, setLiveSynthesizer] = useState<LiveSynthesizerProgress | null>(null);
  const [liveStreamText, setLiveStreamText] = useState("");
  const [liveTotalMs, setLiveTotalMs] = useState(0);
  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => {
    if (!testRunning) return;
    const interval = setInterval(() => setNowMs(Date.now()), 100);
    return () => clearInterval(interval);
  }, [testRunning]);

  // Load Strategies & Catalog Models on mount
  const loadData = async () => {
    setLoading(true);
    try {
      const [stratRes, catRes] = await Promise.all([
        fetch("/api/fusion/strategies"),
        fetch("/v1/models"),
      ]);

      const stratData = await stratRes.json().catch(() => ({}));
      const catData = await catRes.json().catch(() => ({}));

      if (stratData.success) {
        setStrategies(stratData.strategies || []);
        if (stratData.strategies.length > 0 && !selectedStrategyName) {
          setSelectedStrategyName(stratData.strategies[0].name);
        }
      }

      if (Array.isArray(catData.data)) {
        setCatalogModels(catData.data);
      }
    } catch (err) {
      console.error("Failed loading Fusion data:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
    // Mount-time load only; loadData is stable-enough for the lifecycle we use.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Probe Model Health Function
  const handleProbeModel = async (modelId: string) => {
    if (!modelId) return;
    setProbingModels((prev) => ({ ...prev, [modelId]: { status: "testing" } }));
    const start = Date.now();

    try {
      const res = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 5,
          stream: false,
        }),
      });

      const latencyMs = Date.now() - start;
      if (res.ok) {
        setProbingModels((prev) => ({
          ...prev,
          [modelId]: { status: "online", ms: latencyMs },
        }));
      } else {
        const errText = await res.text().catch(() => "Unknown error");
        setProbingModels((prev) => ({
          ...prev,
          [modelId]: { status: "error", error: `HTTP ${res.status}: ${errText.slice(0, 80)}` },
        }));
      }
    } catch (err: any) {
      setProbingModels((prev) => ({
        ...prev,
        [modelId]: { status: "error", error: err.message || "Failed connection" },
      }));
    }
  };

  // Filter Catalog Models for Picker Modal
  const filteredCatalogModels = useMemo(() => {
    let list = catalogModels;
    if (pickerCategory !== "all") {
      list = list.filter((m) => {
        const id = m.id.toLowerCase();
        if (pickerCategory === "search")
          return (
            id.includes("sonar") ||
            id.includes("felo") ||
            id.includes("web") ||
            id.includes("search")
          );
        if (pickerCategory === "reasoning")
          return (
            id.includes("think") ||
            id.includes("reason") ||
            id.includes("deepseek") ||
            id.includes("claude") ||
            id.includes("opus")
          );
        if (pickerCategory === "combos") return id.startsWith("auto/") || !id.includes("/");
        return true;
      });
    }
    if (pickerSearch.trim()) {
      const q = pickerSearch.toLowerCase();
      list = list.filter(
        (m) => matchesSearch(m.id, q) || (m.owned_by && matchesSearch(m.owned_by, q))
      );
    }
    return list;
  }, [catalogModels, pickerSearch, pickerCategory]);

  const handleOpenPicker = (
    type: "engine_primary" | "engine_fallback" | "synthesizer_primary" | "synthesizer_fallback",
    engineIndex?: number
  ) => {
    setPickerTarget({ type, engineIndex });
    setPickerSearch("");
    setPickerCategory("all");
    setPickerOpen(true);
  };

  const handleSelectModelFromPicker = (modelId: string) => {
    if (!pickerTarget || !editing) return;

    const newEditing = { ...editing };
    const engines = [...(newEditing.engines || [])].map(normalizeEngineItem);

    if (pickerTarget.type === "engine_primary" && pickerTarget.engineIndex !== undefined) {
      engines[pickerTarget.engineIndex] = {
        ...engines[pickerTarget.engineIndex],
        model: modelId,
      };
      newEditing.engines = engines;
    } else if (pickerTarget.type === "engine_fallback" && pickerTarget.engineIndex !== undefined) {
      engines[pickerTarget.engineIndex] = {
        ...engines[pickerTarget.engineIndex],
        fallback: modelId,
      };
      newEditing.engines = engines;
    } else if (pickerTarget.type === "synthesizer_primary") {
      newEditing.synthesizer = modelId;
    } else if (pickerTarget.type === "synthesizer_fallback") {
      newEditing.synthesizerFallback = modelId;
    }

    setEditing(newEditing);
    setPickerOpen(false);
  };

  const handleAddEngineNode = () => {
    if (!editing) return;
    const engines = [...(editing.engines || [])].map(normalizeEngineItem);
    engines.push({ model: "sonar" });
    setEditing({ ...editing, engines });
  };

  const handleRemoveEngineNode = (index: number) => {
    if (!editing) return;
    const engines = [...(editing.engines || [])].map(normalizeEngineItem);
    engines.splice(index, 1);
    setEditing({ ...editing, engines });
  };

  const handleClearEngineFallback = (index: number) => {
    if (!editing) return;
    const engines = [...(editing.engines || [])].map(normalizeEngineItem);
    delete engines[index].fallback;
    setEditing({ ...editing, engines });
  };

  const handleSaveStrategy = async () => {
    if (
      !editing?.name ||
      !editing?.engines ||
      editing.engines.length === 0 ||
      !editing?.synthesizer
    ) {
      alert("Please specify a strategy name, at least one search engine, and a synthesizer model.");
      return;
    }

    try {
      const res = await fetch("/api/fusion/strategies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(editing),
      });
      const data = await res.json();
      if (data.success) {
        setEditing(null);
        loadData();
      } else {
        alert("Error saving strategy: " + data.error);
      }
    } catch (err: any) {
      alert("Error: " + err.message);
    }
  };

  const handleDeleteStrategy = async (id: string) => {
    if (!confirm("Are you sure you want to delete this fusion strategy?")) return;
    try {
      const res = await fetch(`/api/fusion/strategies?id=${id}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        loadData();
      }
    } catch (err: any) {
      alert("Error deleting strategy: " + err.message);
    }
  };

  const handleRunPlayground = async () => {
    if (!testPrompt.trim() || !selectedStrategyName) return;

    setTestRunning(true);
    setTestResult(null);
    setLiveStreamText("");
    setLiveEngines({});
    setLiveSynthesizer(null);
    setLiveTotalMs(0);

    const activeStrat = strategies.find((s) => s.name === selectedStrategyName);

    const initEngines: Record<string, LiveEngineProgress> = {};
    if (activeStrat) {
      activeStrat.engines.forEach((item) => {
        const name = typeof item === "string" ? item : item.model;
        initEngines[name] = { engine: name, status: "pending" };
      });
      setLiveSynthesizer({ synthesizer: activeStrat.synthesizer, status: "idle" });
    }
    setLiveEngines(initEngines);

    const start = Date.now();

    try {
      const res = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: selectedStrategyName,
          messages: [{ role: "user", content: testPrompt }],
          stream: true,
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "Unknown error");
        setTestResult({ error: `HTTP ${res.status}: ${errText}` });
        setTestRunning(false);
        return;
      }

      if (!res.body) {
        setTestResult({ error: "No response body received" });
        setTestRunning(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulatedText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const jsonStr = trimmed.slice(6);
          if (jsonStr === "[DONE]") continue;

          try {
            const data = JSON.parse(jsonStr);

            if (data.fusion_progress) {
              const p = data.fusion_progress;

              if (p.type === "start") {
                const map: Record<string, LiveEngineProgress> = {};
                (p.engines || []).forEach((eng: string) => {
                  map[eng] = { engine: eng, status: "running", startTime: Date.now() };
                });
                setLiveEngines(map);
                setLiveSynthesizer({ synthesizer: p.synthesizer || "synthesizer", status: "idle" });
              } else if (p.type === "engine_start") {
                setLiveEngines((prev) => ({
                  ...prev,
                  [p.engine]: {
                    engine: p.engine,
                    status: "running",
                    startTime: prev[p.engine]?.startTime || Date.now(),
                  },
                }));
              } else if (p.type === "engine_done") {
                setLiveEngines((prev) => ({
                  ...prev,
                  [p.engine]: {
                    engine: p.engine,
                    status: p.success ? "online" : "error",
                    latencyMs: p.latency_ms,
                    error: p.error,
                    fallbackUsed: p.fallbackUsed,
                  },
                }));
              } else if (p.type === "synthesizer_start") {
                setLiveSynthesizer({
                  synthesizer: p.synthesizer,
                  status: "running",
                  startTime: Date.now(),
                });
              } else if (p.type === "complete") {
                setLiveTotalMs(p.total_ms || Date.now() - start);
                setLiveSynthesizer((prev) =>
                  prev
                    ? {
                        ...prev,
                        status: "complete",
                        latencyMs: Date.now() - (prev.startTime || start),
                      }
                    : null
                );
              } else if (p.type === "error") {
                setTestResult({ error: p.error });
              }
            }

            const delta = data.choices?.[0]?.delta?.content;
            if (delta) {
              accumulatedText += delta;
              setLiveStreamText(accumulatedText);
            }
          } catch {
            // Ignore parse errors on partial buffer lines
          }
        }
      }

      setTestResult({
        totalMs: Date.now() - start,
        status: 200,
        data: {
          choices: [{ message: { content: accumulatedText } }],
        },
      });
    } catch (err: any) {
      setTestResult({ error: err.message || "Request failed" });
    } finally {
      setTestRunning(false);
    }
  };

  const applyPreset = (presetType: "multi_search" | "code_audit" | "fact_checker") => {
    if (presetType === "multi_search") {
      setEditing({
        name: "fusion/web-research-pro",
        description: "Concurrent web search across Sonar & Felo synthesized by Gemini Flash",
        engines: [{ model: "sonar", fallback: "gemini-web" }, { model: "felo" }],
        synthesizer: "paid-premium",
        synthesizerFallback: "raycast",
        systemPrompt:
          "You are an expert multi-source search synthesis engine. Synthesize the raw search results into a concise, well-structured final answer with citations.",
        enabled: true,
      });
    } else if (presetType === "code_audit") {
      setEditing({
        name: "fusion/code-audit-studio",
        description: "Adversarial code review via DeepSeek Think & Claude Sonnet",
        engines: [{ model: "deepseek/deepseek-reasoner" }, { model: "claude-3-5-sonnet" }],
        synthesizer: "paid-premium",
        synthesizerFallback: "raycast",
        systemPrompt:
          "You are a pragmatic senior code reviewer. Synthesize the findings into prioritized bug reports, root causes, and minimal diff fixes.",
        enabled: true,
      });
    } else if (presetType === "fact_checker") {
      setEditing({
        name: "fusion/fast-fact-checker",
        description: "Ultra-fast multi-engine fact extraction",
        engines: [{ model: "sonar" }, { model: "auto/best-fast" }],
        synthesizer: "paid-premium",
        systemPrompt: "Extract core verified facts into bullet points.",
        enabled: true,
      });
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-8 text-slate-100 font-sans">
      {/* Studio Header */}
      <div className="flex justify-between items-center border-b border-slate-800 pb-5">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-black tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-sky-400 via-cyan-300 to-indigo-400">
              ⚡ OmniFuse Studio
            </h1>
            <span className="text-[10px] uppercase font-bold tracking-widest bg-sky-500/10 text-sky-400 border border-sky-500/20 px-2 py-0.5 rounded-full">
              v0.2.0 Native
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Visual Multi-Engine Parallel Search & Synthesis Studio for OmniRoute
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-3">
          <button
            onClick={() => applyPreset("multi_search")}
            className="text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-sky-300 border border-sky-500/30 px-3 py-1.5 rounded-lg transition shadow-sm"
          >
            🌐 + Search Strategy
          </button>
          <button
            onClick={() => applyPreset("code_audit")}
            className="text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-indigo-300 border border-indigo-500/30 px-3 py-1.5 rounded-lg transition shadow-sm"
          >
            🧠 + Code Audit Strategy
          </button>
        </div>
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Column: Active Strategies & Studio Canvas (7 cols) */}
        <div className="lg:col-span-7 space-y-6">
          <div className="flex justify-between items-center">
            <h2 className="text-sm font-bold tracking-wide uppercase text-slate-300">
              Configured Strategies ({strategies.length})
            </h2>
            <button
              onClick={() => {
                setEditing({
                  name: "fusion/custom-strategy",
                  description: "Custom parallel synthesis strategy",
                  engines: [{ model: "sonar" }],
                  synthesizer: "paid-premium",
                  systemPrompt: "Synthesize findings into a clear, concise answer.",
                  enabled: true,
                });
              }}
              className="bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold px-3 py-1.5 rounded-lg transition flex items-center gap-1 shadow-lg shadow-sky-600/20"
            >
              + Create Strategy Canvas
            </button>
          </div>

          {/* Strategy Cards List */}
          {loading ? (
            <div className="text-slate-500 text-xs animate-pulse">Loading strategy canvas...</div>
          ) : (
            <div className="space-y-3">
              {strategies.map((s) => (
                <div
                  key={s.id}
                  className="bg-slate-900/90 border border-slate-800 hover:border-slate-700 p-4 rounded-xl space-y-3 transition shadow-sm"
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-black text-sky-400">{s.name}</span>
                        {s.enabled ? (
                          <span className="text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded-full">
                            Active
                          </span>
                        ) : (
                          <span className="text-[10px] font-bold bg-slate-800 text-slate-500 px-2 py-0.5 rounded-full">
                            Disabled
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-400 mt-1">{s.description}</p>
                    </div>

                    <div className="flex gap-2">
                      <button
                        onClick={() => setEditing(s)}
                        className="text-xs font-semibold px-2.5 py-1 rounded bg-slate-800 text-sky-300 hover:bg-slate-700 transition"
                      >
                        Edit Canvas
                      </button>
                      <button
                        onClick={() => handleDeleteStrategy(s.id)}
                        className="text-xs font-semibold px-2 py-1 rounded bg-slate-800 text-rose-400 hover:bg-rose-950 transition"
                      >
                        Delete
                      </button>
                    </div>
                  </div>

                  {/* Engine Nodes Pipeline Overview */}
                  <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-800/60 text-xs">
                    <span className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">
                      Parallel Nodes:
                    </span>
                    {s.engines.map((item, idx) => {
                      const step = normalizeEngineItem(item);
                      return (
                        <div
                          key={idx}
                          className="flex items-center gap-1 font-mono text-[11px] bg-slate-800 border border-slate-700/80 rounded-md px-2 py-1"
                        >
                          <span className="text-sky-300 font-semibold">{step.model}</span>
                          {step.fallback && (
                            <span className="text-slate-400">
                              ➔ <span className="text-amber-300 font-medium">{step.fallback}</span>
                            </span>
                          )}
                        </div>
                      );
                    })}

                    <span className="text-slate-600 font-bold">➔</span>

                    <span className="text-[10px] uppercase font-bold text-amber-400/80 tracking-wider">
                      Synthesizer:
                    </span>
                    <div className="font-mono text-[11px] bg-amber-950/40 border border-amber-500/30 text-amber-300 rounded-md px-2 py-1 font-bold">
                      {s.synthesizer}
                      {s.synthesizerFallback && (
                        <span className="text-amber-200/60 font-normal">
                          {" "}
                          ➔ {s.synthesizerFallback}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* STUDIO CANVAS EDITOR MODAL / CARD */}
          {editing && (
            <div className="bg-slate-900 border-2 border-sky-500/50 p-6 rounded-2xl space-y-6 shadow-2xl relative">
              <div className="flex justify-between items-center border-b border-slate-800 pb-3">
                <h3 className="text-base font-black text-sky-400 flex items-center gap-2">
                  🎨 Strategy Studio Canvas Manager
                </h3>
                <button
                  onClick={() => setEditing(null)}
                  className="text-xs font-bold text-slate-400 hover:text-slate-200"
                >
                  ✕ Close
                </button>
              </div>

              <div className="space-y-4">
                {/* Meta info */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-bold text-slate-400 mb-1">
                      Strategy Name (Virtual Model Identifier)
                    </label>
                    <input
                      type="text"
                      value={editing.name || ""}
                      onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-sky-300 focus:outline-none focus:border-sky-500"
                      placeholder="fusion/web-research-pro"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-400 mb-1">
                      Description
                    </label>
                    <input
                      type="text"
                      value={editing.description || ""}
                      onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
                      placeholder="Description..."
                    />
                  </div>
                </div>

                {/* PARALLEL ENGINE NODES CANVAS */}
                <div className="space-y-3 pt-2">
                  <div className="flex justify-between items-center">
                    <label className="block text-xs font-bold tracking-wider uppercase text-sky-400">
                      ⚡ 1. Parallel Engine Nodes (Runs Concurrently)
                    </label>
                    <button
                      onClick={handleAddEngineNode}
                      className="text-xs font-bold bg-sky-600/20 hover:bg-sky-600/30 text-sky-300 border border-sky-500/30 px-3 py-1 rounded-lg transition"
                    >
                      + Add Engine Node
                    </button>
                  </div>

                  <div className="space-y-2">
                    {(editing.engines || []).map((rawItem, idx) => {
                      const item = normalizeEngineItem(rawItem);
                      const primaryProbe = probingModels[item.model];
                      return (
                        <div
                          key={idx}
                          className="bg-slate-950 border border-slate-800 p-3 rounded-xl flex flex-wrap items-center justify-between gap-3"
                        >
                          <div className="flex items-center gap-3 flex-1 min-w-[280px]">
                            <span className="text-[10px] font-mono font-bold bg-slate-800 text-slate-400 px-2 py-1 rounded">
                              #{idx + 1}
                            </span>

                            {/* Primary Engine Button */}
                            <div className="flex items-center gap-1.5">
                              <span className="text-xs text-slate-400">Model:</span>
                              <button
                                onClick={() => handleOpenPicker("engine_primary", idx)}
                                className="font-mono text-xs font-bold bg-slate-900 hover:bg-slate-800 text-sky-300 border border-sky-500/40 px-3 py-1.5 rounded-lg flex items-center gap-2 transition"
                              >
                                <span>{item.model}</span>
                                <span className="text-[10px] text-slate-500">🔍 Search</span>
                              </button>

                              {/* Probe Test Button */}
                              <button
                                onClick={() => handleProbeModel(item.model)}
                                className="text-[10px] font-bold bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 px-2 py-1 rounded transition"
                                title="Test model availability and ping latency"
                              >
                                ⚡ Probe
                              </button>

                              {primaryProbe && (
                                <span className="text-[10px] font-mono">
                                  {primaryProbe.status === "testing" && (
                                    <span className="text-amber-400 font-bold animate-pulse">
                                      Testing...
                                    </span>
                                  )}
                                  {primaryProbe.status === "online" && (
                                    <span className="text-emerald-400 font-bold bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded">
                                      🟢 {primaryProbe.ms}ms
                                    </span>
                                  )}
                                  {primaryProbe.status === "error" && (
                                    <span
                                      className="text-rose-400 font-bold bg-rose-500/10 border border-rose-500/20 px-1.5 py-0.5 rounded"
                                      title={primaryProbe.error}
                                    >
                                      🔴 Offline
                                    </span>
                                  )}
                                </span>
                              )}
                            </div>

                            {/* Optional Engine Fallback */}
                            <div className="flex items-center gap-1.5">
                              <span className="text-xs text-slate-500">➔ Fallback:</span>
                              {item.fallback ? (
                                <div className="flex items-center gap-1">
                                  <button
                                    onClick={() => handleOpenPicker("engine_fallback", idx)}
                                    className="font-mono text-xs font-bold bg-amber-950/30 hover:bg-amber-900/40 text-amber-300 border border-amber-500/40 px-2.5 py-1.5 rounded-lg transition"
                                  >
                                    {item.fallback}
                                  </button>
                                  <button
                                    onClick={() => handleClearEngineFallback(idx)}
                                    className="text-xs text-slate-500 hover:text-rose-400 px-1"
                                    title="Remove fallback"
                                  >
                                    ✕
                                  </button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => handleOpenPicker("engine_fallback", idx)}
                                  className="text-[11px] text-slate-500 hover:text-amber-300 border border-dashed border-slate-700 hover:border-amber-500/40 px-2 py-1 rounded-lg transition"
                                >
                                  + Set Fallback
                                </button>
                              )}
                            </div>
                          </div>

                          <button
                            onClick={() => handleRemoveEngineNode(idx)}
                            className="text-xs text-rose-400 hover:text-rose-300 font-bold px-2 py-1 rounded bg-rose-950/30 hover:bg-rose-900/40 border border-rose-500/20"
                          >
                            Remove Node
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* SYNTHESIZER NODE CANVAS */}
                <div className="space-y-3 pt-3 border-t border-slate-800">
                  <label className="block text-xs font-bold tracking-wider uppercase text-amber-400">
                    👑 2. Master Synthesizer Node (Combines All Engine Results)
                  </label>

                  <div className="bg-slate-950 border border-amber-500/30 p-4 rounded-xl flex flex-wrap items-center justify-between gap-4">
                    <div className="flex flex-wrap items-center gap-4">
                      {/* Primary Synthesizer */}
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-slate-400 font-medium">
                          Synthesizer Model:
                        </span>
                        <button
                          onClick={() => handleOpenPicker("synthesizer_primary")}
                          className="font-mono text-xs font-bold bg-amber-950/40 hover:bg-amber-900/50 text-amber-300 border border-amber-500/50 px-3 py-1.5 rounded-lg flex items-center gap-2 transition"
                        >
                          <span>{editing.synthesizer || "Select Model..."}</span>
                          <span className="text-[10px] text-amber-400/60">🔍 Search Catalog</span>
                        </button>

                        <button
                          onClick={() =>
                            editing.synthesizer && handleProbeModel(editing.synthesizer)
                          }
                          className="text-[10px] font-bold bg-amber-950/40 hover:bg-amber-900/60 text-amber-300 border border-amber-500/30 px-2 py-1 rounded transition"
                        >
                          ⚡ Probe
                        </button>

                        {editing.synthesizer && probingModels[editing.synthesizer] && (
                          <span className="text-[10px] font-mono">
                            {probingModels[editing.synthesizer].status === "testing" && (
                              <span className="text-amber-400 font-bold animate-pulse">
                                Testing...
                              </span>
                            )}
                            {probingModels[editing.synthesizer].status === "online" && (
                              <span className="text-emerald-400 font-bold bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded">
                                🟢 {probingModels[editing.synthesizer].ms}ms
                              </span>
                            )}
                            {probingModels[editing.synthesizer].status === "error" && (
                              <span className="text-rose-400 font-bold bg-rose-500/10 border border-rose-500/20 px-1.5 py-0.5 rounded">
                                🔴 Offline
                              </span>
                            )}
                          </span>
                        )}
                      </div>

                      {/* Optional Synthesizer Fallback */}
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-slate-500 font-medium">
                          ➔ Fallback Synthesizer:
                        </span>
                        {editing.synthesizerFallback ? (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleOpenPicker("synthesizer_fallback")}
                              className="font-mono text-xs font-bold bg-slate-900 hover:bg-slate-800 text-amber-200 border border-slate-700 px-3 py-1.5 rounded-lg transition"
                            >
                              {editing.synthesizerFallback}
                            </button>
                            <button
                              onClick={() =>
                                setEditing({ ...editing, synthesizerFallback: undefined })
                              }
                              className="text-xs text-slate-500 hover:text-rose-400 px-1"
                            >
                              ✕
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => handleOpenPicker("synthesizer_fallback")}
                            className="text-xs text-slate-500 hover:text-amber-300 border border-dashed border-slate-700 hover:border-amber-500/40 px-2 py-1.5 rounded-lg transition"
                          >
                            + Set Synthesizer Fallback
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* SYSTEM PROMPT CANVAS */}
                <div className="space-y-2 pt-2">
                  <div className="flex justify-between items-center">
                    <label className="block text-xs font-bold text-slate-400">
                      Custom Synthesis System Prompt
                    </label>
                    <div className="flex gap-2">
                      <button
                        onClick={() =>
                          setEditing({
                            ...editing,
                            systemPrompt:
                              "You are an expert search synthesis engine. Synthesize the raw multi-engine findings into a clear, unified, and accurate final answer.",
                          })
                        }
                        className="text-[10px] text-sky-400 hover:underline"
                      >
                        Search Synthesis Preset
                      </button>
                      <button
                        onClick={() =>
                          setEditing({
                            ...editing,
                            systemPrompt:
                              "Synthesize the multi-model code audit findings into a concise list of bugs, security risks, and concrete code diff fixes.",
                          })
                        }
                        className="text-[10px] text-sky-400 hover:underline"
                      >
                        Code Audit Preset
                      </button>
                    </div>
                  </div>
                  <textarea
                    rows={3}
                    value={editing.systemPrompt || ""}
                    onChange={(e) => setEditing({ ...editing, systemPrompt: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-xs font-mono text-slate-200 focus:outline-none focus:border-sky-500"
                    placeholder="System prompt..."
                  />
                </div>
              </div>

              {/* Modal Save Actions */}
              <div className="flex justify-end gap-3 pt-4 border-t border-slate-800">
                <button
                  onClick={() => setEditing(null)}
                  className="px-4 py-2 rounded-lg text-xs font-bold bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveStrategy}
                  className="px-5 py-2 rounded-lg text-xs font-bold bg-sky-600 hover:bg-sky-500 text-white transition shadow-lg shadow-sky-600/30"
                >
                  Save Strategy to OmniRoute
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Right Column: Live Playground & Waterfall (5 cols) */}
        <div className="lg:col-span-5 space-y-6">
          <h2 className="text-sm font-bold tracking-wide uppercase text-slate-300">
            Live Waterfall Timeline & Playground
          </h2>

          <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl space-y-4 shadow-xl">
            <div className="space-y-2">
              <label className="block text-xs font-bold text-slate-400">Target Strategy</label>
              <select
                value={selectedStrategyName}
                onChange={(e) => setSelectedStrategyName(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2.5 text-xs text-sky-400 font-mono font-bold focus:outline-none focus:border-sky-500"
              >
                {strategies.map((s) => (
                  <option key={s.id} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-bold text-slate-400">Test Query</label>
              <textarea
                rows={4}
                value={testPrompt}
                onChange={(e) => setTestPrompt(e.target.value)}
                placeholder="Explain Rust async context pinning pitfalls..."
                className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
              />
            </div>

            <button
              onClick={handleRunPlayground}
              disabled={testRunning || !testPrompt.trim()}
              className="w-full bg-gradient-to-r from-sky-600 to-indigo-600 hover:from-sky-500 hover:to-indigo-500 disabled:opacity-50 text-white py-2.5 rounded-lg text-xs font-black tracking-wide uppercase transition shadow-lg shadow-indigo-500/20"
            >
              {testRunning ? "Running Parallel Fusion..." : "🚀 Execute Fusion Query"}
            </button>

            {/* Live Progress & Waterfall Breakdown */}
            {(testRunning || Object.keys(liveEngines).length > 0 || testResult) && (
              <div className="pt-4 border-t border-slate-800 space-y-4">
                <div className="flex justify-between items-center text-xs font-bold">
                  <div className="flex items-center gap-2">
                    <span className="text-slate-300 uppercase tracking-wider text-[10px] font-black">
                      ⚡ Live Multi-Engine Waterfall
                    </span>
                    {testRunning && (
                      <span className="flex items-center gap-1 text-[10px] text-amber-400 font-mono animate-pulse bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-full">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping" />
                        Executing Parallel Engines...
                      </span>
                    )}
                  </div>
                  <span className="font-mono text-sky-400 bg-sky-500/10 border border-sky-500/20 px-2.5 py-0.5 rounded font-bold">
                    {testRunning
                      ? `${((nowMs - (testResult?.startMs || nowMs)) / 1000).toFixed(1)}s`
                      : liveTotalMs
                        ? `${liveTotalMs}ms`
                        : testResult?.totalMs
                          ? `${testResult.totalMs}ms`
                          : "0ms"}
                  </span>
                </div>

                {/* Sub-Engines Live Status Cards */}
                <div className="space-y-2.5 bg-slate-950 p-4 rounded-xl border border-slate-800/80 shadow-inner">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                    1. Parallel Sub-Engines ({Object.keys(liveEngines).length})
                  </div>
                  {Object.values(liveEngines).map((eng, idx) => {
                    const isRunning = eng.status === "running";
                    const isOnline = eng.status === "online";
                    const isError = eng.status === "error";
                    const elapsedSec = eng.startTime
                      ? ((nowMs - eng.startTime) / 1000).toFixed(1)
                      : 0;

                    return (
                      <div
                        key={eng.engine}
                        className={`p-3 rounded-lg border flex items-center justify-between transition-all ${
                          isRunning
                            ? "bg-amber-950/20 border-amber-500/40 shadow-sm"
                            : isOnline
                              ? "bg-emerald-950/20 border-emerald-500/30"
                              : isError
                                ? "bg-rose-950/20 border-rose-500/30"
                                : "bg-slate-900/50 border-slate-800"
                        }`}
                      >
                        <div className="flex items-center gap-2.5 font-mono text-xs">
                          <span className="text-[10px] font-bold text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded">
                            #{idx + 1}
                          </span>
                          <span className="font-bold text-slate-200">{eng.engine}</span>
                          {eng.fallbackUsed && (
                            <span className="text-[10px] bg-purple-500/10 text-purple-300 border border-purple-500/20 px-1.5 py-0.5 rounded">
                              fallback: {eng.fallbackUsed}
                            </span>
                          )}
                        </div>

                        {/* Status Badge */}
                        <div className="flex items-center gap-2 text-xs font-mono font-bold">
                          {isRunning && (
                            <span className="text-amber-400 flex items-center gap-1.5 bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 rounded animate-pulse">
                              <span className="w-2 h-2 rounded-full bg-amber-400 animate-spin border-t-2 border-transparent" />
                              Running ({elapsedSec}s)
                            </span>
                          )}
                          {isOnline && (
                            <span className="text-emerald-400 flex items-center gap-1 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded">
                              ✓ {eng.latencyMs}ms
                            </span>
                          )}
                          {isError && (
                            <span className="text-rose-400 flex items-center gap-1 bg-rose-500/10 border border-rose-500/30 px-2 py-0.5 rounded text-[11px]">
                              ✗ {eng.error || "Failed"}
                            </span>
                          )}
                          {eng.status === "pending" && (
                            <span className="text-slate-500 bg-slate-900 border border-slate-800 px-2 py-0.5 rounded text-[11px]">
                              ⏳ Pending
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  {/* Synthesizer Live Status Card */}
                  {liveSynthesizer && (
                    <div className="pt-2 border-t border-slate-800/80 mt-3 space-y-1">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-amber-500/90 mb-1">
                        2. Master Synthesizer Node
                      </div>
                      <div
                        className={`p-3 rounded-lg border flex items-center justify-between transition-all ${
                          liveSynthesizer.status === "running"
                            ? "bg-indigo-950/30 border-indigo-500/50 shadow-md shadow-indigo-500/10"
                            : liveSynthesizer.status === "complete"
                              ? "bg-emerald-950/20 border-emerald-500/30"
                              : liveSynthesizer.status === "error"
                                ? "bg-rose-950/20 border-rose-500/30"
                                : "bg-slate-900/50 border-slate-800 opacity-60"
                        }`}
                      >
                        <div className="flex items-center gap-2 font-mono text-xs">
                          <span className="text-amber-400 font-bold">👑 Synthesizer:</span>
                          <span className="font-bold text-slate-100">
                            {liveSynthesizer.synthesizer}
                          </span>
                        </div>

                        <div className="flex items-center gap-2 text-xs font-mono font-bold">
                          {liveSynthesizer.status === "running" && (
                            <span className="text-indigo-300 flex items-center gap-1.5 bg-indigo-500/10 border border-indigo-500/30 px-2.5 py-0.5 rounded animate-pulse">
                              <span className="w-2 h-2 rounded-full bg-indigo-400 animate-ping" />
                              Synthesizing Output...
                            </span>
                          )}
                          {liveSynthesizer.status === "complete" && (
                            <span className="text-emerald-400 flex items-center gap-1 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded">
                              ✓ Complete
                            </span>
                          )}
                          {liveSynthesizer.status === "error" && (
                            <span className="text-rose-400 flex items-center gap-1 bg-rose-500/10 border border-rose-500/30 px-2 py-0.5 rounded text-[11px]">
                              ✗ {liveSynthesizer.error || "Failed"}
                            </span>
                          )}
                          {liveSynthesizer.status === "idle" && (
                            <span className="text-slate-500 bg-slate-900 border border-slate-800 px-2 py-0.5 rounded text-[11px]">
                              ⏳ Waiting for engines...
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Real-time Streaming Output Display */}
                <div className="bg-slate-950 border border-slate-800 p-4 rounded-xl space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] text-slate-400 uppercase tracking-widest font-black flex items-center gap-1.5">
                      Synthesized Response Live Output
                      {testRunning && (
                        <span className="w-2 h-2 rounded-full bg-sky-400 animate-ping inline-block" />
                      )}
                    </span>
                    {liveStreamText && (
                      <span className="text-[10px] font-mono text-slate-500">
                        {liveStreamText.length} chars
                      </span>
                    )}
                  </div>

                  {testResult?.error ? (
                    <div className="p-3 bg-rose-950/40 border border-rose-500/40 rounded-lg text-xs font-mono text-rose-300">
                      🚨 {testResult.error}
                    </div>
                  ) : (
                    <pre className="whitespace-pre-wrap font-sans text-slate-200 text-xs leading-relaxed max-h-96 overflow-y-auto p-1">
                      {liveStreamText ||
                        testResult?.data?.choices?.[0]?.message?.content ||
                        (testRunning ? "Waiting for synthesizer stream..." : "No result yet.")}
                      {testRunning && liveSynthesizer?.status === "running" && (
                        <span className="inline-block w-2 h-4 bg-sky-400 animate-pulse ml-0.5 align-middle" />
                      )}
                    </pre>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* SEARCHABLE MODEL PICKER MODAL */}
      {pickerOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-sky-500/40 max-w-xl w-full rounded-2xl p-6 space-y-4 shadow-2xl">
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <h3 className="text-sm font-black text-sky-400">
                🔍 Select Model from OmniRoute Catalog
              </h3>
              <button
                onClick={() => setPickerOpen(false)}
                className="text-xs font-bold text-slate-400 hover:text-slate-200"
              >
                ✕ Close
              </button>
            </div>

            {/* Search Input & Category Filters */}
            <div className="space-y-3">
              <input
                type="text"
                value={pickerSearch}
                onChange={(e) => setPickerSearch(e.target.value)}
                placeholder="Search models (e.g. sonar, deepseek, gemini, claude)..."
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-sky-500"
                autoFocus
              />

              <div className="flex gap-2 text-xs">
                {["all", "search", "reasoning", "combos"].map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setPickerCategory(cat)}
                    className={`px-3 py-1 rounded-lg capitalize font-semibold text-[11px] transition ${
                      pickerCategory === cat
                        ? "bg-sky-600 text-white"
                        : "bg-slate-800 text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>

            {/* Models Scrollable List */}
            <div className="max-h-80 overflow-y-auto space-y-1.5 pr-1 border-t border-slate-800 pt-3">
              {filteredCatalogModels.length === 0 ? (
                <div className="text-xs text-slate-500 text-center py-6">
                  No matching models found in catalog.
                </div>
              ) : (
                filteredCatalogModels.map((m) => {
                  const probeState = probingModels[m.id];
                  return (
                    <div
                      key={m.id}
                      className="w-full text-left bg-slate-950 hover:bg-slate-800 border border-slate-800 hover:border-sky-500/50 p-2.5 rounded-lg flex justify-between items-center transition group"
                    >
                      <button
                        onClick={() => handleSelectModelFromPicker(m.id)}
                        className="flex-1 text-left flex items-center justify-between pr-3"
                      >
                        <span className="font-mono text-xs font-bold text-slate-200 group-hover:text-sky-300">
                          {m.id}
                        </span>
                        {m.owned_by && (
                          <span className="text-[10px] bg-slate-900 border border-slate-700/60 text-slate-400 px-2 py-0.5 rounded font-mono">
                            {m.owned_by}
                          </span>
                        )}
                      </button>

                      {/* Probe Test Button in Modal */}
                      <div className="flex items-center gap-2">
                        {probeState && (
                          <span className="text-[10px] font-mono">
                            {probeState.status === "testing" && (
                              <span className="text-amber-400 font-bold animate-pulse">
                                Testing...
                              </span>
                            )}
                            {probeState.status === "online" && (
                              <span className="text-emerald-400 font-bold bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded">
                                🟢 {probeState.ms}ms
                              </span>
                            )}
                            {probeState.status === "error" && (
                              <span
                                className="text-rose-400 font-bold bg-rose-500/10 border border-rose-500/20 px-1.5 py-0.5 rounded"
                                title={probeState.error}
                              >
                                🔴 Error
                              </span>
                            )}
                          </span>
                        )}

                        <button
                          onClick={() => handleProbeModel(m.id)}
                          className="text-[10px] font-bold bg-sky-600/20 hover:bg-sky-600/40 text-sky-300 border border-sky-500/30 px-2 py-1 rounded transition"
                        >
                          ⚡ Test
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
