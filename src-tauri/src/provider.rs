//! Reasoning provider configuration and transport.
//!
//! Three rules govern this module, and every one of them is enforced by code in this
//! file rather than by documentation or by the operator's good intentions:
//!
//! 1. **The app ships no model, no account, and no credential.** Configuration lives
//!    outside the repository in the operator's own config directory. A fresh clone from
//!    GitHub has reasoning disabled and no way to inherit anyone else's access.
//!
//! 2. **A credential value is never stored in the config file.** The file may name an
//!    environment variable; the value is read from the process environment at call time,
//!    used for exactly one request header, and never logged, never returned to the
//!    webview, and never included in an error message.
//!
//! 3. **Direct HTTP is loopback-only.** `parse_loopback_url` rejects remote hosts. CLI
//!    providers are distinct: Codex and OpenCode send bounded intent data to their
//!    signed-in cloud providers. Do not confuse their privacy boundary with local HTTP.

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{IpAddr, TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// Bounded read ceiling for a provider response body.
pub const MAX_RESPONSE_BYTES: usize = 256 * 1024;
/// Bounded ceiling for the request we are willing to send.
pub const MAX_REQUEST_BYTES: usize = 512 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_TIMEOUT_SECONDS: u64 = 90;
const MAX_TIMEOUT_SECONDS: u64 = 600;

/// Which reasoning backend to use. `Disabled` is the default for every fresh install.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderKind {
    /// No reasoning provider. Search, lessons, copy, and insert all work normally.
    #[default]
    Disabled,
    /// A local Ollama daemon, typically `http://127.0.0.1:11434`.
    Ollama,
    /// Any OpenAI-compatible server on loopback: llama.cpp, LM Studio, vLLM, a proxy.
    OpenaiCompatible,
    /// The Codex CLI, which authenticates itself from the operator's own machine.
    Codex,
    /// An isolated OpenCode CLI invocation using its OpenAI OAuth sign-in.
    Opencode,
}

impl ProviderKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Ollama => "ollama",
            Self::OpenaiCompatible => "openai-compatible",
            Self::Codex => "codex",
            Self::Opencode => "opencode",
        }
    }
}

/// Operator-owned reasoning configuration, read from outside the repository.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields, rename_all = "snake_case")]
pub struct ReasoningConfig {
    /// Reasoning stays off until the operator turns it on deliberately.
    pub enabled: bool,
    pub provider: ProviderKind,
    /// Model identifier passed through to the provider. Never hardcoded in the app.
    pub model: String,
    /// Loopback base URL for HTTP providers. Ignored by CLI providers.
    pub endpoint: String,
    /// NAME of an environment variable holding an API key — never the key itself.
    /// Local servers normally need nothing here.
    pub api_key_env: Option<String>,
    /// Wall-clock ceiling for one reasoning call.
    pub timeout_seconds: u64,
    /// Exact `codex --version` string required by the `codex` provider. `None` accepts
    /// any installed version, which is the right default once the app no longer pins a
    /// single reviewed build.
    pub codex_version: Option<String>,
    /// Absolute path to the reviewed OpenCode executable. Do not point this at a
    /// package-manager shim or a shell wrapper with side effects.
    pub opencode_path: Option<String>,
    /// Exact `opencode --version` string. Required for this security-sensitive CLI.
    pub opencode_version: Option<String>,
    /// Ignored by the parser; lets the shipped example carry human-readable notes.
    #[serde(rename = "_comment", skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

impl Default for ReasoningConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: ProviderKind::Disabled,
            model: String::new(),
            endpoint: "http://127.0.0.1:11434".into(),
            api_key_env: None,
            timeout_seconds: DEFAULT_TIMEOUT_SECONDS,
            codex_version: None,
            opencode_path: None,
            opencode_version: None,
            comment: None,
        }
    }
}

impl ReasoningConfig {
    /// Clamp the configured deadline into a sane band so a typo cannot hang the app
    /// forever or make every call fail instantly.
    pub fn timeout(&self) -> Duration {
        Duration::from_secs(self.timeout_seconds.clamp(5, MAX_TIMEOUT_SECONDS))
    }

    /// Validate the parts of the configuration that must hold before any request runs.
    pub fn validate(&self) -> Result<(), String> {
        if !self.enabled || self.provider == ProviderKind::Disabled {
            return Ok(());
        }
        if self.model.trim().is_empty() {
            return Err("Set `model` in the reasoning config before enabling it.".into());
        }
        if self.model.len() > 256 || !is_safe_identifier(&self.model) {
            return Err("The configured `model` name contains unsupported characters.".into());
        }
        if let Some(name) = &self.api_key_env {
            if name.trim().is_empty() || !is_safe_env_name(name) {
                return Err("`api_key_env` must be a plain environment variable NAME.".into());
            }
        }
        match self.provider {
            ProviderKind::Ollama | ProviderKind::OpenaiCompatible => {
                parse_loopback_url(&self.endpoint).map(|_| ())
            }
            ProviderKind::Opencode => {
                if !self.model.starts_with("openai/") || self.model == "openai/" {
                    return Err("OpenCode reasoning requires an openai/ model identifier.".into());
                }
                if self.api_key_env.is_some() || self.codex_version.is_some() {
                    return Err("OpenCode uses its own sign-in; remove unrelated credential and version fields.".into());
                }
                let Some(path) = self.opencode_path.as_deref() else {
                    return Err(
                        "Set `opencode_path` to the absolute reviewed OpenCode executable.".into(),
                    );
                };
                if path.len() > 2048
                    || !std::path::Path::new(path).is_absolute()
                    || path.chars().any(char::is_control)
                {
                    return Err("`opencode_path` must be a plain absolute executable path.".into());
                }
                let Some(version) = self.opencode_version.as_deref() else {
                    return Err("Pin `opencode_version` before enabling OpenCode reasoning.".into());
                };
                if version.len() > 32
                    || version.split('.').count() != 3
                    || version
                        .split('.')
                        .any(|part| part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()))
                {
                    return Err("`opencode_version` must be an exact numeric version.".into());
                }
                Ok(())
            }
            ProviderKind::Codex | ProviderKind::Disabled => Ok(()),
        }
    }
}

/// Model names are passed to a provider verbatim, so keep them to an unsurprising set
/// rather than trusting that every downstream server quotes them correctly.
fn is_safe_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-' | ':' | '/')
        })
}

fn is_safe_env_name(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
        && !value.starts_with(|character: char| character.is_ascii_digit())
}

/// A parsed, proven-local endpoint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoopbackUrl {
    pub host: String,
    pub port: u16,
}

impl LoopbackUrl {
    pub fn authority(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

/// Parse an endpoint and prove it points at this machine.
///
/// This is the single choke point that keeps operator intent on the local host. It runs
/// before any socket is opened, resolves the name, and requires **every** resolved
/// address to be a loopback address — a name that resolves to both `127.0.0.1` and a
/// public address is rejected rather than accepted on its good half.
pub fn parse_loopback_url(endpoint: &str) -> Result<LoopbackUrl, String> {
    let trimmed = endpoint.trim();
    if trimmed.len() > 2048 {
        return Err("The configured `endpoint` is too long.".into());
    }
    let rest = trimmed.strip_prefix("http://").ok_or_else(|| {
        "`endpoint` must start with http:// and point at this machine.".to_owned()
    })?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return Err("`endpoint` is missing a host.".into());
    }
    if authority.contains('@') {
        return Err("`endpoint` must not contain credentials.".into());
    }

    let (host, port) = if let Some(remainder) = authority.strip_prefix('[') {
        // Bracketed IPv6 literal, e.g. [::1]:11434
        let (inside, tail) = remainder
            .split_once(']')
            .ok_or_else(|| "`endpoint` has an unterminated IPv6 host.".to_owned())?;
        let port = match tail.strip_prefix(':') {
            Some(value) => value
                .parse::<u16>()
                .map_err(|_| "`endpoint` has an invalid port.".to_owned())?,
            None if tail.is_empty() => 80,
            None => return Err("`endpoint` has an invalid IPv6 authority.".into()),
        };
        (inside.to_owned(), port)
    } else {
        match authority.rsplit_once(':') {
            Some((name, value)) => (
                name.to_owned(),
                value
                    .parse::<u16>()
                    .map_err(|_| "`endpoint` has an invalid port.".to_owned())?,
            ),
            None => (authority.to_owned(), 80),
        }
    };

    if host.is_empty() {
        return Err("`endpoint` is missing a host.".into());
    }
    if port == 0 {
        return Err("`endpoint` has an invalid port.".into());
    }

    // A literal address needs no resolver, and refusing to resolve one keeps this check
    // deterministic and offline for the common case.
    if let Ok(address) = host.parse::<IpAddr>() {
        return if address.is_loopback() {
            Ok(LoopbackUrl { host, port })
        } else {
            Err(local_only_message())
        };
    }

    let resolved: Vec<_> = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|_| "`endpoint` host could not be resolved.".to_owned())?
        .collect();
    if resolved.is_empty() {
        return Err("`endpoint` host could not be resolved.".into());
    }
    if resolved.iter().all(|address| address.ip().is_loopback()) {
        Ok(LoopbackUrl { host, port })
    } else {
        Err(local_only_message())
    }
}

fn local_only_message() -> String {
    "Operator Key only sends reasoning requests to a local endpoint (127.0.0.1, ::1). \
Point `endpoint` at a model running on this machine."
        .to_owned()
}

/// Location of the operator-owned config file, outside the repository.
///
/// `$OPERATOR_KEY_CONFIG` wins so tests and packagers can redirect it; otherwise the
/// XDG config directory, then `~/.config`.
pub fn config_path() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("OPERATOR_KEY_CONFIG") {
        if !explicit.is_empty() {
            return Some(PathBuf::from(explicit));
        }
    }
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .filter(|value| !value.is_empty())
                .map(|home| PathBuf::from(home).join(".config"))
        })?;
    Some(base.join("operator-key").join("reasoning.json"))
}

/// Read the operator's configuration, defaulting to "off" whenever it is absent.
///
/// A missing file is the expected state for a fresh clone and is not an error. A file
/// that exists but cannot be parsed IS an error: silently falling back to defaults would
/// hide a typo that the operator believes is protecting them.
pub fn load_config() -> Result<ReasoningConfig, String> {
    let Some(path) = config_path() else {
        return Ok(ReasoningConfig::default());
    };
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ReasoningConfig::default())
        }
        Err(_) => return Err("The reasoning config file could not be read.".into()),
    };
    if bytes.len() > 64 * 1024 {
        return Err("The reasoning config file is unexpectedly large.".into());
    }
    let config: ReasoningConfig = serde_json::from_slice(&bytes)
        .map_err(|_| "The reasoning config file is not valid JSON for this schema.".to_owned())?;
    config.validate()?;
    Ok(config)
}

/// Resolve the API key from the environment, by variable name.
///
/// Returns the value only to the caller that immediately builds a request header. The
/// value is never stored, never logged, and never crosses back into the webview.
pub fn resolve_api_key(config: &ReasoningConfig) -> Option<String> {
    let name = config.api_key_env.as_ref()?;
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

#[derive(Debug)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

/// Minimal HTTP/1.1 POST against a proven-loopback endpoint.
///
/// Hand-rolled on purpose. A full HTTP client would bring a TLS stack, and a TLS stack is
/// the only thing standing between this module and the ability to ship an operator's
/// intent to a remote service. Without one, "local only" is a property of the code rather
/// than a promise in the docs.
pub fn post_json(
    url: &LoopbackUrl,
    path: &str,
    body: &[u8],
    api_key: Option<&str>,
    deadline: Instant,
) -> Result<HttpResponse, String> {
    if body.len() > MAX_REQUEST_BYTES {
        return Err("The reasoning request exceeded its size limit.".into());
    }
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err("The reasoning request timed out.".into());
    }

    let mut stream = TcpStream::connect_timeout(
        &url.authority()
            .to_socket_addrs()
            .map_err(|_| "The local model endpoint could not be resolved.".to_owned())?
            .find(|address| address.ip().is_loopback())
            .ok_or_else(local_only_message)?,
        CONNECT_TIMEOUT.min(remaining),
    )
    .map_err(|_| {
        format!(
            "No local model is listening on {}. Start it, or turn reasoning off.",
            url.authority()
        )
    })?;
    stream
        .set_read_timeout(Some(remaining))
        .and_then(|()| stream.set_write_timeout(Some(remaining)))
        .map_err(|_| "The local model connection could not be configured.".to_owned())?;

    let mut request = Vec::with_capacity(body.len() + 512);
    request.extend_from_slice(
        format!(
            "POST {path} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nAccept: application/json\r\n",
            url.authority(),
            body.len()
        )
        .as_bytes(),
    );
    if let Some(key) = api_key {
        // Reject a key that cannot sit in a header rather than splicing CRLF into the
        // request, which would let a poisoned environment variable forge headers.
        if key.bytes().any(|byte| byte < 0x20 || byte == 0x7f) {
            return Err("The configured API key contains invalid characters.".into());
        }
        request.extend_from_slice(format!("Authorization: Bearer {key}\r\n").as_bytes());
    }
    request.extend_from_slice(b"\r\n");
    request.extend_from_slice(body);

    stream
        .write_all(&request)
        .and_then(|()| stream.flush())
        .map_err(|_| "The reasoning request could not be sent to the local model.".to_owned())?;

    let mut raw = Vec::with_capacity(8 * 1024);
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        if Instant::now() >= deadline {
            return Err("The local model did not respond before the deadline.".into());
        }
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                raw.extend_from_slice(&buffer[..count]);
                // Bound the read: one extra byte proves overflow without buffering more.
                if raw.len() > MAX_RESPONSE_BYTES + 1 {
                    return Err("The local model returned an oversized response.".into());
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                return Err("The local model did not respond before the deadline.".into());
            }
            Err(_) => return Err("The local model connection failed.".into()),
        }
    }

    parse_http_response(&raw)
}

/// Split a raw HTTP/1.1 response into status and body, honouring chunked encoding.
pub fn parse_http_response(raw: &[u8]) -> Result<HttpResponse, String> {
    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "The local model returned a malformed response.".to_owned())?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let mut lines = head.split("\r\n");
    let status_line = lines
        .next()
        .ok_or_else(|| "The local model returned a malformed response.".to_owned())?;
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| "The local model returned a malformed status line.".to_owned())?;
    let chunked = lines.any(|line| {
        let lower = line.to_ascii_lowercase();
        lower.starts_with("transfer-encoding:") && lower.contains("chunked")
    });

    let body = &raw[split + 4..];
    let body = if chunked {
        decode_chunked(body)?
    } else {
        body.to_vec()
    };
    if body.len() > MAX_RESPONSE_BYTES {
        return Err("The local model returned an oversized response.".into());
    }
    Ok(HttpResponse { status, body })
}

fn decode_chunked(mut input: &[u8]) -> Result<Vec<u8>, String> {
    let mut output = Vec::with_capacity(input.len().min(8 * 1024));
    loop {
        let line_end = input
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or_else(|| "The local model returned a malformed chunked body.".to_owned())?;
        let size_text = String::from_utf8_lossy(&input[..line_end]);
        let size_text = size_text.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_text, 16)
            .map_err(|_| "The local model returned a malformed chunk size.".to_owned())?;
        input = &input[line_end + 2..];
        if size == 0 {
            return Ok(output);
        }
        if size > MAX_RESPONSE_BYTES || output.len() + size > MAX_RESPONSE_BYTES {
            return Err("The local model returned an oversized response.".into());
        }
        if input.len() < size {
            return Err("The local model returned a truncated chunk.".into());
        }
        output.extend_from_slice(&input[..size]);
        input = &input[size..];
        if input.starts_with(b"\r\n") {
            input = &input[2..];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_install_has_reasoning_disabled_and_no_credential() {
        let config = ReasoningConfig::default();

        assert!(!config.enabled);
        assert_eq!(config.provider, ProviderKind::Disabled);
        assert_eq!(config.api_key_env, None);
        assert!(config.model.is_empty());
        assert!(config.validate().is_ok());
        assert_eq!(resolve_api_key(&config), None);
    }

    #[test]
    fn loopback_hosts_are_accepted_with_and_without_explicit_ports() {
        for (endpoint, port) in [
            ("http://127.0.0.1:11434", 11434),
            ("http://127.0.0.1", 80),
            ("http://[::1]:8080", 8080),
            ("http://127.5.5.5:1234", 1234),
            ("http://127.0.0.1:11434/", 11434),
            ("http://127.0.0.1:11434/v1/chat/completions", 11434),
        ] {
            let parsed = parse_loopback_url(endpoint)
                .unwrap_or_else(|error| panic!("{endpoint} should parse: {error}"));
            assert_eq!(parsed.port, port);
        }
    }

    #[test]
    fn every_remote_endpoint_is_refused_before_a_socket_is_opened() {
        for endpoint in [
            "http://api.openai.com/v1/chat/completions",
            "http://1.1.1.1:11434",
            "http://169.254.169.254/latest/meta-data",
            "http://[2606:4700:4700::1111]:80",
            "https://127.0.0.1:11434",
            "ftp://127.0.0.1",
            "http://user:password@127.0.0.1:11434",
            "http://",
            "http://127.0.0.1:0",
            "http://127.0.0.1:not-a-port",
        ] {
            assert!(
                parse_loopback_url(endpoint).is_err(),
                "{endpoint} must be refused"
            );
        }
    }

    #[test]
    fn a_remote_endpoint_error_never_echoes_the_configured_host() {
        // A literal remote address is decided without a resolver, so this path is
        // deterministic offline and must carry the local-only explanation.
        let literal = parse_loopback_url("http://203.0.113.10:9000").unwrap_err();
        assert!(literal.contains("local endpoint"), "got: {literal}");
        assert!(!literal.contains("203.0.113.10"), "got: {literal}");

        // A named host may be refused either because it resolved to a non-loopback
        // address or because it did not resolve at all. Both are safe refusals, and
        // neither may echo the operator's configured hostname back into the UI.
        let named = parse_loopback_url("http://secret-internal-host.example.com:9000").unwrap_err();
        assert!(
            !named.contains("secret-internal-host"),
            "the configured host must never be echoed: {named}"
        );
    }

    #[test]
    fn configuration_requires_a_model_and_rejects_unsafe_names() {
        let base = ReasoningConfig {
            enabled: true,
            provider: ProviderKind::Ollama,
            ..ReasoningConfig::default()
        };

        assert!(base.validate().is_err(), "an empty model must be refused");

        for model in ["qwen2.5-coder:7b", "llama3.2:3b", "gpt-oss:20b"] {
            let config = ReasoningConfig {
                model: model.into(),
                ..base.clone()
            };
            assert!(config.validate().is_ok(), "{model} should be accepted");
        }

        for model in ["model; rm -rf /", "model\nInjected: header", "model $(id)"] {
            let config = ReasoningConfig {
                model: model.into(),
                ..base.clone()
            };
            assert!(config.validate().is_err(), "{model:?} must be refused");
        }
    }

    #[test]
    fn api_key_env_accepts_a_name_and_refuses_anything_that_looks_like_a_value() {
        let base = ReasoningConfig {
            enabled: true,
            provider: ProviderKind::OpenaiCompatible,
            model: "local-model".into(),
            ..ReasoningConfig::default()
        };

        let named = ReasoningConfig {
            api_key_env: Some("OPERATOR_KEY_API_KEY".into()),
            ..base.clone()
        };
        assert!(named.validate().is_ok());

        for value in ["sk-abcdef0123456789", "Bearer token", "", "2FA_KEY", "a b"] {
            let config = ReasoningConfig {
                api_key_env: Some(value.into()),
                ..base.clone()
            };
            assert!(
                config.validate().is_err(),
                "{value:?} must be refused as an env NAME"
            );
        }
    }

    #[test]
    fn a_disabled_config_is_valid_even_when_other_fields_are_unset() {
        let config = ReasoningConfig {
            enabled: false,
            provider: ProviderKind::Ollama,
            model: String::new(),
            ..ReasoningConfig::default()
        };

        assert!(config.validate().is_ok());
    }

    #[test]
    fn timeouts_are_clamped_into_a_usable_band() {
        let fast = ReasoningConfig {
            timeout_seconds: 0,
            ..ReasoningConfig::default()
        };
        let slow = ReasoningConfig {
            timeout_seconds: u64::MAX,
            ..ReasoningConfig::default()
        };

        assert_eq!(fast.timeout(), Duration::from_secs(5));
        assert_eq!(slow.timeout(), Duration::from_secs(MAX_TIMEOUT_SECONDS));
    }

    #[test]
    fn config_rejects_unknown_fields_rather_than_ignoring_a_typo() {
        let json = br#"{"enabled":true,"provider":"ollama","modle":"typo"}"#;

        let parsed = serde_json::from_slice::<ReasoningConfig>(json);

        assert!(parsed.is_err(), "an unknown field must fail loudly");
    }

    #[test]
    fn config_parses_the_documented_example_shape() {
        let json = br#"{
            "_comment": "notes are allowed",
            "enabled": true,
            "provider": "ollama",
            "model": "qwen2.5-coder:7b",
            "endpoint": "http://127.0.0.1:11434",
            "timeout_seconds": 90
        }"#;

        let config: ReasoningConfig = serde_json::from_slice(json).unwrap();

        assert!(config.enabled);
        assert_eq!(config.provider, ProviderKind::Ollama);
        assert_eq!(config.model, "qwen2.5-coder:7b");
        assert_eq!(config.api_key_env, None);
        assert!(config.validate().is_ok());
    }

    #[test]
    fn shipped_example_is_valid_disabled_configuration() {
        let example = include_str!("../../docs/reasoning.example.json");
        let config: ReasoningConfig = serde_json::from_str(example).unwrap();
        assert!(!config.enabled);
        assert_eq!(config.provider, ProviderKind::Disabled);
        assert!(config.validate().is_ok());
    }

    #[test]
    fn opencode_requires_a_pinned_binary_and_openai_model_without_api_key_env() {
        let base = ReasoningConfig {
            enabled: true,
            provider: ProviderKind::Opencode,
            model: "openai/gpt-6-luna".into(),
            opencode_path: Some("/opt/opencode/1.18.32/opencode".into()),
            opencode_version: Some("1.18.32".into()),
            ..ReasoningConfig::default()
        };
        assert!(base.validate().is_ok());
        for invalid in [
            ReasoningConfig {
                model: "opencode/unknown".into(),
                ..base.clone()
            },
            ReasoningConfig {
                opencode_path: Some("opencode".into()),
                ..base.clone()
            },
            ReasoningConfig {
                opencode_path: None,
                ..base.clone()
            },
            ReasoningConfig {
                opencode_version: None,
                ..base.clone()
            },
            ReasoningConfig {
                opencode_version: Some("1.18.32\nextra".into()),
                ..base.clone()
            },
            ReasoningConfig {
                api_key_env: Some("OPENAI_API_KEY".into()),
                ..base.clone()
            },
        ] {
            assert!(invalid.validate().is_err());
        }
        let json = serde_json::to_string(&base).unwrap();
        assert_eq!(
            serde_json::from_str::<ReasoningConfig>(&json).unwrap(),
            base
        );
        let serialized: serde_json::Value = serde_json::from_str(&json).unwrap();
        let fields: std::collections::BTreeSet<_> = serialized
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            fields,
            [
                "api_key_env",
                "codex_version",
                "enabled",
                "endpoint",
                "model",
                "opencode_path",
                "opencode_version",
                "provider",
                "timeout_seconds",
            ]
            .into_iter()
            .collect()
        );
    }

    #[test]
    fn http_responses_are_parsed_for_plain_and_chunked_bodies() {
        let plain = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}";
        let parsed = parse_http_response(plain).unwrap();
        assert_eq!(
            (parsed.status, parsed.body.as_slice()),
            (200, b"{}".as_ref())
        );

        let chunked =
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{\"a\"\r\n4\r\n:1}\n\r\n0\r\n\r\n";
        let parsed = parse_http_response(chunked).unwrap();
        assert_eq!(parsed.status, 200);
        assert_eq!(parsed.body, b"{\"a\":1}\n");

        let error = parse_http_response(b"HTTP/1.1 500 Internal Server Error\r\n\r\nboom").unwrap();
        assert_eq!(error.status, 500);
    }

    #[test]
    fn malformed_responses_fail_closed() {
        for raw in [
            b"not http at all".as_ref(),
            b"HTTP/1.1\r\n\r\n".as_ref(),
            b"HTTP/1.1 OK\r\n\r\nbody".as_ref(),
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n".as_ref(),
        ] {
            assert!(parse_http_response(raw).is_err());
        }
    }

    #[test]
    fn config_path_prefers_an_explicit_override_and_stays_outside_the_repository() {
        let path = config_path().expect("a config path should resolve in a normal environment");

        assert!(path.ends_with("operator-key/reasoning.json"));
        assert!(
            !path.starts_with(env!("CARGO_MANIFEST_DIR")),
            "config must never live inside the repository: {}",
            path.display()
        );
    }
}
