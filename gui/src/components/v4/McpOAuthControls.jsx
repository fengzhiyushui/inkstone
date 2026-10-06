import React from "react";
import { createMcpAuthController } from "../../state/mcp-oauth.js";

export default function McpOAuthControls({ serverId, initialStatus, disabled, kernel, t, onChanged }) {
  const [auth, setAuth] = React.useState({ status: initialStatus?.status || initialStatus || "unauthenticated", busy: false });
  const controller = React.useRef(null);
  const changed = React.useRef(onChanged);
  changed.current = onChanged;
  React.useEffect(() => {
    const current = createMcpAuthController({ kernel, serverId, initialStatus,
      onState: setAuth, onChanged: () => changed.current?.() });
    controller.current = current;
    void current.refresh();
    return () => current.dispose();
  }, [kernel, serverId]);
  const pending = auth.status === "pending";
  const authenticated = auth.status === "authenticated";
  return <div className="mcp-oauth-controls">
    <div className="mcp-oauth-row">
      <span role="status" aria-live="polite">{t("mcp.oauth.label")}: {t(`mcp.oauth.${auth.status}`)}</span>
      {pending ? <button type="button" className="btn ghost" disabled={auth.busy}
        onClick={() => controller.current?.run("cancelMcpAuth")}>{t("mcp.oauth.cancel")}</button>
        : authenticated ? <button type="button" className="btn ghost" disabled={auth.busy}
          onClick={() => controller.current?.run("logoutMcpAuth")}>{t("mcp.oauth.logout")}</button>
          : <button type="button" className="btn accent" disabled={disabled || auth.busy || auth.status === "disabled"}
            onClick={() => controller.current?.run("startMcpAuth")}>{auth.busy ? t("mcp.oauth.opening") : t("mcp.oauth.login")}</button>}
      <button type="button" className="btn ghost" disabled={auth.busy}
        onClick={() => controller.current?.refresh()}>{t("mcp.oauth.refresh")}</button>
    </div>
    {auth.issuer && <div className="mcp-input-desc">{t("mcp.oauth.issuer")}: {auth.issuer}</div>}
    {pending && <div className="mcp-input-desc">{t("mcp.oauth.browserHint")}</div>}
    {auth.status === "error" && <div className="mcp-error-banner" role="alert">{t("mcp.oauth.errorHint")}</div>}
  </div>;
}
