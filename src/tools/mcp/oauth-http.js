import { pinnedHttpRequest } from "./http-client.js";

/** OAuth credentials are sent only to the configured resource, never across a redirect. */
export async function oauthHttpRequest(url, resolveOptions, requestOptions, oauth = null, resourceUrl = url) {
  if (!oauth) return pinnedHttpRequest(url, resolveOptions, requestOptions);
  if (new URL(url).origin !== new URL(resourceUrl).origin) {
    throw Object.assign(new Error("OAuth MCP endpoint must remain on the configured resource origin"), { code: "MCP_OAUTH_RESOURCE_MISMATCH" });
  }
  let token = await oauth.getAccessToken();
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = Object.fromEntries(Object.entries(requestOptions.headers || {})
      .filter(([name]) => name.toLowerCase() !== "authorization"));
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await pinnedHttpRequest(url, { ...resolveOptions, maxRedirects: 0 }, { ...requestOptions, headers });
    if (response.status !== 401) return response;
    const challenge = response.getHeader("www-authenticate") || "";
    response.stream?.destroy?.();
    token = await oauth.handleUnauthorized(challenge, { accessToken: token, allowRefresh: attempt === 0 });
    if (!token || attempt > 0) {
      throw Object.assign(new Error("MCP authorization required; sign in to this server"), { code: "MCP_AUTH_REQUIRED", status: 401 });
    }
  }
}
