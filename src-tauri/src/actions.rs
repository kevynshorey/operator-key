use serde::Deserialize;
use std::collections::HashMap;
use std::env;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

const CATALOG_JSON: &str = include_str!("../../data/catalog.json");
/// Hard ceiling on a sidecar catalog, so a huge or runaway file cannot exhaust memory.
const MAX_SIDECAR_CATALOG_BYTES: u64 = 32 * 1024 * 1024;
const NATIVE_DEADLINE: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(5);
const MAX_NATIVE_STDIN_BYTES: usize = 4 * 1024;
const MAX_CAPTURE_BYTES: usize = 64 * 1024;
const OUTPUT_TRUNCATED_MARKER: &str = "\n[output truncated]";
static CAPTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
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
    product: String,
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
    ControlCharacter,
    ProgramMissing(&'static str),
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
            Self::ControlCharacter => write!(
                formatter,
                "this command contains a hidden control character and was not inserted"
            ),
            Self::ProgramMissing(program) => write!(
                formatter,
                "`{program}` is not installed on this machine, so the command was not inserted"
            ),
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

struct CaptureFile {
    file: File,
    path: std::path::PathBuf,
}

impl CaptureFile {
    fn new(stream: &str) -> Result<Self, String> {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        for _ in 0..128 {
            let sequence = CAPTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "operator-key-{}-{timestamp}-{sequence}-{stream}.tmp",
                std::process::id()
            ));
            let mut options = OpenOptions::new();
            options.read(true).write(true).create_new(true);
            #[cfg(unix)]
            options.mode(0o600);
            match options.open(&path) {
                Ok(file) => return Ok(Self { file, path }),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(format!("could not create process capture file: {error}"));
                }
            }
        }
        Err("could not create a unique process capture file".into())
    }

    fn stdio(&self) -> Result<Stdio, String> {
        self.file
            .try_clone()
            .map(Stdio::from)
            .map_err(|error| format!("could not clone process capture file: {error}"))
    }

    fn read_bounded(&self) -> Result<String, String> {
        let mut file = File::open(&self.path)
            .map_err(|error| format!("could not open process capture file: {error}"))?;
        let mut bytes = Vec::with_capacity((MAX_CAPTURE_BYTES + 1).min(8 * 1024));
        Read::take(&mut file, (MAX_CAPTURE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("could not read process capture file: {error}"))?;
        let truncated = bytes.len() > MAX_CAPTURE_BYTES;
        bytes.truncate(MAX_CAPTURE_BYTES);
        let mut output = String::from_utf8_lossy(&bytes).into_owned();
        if truncated {
            output.push_str(OUTPUT_TRUNCATED_MARKER);
        }
        Ok(output)
    }
}

impl Drop for CaptureFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

struct ProcessCapture {
    stdout: CaptureFile,
    stderr: CaptureFile,
}

impl ProcessCapture {
    fn new() -> Result<Self, String> {
        Ok(Self {
            stdout: CaptureFile::new("stdout")?,
            stderr: CaptureFile::new("stderr")?,
        })
    }

    fn output(&self, status: ExitStatus) -> Result<ProcessOutput, String> {
        Ok(ProcessOutput {
            success: status.success(),
            stdout: self.stdout.read_bounded()?,
            stderr: self.stderr.read_bounded()?.trim().to_owned(),
        })
    }
}

fn restore_window(
    show: impl FnOnce() -> Result<(), String>,
    focus: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    show()?;
    focus()
}

#[derive(Debug, PartialEq, Eq)]
enum ChildPoll<T> {
    Exited(T),
    TimedOutAfterExit,
    TimedOutRunning,
}

fn poll_child_until<T>(
    deadline: Instant,
    mut try_wait: impl FnMut() -> Result<Option<T>, String>,
    mut now: impl FnMut() -> Instant,
    mut sleep: impl FnMut(Duration),
) -> Result<ChildPoll<T>, String> {
    loop {
        match try_wait()? {
            Some(status) => {
                return Ok(if now() >= deadline {
                    ChildPoll::TimedOutAfterExit
                } else {
                    ChildPoll::Exited(status)
                });
            }
            None => {
                let observed_at = now();
                if observed_at >= deadline {
                    return Ok(ChildPoll::TimedOutRunning);
                }
                sleep(POLL_INTERVAL.min(deadline.saturating_duration_since(observed_at)));
            }
        }
    }
}

fn error_after_termination(child: &mut Child, program: &str, primary: String) -> String {
    terminate_and_reap(child, program)
        .err()
        .map_or(primary.clone(), |error| format!("{primary}; {error}"))
}

fn write_child_stdin(child: &mut Child, bytes: &[u8], program: &str) -> Result<(), String> {
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| format!("{program} stdin was unavailable"))?;
    stdin
        .write_all(bytes)
        .map_err(|error| format!("could not write to {program}: {error}"))?;
    drop(stdin);
    Ok(())
}

fn run_spawned_child_with(
    mut child: Child,
    program: &str,
    input: Option<Vec<u8>>,
    deadline: Instant,
    capture: ProcessCapture,
    mut now: impl FnMut() -> Instant,
    mut write_input: impl FnMut(&mut Child, &[u8], &str) -> Result<(), String>,
) -> Result<ProcessOutput, String> {
    if let Err(primary) = ensure_before_deadline(deadline, now(), program) {
        return Err(error_after_termination(&mut child, program, primary));
    }

    if input
        .as_ref()
        .is_some_and(|bytes| bytes.len() > MAX_NATIVE_STDIN_BYTES)
    {
        let primary = format!("{program} input exceeds {MAX_NATIVE_STDIN_BYTES} byte native limit");
        return Err(error_after_termination(&mut child, program, primary));
    }

    if let Some(bytes) = input {
        if let Err(primary) = write_input(&mut child, &bytes, program) {
            return Err(error_after_termination(&mut child, program, primary));
        }
    }

    if let Err(primary) = ensure_before_deadline(deadline, now(), program) {
        return Err(error_after_termination(&mut child, program, primary));
    }

    let poll = poll_child_until(
        deadline,
        || {
            child
                .try_wait()
                .map_err(|error| format!("could not wait for {program}: {error}"))
        },
        &mut now,
        thread::sleep,
    );
    match poll {
        Ok(ChildPoll::Exited(status)) => capture.output(status),
        Ok(ChildPoll::TimedOutAfterExit) => Err(format!("{program} timed out")),
        Ok(ChildPoll::TimedOutRunning) => {
            let primary = format!("{program} timed out");
            Err(error_after_termination(&mut child, program, primary))
        }
        Err(primary) => Err(error_after_termination(&mut child, program, primary)),
    }
}

fn run_spawned_child(
    child: Child,
    program: &str,
    input: Option<Vec<u8>>,
    deadline: Instant,
    capture: ProcessCapture,
) -> Result<ProcessOutput, String> {
    run_spawned_child_with(
        child,
        program,
        input,
        deadline,
        capture,
        Instant::now,
        write_child_stdin,
    )
}

fn ensure_before_deadline(deadline: Instant, now: Instant, program: &str) -> Result<(), String> {
    if now >= deadline {
        Err(format!("{program} timed out"))
    } else {
        Ok(())
    }
}

fn process_output(
    program: &str,
    args: &[&str],
    deadline: Instant,
) -> Result<ProcessOutput, String> {
    ensure_before_deadline(deadline, Instant::now(), program)?;
    let capture = ProcessCapture::new()?;
    let stdout = capture.stdout.stdio()?;
    let stderr = capture.stderr.stdio()?;
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr);
    ensure_before_deadline(deadline, Instant::now(), program)?;
    let child = command
        .spawn()
        .map_err(|error| format!("could not start {program}: {error}"))?;
    run_spawned_child(child, program, None, deadline, capture)
}

fn process_input(
    program: &str,
    args: &[&str],
    input: &[u8],
    deadline: Instant,
) -> Result<ProcessOutput, String> {
    ensure_before_deadline(deadline, Instant::now(), program)?;
    if input.len() > MAX_NATIVE_STDIN_BYTES {
        return Err(format!(
            "{program} input exceeds {MAX_NATIVE_STDIN_BYTES} byte native limit"
        ));
    }
    let capture = ProcessCapture::new()?;
    let stdout = capture.stdout.stdio()?;
    let stderr = capture.stderr.stdio()?;
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(stdout)
        .stderr(stderr);
    ensure_before_deadline(deadline, Instant::now(), program)?;
    let child = command
        .spawn()
        .map_err(|error| format!("could not start {program}: {error}"))?;
    run_spawned_child(child, program, Some(input.to_vec()), deadline, capture)
}

/// Which desktop integrations this machine can actually perform.
///
/// Clipboard and insertion are implemented with `wl-copy`, `hyprctl` and `wtype`, which
/// exist only under Wayland, and insertion additionally needs Hyprland's IPC. On any
/// other desktop those binaries are simply absent, and the operator previously saw a raw
/// "could not start hyprctl" process error. Detecting the capability up front lets the UI
/// say what is unsupported and why, while search stays fully available everywhere.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCapabilities {
    pub can_copy: bool,
    pub can_insert: bool,
}

/// Report what this desktop supports, from the environment and PATH only.
///
/// This runs no subprocess: it is called on startup to render availability, so it must be
/// cheap and must never block the UI.
pub fn detect_desktop_capabilities() -> DesktopCapabilities {
    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some();
    let hyprland = std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some();
    DesktopCapabilities {
        can_copy: wayland && program_on_path("wl-copy"),
        can_insert: wayland && hyprland && program_on_path("hyprctl") && program_on_path("wtype"),
    }
}

/// Which Operator Key feature a requirement row describes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DesktopFeature {
    Search,
    Copy,
    Insert,
}

/// How much of Operator Key this desktop can actually run.
///
/// `Degraded` is deliberately distinct from `Unsupported`: a GNOME or KDE Wayland session
/// can copy perfectly well even though it will never insert into a terminal, and telling
/// that operator "unsupported" would be false.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DesktopMode {
    Supported,
    Degraded,
    Unsupported,
}

/// One feature, whether it is available, and precisely what is missing if it is not.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRequirement {
    pub feature: DesktopFeature,
    pub met: bool,
    /// Exactly what the operator must add. Empty whenever `met` is true.
    ///
    /// These are fixed descriptive strings. They never interpolate the environment, so the
    /// report stays safe to render and to paste into a bug report.
    pub unmet_prerequisites: Vec<String>,
}

/// The full compatibility picture for this desktop.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCompatibilityReport {
    pub mode: DesktopMode,
    pub capabilities: DesktopCapabilities,
    /// Catalog search and learning run from bundled data and never need the desktop.
    pub search_available: bool,
    pub requirements: Vec<DesktopRequirement>,
}

const WAYLAND_PREREQUISITE: &str = "A Wayland session (this session is not Wayland)";
const HYPRLAND_PREREQUISITE: &str =
    "Hyprland, for the window IPC that confirms the target terminal";

/// Describe what this desktop supports and what is missing, without running a subprocess.
///
/// The existing capability probe answers "can I?"; this answers "and what do I install to
/// change that?". Both read the same environment and PATH so a rendered requirement can
/// never disagree with the gate that actually refuses the action.
pub fn describe_desktop_compatibility() -> DesktopCompatibilityReport {
    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some();
    let hyprland = std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some();
    let capabilities = detect_desktop_capabilities();

    let mut copy_missing: Vec<String> = Vec::new();
    if !wayland {
        copy_missing.push(WAYLAND_PREREQUISITE.to_owned());
    }
    if !program_on_path("wl-copy") {
        copy_missing.push("wl-copy, from the wl-clipboard package".to_owned());
    }

    let mut insert_missing: Vec<String> = Vec::new();
    if !wayland {
        insert_missing.push(WAYLAND_PREREQUISITE.to_owned());
    }
    if !hyprland {
        insert_missing.push(HYPRLAND_PREREQUISITE.to_owned());
    }
    for program in ["hyprctl", "wtype"] {
        if !program_on_path(program) {
            insert_missing.push(format!("{program}, on PATH"));
        }
    }

    // Report what the gate will actually do, not merely what is installed.
    if capabilities.can_copy {
        copy_missing.clear();
    }
    if capabilities.can_insert {
        insert_missing.clear();
    }

    // Derive the mode from what the gate will actually allow, never from the session type
    // alone: a Wayland desktop with no helper installed can perform no desktop action, and
    // calling that "degraded" would overstate what is available.
    let mode = if capabilities.can_copy && capabilities.can_insert {
        DesktopMode::Supported
    } else if capabilities.can_copy || capabilities.can_insert {
        DesktopMode::Degraded
    } else {
        DesktopMode::Unsupported
    };

    DesktopCompatibilityReport {
        mode,
        capabilities,
        // Search is bundled and deterministic: it is available on every desktop.
        search_available: true,
        requirements: vec![
            DesktopRequirement {
                feature: DesktopFeature::Search,
                met: true,
                unmet_prerequisites: Vec::new(),
            },
            DesktopRequirement {
                feature: DesktopFeature::Copy,
                met: capabilities.can_copy,
                unmet_prerequisites: copy_missing,
            },
            DesktopRequirement {
                feature: DesktopFeature::Insert,
                met: capabilities.can_insert,
                unmet_prerequisites: insert_missing,
            },
        ],
    }
}

/// Explain an unsupported desktop in terms the operator can act on.
fn unsupported_desktop_message(action: &str) -> String {
    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some();
    let hyprland = std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some();
    if !wayland {
        format!(
            "{action} needs Wayland. This session is not Wayland, so search and copy-by-hand still work but {} is unavailable here.",
            action.to_lowercase()
        )
    } else if !hyprland {
        format!(
            "{action} needs Hyprland's window IPC, which this Wayland session does not provide."
        )
    } else {
        let mut missing: Vec<&str> = Vec::new();
        for program in ["hyprctl", "wtype", "wl-copy"] {
            if !program_on_path(program) {
                missing.push(program);
            }
        }
        if missing.is_empty() {
            format!("{action} is unavailable on this desktop.")
        } else {
            format!("{action} needs {} on PATH.", missing.join(" and "))
        }
    }
}

struct NativeClipboard;

impl ClipboardWriter for NativeClipboard {
    fn write_text(&self, text: &str) -> Result<(), String> {
        let deadline = Instant::now() + NATIVE_DEADLINE;
        let output = process_input(
            "wl-copy",
            &["--type", "text/plain;charset=utf-8"],
            text.as_bytes(),
            deadline,
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
        process_output(program, args, self.deadline)
    }

    fn input(&self, program: &str, args: &[&str], stdin: &[u8]) -> Result<ProcessOutput, String> {
        process_input(program, args, stdin, self.deadline)
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

/// Map a catalog product to the executable an operator needs for its commands.
///
/// `omarchy` is absent deliberately: its entries are keybindings and desktop actions
/// rather than a single binary, so there is nothing on PATH to verify.
fn required_program(product: &str) -> Option<&'static str> {
    match product {
        "git" => Some("git"),
        "gh" => Some("gh"),
        "hermes" => Some("hermes"),
        "codex" => Some("codex"),
        "claude-code" => Some("claude"),
        _ => None,
    }
}

/// True when `program` resolves to an executable file on the current PATH.
///
/// The catalog's `available` flag is decided on the machine that BUILT the catalog. A
/// downloaded release therefore carries the builder's environment, not the operator's,
/// and insertion must not type a command for a tool this machine does not have. This is
/// the runtime half of that check: `available` stays an advisory hint for ranking and
/// display, while this decides whether keystrokes are allowed.
#[cfg(unix)]
fn program_on_path(program: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;

    // A catalog product name is a fixed identifier from `required_program`, never
    // operator input, but refuse separators anyway so this can never become a path probe.
    if program.is_empty() || program.contains('/') {
        return false;
    }
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|directory| {
        if directory.as_os_str().is_empty() {
            return false;
        }
        let candidate = directory.join(program);
        candidate
            .metadata()
            .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    })
}

#[cfg(not(unix))]
fn program_on_path(program: &str) -> bool {
    if program.is_empty() {
        return false;
    }
    std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).any(|directory| directory.join(program).is_file()))
        .unwrap_or(false)
}

/// Reject any control character before command text can be typed into a live terminal.
///
/// `\n` and `\r` submit a line, so they were always refused. The wider rule matters for
/// the same reason: ESC (`\x1b`) begins a terminal escape sequence, and other C0/C1 and
/// Unicode separator controls can move the cursor or alter what a reader sees versus what
/// the shell receives. The catalog is generated from local `--help` output and is clean
/// today, but this is the last gate before synthetic keystrokes reach a real shell, so it
/// validates rather than assumes. Legitimate command text never needs a control
/// character; a bidirectional override or a bare ESC is a signal, not a false positive.
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
    if entry.command.chars().any(is_forbidden_in_command) {
        return Err(ActionError::ControlCharacter);
    }
    if let Some(program) = required_program(&entry.product) {
        if !program_on_path(program) {
            return Err(ActionError::ProgramMissing(program));
        }
    }
    Ok(())
}

/// True for characters that must never reach a terminal through synthetic keystrokes.
fn is_forbidden_in_command(character: char) -> bool {
    character.is_control()
        || matches!(
            character,
            // Bidirectional overrides: reorder rendered text away from what is typed.
            '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'
            // Zero-width and invisible formatting.
            | '\u{200b}'..='\u{200d}' | '\u{2060}' | '\u{feff}'
            // Line and paragraph separators: newline equivalents in some consumers.
            | '\u{2028}' | '\u{2029}'
            // NBSP and friends: render as a space but are not argument separators.
            | '\u{00a0}' | '\u{202f}'
        )
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

        let focus_dispatcher = format!(
            r#"hl.dsp.focus({{ window = "address:{}" }})"#,
            captured.address
        );
        let focus_output = environment
            .output("hyprctl", &["dispatch", &focus_dispatcher])
            .map_err(ActionError::TargetDetection)?;
        successful_output(focus_output, "hyprctl dispatch hl.dsp.focus")
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

/// Where an operator's own rebuilt catalog is read from, if they have one.
///
/// The catalog is generated from `--help` output on the machine that runs
/// `scripts/build_catalog.py`. Before this, the only catalog was the one compiled into the
/// binary, so reflecting your own installed tools meant rebuilding the whole application
/// and having the Rust and Node toolchains to do it.
///
/// Returns `None` when no home directory is known, which reads as "no sidecar".
fn sidecar_catalog_path() -> Option<PathBuf> {
    let base = match env::var_os("XDG_DATA_HOME") {
        Some(value) if !value.is_empty() => PathBuf::from(value),
        _ => PathBuf::from(env::var_os("HOME")?).join(".local/share"),
    };
    Some(base.join("operator-key").join("catalog.json"))
}

/// Merge an operator's sidecar catalog over the embedded one, refusing any downgrade.
///
/// The security question is what a sidecar file is allowed to change. The app types
/// command text into a live terminal, so the catalog is the trust anchor for that text: if
/// a sidecar could relabel `git push --force` as green, it could get a destructive command
/// inserted behind a safe-looking badge.
///
/// The rule is therefore asymmetric, and deliberately not "recompute safety from the
/// command text". Recomputing sounds safer but is measurably worse: 33 entries in the
/// shipped catalog are classified *below* what the word rules alone would produce, because
/// the adapters know things the word list cannot — `--force-with-lease` is the safe form of
/// a force push, `--dry-run` performs no write. Recomputing would paint those red, and a
/// red badge that fires on safe commands is the one failure this product cannot afford:
/// operators stop reading it, and then it cannot warn them about anything.
///
/// So:
///   * An ID present in the embedded catalog keeps its **embedded** safety level. A
///     sidecar may refresh its text, but never its risk.
///   * An ID not in the embedded catalog is accepted as a new entry, but is clamped so it
///     can never be more permissive than `amber`: a brand-new command from an unreviewed
///     source is never silently green.
///   * Anything unparsable leaves the embedded catalog in place.
///
/// This works on the raw JSON rather than the typed struct so that fields the native side
/// does not model — descriptions, aliases, provenance — survive into the UI intact.
fn merge_sidecar_value(
    embedded: &serde_json::Value,
    mut sidecar: serde_json::Value,
) -> serde_json::Value {
    let trusted: HashMap<String, serde_json::Value> = embedded
        .get("entries")
        .and_then(|entries| entries.as_array())
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let id = entry.get("id")?.as_str()?.to_string();
                    Some((id, entry.get("safety_level")?.clone()))
                })
                .collect()
        })
        .unwrap_or_default();

    if let Some(entries) = sidecar
        .get_mut("entries")
        .and_then(|entries| entries.as_array_mut())
    {
        for entry in entries.iter_mut() {
            let id = entry
                .get("id")
                .and_then(|id| id.as_str())
                .map(|id| id.to_string());
            let Some(object) = entry.as_object_mut() else {
                continue;
            };
            match id.as_deref().and_then(|id| trusted.get(id)) {
                // Known entry: the reviewed classification is authoritative.
                Some(level) => {
                    object.insert("safety_level".into(), level.clone());
                }
                // Unknown entry: allow it, but never at the most permissive level.
                None => {
                    // `is_none_or` would be clearer but needs Rust 1.82, and this crate
                    // supports 1.77.2. A missing or non-string level counts as green here
                    // so that a malformed entry is clamped rather than trusted.
                    let is_green = match object.get("safety_level").and_then(|l| l.as_str()) {
                        Some(level) => level == "green",
                        None => true,
                    };
                    if is_green {
                        object.insert("safety_level".into(), serde_json::Value::from("amber"));
                    }
                }
            }
        }
    }

    sidecar
}

/// The catalog the app should use: embedded, with an operator's sidecar applied if valid.
///
/// Every failure path returns the embedded catalog rather than an error: a missing,
/// unreadable, oversized or malformed sidecar must degrade to the known-good data, never
/// leave the operator with no catalog at all.
/// The catalog every part of the app must agree on, sidecar applied.
///
/// `intent.rs` resolves reasoning candidates against a catalog too. If it used the
/// build-time import while this module used the merged one, an entry that came from an
/// operator's sidecar would be visible and insertable in the UI yet rejected by reasoning
/// as "not in the catalog". One loader keeps the two views honest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CatalogSource {
    Embedded,
    Sidecar,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CatalogFailure {
    PathUnavailable,
    Unreadable,
    UnsafeFileType,
    TooLarge,
    Malformed,
    Empty,
    InvalidSchema,
}
#[derive(Debug)]
struct CatalogLoad {
    value: serde_json::Value,
    source: CatalogSource,
    failure: Option<CatalogFailure>,
}

fn load_catalog_from_path(path: Option<&std::path::Path>) -> Result<CatalogLoad, String> {
    let embedded: serde_json::Value =
        serde_json::from_str(CATALOG_JSON).map_err(|e| e.to_string())?;
    let fallback = |failure| CatalogLoad {
        value: embedded.clone(),
        source: CatalogSource::Embedded,
        failure,
    };
    let Some(path) = path else {
        return Ok(fallback(Some(CatalogFailure::PathUnavailable)));
    };
    let metadata = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(fallback(None)),
        Err(_) => return Ok(fallback(Some(CatalogFailure::Unreadable))),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Ok(fallback(Some(CatalogFailure::UnsafeFileType)));
    }
    if metadata.len() > MAX_SIDECAR_CATALOG_BYTES {
        return Ok(fallback(Some(CatalogFailure::TooLarge)));
    }
    let raw = match fs::read_to_string(path) {
        Ok(v) => v,
        Err(_) => return Ok(fallback(Some(CatalogFailure::Unreadable))),
    };
    let sidecar: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return Ok(fallback(Some(CatalogFailure::Malformed))),
    };
    match sidecar.get("entries").and_then(|v| v.as_array()) {
        None => return Ok(fallback(Some(CatalogFailure::InvalidSchema))),
        Some(v) if v.is_empty() => return Ok(fallback(Some(CatalogFailure::Empty))),
        _ => (),
    }
    let value = merge_sidecar_value(&embedded, sidecar);
    if serde_json::from_value::<Catalog>(value.clone()).is_err() {
        return Ok(fallback(Some(CatalogFailure::InvalidSchema)));
    }
    Ok(CatalogLoad {
        value,
        source: CatalogSource::Sidecar,
        failure: None,
    })
}

fn merged_catalog_value_from_path(
    path: Option<&std::path::Path>,
) -> Result<serde_json::Value, String> {
    Ok(load_catalog_from_path(path)?.value)
}

pub(crate) fn merged_catalog_value() -> Result<serde_json::Value, String> {
    merged_catalog_value_from_path(sidecar_catalog_path().as_deref())
}

fn load_catalog() -> Result<Catalog, String> {
    let value = merged_catalog_value()?;
    serde_json::from_value(value).map_err(|error| error.to_string())
}

fn catalog() -> Result<&'static Catalog, ActionError> {
    static CATALOG: OnceLock<Result<Catalog, String>> = OnceLock::new();
    CATALOG
        .get_or_init(load_catalog)
        .as_ref()
        .map_err(|message| ActionError::Catalog(message.clone()))
}

/// Hand the UI the same catalog the native gates will enforce.
///
/// Both sides must agree on command text. `matched_entry` requires the submitted command
/// to equal the catalog's exactly, so if the UI rendered build-time text while the native
/// side had applied an operator's sidecar, every copy and insert would fail as a mismatch.
#[tauri::command]
pub async fn catalog_snapshot() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(merged_catalog_value)
        .await
        .map_err(|error| format!("catalog snapshot failed: {error}"))?
}

/// Safe diagnostics for sidecar selection. Raw file contents and paths are never returned.
#[derive(serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub struct CatalogHealth {
    pub source: String,
    pub failure: Option<String>,
}
#[tauri::command]
pub async fn catalog_health() -> Result<CatalogHealth, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let loaded = load_catalog_from_path(sidecar_catalog_path().as_deref())?;
        Ok(CatalogHealth {
            source: match loaded.source {
                CatalogSource::Embedded => "embedded",
                CatalogSource::Sidecar => "sidecar",
            }
            .into(),
            failure: loaded
                .failure
                .map(|failure| format!("{failure:?}").to_lowercase()),
        })
    })
    .await
    .map_err(|_| "Catalog health probe failed.".to_string())?
}

/// Report which desktop integrations work here, so the UI can disable what cannot.
#[tauri::command]
pub async fn desktop_capabilities() -> Result<DesktopCapabilities, String> {
    tauri::async_runtime::spawn_blocking(detect_desktop_capabilities)
        .await
        .map_err(|error| format!("desktop capability probe failed: {error}"))
}

/// Report what this desktop supports and exactly what is missing, for Settings.
///
/// This is the actionable companion to `desktop_capabilities`: both read the same
/// environment and PATH, so a displayed prerequisite can never disagree with the gate.
#[tauri::command]
pub async fn desktop_compatibility() -> Result<DesktopCompatibilityReport, String> {
    tauri::async_runtime::spawn_blocking(describe_desktop_compatibility)
        .await
        .map_err(|error| format!("desktop compatibility probe failed: {error}"))
}

#[tauri::command]
pub async fn copy_catalog_command(entry_id: String, command: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !detect_desktop_capabilities().can_copy {
            return Err(unsupported_desktop_message("Copying to the clipboard"));
        }
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
        if !detect_desktop_capabilities().can_insert {
            return Err(unsupported_desktop_message("Inserting into a terminal"));
        }
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
    use std::cell::{Cell, RefCell};
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
            // "omarchy" needs no binary on PATH, so the existing fixtures keep exercising
            // the checks they were written for. The PATH gate has its own tests below.
            product: "omarchy".into(),
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
                "output:hyprctl:dispatch hl.dsp.focus({ window = \"address:0x123\" })",
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
                .any(|call| call.starts_with("output:hyprctl:dispatch")));
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

    #[test]
    fn terminal_status_observation_respects_the_absolute_deadline_boundary() {
        let deadline = Instant::now();

        let before = poll_child_until(
            deadline,
            || Ok(Some(7)),
            || deadline - Duration::from_nanos(1),
            |_| {},
        )
        .unwrap();
        assert_eq!(before, ChildPoll::Exited(7));

        let at_boundary = poll_child_until(deadline, || Ok(Some(7)), || deadline, |_| {}).unwrap();
        assert_eq!(at_boundary, ChildPoll::TimedOutAfterExit);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn child_timeout_kills_and_reaps_the_process() {
        let capture = ProcessCapture::new().unwrap();
        let child = Command::new("sleep")
            .arg("30")
            .stdin(Stdio::null())
            .stdout(capture.stdout.stdio().unwrap())
            .stderr(capture.stderr.stdio().unwrap())
            .spawn()
            .unwrap();
        let pid = child.id();

        let error = run_spawned_child(
            child,
            "sleep",
            None,
            Instant::now() + Duration::from_millis(20),
            capture,
        )
        .unwrap_err();

        assert!(error.contains("timed out"));
        assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn expired_spawned_child_is_reaped_without_writing_stdin() {
        let deadline = Instant::now();
        let capture = ProcessCapture::new().unwrap();
        let child = Command::new("sleep")
            .arg("30")
            .stdin(Stdio::piped())
            .stdout(capture.stdout.stdio().unwrap())
            .stderr(capture.stderr.stdio().unwrap())
            .spawn()
            .unwrap();
        let pid = child.id();
        let write_attempted = Cell::new(false);

        let error = run_spawned_child_with(
            child,
            "sleep",
            Some(b"must not be written".to_vec()),
            deadline,
            capture,
            || deadline,
            |_, _, _| {
                write_attempted.set(true);
                Ok(())
            },
        )
        .unwrap_err();

        assert_eq!(error, "sleep timed out");
        assert!(!write_attempted.get());
        assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn timeout_does_not_wait_for_descendants_holding_output_descriptors() {
        let started = Instant::now();

        let error = process_output(
            "sh",
            &["-c", "sleep 1 & exec sleep 30"],
            Instant::now() + Duration::from_millis(30),
        )
        .unwrap_err();

        assert!(error.contains("timed out"));
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "runner exceeded hard deadline: {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn oversized_input_is_rejected_before_process_spawn() {
        let input = vec![b'x'; MAX_NATIVE_STDIN_BYTES + 1];

        let error = process_input(
            "/operator-key-test-program-does-not-exist",
            &[],
            &input,
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap_err();

        assert!(error.contains("input exceeds"), "unexpected error: {error}");
    }

    #[test]
    fn expired_output_deadline_is_rejected_before_process_spawn() {
        let error = process_output(
            "/operator-key-test-program-does-not-exist",
            &[],
            Instant::now() - Duration::from_millis(1),
        )
        .unwrap_err();

        assert_eq!(error, "/operator-key-test-program-does-not-exist timed out");
    }

    #[test]
    fn expired_input_deadline_is_rejected_before_process_spawn() {
        let error = process_input(
            "/operator-key-test-program-does-not-exist",
            &[],
            b"must not be written",
            Instant::now() - Duration::from_millis(1),
        )
        .unwrap_err();

        assert_eq!(error, "/operator-key-test-program-does-not-exist timed out");
    }

    #[test]
    fn capture_files_are_deleted_when_the_capture_is_dropped() {
        let (stdout_path, stderr_path) = {
            let capture = ProcessCapture::new().unwrap();
            assert!(capture.stdout.path.exists());
            assert!(capture.stderr.path.exists());
            (capture.stdout.path.clone(), capture.stderr.path.clone())
        };

        assert!(!stdout_path.exists());
        assert!(!stderr_path.exists());
    }

    #[test]
    fn captured_output_reads_only_one_overflow_byte_and_reports_truncation() {
        let mut capture = CaptureFile::new("bounded-test").unwrap();
        capture
            .file
            .write_all(&vec![b'x'; MAX_CAPTURE_BYTES + 4 * 1024])
            .unwrap();

        let output = capture.read_bounded().unwrap();

        assert_eq!(
            output.len(),
            MAX_CAPTURE_BYTES + OUTPUT_TRUNCATED_MARKER.len()
        );
        assert!(output[..MAX_CAPTURE_BYTES].bytes().all(|byte| byte == b'x'));
        assert!(output.ends_with(OUTPUT_TRUNCATED_MARKER));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn completed_process_preserves_normal_stdout_and_stderr() {
        let output = process_output(
            "sh",
            &[
                "-c",
                "printf stdout-value; printf ' stderr-value\\n' >&2; exit 7",
            ],
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();

        assert!(!output.success);
        assert_eq!(output.stdout, "stdout-value");
        assert_eq!(output.stderr, "stderr-value");
    }

    /// Build an entry for a product whose binary must exist on PATH.
    fn product_entry(product: &str, command: &str) -> CatalogEntry {
        CatalogEntry {
            id: "entry-1".into(),
            product: product.into(),
            interface: "shell-command".into(),
            command: command.into(),
            safety_level: SafetyLevel::Green,
            available: true,
        }
    }

    #[test]
    fn a_hidden_control_character_is_refused_before_any_keystroke_is_sent() {
        // The catalog is generated from local --help output and is clean today. This is
        // the last gate before synthetic keystrokes reach a live shell, so it validates
        // rather than trusting the generator.
        for (name, command) in [
            ("escape", "git status\u{1b}[2K"),
            ("bell", "git status\u{7}"),
            ("backspace", "git status\u{8}"),
            ("vertical tab", "git status\u{b}"),
            ("nul", "git status\u{0}"),
            ("delete", "git status\u{7f}"),
            ("bidi override", "git status\u{202e}drowssap"),
            ("zero width space", "git\u{200b} status"),
            ("line separator", "git status\u{2028}rm -rf /"),
            ("non-breaking space", "git\u{a0}status"),
        ] {
            let entry = CatalogEntry {
                product: "omarchy".into(),
                ..product_entry("omarchy", command)
            };
            assert_eq!(
                validate_insert(&entry),
                Err(ActionError::ControlCharacter),
                "{name} must be refused"
            );
        }
    }

    #[test]
    fn ordinary_command_text_still_passes_the_control_character_gate() {
        // Fail-closed logic must not reject the commands the catalog actually contains.
        for command in [
            "git status",
            "gh pr create --fill",
            "git commit -m \"message with spaces\"",
            "git log --pretty=format:'%h %s'",
            "hermes chat --model gpt-4o | tee /tmp/out.txt",
            "git diff HEAD~1..HEAD -- src/*.rs",
            "gh api repos/{owner}/{repo} --jq '.name'",
        ] {
            let entry = product_entry("omarchy", command);
            assert_eq!(validate_insert(&entry), Ok(()), "{command} must be allowed");
        }
    }

    /// Build a catalog JSON document from (id, command, level) triples.
    fn catalog_value(rows: &[(&str, &str, &str)]) -> serde_json::Value {
        serde_json::json!({
            "entries": rows.iter().map(|(id, command, level)| serde_json::json!({
                "id": id,
                "product": "omarchy",
                "interface": "shell-command",
                "command": command,
                "safety_level": level,
                "available": true,
            })).collect::<Vec<_>>()
        })
    }

    fn level_of(value: &serde_json::Value, index: usize) -> &str {
        value["entries"][index]["safety_level"].as_str().unwrap()
    }

    #[test]
    fn a_sidecar_catalog_cannot_downgrade_a_dangerous_command() {
        // The attack this rule exists to stop: the app types command text into a live
        // terminal, so if a sidecar file could relabel a destructive command as green, it
        // would be inserted behind a safe-looking badge.
        let embedded = catalog_value(&[("id-1", "git push --force", "red")]);
        let hostile = catalog_value(&[("id-1", "git push --force", "green")]);

        let merged = merge_sidecar_value(&embedded, hostile);

        assert_eq!(level_of(&merged, 0), "red");
        // And the gate still refuses it, which is the property that actually protects the
        // operator rather than the label alone.
        let typed: Catalog = serde_json::from_value(merged).unwrap();
        assert_eq!(
            validate_insert(&typed.entries[0]),
            Err(ActionError::RedAction)
        );
    }

    #[test]
    fn a_sidecar_catalog_cannot_downgrade_amber_to_green_either() {
        let embedded = catalog_value(&[("id-1", "git commit", "amber")]);
        let hostile = catalog_value(&[("id-1", "git commit", "green")]);

        let merged = merge_sidecar_value(&embedded, hostile);

        assert_eq!(level_of(&merged, 0), "amber");
    }

    #[test]
    fn a_sidecar_entry_may_refresh_command_text_for_a_known_id() {
        // The point of the feature: an operator who rebuilds the catalog against their own
        // newer tools sees their own commands without rebuilding the application.
        let embedded = catalog_value(&[("id-1", "gh pr list --limit 30", "green")]);
        let refreshed = catalog_value(&[("id-1", "gh pr list --limit 50", "green")]);

        let merged = merge_sidecar_value(&embedded, refreshed);

        assert_eq!(merged["entries"][0]["command"], "gh pr list --limit 50");
        assert_eq!(level_of(&merged, 0), "green");
    }

    #[test]
    fn a_new_sidecar_entry_is_never_accepted_as_green() {
        // A command the reviewed catalog has never seen is allowed through so the feature
        // is useful, but it cannot arrive at the most permissive level.
        let embedded = catalog_value(&[("id-1", "gh pr list", "green")]);
        let with_new = catalog_value(&[("id-2", "some brand new command", "green")]);

        let merged = merge_sidecar_value(&embedded, with_new);

        assert_eq!(merged["entries"][0]["id"], "id-2");
        assert_eq!(level_of(&merged, 0), "amber");
    }

    #[test]
    fn a_new_sidecar_entry_keeps_a_stricter_level_it_declares() {
        let embedded = catalog_value(&[("id-1", "gh pr list", "green")]);
        let with_new = catalog_value(&[("id-2", "rm -rf /", "red")]);

        let merged = merge_sidecar_value(&embedded, with_new);

        assert_eq!(level_of(&merged, 0), "red");
    }

    #[test]
    fn sidecar_merging_preserves_every_sidecar_entry() {
        let embedded = catalog_value(&[("id-1", "a", "green"), ("id-2", "b", "red")]);
        let sidecar = catalog_value(&[
            ("id-1", "a2", "green"),
            ("id-2", "b2", "green"),
            ("id-3", "c", "amber"),
        ]);

        let merged = merge_sidecar_value(&embedded, sidecar);

        assert_eq!(merged["entries"].as_array().unwrap().len(), 3);
        // id-2 was red in the reviewed catalog and must stay red.
        assert_eq!(level_of(&merged, 1), "red");
    }

    #[test]
    fn a_sidecar_entry_without_a_safety_level_is_not_treated_as_green() {
        // A malformed or truncated entry must not default to the most permissive label.
        let embedded = catalog_value(&[("id-1", "a", "green")]);
        let sidecar = serde_json::json!({
            "entries": [{
                "id": "id-9",
                "product": "omarchy",
                "interface": "shell-command",
                "command": "mystery command",
                "available": true,
            }]
        });

        let merged = merge_sidecar_value(&embedded, sidecar);

        assert_eq!(level_of(&merged, 0), "amber");
    }

    #[test]
    fn the_sidecar_path_follows_the_xdg_data_directory() {
        let _guard = ENVIRONMENT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let previous = env::var_os("XDG_DATA_HOME");

        // SAFETY: single-threaded within the environment lock.
        unsafe { env::set_var("XDG_DATA_HOME", "/tmp/xdg-example") };
        let path = sidecar_catalog_path().expect("a path when XDG_DATA_HOME is set");
        assert_eq!(
            path,
            PathBuf::from("/tmp/xdg-example/operator-key/catalog.json")
        );

        match previous {
            Some(value) => unsafe { env::set_var("XDG_DATA_HOME", value) },
            None => unsafe { env::remove_var("XDG_DATA_HOME") },
        }
    }

    #[test]
    fn catalog_loader_reports_sidecar_even_when_equal_to_embedded() {
        let embedded: serde_json::Value = serde_json::from_str(CATALOG_JSON).unwrap();
        let temp = std::env::temp_dir().join(format!(
            "catalog-health-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&temp).unwrap();
        let path = temp.join("catalog.json");
        fs::write(&path, serde_json::to_vec(&embedded).unwrap()).unwrap();
        let loaded = load_catalog_from_path(Some(&path)).unwrap();
        assert_eq!(loaded.source, CatalogSource::Sidecar);
        assert_eq!(loaded.value, embedded);
        assert_eq!(loaded.failure, None);
    }

    #[test]
    fn catalog_loader_distinguishes_bad_json_empty_and_invalid_schema() {
        let temp = std::env::temp_dir().join(format!(
            "catalog-health-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&temp).unwrap();
        let path = temp.join("catalog.json");
        for (raw, expected) in [
            ("{", CatalogFailure::Malformed),
            (r#"{"entries":[]}"#, CatalogFailure::Empty),
            (r#"{"entries":[{}]}"#, CatalogFailure::InvalidSchema),
        ] {
            fs::write(&path, raw).unwrap();
            let loaded = load_catalog_from_path(Some(&path)).unwrap();
            assert_eq!(loaded.source, CatalogSource::Embedded);
            assert_eq!(loaded.failure, Some(expected));
        }
    }

    #[test]
    fn missing_sidecar_uses_embedded_without_failure() {
        let temp = std::env::temp_dir().join(format!(
            "catalog-health-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&temp).unwrap();
        let loaded = load_catalog_from_path(Some(&temp.join("absent.json"))).unwrap();
        assert_eq!(loaded.source, CatalogSource::Embedded);
        assert_eq!(loaded.failure, None);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_is_rejected_by_the_shared_loader() {
        use std::os::unix::fs::symlink;
        let temp = std::env::temp_dir().join(format!(
            "catalog-health-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&temp).unwrap();
        let target = temp.join("target.json");
        let path = temp.join("catalog.json");
        fs::write(
            &target,
            serde_json::to_vec(&serde_json::from_str::<serde_json::Value>(CATALOG_JSON).unwrap())
                .unwrap(),
        )
        .unwrap();
        symlink(&target, &path).unwrap();
        let loaded = load_catalog_from_path(Some(&path)).unwrap();
        assert_eq!(loaded.source, CatalogSource::Embedded);
        assert_eq!(loaded.failure, Some(CatalogFailure::UnsafeFileType));
        assert_eq!(
            merged_catalog_value_from_path(Some(&path)).unwrap(),
            loaded.value
        );
    }

    #[test]
    fn a_missing_sidecar_leaves_the_embedded_catalog_in_place() {
        let _guard = ENVIRONMENT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let previous = env::var_os("XDG_DATA_HOME");

        // SAFETY: single-threaded within the environment lock.
        unsafe { env::set_var("XDG_DATA_HOME", "/nonexistent-operator-key-test-path") };
        let loaded = load_catalog().expect("the embedded catalog still parses");
        assert!(
            !loaded.entries.is_empty(),
            "a missing sidecar must not empty the catalog"
        );

        match previous {
            Some(value) => unsafe { env::set_var("XDG_DATA_HOME", value) },
            None => unsafe { env::remove_var("XDG_DATA_HOME") },
        }
    }

    #[test]
    fn a_hostile_sidecar_file_on_disk_cannot_get_a_red_command_inserted() {
        // The unit tests above prove the merge function. This proves the whole path an
        // attacker would actually use: write a real file to the real configured location,
        // load through the real loader, and confirm the insertion gate still refuses.
        let _guard = ENVIRONMENT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let previous = env::var_os("XDG_DATA_HOME");

        let root = std::env::temp_dir().join(format!(
            "operator-key-sidecar-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let dir = root.join("operator-key");
        fs::create_dir_all(&dir).expect("create sidecar dir");

        // Take a genuinely red entry out of the shipped catalog and try to relabel it.
        let embedded: Catalog = serde_json::from_str(CATALOG_JSON).expect("embedded catalog");
        let red = embedded
            .entries
            .iter()
            .find(|e| e.safety_level == SafetyLevel::Red)
            .expect("the shipped catalog contains a red entry");

        let hostile = format!(
            r#"{{"entries":[{{"id":"{}","product":"{}","interface":"{}","command":"{}","safety_level":"green","available":true}}]}}"#,
            red.id,
            red.product,
            red.interface,
            red.command.replace('\\', "\\\\").replace('"', "\\\"")
        );
        fs::write(dir.join("catalog.json"), hostile).expect("write hostile sidecar");

        // SAFETY: single-threaded within the environment lock.
        unsafe { env::set_var("XDG_DATA_HOME", &root) };
        let loaded = load_catalog().expect("catalog loads");
        let entry = loaded
            .entries
            .iter()
            .find(|e| e.id == red.id)
            .expect("the entry survived the merge");

        // The file said green. The reviewed catalog said red. Red wins.
        assert_eq!(
            entry.safety_level,
            SafetyLevel::Red,
            "a sidecar file must not be able to relabel a destructive command"
        );
        assert_eq!(validate_insert(entry), Err(ActionError::RedAction));

        match previous {
            Some(value) => unsafe { env::set_var("XDG_DATA_HOME", value) },
            None => unsafe { env::remove_var("XDG_DATA_HOME") },
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_malformed_sidecar_file_degrades_to_the_embedded_catalog() {
        let _guard = ENVIRONMENT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let previous = env::var_os("XDG_DATA_HOME");

        let root = std::env::temp_dir().join(format!(
            "operator-key-bad-sidecar-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let dir = root.join("operator-key");
        fs::create_dir_all(&dir).expect("create sidecar dir");
        fs::write(dir.join("catalog.json"), "{ this is not json").expect("write junk");

        // SAFETY: single-threaded within the environment lock.
        unsafe { env::set_var("XDG_DATA_HOME", &root) };
        let loaded = load_catalog().expect("a broken sidecar must not break the app");
        assert!(
            loaded.entries.len() > 1000,
            "expected the full embedded catalog, got {} entries",
            loaded.entries.len()
        );

        match previous {
            Some(value) => unsafe { env::set_var("XDG_DATA_HOME", value) },
            None => unsafe { env::remove_var("XDG_DATA_HOME") },
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn insertion_is_refused_when_the_required_program_is_absent_from_path() {
        // `available` is decided on the machine that BUILT the catalog. A downloaded
        // release carries the builder's environment, so the decision is remade here.
        // PATH mutation is serialized, because cargo runs tests in parallel threads and
        // an unsynchronized change here would intermittently break any other test that
        // resolves a program.
        let entry = product_entry("git", "git status");
        with_environment(&[("PATH", Some("/nonexistent-operator-key-probe"))], || {
            assert_eq!(
                validate_insert(&entry),
                Err(ActionError::ProgramMissing("git"))
            );
        });

        // The message names the missing tool so the operator can act on it.
        assert!(ActionError::ProgramMissing("git")
            .to_string()
            .contains("`git` is not installed"));
    }

    #[test]
    fn insertion_is_allowed_when_the_required_program_is_present() {
        // `sh` is guaranteed on any POSIX machine, so this proves the gate passes rather
        // than merely that it rejects everything.
        assert!(program_on_path("sh"), "sh must resolve on a POSIX machine");
        assert!(!program_on_path("operator-key-definitely-not-installed"));
        // A product with no single binary is not gated at all.
        assert_eq!(required_program("omarchy"), None);
        assert_eq!(required_program("git"), Some("git"));
        assert_eq!(required_program("claude-code"), Some("claude"));
    }

    #[test]
    fn a_path_lookup_never_becomes_a_path_probe() {
        // required_program only ever yields fixed identifiers, but the helper refuses
        // separators so it cannot be repurposed into an arbitrary filesystem check.
        assert!(!program_on_path("/bin/sh"));
        assert!(!program_on_path("../bin/sh"));
        assert!(!program_on_path(""));
    }

    /// Serialize the tests that mutate process-wide environment variables.
    static ENVIRONMENT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Run `body` with an exact environment, restoring the previous values afterwards.
    fn with_environment(pairs: &[(&str, Option<&str>)], body: impl FnOnce()) {
        let guard = ENVIRONMENT_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let saved: Vec<(String, Option<std::ffi::OsString>)> = pairs
            .iter()
            .map(|(key, _)| ((*key).to_owned(), std::env::var_os(key)))
            .collect();
        for (key, value) in pairs {
            // SAFETY: mutation is serialized by ENVIRONMENT_LOCK and reverted below.
            unsafe {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(body));
        for (key, value) in saved {
            unsafe {
                match value {
                    Some(value) => std::env::set_var(&key, value),
                    None => std::env::remove_var(&key),
                }
            }
        }
        drop(guard);
        if let Err(payload) = outcome {
            std::panic::resume_unwind(payload);
        }
    }

    #[test]
    fn a_non_wayland_desktop_reports_no_copy_or_insert_and_explains_why() {
        // Previously this path surfaced a raw "could not start hyprctl" process error.
        with_environment(
            &[
                ("WAYLAND_DISPLAY", None),
                ("HYPRLAND_INSTANCE_SIGNATURE", None),
            ],
            || {
                let capabilities = detect_desktop_capabilities();
                assert_eq!(
                    capabilities,
                    DesktopCapabilities {
                        can_copy: false,
                        can_insert: false
                    }
                );

                let message = unsupported_desktop_message("Inserting into a terminal");
                assert!(message.contains("needs Wayland"), "{message}");
                assert!(
                    !message.contains("hyprctl"),
                    "no raw binary name: {message}"
                );
            },
        );
    }

    #[test]
    fn a_wayland_session_without_hyprland_can_copy_but_not_insert() {
        with_environment(
            &[
                ("WAYLAND_DISPLAY", Some("wayland-0")),
                ("HYPRLAND_INSTANCE_SIGNATURE", None),
            ],
            || {
                // Insertion needs Hyprland's IPC and must be refused regardless of PATH.
                assert!(!detect_desktop_capabilities().can_insert);

                let message = unsupported_desktop_message("Inserting into a terminal");
                assert!(message.contains("Hyprland"), "{message}");
            },
        );
    }

    /// Build a PATH directory containing exactly the named executables.
    fn probe_path_with(programs: &[&str]) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "operator-key-compat-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).expect("create probe dir");
        for program in programs {
            let path = root.join(program);
            fs::write(&path, b"#!/bin/sh\nexit 0\n").expect("write probe program");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
                    .expect("mark probe executable");
            }
        }
        root
    }

    #[test]
    fn a_wayland_session_with_no_usable_action_reports_unsupported_not_degraded() {
        // Degraded must mean "some desktop action works". A Wayland session missing every
        // helper has none, so calling it Degraded would overstate what the gate allows.
        let root = probe_path_with(&[]);

        with_environment(
            &[
                ("WAYLAND_DISPLAY", Some("wayland-0")),
                ("HYPRLAND_INSTANCE_SIGNATURE", Some("test-signature")),
                ("PATH", Some(root.to_str().expect("probe path is utf-8"))),
            ],
            || {
                let report = describe_desktop_compatibility();

                assert_eq!(report.mode, DesktopMode::Unsupported);
                assert!(!report.capabilities.can_copy);
                assert!(!report.capabilities.can_insert);
                // Search is unaffected and must still be reported as available.
                assert!(report.search_available);
            },
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_wayland_session_that_can_only_copy_reports_degraded() {
        let root = probe_path_with(&["wl-copy"]);

        with_environment(
            &[
                ("WAYLAND_DISPLAY", Some("wayland-0")),
                ("HYPRLAND_INSTANCE_SIGNATURE", None),
                ("PATH", Some(root.to_str().expect("probe path is utf-8"))),
            ],
            || {
                let report = describe_desktop_compatibility();

                // One action works, so this really is partly supported.
                assert_eq!(report.mode, DesktopMode::Degraded);
                assert!(report.capabilities.can_copy);
                assert!(!report.capabilities.can_insert);
            },
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn every_unavailable_desktop_action_names_at_least_one_prerequisite() {
        // An unmet requirement with an empty list would be exactly the unactionable
        // "Not confirmed" this report exists to replace.
        let root = probe_path_with(&[]);

        with_environment(
            &[
                ("WAYLAND_DISPLAY", Some("wayland-0")),
                ("HYPRLAND_INSTANCE_SIGNATURE", Some("test-signature")),
                ("PATH", Some(root.to_str().expect("probe path is utf-8"))),
            ],
            || {
                for requirement in describe_desktop_compatibility().requirements {
                    if requirement.met {
                        assert!(
                            requirement.unmet_prerequisites.is_empty(),
                            "{requirement:?}"
                        );
                    } else {
                        assert!(
                            !requirement.unmet_prerequisites.is_empty(),
                            "an unavailable action must say what is missing: {requirement:?}"
                        );
                    }
                }
            },
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_non_wayland_report_names_the_session_prerequisite_not_a_raw_binary() {
        with_environment(
            &[
                ("WAYLAND_DISPLAY", None),
                ("HYPRLAND_INSTANCE_SIGNATURE", None),
                ("XDG_SESSION_TYPE", Some("x11")),
            ],
            || {
                let report = describe_desktop_compatibility();

                assert_eq!(report.mode, DesktopMode::Unsupported);
                assert!(!report.capabilities.can_copy);
                assert!(!report.capabilities.can_insert);

                // Search must never be described as blocked: it works everywhere.
                assert!(report.search_available, "search is always available");

                let copy = report
                    .requirements
                    .iter()
                    .find(|item| item.feature == DesktopFeature::Copy)
                    .expect("copy requirement is reported");
                assert!(!copy.met, "copy cannot be met without Wayland");
                // The operator needs the session prerequisite, not a bare program name.
                assert!(
                    copy.unmet_prerequisites
                        .iter()
                        .any(|item| item.contains("Wayland")),
                    "{:?}",
                    copy.unmet_prerequisites
                );
            },
        );
    }

    #[test]
    fn a_wayland_session_without_hyprland_reports_degraded_with_copy_only() {
        // Pin PATH: whether the host happens to have wl-copy installed must not decide
        // this test's outcome. Here copy is available and insertion structurally is not.
        let root = probe_path_with(&["wl-copy"]);

        with_environment(
            &[
                ("WAYLAND_DISPLAY", Some("wayland-0")),
                ("HYPRLAND_INSTANCE_SIGNATURE", None),
                ("XDG_SESSION_TYPE", Some("wayland")),
                ("PATH", Some(root.to_str().expect("probe path is utf-8"))),
            ],
            || {
                let report = describe_desktop_compatibility();

                // Copy works, so this desktop is partly supported; insertion is
                // structurally impossible here and must be named as such.
                assert_eq!(report.mode, DesktopMode::Degraded);
                assert!(report.capabilities.can_copy);
                assert!(!report.capabilities.can_insert);

                let insert = report
                    .requirements
                    .iter()
                    .find(|item| item.feature == DesktopFeature::Insert)
                    .expect("insert requirement is reported");
                assert!(!insert.met);
                assert!(
                    insert
                        .unmet_prerequisites
                        .iter()
                        .any(|item| item.contains("Hyprland")),
                    "{:?}",
                    insert.unmet_prerequisites
                );
            },
        );
    }

    #[test]
    fn a_hyprland_session_missing_helpers_names_each_missing_program_to_install() {
        with_environment(
            &[
                ("WAYLAND_DISPLAY", Some("wayland-0")),
                ("HYPRLAND_INSTANCE_SIGNATURE", Some("test-signature")),
                ("PATH", Some("/nonexistent-operator-key-probe")),
            ],
            || {
                let report = describe_desktop_compatibility();

                // No helper is installed, so no desktop action is possible here.
                assert_eq!(report.mode, DesktopMode::Unsupported);
                assert!(report.search_available);

                let copy = report
                    .requirements
                    .iter()
                    .find(|item| item.feature == DesktopFeature::Copy)
                    .expect("copy requirement is reported");
                assert!(
                    copy.unmet_prerequisites
                        .iter()
                        .any(|item| item.contains("wl-copy")),
                    "{:?}",
                    copy.unmet_prerequisites
                );

                let insert = report
                    .requirements
                    .iter()
                    .find(|item| item.feature == DesktopFeature::Insert)
                    .expect("insert requirement is reported");
                // Both helper programs are absent and both must be named, so the operator
                // installs everything in one step instead of discovering them one at a time.
                assert!(
                    insert
                        .unmet_prerequisites
                        .iter()
                        .any(|item| item.contains("wtype")),
                    "{:?}",
                    insert.unmet_prerequisites
                );
            },
        );
    }

    #[test]
    fn a_fully_equipped_hyprland_session_reports_supported_with_no_unmet_prerequisites() {
        let root = std::env::temp_dir().join(format!(
            "operator-key-compat-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).expect("create probe dir");
        for program in ["wl-copy", "hyprctl", "wtype"] {
            let path = root.join(program);
            fs::write(&path, b"#!/bin/sh\nexit 0\n").expect("write probe program");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
                    .expect("mark probe executable");
            }
        }

        with_environment(
            &[
                ("WAYLAND_DISPLAY", Some("wayland-0")),
                ("HYPRLAND_INSTANCE_SIGNATURE", Some("test-signature")),
                ("PATH", Some(root.to_str().expect("probe path is utf-8"))),
            ],
            || {
                let report = describe_desktop_compatibility();

                assert_eq!(report.mode, DesktopMode::Supported);
                assert!(report.capabilities.can_copy);
                assert!(report.capabilities.can_insert);
                assert!(
                    report.requirements.iter().all(|item| item.met),
                    "{:?}",
                    report.requirements
                );
                assert!(
                    report
                        .requirements
                        .iter()
                        .all(|item| item.unmet_prerequisites.is_empty()),
                    "a met requirement lists nothing to install"
                );
            },
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_compatibility_report_never_exposes_the_operators_home_path() {
        // Public-release privacy: this report is rendered in the UI and may be pasted into
        // a bug report, so it must describe prerequisites without leaking the environment.
        let report = describe_desktop_compatibility();
        let rendered = serde_json::to_string(&report).expect("report serializes");

        if let Some(home) = std::env::var_os("HOME") {
            let home = home.to_string_lossy().to_string();
            if !home.is_empty() && home != "/" {
                assert!(
                    !rendered.contains(&home),
                    "compatibility report must not embed the home directory"
                );
            }
        }
    }

    #[test]
    fn a_hyprland_session_missing_its_helpers_names_the_missing_programs() {
        with_environment(
            &[
                ("WAYLAND_DISPLAY", Some("wayland-0")),
                ("HYPRLAND_INSTANCE_SIGNATURE", Some("test-signature")),
                ("PATH", Some("/nonexistent-operator-key-probe")),
            ],
            || {
                assert_eq!(
                    detect_desktop_capabilities(),
                    DesktopCapabilities {
                        can_copy: false,
                        can_insert: false
                    }
                );

                let message = unsupported_desktop_message("Inserting into a terminal");
                assert!(message.contains("on PATH"), "{message}");
                assert!(message.contains("hyprctl"), "{message}");
            },
        );
    }
}
