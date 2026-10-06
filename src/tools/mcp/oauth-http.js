import { pinnedHttpRequest } from "./http-client.js";

/** OAuth credentials are sent only to the configured resource, never across a redirect. */
export async function oauthHttpRequest(url, resolveOptions, requestOptions, oauth = null, resourceUrl = url) {
  requestOptions.signal?.throwIfAborted();
  if (!oauth) return pinnedHttpRequest(url, resolveOptions, requestOptions);
  if (new URL(url).origin !== new URL(resourceUrl).origin) {
    throw Object.assign(new Error("OAuth MCP endpoint must remain on the configured resource origin"), { code: "MCP_OAUTH_RESOURCE_MISMATCH" });
  }
  let token = await waitForOAuth(oauth.getAccessToken(), requestOptions.signal);
  for (let attempt = 0; attempt < 2; attempt++) {
    // Token refresh/discovery can be shared and continue after one caller
    // cancels. That caller must never resume its MCP request afterwards.
    requestOptions.signal?.throwIfAborted();
    const headers = Object.fromEntries(Object.entries(requestOptions.headers || {})
      .filter(([name]) => name.toLowerCase() !== "authorization"));
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await pinnedHttpRequest(url, { ...resolveOptions, maxRedirects: 0 }, { ...requestOptions, headers });
    if (requestOptions.signal?.aborted) {
      response.stream?.destroy?.();
      requestOptions.signal.throwIfAborted();
    }
    if (response.status !== 401) return response;
    const challenge = response.getHeader("www-authenticate") || "";
    response.stream?.destroy?.();
    token = await waitForOAuth(oauth.handleUnauthorized(challenge, { accessToken: token, allowRefresh: attempt === 0 }), requestOptions.signal);
    requestOptions.signal?.throwIfAborted();
    if (!token || attempt > 0) {
      throw Object.assign(new Error("MCP authorization required; sign in to this server"), { code: "MCP_AUTH_REQUIRED", status: 401 });
    }
  }
}

// Cancel the caller's wait without aborting a shared refresh used by another
// request. Always remove the listener, including successful and failed refresh.
function waitForOAuth(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    Promise.resolve(promise).then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); }
    );
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
