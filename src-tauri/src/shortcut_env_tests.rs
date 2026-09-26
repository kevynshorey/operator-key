//! Unit tests for `shortcut_env`, kept in a `*_tests.rs` file on purpose: the
//! `no machine state committed` CI gate refuses absolute home paths in tracked
//! sources but deliberately excludes test files, because fixtures like the
//! `/home/...` dispatcher argument below ARE the evidence that laundering
//! works. Wired in via `#[path]` from `shortcut_env.rs`, so `super::*` is the
//! module under test exactly as with an inline `mod tests`.

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

    let failed_query = assemble_report(true, true, Some(Err("boom".into())), Some(Ok("{}".into())));
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
