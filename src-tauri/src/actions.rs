use serde::Deserialize;
use std::fmt;
use std::io::{Read, Write};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

const CATALOG_JSON: &str = include_str!("../../data/catalog.json");
const NATIVE_DEADLINE: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(5);
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
    safety_level: SafetyLevel,
    available: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum SafetyLevel {
    Green,
    Amber,
    Red,
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
    TargetChanged,
    Insertion(String),
    Clipboard(String),
    Restoration {
        primary: String,
        restoration: String,
    },
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
            Self::TargetChanged => {
                write!(
                    formatter,
                    "terminal target identity changed before insertion"
                )
            }
            Self::Insertion(message) => write!(formatter, "literal insertion failed: {message}"),
            Self::Clipboard(message) => write!(formatter, "clipboard copy failed: {message}"),
            Self::Restoration {
                primary,
                restoration,
            } => write!(
                formatter,
                "{primary}; overlay restoration also failed: {restoration}"
            ),
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
    fn restore_overlay(&self) -> Result<(), String>;
    fn wait_for_focus_handoff(&self);
    fn output(&self, program: &str, args: &[&str]) -> Result<ProcessOutput, String>;
    fn input(&self, program: &str, args: &[&str], stdin: &[u8]) -> Result<ProcessOutput, String>;
}

fn terminate_and_reap(child: &mut Child, program: &str) -> Result<(), String> {
    let kill_error = child.kill().err();
    let wait_error = child.wait().err();
    match (kill_error, wait_error) {
        (_, None) => Ok(()),
        (Some(kill), Some(wait)) => Err(format!(
            "could not kill {program}: {kill}; could not reap {program}: {wait}"
        )),
        (None, Some(wait)) => Err(format!("could not reap {program}: {wait}")),
    }
}

fn read_pipe<R: Read>(mut pipe: R) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    pipe.read_to_end(&mut bytes)
        .map_err(|error| format!("could not read process output: {error}"))?;
    Ok(bytes)
}

fn restore_window(
    show: impl FnOnce() -> Result<(), String>,
    focus: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    show()?;
    focus()
}

fn run_spawned_child(
    mut child: Child,
    program: &str,
    input: Option<Vec<u8>>,
    timeout: Duration,
) -> Result<ProcessOutput, String> {
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let primary = format!("{program} stdout was unavailable");
            return match terminate_and_reap(&mut child, program) {
                Ok(()) => Err(primary),
                Err(cleanup) => Err(format!("{primary}; {cleanup}")),
            };
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            let primary = format!("{program} stderr was unavailable");
            return match terminate_and_reap(&mut child, program) {
                Ok(()) => Err(primary),
                Err(cleanup) => Err(format!("{primary}; {cleanup}")),
            };
        }
    };
    let stdout_reader = thread::spawn(move || read_pipe(stdout));
    let stderr_reader = thread::spawn(move || read_pipe(stderr));

    let mut writer = match input {
        Some(bytes) => {
            let mut stdin = match child.stdin.take() {
                Some(stdin) => stdin,
                None => {
                    let primary = format!("{program} stdin was unavailable");
                    let cleanup = terminate_and_reap(&mut child, program).err();
                    let _ = stdout_reader.join();
                    let _ = stderr_reader.join();
                    return Err(
                        cleanup.map_or(primary.clone(), |error| format!("{primary}; {error}"))
                    );
                }
            };
            let program = program.to_owned();
            Some(thread::spawn(move || {
                stdin
                    .write_all(&bytes)
                    .map_err(|error| format!("could not write to {program}: {error}"))
            }))
        }
        None => None,
    };

    let started = Instant::now();
    let status: ExitStatus = loop {
        if writer.as_ref().is_some_and(|handle| handle.is_finished()) {
            let write_result = writer.take().expect("writer exists").join();
            let write_result = match write_result {
                Ok(result) => result,
                Err(_) => {
                    let primary = format!("{program} stdin writer panicked");
                    let cleanup = terminate_and_reap(&mut child, program).err();
                    let _ = stdout_reader.join();
                    let _ = stderr_reader.join();
                    return Err(
                        cleanup.map_or(primary.clone(), |error| format!("{primary}; {error}"))
                    );
                }
            };
            if let Err(primary) = write_result {
                let cleanup = terminate_and_reap(&mut child, program).err();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(cleanup.map_or(primary.clone(), |error| format!("{primary}; {error}")));
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < timeout => {
                thread::sleep(POLL_INTERVAL.min(timeout.saturating_sub(started.elapsed())));
            }
            Ok(None) => {
                let primary = format!("{program} timed out after {} ms", timeout.as_millis());
                let cleanup = terminate_and_reap(&mut child, program).err();
                if let Some(writer) = writer.take() {
                    let _ = writer.join();
                }
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(cleanup.map_or(primary.clone(), |error| format!("{primary}; {error}")));
            }
            Err(error) => {
                let primary = format!("could not wait for {program}: {error}");
                let cleanup = terminate_and_reap(&mut child, program).err();
                if let Some(writer) = writer.take() {
                    let _ = writer.join();
                }
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(cleanup.map_or(primary.clone(), |error| format!("{primary}; {error}")));
            }
        }
    };

    if let Some(writer) = writer {
        writer
            .join()
            .map_err(|_| format!("{program} stdin writer panicked"))??;
    }
    let stdout = stdout_reader
        .join()
        .map_err(|_| format!("{program} stdout reader panicked"))??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| format!("{program} stderr reader panicked"))??;
    Ok(ProcessOutput {
        success: status.success(),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).trim().to_owned(),
    })
}

fn process_output(
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<ProcessOutput, String> {
    let child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not start {program}: {error}"))?;
    run_spawned_child(child, program, None, timeout)
}

fn process_input(
    program: &str,
    args: &[&str],
    input: &[u8],
    timeout: Duration,
) -> Result<ProcessOutput, String> {
    let child = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not start {program}: {error}"))?;
    run_spawned_child(child, program, Some(input.to_vec()), timeout)
}

struct NativeClipboard;

impl ClipboardWriter for NativeClipboard {
    fn write_text(&self, text: &str) -> Result<(), String> {
        let output = process_input(
            "wl-copy",
            &["--type", "text/plain;charset=utf-8"],
            text.as_bytes(),
            NATIVE_DEADLINE,
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
    deadline: Instant,
}

impl NativeInsertionEnvironment {
    fn remaining(&self) -> Result<Duration, String> {
        self.deadline
            .checked_duration_since(Instant::now())
            .filter(|duration| !duration.is_zero())
            .ok_or_else(|| "insertion deadline elapsed".into())
    }
}

impl InsertionEnvironment for NativeInsertionEnvironment {
    fn hide_overlay(&self) -> Result<(), String> {
        self.window.hide().map_err(|error| error.to_string())
    }

    fn restore_overlay(&self) -> Result<(), String> {
        restore_window(
            || {
                self.window
                    .show()
                    .map_err(|error| format!("could not show overlay: {error}"))
            },
            || {
                self.window
                    .set_focus()
                    .map_err(|error| format!("could not focus overlay: {error}"))
            },
        )
    }

    fn wait_for_focus_handoff(&self) {
        thread::sleep(Duration::from_millis(175));
    }

    fn output(&self, program: &str, args: &[&str]) -> Result<ProcessOutput, String> {
        process_output(program, args, self.remaining()?)
    }

    fn input(&self, program: &str, args: &[&str], stdin: &[u8]) -> Result<ProcessOutput, String> {
        process_input(program, args, stdin, self.remaining()?)
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
    if !matches!(entry.safety_level, SafetyLevel::Green | SafetyLevel::Amber) {
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

fn is_valid_hyprland_address(address: &str) -> bool {
    (3..=18).contains(&address.len())
        && address.starts_with("0x")
        && address[2..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_allowlisted_terminal(window: &ActiveWindow) -> bool {
    is_valid_hyprland_address(&window.address)
        && [&window.class, &window.initial_class]
            .into_iter()
            .any(|value| TERMINAL_CLASSES.contains(&value.as_str()))
}

fn successful_output(output: ProcessOutput, program: &str) -> Result<ProcessOutput, String> {
    if output.success {
        Ok(output)
    } else if output.stderr.is_empty() {
        Err(format!("{program} exited unsuccessfully"))
    } else {
        Err(output.stderr)
    }
}

fn active_window(environment: &impl InsertionEnvironment) -> Result<ActiveWindow, ActionError> {
    let output = environment
        .output("hyprctl", &["-j", "activewindow"])
        .map_err(ActionError::TargetDetection)?;
    let output = successful_output(output, "hyprctl").map_err(ActionError::TargetDetection)?;
    serde_json::from_str(&output.stdout)
        .map_err(|error| ActionError::TargetDetection(error.to_string()))
}

fn restore_after(primary: ActionError, environment: &impl InsertionEnvironment) -> ActionError {
    match environment.restore_overlay() {
        Ok(()) => primary,
        Err(restoration) => ActionError::Restoration {
            primary: primary.to_string(),
            restoration,
        },
    }
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
        return Err(restore_after(ActionError::Overlay(error), environment));
    }
    environment.wait_for_focus_handoff();

    let result = (|| {
        let captured = active_window(environment)?;
        if !is_allowlisted_terminal(&captured) {
            return Err(ActionError::NonTerminal);
        }

        let selector = format!("address:{}", captured.address);
        let focus_output = environment
            .output("hyprctl", &["dispatch", "focuswindow", &selector])
            .map_err(ActionError::TargetDetection)?;
        successful_output(focus_output, "hyprctl dispatch focuswindow")
            .map_err(ActionError::TargetDetection)?;

        let revalidated = active_window(environment)?;
        if captured.address != revalidated.address || !is_allowlisted_terminal(&revalidated) {
            return Err(ActionError::TargetChanged);
        }

        let insert_output = environment
            .input("wtype", &["-"], entry.command.as_bytes())
            .map_err(ActionError::Insertion)?;
        successful_output(insert_output, "wtype").map_err(ActionError::Insertion)?;
        Ok(())
    })();

    result.map_err(|error| restore_after(error, environment))
}

fn catalog() -> Result<&'static Catalog, ActionError> {
    static CATALOG: OnceLock<Result<Catalog, String>> = OnceLock::new();
    CATALOG
        .get_or_init(|| serde_json::from_str(CATALOG_JSON).map_err(|error| error.to_string()))
        .as_ref()
        .map_err(|message| ActionError::Catalog(message.clone()))
}

#[tauri::command]
pub async fn copy_catalog_command(entry_id: String, command: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        copy_catalog_command_with(
            catalog().map_err(|error| error.to_string())?,
            &entry_id,
            &command,
            &NativeClipboard,
        )
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("native clipboard task failed: {error}"))?
}

#[tauri::command]
pub async fn insert_catalog_command(
    window: tauri::WebviewWindow,
    entry_id: String,
    command: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let environment = NativeInsertionEnvironment {
            window,
            deadline: Instant::now() + NATIVE_DEADLINE,
        };
        insert_catalog_command_with(
            catalog().map_err(|error| error.to_string())?,
            &entry_id,
            &command,
            &environment,
        )
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("native insertion task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::VecDeque;

    fn entry(interface: &str, safety_level: &str, available: bool, command: &str) -> CatalogEntry {
        let safety_level = match safety_level {
            "green" => SafetyLevel::Green,
            "amber" => SafetyLevel::Amber,
            "red" => SafetyLevel::Red,
            value => panic!("unsupported test safety level: {value}"),
        };
        CatalogEntry {
            id: "entry-1".into(),
            interface: interface.into(),
            command: command.into(),
            safety_level,
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
        restore_error: Option<String>,
    }

    impl FakeEnvironment {
        fn terminal(class: &str) -> Self {
            let json = format!(
                r#"{{"address":"0x123","class":"{class}","initialClass":"{class}","title":"shell"}}"#
            );
            Self {
                output: RefCell::new(VecDeque::from([
                    ProcessOutput::success(json.clone()),
                    ProcessOutput::success(""),
                    ProcessOutput::success(json),
                ])),
                calls: RefCell::new(Vec::new()),
                hide_error: None,
                restore_error: None,
            }
        }

        fn with_output(output: ProcessOutput) -> Self {
            Self {
                output: RefCell::new(VecDeque::from([output])),
                calls: RefCell::new(Vec::new()),
                hide_error: None,
                restore_error: None,
            }
        }

        fn with_hide_error(message: &str) -> Self {
            Self {
                output: RefCell::new(VecDeque::new()),
                calls: RefCell::new(Vec::new()),
                hide_error: Some(message.into()),
                restore_error: None,
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

        fn restore_overlay(&self) -> Result<(), String> {
            self.calls.borrow_mut().push("restore".into());
            self.restore_error.clone().map_or(Ok(()), Err)
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
                "output:hyprctl:dispatch focuswindow address:0x123",
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
    fn insertion_rejects_an_invalid_hyprland_address_before_refocus() {
        for address in ["123", "0x", "0x12:34", "0x1234567890abcdef0"] {
            let catalog = catalog(entry("shell-command", "green", true, "hermes help"));
            let json =
                format!(r#"{{"address":"{address}","class":"kitty","initialClass":"kitty"}}"#);
            let environment = FakeEnvironment::with_output(ProcessOutput::success(json));

            assert!(
                insert_catalog_command_with(&catalog, "entry-1", "hermes help", &environment,)
                    .is_err()
            );
            assert!(!environment
                .calls
                .borrow()
                .iter()
                .any(|call| call.contains("dispatch focuswindow")));
        }
    }

    #[test]
    fn insertion_aborts_when_refocusing_the_captured_address_fails() {
        let catalog = catalog(entry("shell-command", "green", true, "hermes help"));
        let environment = FakeEnvironment {
            output: RefCell::new(VecDeque::from([
                ProcessOutput::success(
                    r#"{"address":"0x123","class":"kitty","initialClass":"kitty"}"#,
                ),
                ProcessOutput {
                    success: false,
                    stdout: String::new(),
                    stderr: "dispatch failed".into(),
                },
            ])),
            calls: RefCell::new(Vec::new()),
            hide_error: None,
            restore_error: None,
        };

        let error = insert_catalog_command_with(&catalog, "entry-1", "hermes help", &environment)
            .unwrap_err();

        assert!(error.to_string().contains("dispatch failed"));
        assert_eq!(environment.calls.borrow().last().unwrap(), "restore");
        assert!(!environment
            .calls
            .borrow()
            .iter()
            .any(|call| call.starts_with("input:wtype")));
    }

    #[test]
    fn insertion_aborts_when_the_revalidated_target_changes_identity() {
        for second_snapshot in [
            r#"{"address":"0x456","class":"kitty","initialClass":"kitty"}"#,
            r#"{"address":"0x123","class":"firefox","initialClass":"firefox"}"#,
        ] {
            let catalog = catalog(entry("shell-command", "green", true, "hermes help"));
            let environment = FakeEnvironment {
                output: RefCell::new(VecDeque::from([
                    ProcessOutput::success(
                        r#"{"address":"0x123","class":"kitty","initialClass":"kitty"}"#,
                    ),
                    ProcessOutput::success(""),
                    ProcessOutput::success(second_snapshot),
                ])),
                calls: RefCell::new(Vec::new()),
                hide_error: None,
                restore_error: None,
            };

            assert!(
                insert_catalog_command_with(&catalog, "entry-1", "hermes help", &environment,)
                    .is_err()
            );
            assert_eq!(environment.calls.borrow().last().unwrap(), "restore");
            assert!(!environment
                .calls
                .borrow()
                .iter()
                .any(|call| call.starts_with("input:wtype")));
        }
    }

    #[test]
    fn insertion_fails_closed_for_unknown_safety_levels() {
        let json = r#"{"entries":[{"id":"entry-1","interface":"shell-command","command":"hermes help","safety_level":"blue","available":true}]}"#;

        let error = serde_json::from_str::<Catalog>(json).unwrap_err();

        assert!(error.to_string().contains("unknown variant"));
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
    fn restoration_checks_show_before_focus_and_surfaces_each_failure() {
        let calls = RefCell::new(Vec::new());
        let focus_error = restore_window(
            || {
                calls.borrow_mut().push("show");
                Ok(())
            },
            || {
                calls.borrow_mut().push("focus");
                Err("focus failed".to_owned())
            },
        )
        .unwrap_err();
        assert_eq!(&*calls.borrow(), &["show", "focus"]);
        assert!(focus_error.contains("focus failed"));

        calls.borrow_mut().clear();
        let show_error = restore_window(
            || {
                calls.borrow_mut().push("show");
                Err("show failed".to_owned())
            },
            || {
                calls.borrow_mut().push("focus");
                Ok(())
            },
        )
        .unwrap_err();
        assert_eq!(&*calls.borrow(), &["show"]);
        assert!(show_error.contains("show failed"));
    }

    #[test]
    fn insertion_reports_primary_and_restoration_failures_together() {
        let catalog = catalog(entry("shell-command", "green", true, "hermes help"));
        let mut environment = FakeEnvironment::with_output(ProcessOutput::success(
            r#"{"address":"0x123","class":"firefox","initialClass":"firefox"}"#,
        ));
        environment.restore_error = Some("could not show overlay".into());

        let error = insert_catalog_command_with(&catalog, "entry-1", "hermes help", &environment)
            .unwrap_err();
        let message = error.to_string();

        assert!(message.contains("not an allowlisted terminal"));
        assert!(message.contains("restoration also failed"));
        assert!(message.contains("could not show overlay"));
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

    #[cfg(target_os = "linux")]
    #[test]
    fn child_timeout_kills_and_reaps_the_process() {
        let child = Command::new("sleep")
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let pid = child.id();

        let error = run_spawned_child(child, "sleep", None, Duration::from_millis(20)).unwrap_err();

        assert!(error.contains("timed out"));
        assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists());
    }
}
