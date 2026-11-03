/**
 * Central Context Fabric resource policy.
 *
 * Every entrypoint (native node tool, daemon API, Workspace bridge) should
 * converge on these limits so an agent cannot bypass its context budget by
 * switching surfaces.
 */
function envInt(name, fallback, min, max) {
  const raw = process.env[name];
  const n = raw === undefined ? fallback : Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
function clamp(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function contextLimits() {
  return {
    maxQueryChars: envInt("KILN_CONTEXT_MAX_QUERY_CHARS", 4096, 128, 32768),
    maxBytes: envInt("KILN_CONTEXT_MAX_BYTES", 128000, 4096, 512000),
    maxChunks: envInt("KILN_CONTEXT_MAX_CHUNKS", 50, 1, 100),
    maxMemoryTokens: envInt("KILN_CONTEXT_MAX_MEMORY_TOKENS", 8000, 128, 32000),
    maxDependencyChunks: envInt("KILN_CONTEXT_MAX_DEPENDENCY_CHUNKS", 10, 0, 50),
  };
}

export function boundContextRequest(input = {}, mode = "query") {
  const limits = contextLimits();
  const query = String(input.query || "").trim();
  if (!query) throw new Error("context query is required");
  if (query.length > limits.maxQueryChars) {
    throw new Error(`context query exceeds ${limits.maxQueryChars} characters`);
  }
  const defaultBytes = mode === "sit" ? 18000 : 24000;
  const defaultChunks = mode === "sit" ? 10 : 12;
  return {
    query,
    maxBytes: clamp(input.maxBytes, defaultBytes, 512, limits.maxBytes),
    maxChunks: clamp(input.maxChunks, defaultChunks, 1, limits.maxChunks),
    memoryTokens: clamp(input.memoryTokens, 1200, 128, limits.maxMemoryTokens),
    maxDependencyChunks: clamp(input.maxDependencyChunks, 3, 0, limits.maxDependencyChunks),
    mmrLambda: clamp(input.mmrLambda, 0.78, 0, 1),
    knownHashes: input.knownHashes && typeof input.knownHashes === "object" && !Array.isArray(input.knownHashes)
      ? input.knownHashes
      : {},
    expandDependencies: input.expandDependencies !== false,
    refresh: input.refresh !== false,
  };
}
