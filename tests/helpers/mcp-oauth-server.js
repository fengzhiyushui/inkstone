import http from "node:http";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";

/** Real loopback resource + authorization server. Only the network allowlist is relaxed by tests. */
export async function createMockOAuthServer(options = {}) {
  const calls = [];
  const codes = new Map();
  const json = (res, value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
  let base;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, base);
    calls.push({ path: url.pathname, method: req.method, body, headers: req.headers });
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      if (options.defaultMetadataMissing && url.pathname !== "/.well-known/oauth-protected-resource/custom") return json(res, {}, 404);
      return json(res, { resource: options.resource || `${base}/mcp`, authorization_servers: [options.issuer || base] });
    }
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
      return json(res, { issuer: options.metadataIssuer || options.issuer || base, authorization_endpoint: `${base}/authorize`,
        token_endpoint: options.tokenEndpoint || `${base}/token`, registration_endpoint: options.registration === false ? undefined : `${base}/register`,
        response_types_supported: ["code"], code_challenge_methods_supported: options.pkce || ["S256"],
        client_id_metadata_document_supported: options.cidm !== false, ...options.metadata });
    }
    if (url.pathname === "/register") return json(res, { client_id: "registered-public-client", token_endpoint_auth_method: "none" });
    if (url.pathname === "/authorize") {
      const code = randomBytes(16).toString("hex");
      codes.set(code, Object.fromEntries(url.searchParams));
      const callback = new URL(url.searchParams.get("redirect_uri"));
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", options.callbackState || url.searchParams.get("state"));
      if (!options.omitIssuer) callback.searchParams.set("iss", options.callbackIssuer || options.issuer || base);
      if (options.denied) callback.searchParams.set("error", "access_denied");
      res.writeHead(302, { Location: callback.href }); res.end(); return;
    }
    if (url.pathname === "/token") {
      const params = new URLSearchParams(body);
      if (options.tokenRedirect) { res.writeHead(307, { Location: options.tokenRedirect }); res.end(); return; }
      await options.beforeTokenResponse?.(params);
      if (options.delayTokenMs) await new Promise((resolve) => setTimeout(resolve, options.delayTokenMs));
      if (params.get("grant_type") === "refresh_token") {
        if (options.refreshFail) return json(res, { error: "invalid_grant", error_description: "DO_NOT_LEAK_REFRESH_SECRET" }, 400);
        return json(res, { access_token: "rotated-access-secret", refresh_token: "rotated-refresh-secret", token_type: "Bearer", expires_in: 3600 });
      }
      const grant = codes.get(params.get("code"));
      codes.delete(params.get("code"));
      if (!grant || grant.code_challenge_method !== "S256" ||
          createHash("sha256").update(params.get("code_verifier") || "").digest("base64url") !== grant.code_challenge ||
          grant.redirect_uri !== params.get("redirect_uri") || grant.client_id !== params.get("client_id") || grant.resource !== params.get("resource")) {
        return json(res, { error: "invalid_grant" }, 400);
      }
      return json(res, { access_token: "initial-access-secret", refresh_token: "initial-refresh-secret", token_type: "Bearer", expires_in: options.expiresIn || 3600, ...options.tokens });
    }
    if (url.pathname === "/mcp") {
      if (!req.headers.authorization || options.rejectTokens || (options.rejectInitialToken && req.headers.authorization === "Bearer initial-access-secret")) {
        res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/custom"`);
        return json(res, { error: "authorization_required" }, 401);
      }
      if (options.mcpHandler) return options.mcpHandler(req, res, body);
      return json(res, { ok: true });
    }
    return json(res, {}, 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, resource: `${base}/mcp`, calls, options,
    async authorize(authorizationUrl) {
      const response = await fetch(authorizationUrl, { redirect: "manual" });
      return fetch(response.headers.get("location"));
    },
    close() { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); }
  };
}
