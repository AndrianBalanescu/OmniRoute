import crypto from "node:crypto";

/**
 * Streaming JSON hash — computes `sha256hex(JSON.stringify(value))` WITHOUT
 * materializing the JSON string (#7847 OOM class). Several hot-path call sites
 * stringify a multi-megabyte request body just to hash it (compression memo
 * keys, cache keys). On a ~5 MiB agent body (with base64 screenshots) that
 * allocates a full ~5 MiB string, read once for a hash, then discarded.
 *
 * `jsonSha256()` walks the value and feeds the same bytes `JSON.stringify`
 * would emit directly into a `crypto.createHash("sha256")` stream, so peak
 * allocation stays bounded to a small rolling buffer.
 *
 * Semantics mirror `JSON.stringify` exactly:
 *  - key order = `Object.keys()` order (insertion order)
 *  - `undefined`/function/symbol object values drop the whole entry
 *  - `undefined`/function/symbol array items render as `null`
 *  - non-finite numbers render as `null`
 *  - `BigInt` throws (matches JSON.stringify)
 *  - Date / toJSON / non-plain containers fall back to `JSON.stringify` for
 *    that subtree only (kept rare so big arrays stay on the fast path).
 *
 * Deterministic across calls: identical logical bodies always produce the
 * identical digest, so callers can replace `sha256hex(JSON.stringify(body))`
 * with `jsonSha256(body)` without changing cache/memo semantics.
 */
export function jsonSha256(value: unknown): string {
  const hash = crypto.createHash("sha256");
  writeValue(hash, value, new Set<object>());
  return hash.digest("hex");
}

function isOmitted(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

function isPlainContainer(value: object): boolean {
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function writeValue(
  hash: ReturnType<typeof crypto.createHash>,
  value: unknown,
  seen: Set<object>
): void {
  if (value === null) {
    hash.update("null");
    return;
  }
  const type = typeof value;

  if (type === "string") {
    writeEncodedString(hash, value as string);
    return;
  }
  if (type === "boolean") {
    hash.update(value ? "true" : "false");
    return;
  }
  if (type === "number") {
    // Non-finite numbers serialize as null (matches JSON.stringify).
    hash.update(Number.isFinite(value as number) ? String(value) : "null");
    return;
  }
  if (type === "bigint") {
    // Matches JSON.stringify, which throws rather than guessing an encoding.
    throw new TypeError("Do not know how to serialize a BigInt");
  }
  if (isOmitted(value) || type !== "object") {
    return;
  }

  const obj = value as object;

  // Date, Map, boxed primitives, class instances with toJSON — fall back to
  // JSON.stringify for THIS SUBTREE only, keeping multi-MB arrays on the
  // streaming path. JSON.stringify(Date) emits a quoted ISO string, so push
  // exactly the string form JSON.stringify would have produced.
  const hasToJSON = typeof (obj as { toJSON?: unknown }).toJSON === "function";
  if (hasToJSON || !isPlainContainer(obj)) {
    const encoded = JSON.stringify(obj);
    hash.update(encoded === undefined ? "undefined" : encoded);
    return;
  }

  if (seen.has(obj)) {
    throw new TypeError("Converting circular structure to JSON");
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      hash.update("[");
      for (let i = 0; i < obj.length; i++) {
        if (i > 0) hash.update(",");
        const item = obj[i];
        if (isOmitted(item)) {
          hash.update("null"); // array items render as null
        } else {
          writeValue(hash, item, seen);
        }
      }
      hash.update("]");
      return;
    }

    hash.update("{");
    let first = true;
    for (const key of Object.keys(obj)) {
      const item = (obj as Record<string, unknown>)[key];
      if (isOmitted(item)) continue; // entry disappears entirely
      if (!first) hash.update(",");
      first = false;
      writeEncodedString(hash, key);
      hash.update(":");
      writeValue(hash, item, seen);
    }
    hash.update("}");
  } finally {
    seen.delete(obj);
  }
}

/** Writes a JSON-escaped, double-quoted string, flushing in ~8 KiB chunks. */
function writeEncodedString(hash: ReturnType<typeof crypto.createHash>, value: string): void {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x22) {
      out += '\\"';
    } else if (code === 0x5c) {
      out += "\\\\";
    } else if (code === 0x08) {
      out += "\\b";
    } else if (code === 0x09) {
      out += "\\t";
    } else if (code === 0x0a) {
      out += "\\n";
    } else if (code === 0x0c) {
      out += "\\f";
    } else if (code === 0x0d) {
      out += "\\r";
    } else if (code < 0x20) {
      out += "\\u" + code.toString(16).padStart(4, "0");
    } else if (code >= 0xd800 && code <= 0xdfff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : NaN;
      const isHigh = code >= 0xd800 && code <= 0xdbff;
      const paired = isHigh && next >= 0xdc00 && next <= 0xdfff;
      if (paired) {
        out += value[i] + value[i + 1];
        i++;
      } else {
        out += "\\u" + code.toString(16).padStart(4, "0");
      }
    } else {
      out += value[i];
    }
    if (out.length > 8192) {
      hash.update(out);
      out = "";
    }
  }
  out += '"';
  hash.update(out);
}
