# Optional reasoning providers

Operator Key ships no model, account, or credential. Search, copy, and insertion work without reasoning. A fresh install has `enabled: false`; it does not contact a provider. Reasoning is an opt-in way to rank and explain catalog entries that Operator Key has already selected. It never executes model-authored commands.

On Linux, the operator-owned configuration is normally `~/.config/operator-key/reasoning.json`. The native app shows its actual path. Use a private file (mode 0600). `docs/reasoning.example.json` is a valid disabled starting point. Settings can edit local HTTP providers; version-pinned CLI providers are file-managed and read-only in the editor. Resetting explicitly removes the configuration.

## OpenCode with an economical cloud model

This provider uses your separately signed-in OpenCode CLI and OpenAI account. It sends your typed intent plus bounded catalog candidate fields to OpenAI. Do not use it for sensitive intent text you would not send to OpenAI. Never paste a password, API key, token, or verification code into the app.

1. Install a trusted OpenCode executable and complete `opencode auth login` through OpenCode's normal sign-in flow. Check `opencode auth list` for an OpenAI OAuth entry; do not copy its credential file into this repository.
2. Locate the actual executable, not a shell wrapper or version-manager shim. For a mise install, `mise which opencode` can point to it. Check its exact `--version` output — the reviewed 1.18.32 build exits 0 and prints exactly `1.18.32\n` on stdout with empty stderr; any leading space, vendor banner, or extra line means the executable on disk is not the reviewed build and `opencode_version` will reject it.
3. Create your private reasoning configuration with the corresponding absolute executable path and version:

```json
{
  "enabled": true,
  "provider": "opencode",
  "model": "openai/gpt-6-luna",
  "opencode_path": "/absolute/path/to/reviewed/opencode",
  "opencode_version": "1.18.32",
  "timeout_seconds": 90
}
```

The example version was tested with OpenCode 1.18.32; use the version that actually matches your reviewed executable, and re-review its permissions when upgrading. `endpoint` does not apply. The app requires an `openai/` model, a real absolute CLI path, and an exact version pin; `api_key_env` is not accepted for this provider. Test from Settings, then run a bounded search intent. The CLI provider is not editable in the local-HTTP settings form, so a webview cannot silently change its path or remove the pin.

OpenAI [describes GPT-6 Luna as its efficient focused-task model](https://developers.openai.com/api/docs/models/gpt-6-luna). Its published API rates are $0.10 input and $0.50 output per million tokens, versus GPT-5.6 Luna's $0.20 and $1.20; see the [OpenAI release/pricing announcement](https://openai.com/index/introducing-gpt-6-sol-and-luna/). This app uses OpenCode's signed-in account, **not** an API-key billing setup. Subscription usage, credits, limits, and any additional charges depend on your account and may not match API rates. The model was verified with a live bounded Operator Key request; a listed model alone is not proof that an account can use it.

The app starts each `opencode run` in a private mode-0700 workspace. It redirects XDG config/data/cache/state into that workspace, passes only a minimal allowlisted environment, links OpenCode's existing private OAuth file for the CLI to use, disables external plugins with `--pure`, disables configured tools and MCP, denies all agent permissions, and sends the request over stdin rather than command-line arguments. Its NDJSON event stream must contain one complete text-only answer; any tool event, unknown event, malformed JSON, or invalid catalog ID fails closed. The temporary local session database is removed on return or timeout. This is **not** a kernel sandbox around the OpenCode binary, cryptographic deletion of temporary files, or deletion of data retained by OpenAI. Trust and pin the executable; consult OpenAI's data policy. The OpenCode CLI itself has no no-save flag, which is why the app isolates its writable directories.

## Local HTTP models

Only local HTTP providers are restricted to loopback (`127.0.0.1` or `::1`), with all resolved addresses checked before connecting. A local proxy may itself send data elsewhere; inspect the separate service. Example Ollama setup:

```sh
ollama serve
ollama pull qwen2.5-coder:7b
```

```json
{
  "enabled": true,
  "provider": "ollama",
  "model": "qwen2.5-coder:7b",
  "endpoint": "http://127.0.0.1:11434",
  "timeout_seconds": 90
}
```

An `openai-compatible` local server such as llama.cpp, LM Studio, or vLLM uses the same shape with its own model and loopback endpoint (for example `http://127.0.0.1:8080`). Small models may not reliably return the required structured output; a rejected response is not a command execution. `api_key_env`, if used for a local server, names an environment variable rather than storing its value.

## Codex CLI

The separate `codex` provider uses its own sign-in and can send bounded intent data to its cloud provider. It is file-managed in Settings. An optional `codex_version` exact pin freezes the reviewed CLI surface; see the implementation and test suite for its restrictions. It is not the OpenCode integration above.

## Boundaries and troubleshooting

- Intent text is at most 2,000 UTF-8 bytes; the app reconstructs metadata for at most 220 selected catalog entries. The total prompt is capped at 128 KiB. It does not attach local files, shell history, environment variables, terminal contents, or installed package lists; text you type yourself may of course contain a path or secret, so review it before enabling cloud reasoning.
- The provider must return one to five ordered recommendations using only IDs supplied by the app. Every field is bounded; catalog command text is rendered from trusted app data, never from model output. Dangerous commands remain copy-only.
- A CLI process has an overall 5–600-second configurable deadline, a 64-KiB stdout/stderr capture ceiling, and process-group termination on timeout. Direct local HTTP has bounded request and response bodies. A failed provider never causes a command to execute or insert.
- `spark_intent_status` reports availability, account sign-in metadata, the selected provider/model, and a safe diagnostic; it does not return credentials. OpenCode's status checks its exact binary version and whether OpenAI OAuth is listed. Status is not proof that a particular model call will succeed; use the test button.
- `get_reasoning_settings` returns `{enabled, provider, model, endpoint, timeout_seconds}` only. `save_reasoning_settings` accepts exactly those five fields for local HTTP settings and rejects overwriting file-managed CLI/legacy credential fields. `reset_reasoning_settings` explicitly removes the config and returns disabled defaults. Saved file writes use an exclusive same-directory temporary file (mode 0600), fsync, and atomic rename.
- To turn reasoning off, set `enabled` to `false` in the private file or use the explicit Reset button. Search, copy, and insert continue to work. Disabling reasoning does not sign you out of OpenCode.
