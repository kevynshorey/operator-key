# Reasoning providers

Operator Key ships **no model, no API key and no account**. Search, copy and insert work
offline and always will. Reasoning is an optional extra that you point at a model **you**
run and pay for.

This page explains what that means, how to turn it on, and what the app guarantees.

## What a fresh clone does

Nothing. `enabled` defaults to `false` and `provider` defaults to `disabled`. The app
starts no process and opens no socket until you write a config saying otherwise. The
status line tells you so, and names the file to edit.

If you cloned this repository from GitHub, you are running against **your own** model or
none at all. There is no shared account, and there is nothing in this repository that
could grant access to anyone else's.

## Turning it on

Copy `docs/reasoning.example.json` to the path the app prints in its status line — on
Linux that is normally `~/.config/operator-key/reasoning.json` — then edit it.

### Option 1 — Ollama (simplest)

```bash
# install: https://ollama.com
ollama serve
ollama pull qwen2.5-coder:7b
```

```json
{
  "enabled": true,
  "provider": "ollama",
  "model": "qwen2.5-coder:7b",
  "endpoint": "http://127.0.0.1:11434"
}
```

### Option 2 — any OpenAI-compatible local server

llama.cpp's `llama-server`, LM Studio, vLLM and others expose `/v1/chat/completions`:

```json
{
  "enabled": true,
  "provider": "openai-compatible",
  "model": "qwen2.5-coder-7b-instruct",
  "endpoint": "http://127.0.0.1:8080"
}
```

### Option 3 — Codex CLI

Uses the Codex CLI's **own** sign-in. Operator Key never reads, stores or transmits your
Codex credentials; it shells out to `codex`, which authenticates itself.

```json
{
  "enabled": true,
  "provider": "codex",
  "model": "gpt-5.1-codex-max",
  "codex_version": null
}
```

Set `codex_version` to an exact string such as `"codex-cli 0.154.0"` to refuse any other
build. That is the stricter, reviewed configuration: a future Codex release could enable
a tool surface this app has not reviewed. Leave it `null` to accept whatever you have
installed.

## Which model should I use?

A 7B local model is enough. This task is **ranking and explaining commands the app has
already chosen**, not writing code. The app never executes, copies or inserts
model-authored text — the model returns catalog IDs, and Operator Key renders the command
text from its own trusted catalog. A model that hallucinates a command cannot put that
command in front of you; the plan is rejected instead.

That property is what makes a small local model a sound choice rather than a compromise.

## Guarantees

These are enforced by code and covered by tests in `src-tauri/src/provider.rs` and
`src-tauri/src/intent.rs`, not by documentation:

- **Loopback only.** Every endpoint is resolved and each address checked with
  `IpAddr::is_loopback()` before a socket is opened. A remote host is refused, and the
  error never echoes the hostname you configured.
- **No credential is ever stored.** `api_key_env` names an environment variable. The
  value is read at request time, sent only to your local server, and never written to
  disk, logged, or included in an error message.
- **Bounded in both directions.** Requests are capped at 256 KiB, responses at 1 MiB,
  every string at 4 KiB, with a deadline on the whole exchange.
- **Fail closed.** A plan is rejected unless every `entryId` is one the app supplied,
  the sequence is contiguous, and every field is within bounds.
- **The config is yours.** It lives outside the repository, is created mode `0600`, and
  is listed in `.gitignore`. It cannot be committed by accident.

## Privacy

When reasoning is enabled, what leaves the app is your typed intent plus up to 220
candidate catalog entries (command text, description, safety level). It goes to the
address you configured, which must be on your own machine.

No file paths, environment variables, shell history, terminal contents or installed
package lists are ever included.

## Native settings API

Tauri invoke commands:

- `get_reasoning_settings` returns `{enabled, provider, model, endpoint, timeout_seconds}`. Legacy `api_key_env`, `codex_version`, and `_comment` remain honored by native reasoning, but are never returned to the webview.
- `save_reasoning_settings` accepts exactly those five fields; extra keys are refused. Providers: `disabled`, `ollama`, `openai-compatible`, `codex`. Enabled HTTP providers use the existing loopback and model validation. Timeout is 5–600 seconds, model is at most 256 bytes. Credentials cannot be configured in this UI API.
- `reset_reasoning_settings` removes the settings file and returns disabled defaults.

Writes use a same-directory exclusive temporary file, Unix mode 0600, fsync, and atomic rename. No separate connection-test API is provided; reasoning itself uses the existing bounded request path and catalog-limited candidates.
