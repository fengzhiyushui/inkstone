// Ephemeral MCP form state. Never pass field values to chat history or event logs.
export const MCP_INPUT_MAX_LENGTH = 16_384;

export function inputFields(request) {
  const schema = request?.requestedSchema;
  if (schema?.type !== "object" || (schema.properties != null && typeof schema.properties !== "object")) throw new Error("Unsupported MCP form");
  const required = new Set(schema.required || []);
  const fields = Object.entries(schema.properties || {}).map(([name, rule]) => {
    if (!rule || !["string", "number", "integer", "boolean", "array"].includes(rule.type)) throw new Error("Unsupported MCP form field");
    return { name, rule, required: required.has(name) };
  });
  if (fields.length > 64) throw new Error("Too many MCP form fields");
  return fields;
}

export function parseInputField(field, raw) {
  if (raw.length > MCP_INPUT_MAX_LENGTH) throw new Error("Input is too long");
  if (!raw && !field.required) return { omitted: true };
  const { rule } = field;
  let value = raw;
  if (rule.type === "boolean") {
    if (!/^(true|false)$/i.test(raw.trim())) throw new Error("Enter true or false");
    value = raw.trim().toLowerCase() === "true";
  } else if (rule.type === "number" || rule.type === "integer") {
    if (!raw.trim()) throw new Error("Enter a number");
    value = Number(raw);
    if (!Number.isFinite(value) || (rule.type === "integer" && !Number.isInteger(value))) throw new Error("Enter a valid number");
    if ((rule.minimum != null && value < rule.minimum) || (rule.maximum != null && value > rule.maximum)) throw new Error("Number is outside the permitted range");
  } else if (rule.type === "array") {
    try { value = JSON.parse(raw); } catch { throw new Error("Enter a JSON array"); }
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("Enter a JSON array of strings");
    const allowed = rule.items?.enum || rule.items?.anyOf?.map((item) => item.const);
    if (allowed && value.some((item) => !allowed.includes(item))) throw new Error("Choose the listed values");
    if ((rule.minItems != null && value.length < rule.minItems) || (rule.maxItems != null && value.length > rule.maxItems)) throw new Error("Incorrect number of selected values");
  } else {
    if ((rule.minLength != null && Array.from(raw).length < rule.minLength) || (rule.maxLength != null && Array.from(raw).length > rule.maxLength)) throw new Error("Input length is outside the permitted range");
  }
  const allowed = rule.enum || rule.oneOf?.map((item) => item.const);
  if (allowed && !allowed.includes(value)) throw new Error("Choose a listed value");
  return { value };
}

export function inputFieldHint({ rule }) {
  const choices = rule.enum || rule.oneOf?.map((item) => item.const) || rule.items?.enum || rule.items?.anyOf?.map((item) => item.const);
  return [rule.type === "array" ? "JSON array" : rule.type, rule.format || "", choices ? JSON.stringify(choices) : "",
    rule.minimum != null ? `min ${rule.minimum}` : "", rule.maximum != null ? `max ${rule.maximum}` : "",
    rule.minLength != null ? `min length ${rule.minLength}` : "", rule.maxLength != null ? `max length ${rule.maxLength}` : ""].filter(Boolean).join(" · ");
}

// The event contains only identifiers. Fetch private descriptors from the facade,
// and service them while agent.send/approve is still waiting for the server.
export function createMcpInputResponder({ kernel, prompt, write = () => {} }) {
  let closed = false;
  let pumping = false;
  let dirty = false;
  let active = null;
  const attempted = new Set();
  const respond = (id, response) => Promise.resolve().then(() => kernel.mcp.respondInputRequest(id, response));

  async function pump() {
    dirty = true;
    if (pumping || closed || !kernel?.mcp?.listInputRequests || !kernel?.mcp?.respondInputRequest) return;
    pumping = true;
    try {
      while (dirty && !closed) {
        dirty = false;
        const requests = await kernel.mcp.listInputRequests();
        // Re-fetch after each answer: another client may resolve a queued form.
        const next = (requests || []).find((request) => !attempted.has(request.requestId));
        for (const request of next ? [next] : []) {
          if (closed) break;
          dirty = true;
          attempted.add(request.requestId);
          if (attempted.size > 512) attempted.delete(attempted.values().next().value);
          const controller = new AbortController();
          active = { requestId: request.requestId, controller };
          const expires = typeof request.expiresAt === "number" ? request.expiresAt : Date.parse(request.expiresAt);
          const timer = Number.isFinite(expires) ? setTimeout(() => controller.abort(), Math.max(0, Math.min(2_147_483_647, expires - Date.now()))) : null;
          timer?.unref?.();
          try {
            while (!controller.signal.aborted && !closed) {
              const response = prompt ? await prompt(request, { signal: controller.signal }) : { action: "decline" };
              if (controller.signal.aborted || closed) break;
              try {
                await respond(request.requestId, response || { action: "cancel" });
                break;
              } catch (error) {
                if (error?.code !== "MCP_INPUT_INVALID" || response?.action !== "accept") throw error;
                const pending = await kernel.mcp.listInputRequests();
                if (!(pending || []).some((entry) => entry.requestId === request.requestId)) break;
                write("MCP input did not match the form; please enter it again.");
              }
            }
          } catch {
            if (!controller.signal.aborted && !closed) {
              write("MCP input could not be submitted; request declined.");
              await respond(request.requestId, { action: "decline" }).catch(() => {});
            }
          } finally {
            if (timer) clearTimeout(timer);
            controller.abort();
            active = null;
          }
        }
      }
    } catch { write("MCP input is unavailable."); }
    finally { pumping = false; }
  }

  return {
    handle(event) {
      if (event?.type === "mcp:input_resolved" && event.requestId === active?.requestId) active.controller.abort();
      if (event?.type === "mcp:input_required" || event?.type === "mcp:input_resolved") void pump();
    },
    refresh: pump,
    close() {
      closed = true;
      active?.controller.abort();
      return Promise.resolve().then(() => kernel?.mcp?.listInputRequests?.()).then((requests) => Promise.allSettled((requests || []).map((request) => respond(request.requestId, { action: "cancel" })))).catch(() => {});
    }
  };
}
