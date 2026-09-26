//! Advisory probe of the host's live shortcut environment.
//!
//! The catalog states what upstream ships; this module reports what THIS machine has
//! actually bound right now, plus keyboard layout hints — the difference between "the
//! docs say SUPER + SHIFT + A" and "your compositor will actually act on it".
//!
//! Contract:
//! - READ-ONLY: only `hyprctl -j binds` and `hyprctl -j devices`, never a dispatch or
//!   config write.
//! - ADVISORY: nothing here gates search, copy or insert. Unknown means unknown — an
//!   unavailable probe must never render as "not bound".
//! - BOUNDED: fixed caps on counts and string lengths; dispatcher arguments are
//!   DROPPED entirely (they can carry exec command lines, which embed usernames and
//!   paths — the exact class of data the UI must never see).
//! - HONEST: binds whose modifier mask contains bits we cannot name are skipped, not
//!   guessed; a truncated list says so.

use std::time::{Duration, Instant};

use serde::Deserialize;

/// Hard ceiling on reported bindings; far above any sane config, small enough to bound
/// the payload crossing the Tauri bridge.
const MAX_BINDINGS: usize = 512;
const MAX_CHORD_LEN: usize = 96;
const MAX_DESCRIPTION_LEN: usize = 160;
const MAX_DISPATCHER_LEN: usize = 64;
const MAX_LAYOUTS: usize = 8;
const MAX_LAYOUT_LEN: usize = 48;
const MAX_KEYMAP_LEN: usize = 64;
/// The probe runs at overlay startup; it must never make the operator wait.
const PROBE_DEADLINE: Duration = Duration::from_secs(2);

/// Hyprland modifier mask bits (wlr modifiers): SHIFT=1, CAPS=2, CTRL=4, ALT=8,
/// MOD2=16, MOD3=32, SUPER=64, MOD5=128. We name only the four an operator chord
/// uses; a mask carrying any other bit is skipped as unrepresentable.
const MOD_SHIFT: u32 = 1;
const MOD_CTRL: u32 = 4;
const MOD_ALT: u32 = 8;
const MOD_SUPER: u32 = 64;
const KNOWN_MODS: u32 = MOD_SHIFT | MOD_CTRL | MOD_ALT | MOD_SUPER;

/// Why the environment could not be probed. Fixed strings only — these render in the
/// UI and must never interpolate the environment.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ShortcutProbeStatus {
    /// Bindings and keyboard hints below are live readings.
    Ok,
    /// This desktop cannot be probed (not Hyprland, no hyprctl, or the query failed).
    Unavailable,
}

/// One live binding, reduced to what the UI may know.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveBinding {
    /// Canonical chord in the frontend's normalizeChord order: ctrl+alt+shift+super+key.
    pub chord: String,
    /// Upstream's own description, bounded; empty when the bind has none.
    pub description: String,
    /// Dispatcher name only. The ARGUMENT is deliberately absent (exec lines carry
    /// usernames/paths).
    pub dispatcher: String,
}

/// Keyboard facts we can actually observe, nothing inferred.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyboardHints {
    /// Distinct configured layouts across keyboards, first-seen order.
    pub layouts: Vec<String>,
    /// The main keyboard's active keymap, when one keyboard is marked main.
    pub active_keymap: Option<String>,
}

/// The full advisory snapshot handed to the frontend.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutEnvironmentReport {
    pub status: ShortcutProbeStatus,
    /// Present exactly when status is Unavailable; a fixed reason, never env content.
    pub unavailable_reason: Option<String>,
    pub bindings: Vec<ActiveBinding>,
    /// True when more than MAX_BINDINGS were configured and the list was cut.
    pub truncated: bool,
    pub keyboard: KeyboardHints,
}

pub const REASON_NOT_HYPRLAND: &str =
    "Shortcut probing needs a Hyprland session (this session is not Hyprland)";
pub const REASON_NO_HYPRCTL: &str = "Shortcut probing needs hyprctl on PATH";
pub const REASON_QUERY_FAILED: &str =
    "The Hyprland binding query failed or returned malformed data";

fn unavailable(reason: &str) -> ShortcutEnvironmentReport {
    ShortcutEnvironmentReport {
        status: ShortcutProbeStatus::Unavailable,
        unavailable_reason: Some(reason.to_owned()),
        bindings: Vec::new(),
        truncated: false,
        keyboard: KeyboardHints::default(),
    }
}

#[derive(Deserialize)]
struct RawBind {
    #[serde(default)]
    modmask: u32,
    #[serde(default)]
    key: String,
    #[serde(default)]
    submap: String,
    #[serde(default)]
    mouse: bool,
    #[serde(default)]
    catch_all: bool,
    #[serde(default)]
    description: String,
    #[serde(default)]
    dispatcher: String,
}

#[derive(Deserialize)]
struct RawKeyboard {
    #[serde(default)]
    layout: String,
    #[serde(default)]
    active_keymap: String,
    #[serde(default)]
    main: bool,
}

#[derive(Deserialize)]
struct RawDevices {
    #[serde(default)]
    keyboards: Vec<RawKeyboard>,
}

fn truncate_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

/// Canonical chord for a Hyprland bind, in the frontend's modifier order.
/// Returns None for masks containing bits we cannot name, or an empty key.
fn canonical_chord(modmask: u32, key: &str) -> Option<String> {
    if modmask & !KNOWN_MODS != 0 {
        // CAPS/MOD2/MOD3/MOD5 in the mask: naming this chord without them would
        // describe a DIFFERENT chord. Refuse rather than guess.
        return None;
    }
    let key = key.trim();
    if key.is_empty() {
        return None;
    }
    let mut parts: Vec<&str> = Vec::with_capacity(5);
    if modmask & MOD_CTRL != 0 {
        parts.push("ctrl");
    }
    if modmask & MOD_ALT != 0 {
        parts.push("alt");
    }
    if modmask & MOD_SHIFT != 0 {
        parts.push("shift");
    }
    if modmask & MOD_SUPER != 0 {
        parts.push("super");
    }
    let lowered = key.to_lowercase();
    parts.push(&lowered);
    let chord = parts.join("+");
    if chord.chars().count() > MAX_CHORD_LEN {
        // A clipped chord is a lie about what is bound; an oversized key name is
        // noise, not an operator chord. Skip it.
        return None;
    }
    Some(chord)
}

/// Parse `hyprctl -j binds` output into bounded advisory bindings.
///
/// Skips: mouse binds, catch-alls, submap-scoped binds (not reachable from the top
/// level), keycode-only binds (no honest name), unrepresentable modifier masks, and
/// exact duplicates. Any JSON shape error rejects the whole probe.
pub fn parse_binds(json: &str) -> Result<(Vec<ActiveBinding>, bool), String> {
    let raw: Vec<RawBind> =
        serde_json::from_str(json).map_err(|error| format!("unexpected binds shape: {error}"))?;
    let mut bindings: Vec<ActiveBinding> = Vec::new();
    let mut seen: std::collections::HashSet<(String, String, String)> =
        std::collections::HashSet::new();
    let mut truncated = false;
    for bind in raw {
        if bind.mouse || bind.catch_all || !bind.submap.is_empty() {
            continue;
        }
        let Some(chord) = canonical_chord(bind.modmask, &bind.key) else {
            continue;
        };
        let description = truncate_chars(bind.description.trim(), MAX_DESCRIPTION_LEN);
        let dispatcher = truncate_chars(bind.dispatcher.trim(), MAX_DISPATCHER_LEN);
        let identity = (chord.clone(), description.clone(), dispatcher.clone());
        if !seen.insert(identity) {
            // Same chord+description+dispatcher: a config restating itself, not a
            // second action. Distinct actions on one chord are all kept.
            continue;
        }
        if bindings.len() == MAX_BINDINGS {
            truncated = true;
            break;
        }
        bindings.push(ActiveBinding {
            chord,
            description,
            dispatcher,
        });
    }
    Ok((bindings, truncated))
}

/// Parse `hyprctl -j devices` into keyboard hints. Shape errors reject the probe.
pub fn parse_keyboard_hints(json: &str) -> Result<KeyboardHints, String> {
    let raw: RawDevices =
        serde_json::from_str(json).map_err(|error| format!("unexpected devices shape: {error}"))?;
    let mut layouts: Vec<String> = Vec::new();
    let mut active_keymap: Option<String> = None;
    for keyboard in &raw.keyboards {
        let layout = keyboard.layout.trim();
        if !layout.is_empty() && layouts.len() < MAX_LAYOUTS {
            let bounded = truncate_chars(layout, MAX_LAYOUT_LEN);
            if !layouts.contains(&bounded) {
                layouts.push(bounded);
            }
        }
        if keyboard.main && active_keymap.is_none() {
            let keymap = keyboard.active_keymap.trim();
            if !keymap.is_empty() {
                active_keymap = Some(truncate_chars(keymap, MAX_KEYMAP_LEN));
            }
        }
    }
    Ok(KeyboardHints {
        layouts,
        active_keymap,
    })
}

/// Assemble the report from prerequisite facts and raw query results.
///
/// Pure so tests can exercise every arm without a compositor: the caller resolves the
/// environment and runs hyprctl; this decides what the operator may be told.
pub fn assemble_report(
    hyprland_session: bool,
    hyprctl_on_path: bool,
    binds_json: Option<Result<String, String>>,
    devices_json: Option<Result<String, String>>,
) -> ShortcutEnvironmentReport {
    if !hyprland_session {
        return unavailable(REASON_NOT_HYPRLAND);
    }
    if !hyprctl_on_path {
        return unavailable(REASON_NO_HYPRCTL);
    }
    // Bindings are the report's reason to exist: no clean binds read, no report.
    // The underlying error text never leaves this function — it can carry paths,
    // usernames, or whatever hyprctl printed.
    let Some(Ok(binds_raw)) = binds_json else {
        return unavailable(REASON_QUERY_FAILED);
    };
    let Ok((bindings, truncated)) = parse_binds(&binds_raw) else {
        return unavailable(REASON_QUERY_FAILED);
    };
    // Keyboard hints are garnish: a failed or malformed devices read costs the
    // hints, never the bindings.
    let keyboard = match devices_json {
        Some(Ok(devices_raw)) => parse_keyboard_hints(&devices_raw).unwrap_or_default(),
        _ => KeyboardHints::default(),
    };
    ShortcutEnvironmentReport {
        status: ShortcutProbeStatus::Ok,
        unavailable_reason: None,
        bindings,
        truncated,
        keyboard,
    }
}

fn probe_live() -> ShortcutEnvironmentReport {
    let hyprland = std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some();
    let hyprctl = crate::actions::program_on_path("hyprctl");
    if !hyprland || !hyprctl {
        return assemble_report(hyprland, hyprctl, None, None);
    }
    let deadline = Instant::now() + PROBE_DEADLINE;
    let binds = crate::actions::read_only_query("hyprctl", &["-j", "binds"], deadline);
    let devices = crate::actions::read_only_query("hyprctl", &["-j", "devices"], deadline);
    assemble_report(true, true, Some(binds), Some(devices))
}

/// Tauri command: advisory snapshot of the live shortcut environment.
#[tauri::command]
pub async fn shortcut_environment() -> Result<ShortcutEnvironmentReport, String> {
    tauri::async_runtime::spawn_blocking(probe_live)
        .await
        .map_err(|error| format!("shortcut environment probe failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bind_json(entries: &[&str]) -> String {
        format!("[{}]", entries.join(","))
    }

    const CHATGPT_BIND: &str = r#"{"locked":false,"mouse":false,"release":false,"repeat":false,"longPress":false,"non_consuming":false,"auto_consuming":false,"has_description":true,"modmask":65,"submap":"","submap_universal":"false","key":"A","keycode":0,"catch_all":false,"description":"ChatGPT","allow_input_capture":false,"dispatcher":"exec","arg":"omarchy-launch-webapp https://chatgpt.com"}"#;

    #[test]
    fn decodes_modmask_into_frontend_canonical_chord_order() {
        // SHIFT(1) | SUPER(64) = 65; frontend order is ctrl,alt,shift,super.
        assert_eq!(canonical_chord(65, "A"), Some("shift+super+a".into()));
        assert_eq!(
            canonical_chord(MOD_SUPER, "Return"),
            Some("super+return".into())
        );
        assert_eq!(
            canonical_chord(MOD_CTRL | MOD_ALT | MOD_SHIFT | MOD_SUPER, "F4"),
            Some("ctrl+alt+shift+super+f4".into())
        );
        assert_eq!(
            canonical_chord(0, "XF86AudioMute"),
            Some("xf86audiomute".into())
        );
    }

    #[test]
    fn refuses_to_name_masks_with_unknown_bits_or_empty_keys() {
        // CAPS(2) cannot appear in an operator chord; guessing would misname the bind.
        assert_eq!(canonical_chord(MOD_SUPER | 2, "A"), None);
        assert_eq!(canonical_chord(128, "A"), None);
        assert_eq!(canonical_chord(MOD_SUPER, ""), None);
        assert_eq!(canonical_chord(MOD_SUPER, "   "), None);
    }

    #[test]
    fn parses_real_bind_and_drops_the_argument() {
        let (bindings, truncated) = parse_binds(&bind_json(&[CHATGPT_BIND])).expect("parses");
        assert!(!truncated);
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].chord, "shift+super+a");
        assert_eq!(bindings[0].description, "ChatGPT");
        assert_eq!(bindings[0].dispatcher, "exec");
        // The exec argument may embed usernames/paths; it must not survive anywhere.
        let serialized = serde_json::to_string(&bindings).expect("serializes");
        assert!(!serialized.contains("omarchy-launch-webapp"));
        assert!(!serialized.contains("chatgpt.com"));
    }

    #[test]
    fn drops_the_argument_even_when_the_description_is_empty() {
        // The tempting "fallback": show the exec line when upstream wrote no
        // description. That line carries usernames and paths — empty stays empty.
        let undescribed = CHATGPT_BIND
            .replace(r#""description":"ChatGPT""#, r#""description":"""#)
            .replace(
                r#""arg":"omarchy-launch-webapp https://chatgpt.com""#,
                r#""arg":"exec /home/operator/.secret/run.sh --token abc""#,
            );
        let (bindings, _) = parse_binds(&bind_json(&[&undescribed])).expect("parses");
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].description, "");
        let serialized = serde_json::to_string(&bindings).expect("serializes");
        assert!(!serialized.contains("/home/"));
        assert!(!serialized.contains("token"));
        assert!(!serialized.contains("run.sh"));
    }

    #[test]
    fn skips_mouse_catchall_submap_keycode_and_unrepresentable_binds() {
        let mouse = CHATGPT_BIND.replace(r#""mouse":false"#, r#""mouse":true"#);
        let catch_all = CHATGPT_BIND.replace(r#""catch_all":false"#, r#""catch_all":true"#);
        let submap = CHATGPT_BIND.replace(r#""submap":"""#, r#""submap":"resize""#);
        let keycode_only = CHATGPT_BIND.replace(r#""key":"A""#, r#""key":"""#);
        let caps_mask = CHATGPT_BIND.replace(r#""modmask":65"#, r#""modmask":67"#);
        let json = bind_json(&[
            &mouse,
            &catch_all,
            &submap,
            &keycode_only,
            &caps_mask,
            CHATGPT_BIND,
        ]);
        let (bindings, _) = parse_binds(&json).expect("parses");
        assert_eq!(bindings.len(), 1, "only the plain ChatGPT bind survives");
        assert_eq!(bindings[0].chord, "shift+super+a");
    }

    #[test]
    fn collapses_exact_duplicates_but_keeps_distinct_actions_on_one_chord() {
        let duplicate = CHATGPT_BIND.to_owned();
        let same_chord_other_action = CHATGPT_BIND.replace(
            r#""description":"ChatGPT""#,
            r#""description":"ChatGPT (release)""#,
        );
        let json = bind_json(&[CHATGPT_BIND, &duplicate, &same_chord_other_action]);
        let (bindings, _) = parse_binds(&json).expect("parses");
        assert_eq!(bindings.len(), 2);
        assert!(bindings.iter().all(|b| b.chord == "shift+super+a"));
    }

    #[test]
    fn bounds_the_binding_count_and_reports_truncation() {
        let mut entries = Vec::new();
        for index in 0..(MAX_BINDINGS + 40) {
            entries.push(CHATGPT_BIND.replace(
                r#""description":"ChatGPT""#,
                &format!(r#""description":"entry {index}""#),
            ));
        }
        let refs: Vec<&str> = entries.iter().map(String::as_str).collect();
        let (bindings, truncated) = parse_binds(&bind_json(&refs)).expect("parses");
        assert_eq!(bindings.len(), MAX_BINDINGS);
        assert!(truncated);
    }

    #[test]
    fn bounds_string_lengths() {
        let long_description = "d".repeat(4000);
        let entry = CHATGPT_BIND.replace(
            r#""description":"ChatGPT""#,
            &format!(r#""description":"{long_description}""#),
        );
        let (bindings, _) = parse_binds(&bind_json(&[&entry])).expect("parses");
        assert_eq!(bindings[0].description.chars().count(), MAX_DESCRIPTION_LEN);
    }

    #[test]
    fn malformed_binds_json_is_an_error_not_an_empty_list() {
        assert!(parse_binds("not json").is_err());
        assert!(parse_binds(r#"{"binds":[]}"#).is_err());
        // An empty ARRAY is genuinely zero binds: valid, not an error.
        let (bindings, truncated) = parse_binds("[]").expect("empty array is valid");
        assert!(bindings.is_empty());
        assert!(!truncated);
    }

    #[test]
    fn keyboard_hints_dedupe_layouts_and_prefer_the_main_keyboard() {
        let json = r#"{"keyboards":[
            {"name":"kb-a","layout":"us","active_keymap":"English (US)","main":false},
            {"name":"kb-b","layout":"us","active_keymap":"English (US)","main":false},
            {"name":"kb-c","layout":"gb","active_keymap":"English (UK)","main":true}
        ]}"#;
        let hints = parse_keyboard_hints(json).expect("parses");
        assert_eq!(hints.layouts, vec!["us".to_owned(), "gb".to_owned()]);
        assert_eq!(hints.active_keymap.as_deref(), Some("English (UK)"));
    }

    #[test]
    fn keyboard_hints_without_a_main_keyboard_claim_no_active_keymap() {
        let json = r#"{"keyboards":[{"name":"kb-a","layout":"us","active_keymap":"English (US)","main":false}]}"#;
        let hints = parse_keyboard_hints(json).expect("parses");
        assert_eq!(hints.active_keymap, None);
    }

    #[test]
    fn assemble_requires_hyprland_then_hyprctl_then_clean_queries() {
        let not_hyprland = assemble_report(false, true, None, None);
        assert_eq!(not_hyprland.status, ShortcutProbeStatus::Unavailable);
        assert_eq!(
            not_hyprland.unavailable_reason.as_deref(),
            Some(REASON_NOT_HYPRLAND)
        );
        assert!(not_hyprland.bindings.is_empty());

        let no_hyprctl = assemble_report(true, false, None, None);
        assert_eq!(
            no_hyprctl.unavailable_reason.as_deref(),
            Some(REASON_NO_HYPRCTL)
        );

        let failed_query =
            assemble_report(true, true, Some(Err("boom".into())), Some(Ok("{}".into())));
        assert_eq!(failed_query.status, ShortcutProbeStatus::Unavailable);
        assert_eq!(
            failed_query.unavailable_reason.as_deref(),
            Some(REASON_QUERY_FAILED)
        );
        // The fixed reason must never carry the underlying error text (env content).
        let serialized = serde_json::to_string(&failed_query).expect("serializes");
        assert!(!serialized.contains("boom"));

        let malformed = assemble_report(true, true, Some(Ok("nope".into())), Some(Ok("{}".into())));
        assert_eq!(malformed.status, ShortcutProbeStatus::Unavailable);
    }

    #[test]
    fn assemble_succeeds_with_bindings_even_when_keyboard_hints_fail() {
        // Keyboard hints are garnish; refusing the whole report over them would
        // discard the bindings the operator actually asked about.
        let report = assemble_report(
            true,
            true,
            Some(Ok(bind_json(&[CHATGPT_BIND]))),
            Some(Ok("garbage".into())),
        );
        assert_eq!(report.status, ShortcutProbeStatus::Ok);
        assert_eq!(report.bindings.len(), 1);
        assert_eq!(report.keyboard, KeyboardHints::default());
        assert_eq!(report.unavailable_reason, None);
    }
}

#[cfg(test)]
mod live_smoke {
    /// Ignored by default: depends on a live Hyprland session. Run explicitly with
    /// `cargo test --lib live_smoke -- --ignored --nocapture` on a Hyprland machine.
    #[test]
    #[ignore = "requires a live Hyprland session"]
    fn parses_this_machines_real_binds() {
        if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_none() {
            eprintln!("skipped: not a Hyprland session");
            return;
        }
        let output = std::process::Command::new("hyprctl")
            .args(["-j", "binds"])
            .output()
            .expect("hyprctl runs");
        let json = String::from_utf8(output.stdout).expect("utf8");
        let (bindings, truncated) = super::parse_binds(&json).expect("live binds parse");
        assert!(!bindings.is_empty(), "a live Hyprland session has bindings");
        assert!(!truncated, "a real config stays under the cap");
        // The privacy invariant against real data: no dispatcher arguments survive.
        let serialized = serde_json::to_string(&bindings).expect("serializes");
        assert!(
            !serialized.contains("/home/"),
            "no home paths in the report"
        );
        eprintln!("live bindings parsed: {}", bindings.len());
    }
}
