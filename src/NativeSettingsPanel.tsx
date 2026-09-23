import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { OperatorRuntime } from "./runtime";
import "./native-settings.css";

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
interface Props { runtime: OperatorRuntime; nativeInvoke?: Invoke; onChanged?: () => void; testCandidateId?: string }
interface Settings {
  enabled: boolean;
  provider: "disabled" | "ollama" | "openai-compatible" | "codex";
  model: string;
  endpoint: string;
  timeout_seconds: number;
}
const failures: Record<string, string> = {
  path_unavailable: "The local catalog location is unavailable.",
  unreadable: "The local catalog could not be read.",
  unsafe_file_type: "The local catalog is not a supported regular file.",
  too_large: "The local catalog exceeds the size limit.",
  malformed: "The local catalog is malformed.",
  invalid_schema: "The local catalog does not match the required schema.",
  empty: "The local catalog contains no entries.",
};
function loopback(value: string): boolean {
  // Deliberately narrower than native parsing: no credentials, query, or path secrets.
  return /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?\/?$/.test(value)
    && (() => { try { return Number(new URL(value).port || 80) > 0; } catch { return false; } })();
}
function parseSettings(value: unknown): Settings {
  if (!value || typeof value !== "object") throw new Error("Invalid settings");
  const v = value as Record<string, unknown>;
  if (typeof v.enabled !== "boolean" || !["disabled", "ollama", "openai-compatible", "codex"].includes(String(v.provider))
    || typeof v.model !== "string" || v.model.length > 256 || (v.model !== "" && !/^[A-Za-z0-9._:/-]+$/.test(v.model))
    || typeof v.endpoint !== "string" || !loopback(v.endpoint)
    || typeof v.timeout_seconds !== "number" || !Number.isInteger(v.timeout_seconds) || v.timeout_seconds < 5 || v.timeout_seconds > 600) throw new Error("Invalid settings");
  return { enabled: v.enabled, provider: v.provider as Settings["provider"], model: v.model, endpoint: v.endpoint, timeout_seconds: v.timeout_seconds };
}
function validate(settings: Settings): string | null {
  if (!loopback(settings.endpoint)) return "Use a plain HTTP loopback endpoint (127.0.0.1, localhost, or [::1]), without credentials or a path.";
  if (!Number.isInteger(settings.timeout_seconds) || settings.timeout_seconds < 5 || settings.timeout_seconds > 600) return "Choose a timeout between 5 and 600 seconds.";
  if (settings.model.length > 256 || (settings.model && !/^[A-Za-z0-9._:/-]+$/.test(settings.model))) return "Use a model identifier, not a credential or free-text prompt.";
  if (settings.enabled && (settings.provider === "disabled" || !settings.model)) return "Choose a local provider and model before enabling reasoning.";
  if (settings.provider === "codex") return "Legacy Codex configuration is managed outside this editor. It will not be overwritten.";
  return null;
}
export function NativeSettingsPanel({ runtime, nativeInvoke = invoke, onChanged, testCandidateId }: Props) {
  const [draft, setDraft] = useState<Settings>();
  const [saved, setSaved] = useState<Settings>();
  const [health, setHealth] = useState("Checking catalog source…");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => {
    if (runtime !== "native") return;
    let active = true;
    nativeInvoke("get_reasoning_settings").then((value) => {
      const settings = parseSettings(value);
      if (active) { setDraft(settings); setSaved(settings); }
    }).catch(() => { if (active) setError("Could not load editable reasoning settings. Existing configuration has not been changed. Review the local configuration or reset it explicitly."); });
    nativeInvoke("catalog_health").then((value) => {
      if (!value || typeof value !== "object") throw new Error("Invalid health");
      const data = value as Record<string, unknown>;
      if (!["embedded", "sidecar"].includes(String(data.source))) throw new Error("Invalid health");
      const source = data.source === "sidecar" ? "Local catalog loaded." : "Bundled reference catalog loaded; this is not proof of locally installed tools.";
      const failure = data.failure ? (failures[String(data.failure)] ?? "The local catalog could not be used.") : "";
      if (active) setHealth(`${source} ${failure}`.trim());
    }).catch(() => { if (active) setHealth("Catalog health unavailable. Search can still use the loaded catalog."); });
    return () => { active = false; };
  }, [runtime, nativeInvoke]);
  if (runtime !== "native") return <section className="native-settings"><h2>Catalog & reasoning</h2><p>Bundled reference catalog. Open the native app to configure a local model or inspect a local catalog. This browser does not call a model.</p></section>;
  const update = (change: Partial<Settings>) => { if (draft) setDraft({ ...draft, ...change }); setMessage(""); setError(""); };
  const same = (a: Settings, b: Settings) => JSON.stringify(a) === JSON.stringify(b);
  const save = async () => {
    if (!draft || busy) return;
    const invalid = validate(draft);
    if (invalid) { setError(invalid); return; }
    setBusy(true); setError(""); setMessage("");
    try {
      const returned = parseSettings(await nativeInvoke("save_reasoning_settings", { settings: draft }));
      const readback = parseSettings(await nativeInvoke("get_reasoning_settings"));
      if (!same(returned, readback) || !same(draft, readback)) throw new Error("Readback mismatch");
      setDraft(readback); setSaved(readback); setMessage("Settings saved and verified. Saving does not contact the model."); onChanged?.();
    } catch { setError("Settings could not be saved and verified. Check the local configuration, permissions, and provider. Legacy credentials or version pins must be managed in the configuration file; they are never silently removed."); }
    finally { setBusy(false); }
  };
  const reset = async () => {
    if (busy || !confirmReset) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await nativeInvoke("reset_reasoning_settings");
      const readback = parseSettings(await nativeInvoke("get_reasoning_settings"));
      if (readback.enabled || readback.provider !== "disabled") throw new Error("Reset not verified");
      setDraft(readback); setSaved(readback); setConfirmReset(false); setMessage("Reasoning reset and verified disabled."); onChanged?.();
    } catch { setError("Reset could not be verified. Existing configuration may require manual recovery; no success is assumed."); }
    finally { setBusy(false); }
  };
  const test = async () => {
    if (!saved || !draft || busy || !saved.enabled || !same(saved, draft) || !testCandidateId) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await nativeInvoke("reason_about_intent", { intent: "Explain the selected catalog command without executing anything.", candidateIds: [testCandidateId] });
      if (!result || typeof result !== "object" || !("summary" in result) || typeof result.summary !== "string") throw new Error("Invalid result");
      setMessage("Local model answered the sample request. No command was copied, inserted, or executed.");
    } catch { setError("The local model test failed. Confirm the saved endpoint, running model, and timeout. No command was executed."); }
    finally { setBusy(false); }
  };
  return <section className="native-settings" aria-label="Native model and catalog settings">
    <h2>Catalog health</h2><p>{health}</p>
    <h2>Optional local reasoning</h2>
    <p>Search works without a model. Enabling this sends your intent and bounded catalog fields to your configured service. HTTP providers are loopback-only; a service you operate may itself forward requests. No credentials belong in these fields.</p>
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {!draft && !error && <p>Loading settings…</p>}
    {draft && <fieldset disabled={busy || draft.provider === "codex"}>
      <legend>Local HTTP provider</legend>
      <label><input type="checkbox" checked={draft.enabled} onChange={(e) => update({ enabled: e.target.checked })} />Enable local reasoning</label>
      <label>Local model provider<select value={draft.provider} onChange={(e) => update({ provider: e.target.value as Settings["provider"] })}><option value="disabled">Disabled</option><option value="ollama">Ollama</option><option value="openai-compatible">OpenAI-compatible local server</option>{draft.provider === "codex" && <option value="codex">Legacy Codex — file managed</option>}</select></label>
      <label>Model identifier<input value={draft.model} maxLength={256} autoComplete="off" placeholder="Your installed model name" onChange={(e) => update({ model: e.target.value })} /></label>
      <label>Loopback endpoint<input value={draft.endpoint} maxLength={2048} autoComplete="off" spellCheck={false} onChange={(e) => update({ endpoint: e.target.value })} /></label>
      <label>Request timeout (seconds)<input type="number" min={5} max={600} value={draft.timeout_seconds} onChange={(e) => update({ timeout_seconds: Number(e.target.value) })} /></label>
      <div className="settings-actions"><button type="button" onClick={() => void save()}>Save reasoning settings</button><button type="button" disabled={!saved?.enabled || !same(draft, saved) || !testCandidateId} onClick={() => void test()}>Test local model</button></div>
      <p className="settings-note">Test sends a fixed sample intent and one catalog reference through the saved provider. Save changes before testing.</p>
    </fieldset>}
    {draft?.provider === "codex" && <p>Legacy Codex configuration may contact its provider. It is read-only here; review its configuration and privacy policy, or explicitly reset it.</p>}
    {!confirmReset ? <button type="button" disabled={busy} onClick={() => setConfirmReset(true)}>Reset reasoning</button> : <div className="reset-confirmation"><p>Remove the reasoning configuration, including legacy configuration fields, and return to disabled? This cannot restore your previous settings.</p><button type="button" disabled={busy} onClick={() => void reset()}>Confirm reset</button><button type="button" disabled={busy} onClick={() => setConfirmReset(false)}>Cancel reset</button></div>}
  </section>;
}
