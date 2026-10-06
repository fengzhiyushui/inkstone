import { StringDecoder } from "node:string_decoder";

export const CAPABILITY_CONTENT_DEFAULT_BYTES = 64 * 1024;
export const CAPABILITY_CONTENT_MAX_BYTES = 1024 * 1024;

export function capabilityLimit(value, fallback, ceiling, minimum = 1) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < minimum || !Number.isInteger(value)) {
    throw new TypeError(`MCP limit must be an integer >= ${minimum}`);
  }
  return Math.min(value, ceiling);
}

function clipUtf8(text, limit) {
  return new StringDecoder("utf8").write(Buffer.from(text, "utf8").subarray(0, Math.max(0, limit)));
}

// Preserve resource identities and binary data. Only human-readable text may be
// shortened; oversized binary blocks are omitted rather than returning corrupt
// base64. Unknown fields never bypass the byte budget.
function textSlot(entry, kind) {
  if (kind === "contents" && typeof entry?.text === "string") return [entry, "text"];
  if (kind === "messages" && entry?.content?.type === "text" && typeof entry.content.text === "string") return [entry.content, "text"];
  if (kind === "messages" && entry?.content?.type === "resource" && typeof entry.content.resource?.text === "string") return [entry.content.resource, "text"];
  return null;
}

export function boundCapabilityContent(raw, kind, maxBytes) {
  const items = Array.isArray(raw) ? raw : [];
  const output = [];
  let used = 2; // JSON array brackets
  let truncated = false;
  for (const original of items) {
    const available = maxBytes - used - (output.length ? 1 : 0);
    const serialized = JSON.stringify(original);
    if (typeof serialized !== "string") { truncated = true; break; }
    let entry = original;
    let entryBytes = Buffer.byteLength(serialized, "utf8");
    if (entryBytes > available) {
      // Shallow-copy only the known text path; do not mutate RPC/cache values.
      entry = kind === "contents" ? { ...original } : {
        ...original, content: { ...original?.content, ...(original?.content?.resource ? { resource: { ...original.content.resource } } : {}) }
      };
      const slot = textSlot(entry, kind);
      if (!slot) { truncated = true; break; }
      const text = slot[0][slot[1]];
      slot[0][slot[1]] = "";
      const overhead = Buffer.byteLength(JSON.stringify(entry), "utf8");
      if (overhead > available) { truncated = true; break; }
      // JSON escaping can make text larger than its UTF-8 representation.
      let lo = 0, hi = Math.min(Buffer.byteLength(text, "utf8"), available - overhead);
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        slot[0][slot[1]] = clipUtf8(text, mid);
        if (Buffer.byteLength(JSON.stringify(entry), "utf8") <= available) lo = mid;
        else hi = mid - 1;
      }
      slot[0][slot[1]] = clipUtf8(text, lo);
      entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
      truncated = true;
    }
    output.push(JSON.parse(JSON.stringify(entry)));
    used += entryBytes + (output.length > 1 ? 1 : 0);
    if (truncated) break;
  }
  return { [kind]: output, supported: true, ...(truncated ? { truncated: true } : {}), bytes: used };
}
