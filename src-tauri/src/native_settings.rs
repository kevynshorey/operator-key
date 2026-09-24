use crate::provider::{self, ProviderKind, ReasoningConfig};
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "snake_case")]
pub struct ReasoningSettings {
    pub enabled: bool,
    pub provider: ProviderKind,
    pub model: String,
    pub endpoint: String,
    pub timeout_seconds: u64,
}
impl From<ReasoningConfig> for ReasoningSettings {
    fn from(c: ReasoningConfig) -> Self {
        Self {
            enabled: c.enabled,
            provider: c.provider,
            model: c.model,
            endpoint: c.endpoint,
            timeout_seconds: c.timeout_seconds,
        }
    }
}
fn path() -> Result<PathBuf, String> {
    provider::config_path().ok_or_else(|| "Reasoning settings path is unavailable.".into())
}
#[tauri::command]
pub async fn get_reasoning_settings() -> Result<ReasoningSettings, String> {
    tauri::async_runtime::spawn_blocking(|| read_at(&path()?).map(Into::into))
        .await
        .map_err(|_| "Settings read failed.".to_string())?
}
#[tauri::command]
pub async fn save_reasoning_settings(
    settings: ReasoningSettings,
) -> Result<ReasoningSettings, String> {
    tauri::async_runtime::spawn_blocking(move || save(settings))
        .await
        .map_err(|_| "Settings save failed.".to_string())?
}
#[tauri::command]
pub async fn reset_reasoning_settings() -> Result<ReasoningSettings, String> {
    tauri::async_runtime::spawn_blocking(|| reset_at(&path()?).map(Into::into))
        .await
        .map_err(|_| "Settings reset failed.".to_string())?
}
fn save(s: ReasoningSettings) -> Result<ReasoningSettings, String> {
    save_at(&path()?, s)
}

fn read_at(p: &std::path::Path) -> Result<ReasoningConfig, String> {
    match fs::symlink_metadata(p) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ReasoningConfig::default()),
        Err(_) => return Err("Settings read failed.".into()),
        Ok(m) if m.file_type().is_symlink() || !m.is_file() => {
            return Err("Unsafe settings path.".into())
        }
        Ok(m) if m.len() > 64 * 1024 => return Err("Settings file is too large.".into()),
        Ok(_) => {}
    }
    let bytes = match fs::read(p) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ReasoningConfig::default()),
        Err(_) => return Err("Settings read failed.".into()),
    };
    if bytes.len() > 64 * 1024 {
        return Err("Settings file is too large.".into());
    }
    let c: ReasoningConfig = serde_json::from_slice(&bytes)
        .map_err(|_| "Settings file is malformed or has an unsupported schema.".to_string())?;
    if matches!(c.provider, ProviderKind::Codex | ProviderKind::Opencode) {
        c.validate()?;
        return Ok(c);
    }
    validate_editable(&c)?;
    Ok(c)
}

fn reset_at(p: &std::path::Path) -> Result<ReasoningConfig, String> {
    match fs::symlink_metadata(p) {
        Ok(m) if m.file_type().is_symlink() || !m.is_file() => {
            return Err("Unsafe settings path.".into())
        }
        Ok(_) => fs::remove_file(p).map_err(|_| "Settings reset failed.".to_string())?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("Settings reset failed.".into()),
    }
    Ok(ReasoningConfig::default())
}

fn save_at(p: &std::path::Path, s: ReasoningSettings) -> Result<ReasoningSettings, String> {
    let existing = match read_at(p) {
        Ok(c) => c,
        Err(e) if e == "Settings read failed." => return Err(e),
        Err(e) => return Err(format!("Existing settings cannot be safely replaced: {e}")),
    };
    if matches!(
        existing.provider,
        ProviderKind::Codex | ProviderKind::Opencode
    ) || existing.api_key_env.is_some()
        || existing.codex_version.is_some()
        || existing.opencode_path.is_some()
        || existing.opencode_version.is_some()
    {
        return Err("Cannot overwrite file-managed CLI, credentials, or version-pinned settings in this editor; reset explicitly or edit the config file.".into());
    }
    let c = ReasoningConfig {
        enabled: s.enabled,
        provider: s.provider,
        model: s.model,
        endpoint: s.endpoint,
        timeout_seconds: s.timeout_seconds,
        api_key_env: None,
        codex_version: None,
        opencode_path: None,
        opencode_version: None,
        comment: None,
    };
    validate_editable(&c)?;
    let parent = p.parent().ok_or("Unsafe settings path.")?;
    fs::create_dir_all(parent).map_err(|_| "Settings directory could not be created.")?;
    if let Ok(m) = fs::symlink_metadata(p) {
        if m.file_type().is_symlink() || !m.is_file() {
            return Err("Unsafe settings path.".into());
        }
    }
    static N: AtomicU64 = AtomicU64::new(0);
    let tmp = parent.join(format!(
        ".reasoning-{}-{}.tmp",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let result: Result<(), String> = (|| {
        let bytes = serde_json::to_vec_pretty(&c).map_err(|_| "Settings could not be encoded.")?;
        let mut o = OpenOptions::new();
        o.write(true).create_new(true);
        #[cfg(unix)]
        o.mode(0o600);
        let mut f = o.open(&tmp).map_err(|_| "Settings could not be written.")?;
        f.write_all(&bytes)
            .map_err(|_| "Settings could not be written.")?;
        f.sync_all().map_err(|_| "Settings could not be written.")?;
        fs::rename(&tmp, p).map_err(|_| "Settings could not be saved.")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result?;
    Ok(c.into())
}

fn validate_editable(c: &ReasoningConfig) -> Result<(), String> {
    if !(5..=600).contains(&c.timeout_seconds) {
        return Err("timeout_seconds must be between 5 and 600.".into());
    }
    if c.model.len() > 256 || c.endpoint.len() > 2048 {
        return Err("model or endpoint is too long.".into());
    }
    if !c
        .model
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-' | ':' | '/'))
    {
        return Err("Use a model identifier, not a credential or prompt.".into());
    }
    if matches!(c.provider, ProviderKind::Codex | ProviderKind::Opencode) {
        return Err("CLI settings are file-managed and cannot be edited here.".into());
    }
    if c.enabled && (c.provider == ProviderKind::Disabled || c.model.is_empty()) {
        return Err("Choose a local provider and model before enabling reasoning.".into());
    }
    // Validate even disabled drafts. They remain persisted and may later be enabled.
    provider::parse_loopback_url(&c.endpoint)?;
    let authority = c
        .endpoint
        .strip_prefix("http://")
        .ok_or("Use an HTTP loopback endpoint.")?;
    if authority.trim_end_matches('/').contains('/')
        || authority.contains('?')
        || authority.contains('#')
        || authority.contains('@')
    {
        return Err("Endpoint must not contain credentials, paths, queries, or fragments.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "operator-key-native-settings-{}-{}",
            std::process::id(),
            {
                static SEQUENCE: AtomicU64 = AtomicU64::new(0);
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            }
        ));
        fs::create_dir_all(&dir).unwrap();
        (dir.join("reasoning.json"), dir)
    }
    fn valid() -> ReasoningSettings {
        ReasoningSettings {
            enabled: true,
            provider: ProviderKind::Ollama,
            model: "local".into(),
            endpoint: "http://127.0.0.1:11434".into(),
            timeout_seconds: 20,
        }
    }
    #[test]
    fn disabled_http_settings_are_validated_before_persistence() {
        let (p, dir) = fixture();
        for endpoint in [
            "http://203.0.113.1:11434",
            "http://user:secret@127.0.0.1:11434",
            "http://127.0.0.1:11434/?token=secret",
        ] {
            let mut settings = valid();
            settings.enabled = false;
            settings.endpoint = endpoint.into();
            assert!(
                save_at(&p, settings).is_err(),
                "disabled settings accepted unsafe endpoint"
            );
            assert!(!p.exists());
        }
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn legacy_config_is_preserved_on_save_rejection() {
        let (p, dir) = fixture();
        let raw = br#"{"enabled":false,"provider":"disabled","api_key_env":"LOCAL_MODEL_KEY"}"#;
        fs::write(&p, raw).unwrap();
        assert!(save_at(&p, valid()).is_err());
        assert_eq!(fs::read(&p).unwrap(), raw);
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn opencode_config_is_readable_but_cannot_be_silently_overwritten_by_webview() {
        let (p, dir) = fixture();
        let raw = br#"{"enabled":true,"provider":"opencode","model":"openai/gpt-6-luna","opencode_path":"/opt/opencode/1.18.32/opencode","opencode_version":"1.18.32","timeout_seconds":90}"#;
        fs::write(&p, raw).unwrap();
        let settings = ReasoningSettings::from(read_at(&p).unwrap());
        assert_eq!(settings.provider, ProviderKind::Opencode);
        let exposed = serde_json::to_value(&settings).unwrap();
        assert!(exposed.get("opencode_path").is_none());
        assert!(exposed.get("opencode_version").is_none());
        assert!(save_at(&p, valid()).is_err());
        assert_eq!(fs::read(&p).unwrap(), raw);
        assert_eq!(reset_at(&p).unwrap(), ReasoningConfig::default());
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn filesystem_save_read_reset_and_mode_are_real() {
        let (p, dir) = fixture();
        save_at(&p, valid()).unwrap();
        assert_eq!(read_at(&p).unwrap().model, "local");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&p).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert_eq!(reset_at(&p).unwrap(), ReasoningConfig::default());
        assert!(!p.exists());
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn malformed_and_symlink_settings_are_never_replaced_or_followed() {
        let (p, dir) = fixture();
        fs::write(&p, b"{broken").unwrap();
        assert!(read_at(&p).is_err());
        let before = fs::read(&p).unwrap();
        assert!(save_at(&p, valid()).is_err());
        assert_eq!(fs::read(&p).unwrap(), before);
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let target = dir.join("target");
            fs::write(&target, b"{} ").unwrap();
            fs::remove_file(&p).unwrap();
            symlink(&target, &p).unwrap();
            assert!(read_at(&p).is_err());
            assert!(save_at(&p, valid()).is_err());
            assert_eq!(fs::read(&target).unwrap(), b"{} ");
        }
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn ui_settings_contract_excludes_legacy_secret_fields() {
        let c:ReasoningConfig=serde_json::from_str(r#"{"enabled":false,"provider":"disabled","api_key_env":"LEGACY_SECRET","codex_version":"legacy","_comment":"note"}"#).unwrap();
        let v = serde_json::to_value(ReasoningSettings::from(c)).unwrap();
        assert!(v.get("api_key_env").is_none());
        assert!(v.get("codex_version").is_none());
    }
    #[test]
    fn rejects_remote_url_and_credential_like_endpoint() {
        for endpoint in ["http://203.0.113.4:9", "http://user:secret@127.0.0.1:9"] {
            let s = ReasoningSettings {
                enabled: true,
                provider: ProviderKind::Ollama,
                model: "local".into(),
                endpoint: endpoint.into(),
                timeout_seconds: 20,
            };
            let (p, dir) = fixture();
            assert!(save_at(&p, s).is_err());
            let _ = fs::remove_dir_all(dir);
        }
    }
    #[test]
    fn bounds_timeout_and_model() {
        for s in [
            ReasoningSettings {
                enabled: true,
                provider: ProviderKind::Ollama,
                model: "x".into(),
                endpoint: "http://127.0.0.1:11434".into(),
                timeout_seconds: 601,
            },
            ReasoningSettings {
                enabled: true,
                provider: ProviderKind::Ollama,
                model: "x".repeat(257),
                endpoint: "http://127.0.0.1:11434".into(),
                timeout_seconds: 30,
            },
        ] {
            let (p, dir) = fixture();
            assert!(save_at(&p, s).is_err());
            let _ = fs::remove_dir_all(dir);
        }
    }
    #[test]
    fn malformed_legacy_config_is_not_overwritten_by_read() {
        let raw = br#"{broken"#;
        assert!(serde_json::from_slice::<ReasoningConfig>(raw).is_err());
    }
    #[test]
    fn save_cannot_store_credentials() {
        let s = ReasoningSettings {
            enabled: false,
            provider: ProviderKind::Disabled,
            model: String::new(),
            endpoint: "http://127.0.0.1:11434".into(),
            timeout_seconds: 30,
        };
        let v = serde_json::to_value(s).unwrap();
        assert!(v.get("api_key_env").is_none());
    }
}
