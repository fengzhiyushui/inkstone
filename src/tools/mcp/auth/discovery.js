import { isAllowedByList, resolveFetchTarget } from "../../../security/ssrf.js";
import { pinnedHttpRequest } from "../http-client.js";
import { MODERN_PROTOCOL_VERSION } from "../protocol.js";

export class McpOAuthError extends Error {
  constructor(code, message) { super(message); this.name = "McpOAuthError"; this.code = code; }
}

export function oauthError(code = "MCP_OAUTH_FAILED", message = "MCP OAuth request failed") {
  return new McpOAuthError(code, message);
}

/** No remote body, URL query, or underlying network error is included in public failures. */
export function safeOAuthError(error) {
  return error instanceof McpOAuthError ? error : oauthError();
}

export function validateOAuthUrl(raw, { allowlist = [], issuer = false } = {}) {
  let url;
  try { url = new URL(raw); } catch { throw oauthError("MCP_OAUTH_URL", "Invalid OAuth endpoint URL"); }
  const loopback = /^127\./.test(url.hostname) || url.hostname === "localhost";
  const localHttp = url.protocol === "http:" && loopback && isAllowedByList(url.hostname, allowlist);
  if ((url.protocol !== "https:" && !localHttp) || url.username || url.password || url.hash || (issuer && url.search)) {
    throw oauthError("MCP_OAUTH_URL", "OAuth requires HTTPS (explicitly allowed loopback HTTP is supported)");
  }
  return url;
}

export async function validateOAuthTarget(raw, options) {
  const url = validateOAuthUrl(raw, options);
  try { await resolveFetchTarget(url.href, options); }
  catch { throw oauthError("MCP_OAUTH_SSRF", "OAuth endpoint blocked by network policy"); }
  return url;
}

export async function oauthJsonRequest(raw, options, { method = "GET", body, signal, headers = {} } = {}) {
  const url = validateOAuthUrl(raw, options);
  let response;
  try {
    response = await pinnedHttpRequest(url.href, { ...options, maxRedirects: 0 }, {
      method, body, signal, timeoutMs: options.timeoutMs || 15000, maxBodyBytes: 256 * 1024,
      headers: { Accept: "application/json", ...headers }
    });
  } catch { throw oauthError("MCP_OAUTH_NETWORK", "OAuth endpoint request failed or was blocked"); }
  if (response.status < 200 || response.status >= 300) {
    const error = oauthError("MCP_OAUTH_HTTP", "OAuth endpoint rejected the request");
    error.status = response.status;
    throw error;
  }
  if (response.truncated) throw oauthError("MCP_OAUTH_METADATA", "OAuth response exceeds size limit");
  try {
    const value = JSON.parse(response.text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw oauthError("MCP_OAUTH_METADATA", "Invalid OAuth JSON response"); }
}

function wellKnown(raw, kind) {
  const url = new URL(raw);
  return `${url.origin}/.well-known/${kind}${url.pathname === "/" ? "" : url.pathname}`;
}

async function firstMetadata(urls, options) {
  let last;
  for (const url of [...new Set(urls)]) {
    try { return await oauthJsonRequest(url, options); }
    catch (error) {
      last = error;
      if (error.status !== 404 && error.status !== 405) throw error;
    }
  }
  throw last || oauthError("MCP_OAUTH_DISCOVERY", "OAuth metadata was not found");
}

/** Challenge parsing is bounded and ignores non-Bearer challenges. */
export function resourceMetadataFromChallenge(challenge) {
  if (typeof challenge !== "string" || challenge.length > 16384 || !/(?:^|,)\s*Bearer\b/i.test(challenge)) return null;
  const bearer = challenge.slice(challenge.search(/\bBearer\b/i));
  const matches = [...bearer.matchAll(/\bresource_metadata\s*=\s*"([^"\r\n]+)"/gi)];
  return matches.length === 1 ? matches[0][1] : null;
}

/** An explicit login may precede any MCP connection. Discover its challenge without credentials. */
async function probeResourceMetadata(resource, options) {
  const controller = new AbortController();
  const timeoutMs = Math.min(options.timeoutMs || 15000, 15000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await pinnedHttpRequest(resource, { ...options, maxRedirects: 0 }, {
      method: "POST", signal: controller.signal, timeoutMs, stream: true,
      headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json",
        "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION, "Mcp-Method": "server/discover" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "oauth-discovery", method: "server/discover", params: {} })
    });
    const metadata = response.status === 401 ? resourceMetadataFromChallenge(response.getHeader("www-authenticate")) : null;
    response.stream.destroy();
    if (!metadata) throw oauthError("MCP_OAUTH_DISCOVERY", "MCP resource did not provide OAuth metadata");
    return metadata;
  } catch (error) {
    throw error instanceof McpOAuthError ? error : oauthError("MCP_OAUTH_DISCOVERY", "MCP OAuth metadata discovery failed or was blocked");
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function discoverOAuth(config, options, challengeMetadata = null) {
  const resource = validateOAuthUrl(config.url, options).href;
  const resourceUrl = new URL(resource);
  const metadataUrl = challengeMetadata || config.oauth?.resourceMetadataUrl;
  let prm;
  try {
    prm = await firstMetadata(metadataUrl ? [metadataUrl] : [
      wellKnown(resource, "oauth-protected-resource"), `${resourceUrl.origin}/.well-known/oauth-protected-resource`
    ], options);
  } catch (error) {
    if (metadataUrl || (error.status !== 404 && error.status !== 405)) throw error;
    const challengeUrl = await probeResourceMetadata(resource, options);
    prm = await firstMetadata([challengeUrl], options);
  }
  if (prm.resource !== resource || !Array.isArray(prm.authorization_servers) || !prm.authorization_servers.length) {
    throw oauthError("MCP_OAUTH_RESOURCE", "OAuth protected resource metadata does not match this MCP resource");
  }
  const issuer = config.oauth?.issuer || prm.authorization_servers[0];
  if (typeof issuer !== "string" || !prm.authorization_servers.includes(issuer)) {
    throw oauthError("MCP_OAUTH_ISSUER", "Configured OAuth issuer is not authorized for this resource");
  }
  const issuerUrl = validateOAuthUrl(issuer, { ...options, issuer: true });
  const metadata = await firstMetadata([
    wellKnown(issuer, "oauth-authorization-server"),
    `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
    wellKnown(issuer, "openid-configuration")
  ], options);
  if (metadata.issuer !== issuer) throw oauthError("MCP_OAUTH_ISSUER", "OAuth authorization server issuer mismatch");
  if (!metadata.code_challenge_methods_supported?.includes("S256")) {
    throw oauthError("MCP_OAUTH_PKCE", "OAuth authorization server must support PKCE S256");
  }
  if (metadata.response_types_supported && !metadata.response_types_supported.includes("code")) {
    throw oauthError("MCP_OAUTH_METADATA", "OAuth authorization code flow is not supported");
  }
  // Browser navigations are checked as well; token/registration requests will validate and pin again.
  await validateOAuthTarget(metadata.authorization_endpoint, options);
  await validateOAuthTarget(metadata.token_endpoint, options);
  if (metadata.registration_endpoint) await validateOAuthTarget(metadata.registration_endpoint, options);
  return { issuer: issuerUrl.href === issuer ? issuerUrl.href : issuer, resource, metadata };
}
