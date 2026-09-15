use serde::Deserialize;
use std::fmt;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::Duration;

const CATALOG_JSON: &str = include_str!("../../data/catalog.json");
const TERMINAL_CLASSES: &[&str] = &[
    "Alacritty",
    "alacritty",
    "org.alacritty.alacritty",
    "kitty",
    "foot",
    "footclient",
    "wezterm",
    "org.wezfurlong.wezterm",
    "ghostty",
    "com.mitchellh.ghostty",
];

#[derive(Debug, Deserialize)]
struct Catalog {
    entries: Vec<CatalogEntry>,
}

#[derive(Debug, Deserialize)]
struct CatalogEntry {
    id: String,
    interface: String,
    command: String,
    safety_level: String,
    available: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum ActionError {
    Catalog(String),
    CatalogMismatch,
    Unavailable,
    RedAction,
    UnsupportedInterface,
    Multiline,
    Overlay(String),
    TargetDetection(String),
    NonTerminal,
    Insertion(String),
    Clipboard(String),
}

impl fmt::Display for ActionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Catalog(message) => write!(formatter, "catalog could not be loaded: {message}"),
            Self::CatalogMismatch => {
                write!(formatter, "selection does not match the local catalog")
            }
            Self::Unavailable => write!(formatter, "catalog entry is unavailable"),
            Self::RedAction => write!(formatter, "danger-level entries are copy-only"),
            Self::UnsupportedInterface => {
                write!(formatter, "entry is not terminal-compatible")
            }
            Self::Multiline => write!(formatter, "multiline terminal insertion is not allowed"),
            Self::Overlay(message) => write!(formatter, "overlay handoff failed: {message}"),
            Self::TargetDetection(message) => {
                write!(formatter, "terminal target detection failed: {message}")
            }
            Self::NonTerminal => write!(formatter, "active target is not an allowlisted terminal"),
            Self::Insertion(message) => write!(formatter, "literal insertion failed: {message}"),
            Self::Clipboard(message) => write!(formatter, "clipboard copy failed: {message}"),
        }
    }
}

trait ClipboardWriter {
    fn write_text(&self, text: &str) -> Result<(), String>;
}

#[derive(Debug)]
struct ProcessOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

impl ProcessOutput {
    #[cfg(test)]
    fn success(stdout: impl Into<String>) -> Self {
        Self {
            success: true,
            stdout: stdout.into(),
            stderr: String::new(),
        }
    }
}

trait InsertionEnvironment {
    fn hide_overlay(&self) -> Result<(), String>;
    fn restore_overlay(&self);
    fn wait_for_focus_handoff(&self);
    fn output(&self, program: &str, args: &[&str]) -> Result<ProcessOutput, String>;
    fn input(&self, program: &str, args: &[&str], stdin: &[u8]) -> Result<ProcessOutput, String>;
}

fn process_output(program: &str, args: &[&str]) -> Result<ProcessOutput, String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|error| format!("could not start {program}: {error}"))?;
    Ok(ProcessOutput {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
    })
}

fn process_input(program: &str, args: &[&str], input: &[u8]) -> Result<ProcessOutput, String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not start {program}: {error}"))?;
    child
        .stdin
        .take()
        .ok_or_else(|| format!("{program} stdin was unavailable"))?
        .write_all(input)
        .map_err(|error| format!("could not write to {program}: {error}"))?;
    let output = child
        .wait_with_output()
        .map_err(|error| format!("could not wait for {program}: {error}"))?;
    Ok(ProcessOutput {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
    })
}

struct NativeClipboard;

impl ClipboardWriter for NativeClipboard {
    fn write_text(&self, text: &str) -> Result<(), String> {
        let output = process_input(
            "wl-copy",
            &["--type", "text/plain;charset=utf-8"],
            text.as_bytes(),
        )?;
        if output.success {
            Ok(())
        } else {
            Err(if output.stderr.is_empty() {
                "wl-copy exited unsuccessfully".into()
            } else {
                output.stderr
            })
        }
    }
}

struct NativeInsertionEnvironment {
    window: tauri::WebviewWindow,
}

impl InsertionEnvironment for NativeInsertionEnvironment {
    fn hide_overlay(&self) -> Result<(), String> {
        self.window.hide().map_err(|error| error.to_string())
    }

    fn restore_overlay(&self) {
        let _ = self.window.show();
        let _ = self.window.set_focus();
    }

    fn wait_for_focus_handoff(&self) {
        std::thread::sleep(Duration::from_millis(175));
    }

    fn output(&self, program: &str, args: &[&str]) -> Result<ProcessOutput, String> {
        process_output(program, args)
    }

    fn input(&self, program: &str, args: &[&str], stdin: &[u8]) -> Result<ProcessOutput, String> {
        process_input(program, args, stdin)
    }
}

#[derive(Deserialize)]
struct ActiveWindow {
    #[serde(default)]
    address: String,
    #[serde(default)]
    class: String,
    #[serde(default, rename = "initialClass")]
    initial_class: String,
}

fn matched_entry<'a>(
    catalog: &'a Catalog,
    entry_id: &str,
    command: &str,
) -> Result<&'a CatalogEntry, ActionError> {
    catalog
        .entries
        .iter()
        .find(|entry| entry.id == entry_id && entry.command == command)
        .ok_or(ActionError::CatalogMismatch)
}

fn copy_catalog_command_with(
    catalog: &Catalog,
    entry_id: &str,
    command: &str,
    clipboard: &impl ClipboardWriter,
) -> Result<(), ActionError> {
    let entry = matched_entry(catalog, entry_id, command)?;
    clipboard
        .write_text(&entry.command)
        .map_err(ActionError::Clipboard)
}

fn validate_insert(entry: &CatalogEntry) -> Result<(), ActionError> {
    if entry.safety_level == "red" {
        return Err(ActionError::RedAction);
    }
    if !entry.available {
        return Err(ActionError::Unavailable);
    }
    if !matches!(entry.interface.as_str(), "shell-command" | "cli-flag") {
        return Err(ActionError::UnsupportedInterface);
    }
    if entry.command.contains(['\n', '\r']) {
        return Err(ActionError::Multiline);
    }
    Ok(())
}

fn is_allowlisted_terminal(window: &ActiveWindow) -> bool {
    if window.address.trim().is_empty() {
        return false;
    }
    [&window.class, &window.initial_class]
        .into_iter()
        .any(|value| TERMINAL_CLASSES.contains(&value.as_str()))
}

fn insert_catalog_command_with(
    catalog: &Catalog,
    entry_id: &str,
    command: &str,
    environment: &impl InsertionEnvironment,
) -> Result<(), ActionError> {
    let entry = matched_entry(catalog, entry_id, command)?;
    validate_insert(entry)?;

    if let Err(error) = environment.hide_overlay() {
        environment.restore_overlay();
        return Err(ActionError::Overlay(error));
    }
    environment.wait_for_focus_handoff();

    let result = (|| {
        let active_output = environment
            .output("hyprctl", &["-j", "activewindow"])
            .map_err(ActionError::TargetDetection)?;
        if !active_output.success {
            return Err(ActionError::TargetDetection(
                if active_output.stderr.is_empty() {
                    "hyprctl exited unsuccessfully".into()
                } else {
                    active_output.stderr
                },
            ));
        }
        let active: ActiveWindow = serde_json::from_str(&active_output.stdout)
            .map_err(|error| ActionError::TargetDetection(error.to_string()))?;
        if !is_allowlisted_terminal(&active) {
            return Err(ActionError::NonTerminal);
        }

        let insert_output = environment
            .input("wtype", &["-"], entry.command.as_bytes())
            .map_err(ActionError::Insertion)?;
        if !insert_output.success {
            return Err(ActionError::Insertion(if insert_output.stderr.is_empty() {
                "wtype exited unsuccessfully".into()
            } else {
                insert_output.stderr
            }));
        }
        Ok(())
    })();

    if result.is_err() {
        environment.restore_overlay();
    }
    result
}

fn catalog() -> Result<&'static Catalog, ActionError> {
    static CATALOG: OnceLock<Result<Catalog, String>> = OnceLock::new();
    CATALOG
        .get_or_init(|| serde_json::from_str(CATALOG_JSON).map_err(|error| error.to_string()))
        .as_ref()
        .map_err(|message| ActionError::Catalog(message.clone()))
}

#[tauri::command]
pub fn copy_catalog_command(entry_id: String, command: String) -> Result<(), String> {
    copy_catalog_command_with(
        catalog().map_err(|error| error.to_string())?,
        &entry_id,
        &command,
        &NativeClipboard,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn insert_catalog_command(
    window: tauri::WebviewWindow,
    entry_id: String,
    command: String,
) -> Result<(), String> {
    let environment = NativeInsertionEnvironment { window };
    insert_catalog_command_with(
        catalog().map_err(|error| error.to_string())?,
        &entry_id,
        &command,
        &environment,
    )
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::VecDeque;

    fn entry(interface: &str, safety_level: &str, available: bool, command: &str) -> CatalogEntry {
        CatalogEntry {
            id: "entry-1".into(),
            interface: interface.into(),
            command: command.into(),
            safety_level: safety_level.into(),
            available,
        }
    }

    fn catalog(entry: CatalogEntry) -> Catalog {
        Catalog {
            entries: vec![entry],
        }
    }

    #[derive(Default)]
    struct RecordingClipboard {
        values: RefCell<Vec<String>>,
    }

    impl ClipboardWriter for RecordingClipboard {
        fn write_text(&self, text: &str) -> Result<(), String> {
            self.values.borrow_mut().push(text.into());
            Ok(())
        }
    }

    struct FakeEnvironment {
        output: RefCell<VecDeque<ProcessOutput>>,
        calls: RefCell<Vec<String>>,
        hide_error: Option<String>,
    }

    impl FakeEnvironment {
        fn terminal(class: &str) -> Self {
            let json = format!(
                r#"{{"address":"0x123","class":"{class}","initialClass":"{class}","title":"shell"}}"#
            );
            Self {
                output: RefCell::new(VecDeque::from([ProcessOutput::success(json)])),
                calls: RefCell::new(Vec::new()),
                hide_error: None,
            }
        }

        fn with_output(output: ProcessOutput) -> Self {
            Self {
                output: RefCell::new(VecDeque::from([output])),
                calls: RefCell::new(Vec::new()),
                hide_error: None,
            }
        }

        fn with_hide_error(message: &str) -> Self {
            Self {
                output: RefCell::new(VecDeque::new()),
                calls: RefCell::new(Vec::new()),
                hide_error: Some(message.into()),
            }
        }
    }

    impl InsertionEnvironment for FakeEnvironment {
        fn hide_overlay(&self) -> Result<(), String> {
            self.calls.borrow_mut().push("hide".into());
            match &self.hide_error {
                Some(message) => Err(message.clone()),
                None => Ok(()),
            }
        }

        fn restore_overlay(&self) {
            self.calls.borrow_mut().push("restore".into());
        }

        fn wait_for_focus_handoff(&self) {
            self.calls.borrow_mut().push("wait".into());
        }

        fn output(&self, program: &str, args: &[&str]) -> Result<ProcessOutput, String> {
            self.calls
                .borrow_mut()
                .push(format!("output:{program}:{}", args.join(" ")));
            self.output
                .borrow_mut()
                .pop_front()
                .ok_or_else(|| "missing fake output".into())
        }

        fn input(
            &self,
            program: &str,
            args: &[&str],
            stdin: &[u8],
        ) -> Result<ProcessOutput, String> {
            self.calls.borrow_mut().push(format!(
                "input:{program}:{}:{}",
                args.join(" "),
                String::from_utf8_lossy(stdin)
            ));
            Ok(ProcessOutput::success(""))
        }
    }

    #[test]
    fn copy_writes_only_the_catalog_matched_command() {
        let catalog = catalog(entry("hotkey", "red", false, "CTRL+B"));
        let clipboard = RecordingClipboard::default();

        copy_catalog_command_with(&catalog, "entry-1", "CTRL+B", &clipboard).unwrap();

        assert_eq!(&*clipboard.values.borrow(), &["CTRL+B"]);
    }

    #[test]
    fn copy_rejects_a_command_that_does_not_match_the_catalog_entry() {
        let catalog = catalog(entry("shell-command", "green", true, "hermes help"));
        let clipboard = RecordingClipboard::default();

        let error =
            copy_catalog_command_with(&catalog, "entry-1", "rm -rf /", &clipboard).unwrap_err();

        assert!(error.to_string().contains("catalog"));
        assert!(clipboard.values.borrow().is_empty());
    }

    #[test]
    fn insertion_revalidates_a_structured_terminal_target_then_types_stdin_without_enter() {
        let catalog = catalog(entry("shell-command", "green", true, "hermes help"));
        let environment = FakeEnvironment::terminal("kitty");

        insert_catalog_command_with(&catalog, "entry-1", "hermes help", &environment).unwrap();

        assert_eq!(
            &*environment.calls.borrow(),
            &[
                "hide",
                "wait",
                "output:hyprctl:-j activewindow",
                "input:wtype:-:hermes help",
            ]
        );
        assert!(environment
            .calls
            .borrow()
            .iter()
            .all(|call| !call.contains("Enter") && !call.contains("key 28")));
    }

    #[test]
    fn insertion_accepts_allowlisted_terminal_app_identifiers() {
        for class in [
            "Alacritty",
            "kitty",
            "foot",
            "org.wezfurlong.wezterm",
            "com.mitchellh.ghostty",
        ] {
            let catalog = catalog(entry("cli-flag", "amber", true, "--help"));
            let environment = FakeEnvironment::terminal(class);
            insert_catalog_command_with(&catalog, "entry-1", "--help", &environment).unwrap();
        }
    }

    #[test]
    fn insertion_rejects_a_nonterminal_even_if_its_title_mentions_a_terminal() {
        let catalog = catalog(entry("shell-command", "green", true, "hermes help"));
        let environment = FakeEnvironment::with_output(ProcessOutput::success(
            r#"{"address":"0x123","class":"firefox","initialClass":"firefox","title":"kitty"}"#,
        ));

        let error = insert_catalog_command_with(&catalog, "entry-1", "hermes help", &environment)
            .unwrap_err();

        assert!(error.to_string().contains("terminal"));
        assert_eq!(environment.calls.borrow().last().unwrap(), "restore");
        assert!(!environment
            .calls
            .borrow()
            .iter()
            .any(|call| call.starts_with("input:")));
    }

    #[test]
    fn insertion_requires_an_exact_terminal_class_and_nonblank_address() {
        for json in [
            r#"{"address":"0x123","class":" KITTY ","initialClass":"firefox"}"#,
            r#"{"address":" ","class":"kitty","initialClass":"kitty"}"#,
        ] {
            let catalog = catalog(entry("shell-command", "green", true, "hermes help"));
            let environment = FakeEnvironment::with_output(ProcessOutput::success(json));

            assert!(
                insert_catalog_command_with(&catalog, "entry-1", "hermes help", &environment)
                    .is_err()
            );
            assert_eq!(environment.calls.borrow().last().unwrap(), "restore");
            assert!(!environment
                .calls
                .borrow()
                .iter()
                .any(|call| call.starts_with("input:")));
        }
    }

    #[test]
    fn insertion_rejects_missing_or_malformed_active_window_data() {
        for json in ["{}", "not json"] {
            let catalog = catalog(entry("shell-command", "green", true, "hermes help"));
            let environment = FakeEnvironment::with_output(ProcessOutput::success(json));
            assert!(
                insert_catalog_command_with(&catalog, "entry-1", "hermes help", &environment,)
                    .is_err()
            );
            assert_eq!(environment.calls.borrow().last().unwrap(), "restore");
        }
    }

    #[test]
    fn insertion_rejects_red_unavailable_and_nonterminal_entries_before_hiding() {
        for blocked in [
            entry("shell-command", "red", true, "hermes logout"),
            entry("shell-command", "green", false, "hermes help"),
            entry("hotkey", "green", true, "CTRL+B"),
        ] {
            let command = blocked.command.clone();
            let catalog = catalog(blocked);
            let environment = FakeEnvironment::terminal("kitty");
            assert!(
                insert_catalog_command_with(&catalog, "entry-1", &command, &environment,).is_err()
            );
            assert!(environment.calls.borrow().is_empty());
        }
    }

    #[test]
    fn insertion_rejects_newlines_and_carriage_returns_before_hiding() {
        for command in ["printf one\nprintf two", "printf one\rprintf two"] {
            let catalog = catalog(entry("shell-command", "green", true, command));
            let environment = FakeEnvironment::terminal("kitty");
            assert!(
                insert_catalog_command_with(&catalog, "entry-1", command, &environment,).is_err()
            );
            assert!(environment.calls.borrow().is_empty());
        }
    }

    #[test]
    fn insertion_restores_the_overlay_when_hiding_reports_failure() {
        let catalog = catalog(entry("shell-command", "green", true, "hermes help"));
        let environment = FakeEnvironment::with_hide_error("hide failed");

        let error = insert_catalog_command_with(&catalog, "entry-1", "hermes help", &environment)
            .unwrap_err();

        assert!(error.to_string().contains("overlay handoff failed"));
        assert_eq!(&*environment.calls.borrow(), &["hide", "restore"]);
    }
}
