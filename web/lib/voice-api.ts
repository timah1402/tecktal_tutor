import { apiFetch, apiUrl } from "@/lib/api";

/**
 * Relays a voice-triggered function call (received from OpenAI's Realtime
 * API) to the backend, which executes it through a real MCP `call_tool`
 * round-trip (see `deeptutor/services/voice/mcp_action_server.py`) instead
 * of validating it again client-side.
 */
export async function executeVoiceAction(
  name: string,
  args: Record<string, unknown>,
): Promise<{ status: string; message?: string; [key: string]: unknown }> {
  try {
    const resp = await apiFetch(apiUrl("/api/v1/voice/execute-action"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, arguments: args }),
    });
    if (!resp.ok) {
      const detail = (await resp.json().catch(() => null)) as { detail?: string } | null;
      return { status: "error", message: detail?.detail || `HTTP ${resp.status}` };
    }
    return (await resp.json()) as { status: string; message?: string };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
