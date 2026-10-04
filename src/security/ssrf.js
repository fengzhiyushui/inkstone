import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";

/**
 * SSRF 防护:URL 校验 + DNS 固定(anti-rebinding)。
 *
 * 默认拒绝私网 / 保留网段与 localhost。MCP 场景下用户常常自建内网 Server,
 * 因此支持**显式 allowlist**:只有列出的 CIDR/hostname 才放行私网地址,
 * 未列出的一律 fail-closed(不因 allowlist 存在而放宽其它目标)。
 */

export class SsrfBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = "SsrfBlockedError";
    this.code = "SSRF_BLOCKED";
  }
}

function blocked(message) {
  throw new SsrfBlockedError(message);
}

/** 解析 allowlist 条目:支持精确 IP、CIDR(v4)、以及 hostname。 */
export function parseAllowEntry(entry) {
  const raw = String(entry || "").trim();
  if (!raw) return null;
  if (raw.includes("/")) {
    const [base, bitsRaw] = raw.split("/");
    const bits = Number(bitsRaw);
    if (net.isIP(base) !== 4 || !Number.isInteger(bits) || bits < 0 || bits > 32) {
      throw new Error(`invalid SSRF allowlist CIDR: ${raw}`);
    }
    return { kind: "cidr", base, bits };
  }
  if (net.isIP(raw) === 4) return { kind: "ip", value: raw };
  return { kind: "host", value: raw.toLowerCase() };
}

function normalizeAllowlist(allowlist) {
  if (!allowlist) return [];
  const entries = Array.isArray(allowlist) ? allowlist : [allowlist];
  return entries.map(parseAllowEntry).filter(Boolean);
}

function ipToInt(ip) {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function cidrContains(base, bits, ip) {
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return (ipToInt(base) & mask) === (ipToInt(ip) & mask);
}

/** 该地址是否被 allowlist 明确放行。 */
export function isAllowedByList(address, allowlist = []) {
  const normalized = stripBrackets(String(address || "").toLowerCase());
  for (const entry of normalizeAllowlist(allowlist)) {
    if (entry.kind === "ip" && entry.value === normalized) return true;
    if (entry.kind === "cidr" && net.isIP(normalized) === 4 && cidrContains(entry.base, entry.bits, normalized)) {
      return true;
    }
    if (entry.kind === "host" && entry.value === normalized) return true;
  }
  return false;
}

/**
 * 解析并校验目标,返回直连用的已验证地址。
 * @param {string} rawUrl
 * @param {{ lookup?: Function, allowlist?: string[] }} [options]
 */
export async function resolveFetchTarget(rawUrl, { lookup = dnsLookup, allowlist = [] } = {}) {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    blocked(`unsupported protocol: ${url.protocol}`);
  }
  validateHostname(url.hostname, { allowlist });

  if (isBareIPv4(url.hostname)) {
    return { url, address: url.hostname };
  }
  if (url.hostname.includes(":")) {
    // validateHostname 已拒绝 IPv6;保留 fail-closed 防御。
    blocked(`IPv6 addresses are blocked: ${url.hostname}`);
  }

  const resolved = await lookup(url.hostname, { family: 4, all: true });
  const addresses = normalizeLookupResults(resolved);
  if (addresses.length === 0) blocked(`DNS returned no IPv4 address: ${url.hostname}`);
  // 允许任意一个解析结果命中 allowlist 即可,但其余结果仍必须"要么干净、要么也被放行",
  // 否则 DNS 多记录可被用来绕过(一条合法 + 一条内网)。
  const hostAllowed = isAllowedByList(url.hostname, allowlist);
  const resolvedAllowed = hostAllowed || addresses.some((a) => isAllowedByList(a, allowlist));
  if (!resolvedAllowed) {
    for (const address of addresses) validateResolvedAddress(address, url.hostname);
  }
  // 网络层必须直连这个已验证地址,避免 fetch 再次 DNS 解析产生 rebinding/TOCTOU。
  return { url, address: addresses[0] };
}

export async function validateFetchUrl(rawUrl, options = {}) {
  return (await resolveFetchTarget(rawUrl, options)).url;
}

export function validateHostname(hostname, { allowlist = [] } = {}) {
  const normalized = stripBrackets(hostname.toLowerCase());
  if (isAllowedByList(normalized, allowlist)) return;
  validateResolvedAddress(normalized, hostname);
}

export function validateResolvedAddress(address, label = address, { allowlist = [] } = {}) {
  const normalized = stripBrackets(String(address).toLowerCase());
  if (isAllowedByList(normalized, allowlist)) return;
  if (normalized === "localhost") blocked(`blocked internal hostname: ${label}`);
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice(7);
    if (isBlockedAddress(mapped)) {
      blocked(`blocked internal IPv4-mapped IPv6 address: ${label}`);
    }
  }
  if (normalized.includes(":")) {
    blocked(`IPv6 addresses are blocked: ${label}`);
  }
  if (isPrivateIPv4(normalized)) blocked(`blocked private network: ${label}`);
  if (isReservedIPv4(normalized)) blocked(`blocked reserved network: ${label}`);
}

function normalizeLookupResults(resolved) {
  const entries = Array.isArray(resolved) ? resolved : [resolved];
  return [...new Set(entries
    .map((item) => typeof item === "string" ? item : item?.address)
    .filter((address) => net.isIP(address) === 4))];
}

function isBlockedAddress(normalized) {
  return normalized === "localhost" || isPrivateIPv4(normalized) || isReservedIPv4(normalized);
}

export function isPrivateIPv4(ip) {
  if (net.isIP(ip) !== 4) return false;
  const nums = ip.split(".").map(Number);
  if (nums[0] === 10) return true;
  if (nums[0] === 172 && nums[1] >= 16 && nums[1] <= 31) return true;
  if (nums[0] === 192 && nums[1] === 168) return true;
  return false;
}

export function isReservedIPv4(ip) {
  if (net.isIP(ip) !== 4) return false;
  const [a, b, c, d] = ip.split(".").map(Number);
  if (a === 0) return true;                            // current network / software
  if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT 100.64/10
  if (a === 127) return true;                          // loopback
  if (a === 169 && b === 254) return true;             // link-local
  if (a === 192 && b === 0 && c === 0) return true;   // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true;   // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast(deprecated)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark 198.18/15
  if (a === 198 && b === 51 && c === 100) return true;  // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true;   // TEST-NET-3
  if (a >= 224) return true;                           // multicast / reserved / broadcast
  return a === 255 && b === 255 && c === 255 && d === 255;
}

function isBareIPv4(hostname) {
  return net.isIP(hostname) === 4;
}

function stripBrackets(value) {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}
