"""Git local command, flag, and alias adapter.

Git is catalogued from ``git help -a`` and ``git <command> -h`` on this machine, so the
entries describe the git that is actually installed rather than whatever the current
documentation website describes.

Safety classification here is explicit rather than keyword-derived. The generic
classifier in ``common.safety`` reads the words a command MENTIONS, which is wrong in
both directions for version control: ``git reset``, ``git rebase`` and ``git
filter-branch`` all score green while destroying or rewriting work, and ``git clean``
scores red only because its description happens to contain "Remove". Teaching a newcomer
from those verdicts would be actively dangerous, so every classification below is keyed
to what the command DOES.
"""
from __future__ import annotations

import re
from pathlib import Path

from .common import clean, entry, portable_path, run, run_lenient

# Commands that rewrite, discard, or publish irreversibly. `destructive` (the second
# element) gates them out of onboarding routes entirely.
RED_COMMANDS: dict[str, str] = {
    "clean": "Deletes untracked files from the working tree; they are not in git and cannot be recovered.",
    "filter-branch": "Rewrites every commit in a branch's history, changing all commit hashes.",
    "gc": "Prunes unreachable objects, which can finalise the loss of dangling commits.",
    "prune": "Permanently removes unreachable objects from the object database.",
    "history": "EXPERIMENTAL history rewriting; changes commits that may already be shared.",
}

# Commands that change tracked state or contact a remote. Recoverable, but never
# something to run without understanding.
AMBER_COMMANDS: dict[str, str] = {
    "add": "Stages changes into the index.",
    "am": "Applies patches as commits onto the current branch.",
    "apply": "Modifies working tree files from a patch.",
    "checkout": "Switches branches and can overwrite uncommitted file changes.",
    "cherry-pick": "Creates new commits from existing ones.",
    "commit": "Records staged changes as a new commit.",
    "fetch": "Contacts a remote and downloads objects.",
    "init": "Creates a new repository in this directory.",
    "merge": "Joins histories and writes a merge commit.",
    "mv": "Moves or renames tracked files.",
    "pull": "Fetches from a remote and merges into the current branch.",
    "push": "Publishes local commits to a remote where others can see them.",
    "rebase": "Rewrites local commits onto a new base, changing their hashes.",
    "reset": "Moves HEAD and the index; with --hard it discards working tree changes.",
    "restore": "Overwrites working tree files from another source.",
    "revert": "Creates a new commit that undoes an earlier one.",
    "rm": "Removes files from the working tree and the index.",
    "stash": "Moves uncommitted changes onto a stack and reverts the working tree.",
    "submodule": "Initialises or updates nested repositories.",
    "switch": "Changes the checked-out branch.",
    "tag": "Creates or deletes tags, which are often published.",
    "worktree": "Adds or removes linked working trees on disk.",
    "clone": "Creates a new local copy of a remote repository.",
    "config": "Changes git behaviour for this repository or the whole account.",
    "branch": "Creates, renames, or deletes branches.",
    "notes": "Adds or removes notes attached to objects.",
    "maintenance": "Schedules or runs background repository optimisation.",
    "repack": "Rewrites pack files in the object database.",
    "bisect": "Checks out different commits while searching for a regression.",
    # Bare `git reflog` is `git reflog show` -- read-only, and the single best tool for
    # recovering apparently-lost commits. Only its `expire`/`delete`/`drop` subcommands
    # destroy anything. Rating the bare command red was a false alarm that also locked it
    # out of the recovery lesson, where it is precisely the right answer.
    "reflog": "Shows where your branches have pointed over time; its expire and delete subcommands can discard that safety net.",
    "sparse-checkout": "Changes which files are present in the working tree.",
}

# Read-only inspection. These are the commands onboarding should lead with.
GREEN_COMMANDS: frozenset[str] = frozenset({
    "status", "log", "diff", "show", "blame", "annotate", "grep", "describe",
    "shortlog", "reflog-show", "whatchanged", "range-diff", "cherry",
    "count-objects", "bugreport", "diagnose", "help", "version", "var",
    "check-ignore", "check-attr", "check-mailmap", "verify-commit", "verify-tag",
})

# Flags whose danger is independent of the command they are attached to.
RED_FLAGS: tuple[tuple[str, str], ...] = (
    ("--force", "Overwrites remote or local state without the usual safety checks."),
    ("--hard", "Discards working tree and index changes irreversibly."),
    ("-D", "Force-deletes a branch even if it is not merged."),
    ("--prune", "Deletes refs or objects that are absent from the source."),
    ("--delete", "Deletes the named ref."),
    ("-f", "Force: bypasses the safety check the command would otherwise make."),
)

# Task group drives the catalog's primary filter, so it is stated rather than inferred.
# `classify` files `git commit` under capture-and-input ("Record changes" contains
# "record") and `git init` under context-and-memory, which scatters the version-control
# workflow across unrelated groups.
TASK_GROUPS: dict[str, str] = {
    # Inspecting work
    "status": "review-and-verify", "log": "review-and-verify", "diff": "review-and-verify",
    "show": "review-and-verify", "blame": "review-and-verify", "annotate": "review-and-verify",
    "shortlog": "review-and-verify", "range-diff": "review-and-verify",
    "cherry": "review-and-verify", "describe": "review-and-verify", "grep": "review-and-verify",
    "whatchanged": "review-and-verify", "difftool": "review-and-verify",
    # Recovering from mistakes
    "reset": "debug-and-recover", "restore": "debug-and-recover", "revert": "debug-and-recover",
    "stash": "debug-and-recover", "reflog": "debug-and-recover", "bisect": "debug-and-recover",
    "fsck": "debug-and-recover", "checkout": "debug-and-recover", "clean": "debug-and-recover",
    "rerere": "debug-and-recover",
    # Moving between lines of work
    "branch": "sessions-and-navigation", "switch": "sessions-and-navigation",
    "worktree": "sessions-and-navigation", "tag": "sessions-and-navigation",
    # Configuration
    "config": "configuration", "remote": "configuration", "credential": "configuration",
    "init": "configuration", "clone": "configuration", "submodule": "configuration",
    "sparse-checkout": "configuration", "maintenance": "configuration",
    # Reference
    "help": "help-and-reference", "version": "help-and-reference",
    "bugreport": "help-and-reference", "diagnose": "help-and-reference",
}
DEFAULT_TASK_GROUP = "development"


def task_group(name: str) -> str:
    """Return the catalog task group for a git subcommand."""
    return TASK_GROUPS.get(name, DEFAULT_TASK_GROUP)


SECTIONS_TO_SKIP = (
    "Low-level Commands",
    "Developer-facing file formats",
    "User-facing repository, command and file interfaces",
    "External commands",
    # `git help -a` prints configured aliases as bare "st -> status" rows with no
    # provenance. Cataloguing them from here would produce a second `git st` entry that
    # dedupe resolves in favour of whichever came first, discarding the override
    # provenance AND the alias target's real safety level. parse_aliases owns them.
    "Command aliases",
)


def version(binary: str = "git") -> str:
    """Read the installed git version, or 'unknown' when git is absent."""
    text = run(binary, "--version").strip()
    match = re.search(r"git version ([^\s]+)", text)
    if match:
        return match.group(1)
    return text.splitlines()[0] if text else "unknown"


def classify_command(name: str) -> tuple[str, bool]:
    """Return the (safety_level, destructive) verdict for a git subcommand."""
    if name in RED_COMMANDS:
        return "red", True
    if name in GREEN_COMMANDS:
        return "green", False
    if name in AMBER_COMMANDS:
        return "amber", False
    # An unrecognised porcelain command is not assumed safe. Claiming green for something
    # this adapter has never assessed is exactly the confident-wrong-answer failure mode.
    return "amber", False


def classify_flag(command_name: str, flag: str, description: str) -> tuple[str, bool]:
    """Classify a flag, escalating above its parent command when the flag is the hazard."""
    tokens = {token.strip() for token in re.split(r"[\s,/]+", flag) if token.strip()}
    for dangerous, _ in RED_FLAGS:
        if dangerous in tokens:
            return "red", True
    # `--force-with-lease` is the SAFE alternative to --force and must not inherit its
    # verdict; it refuses to overwrite work the pusher has not seen.
    if any(token.startswith("--force-with-lease") or token.startswith("--force-if-includes")
           for token in tokens):
        return "amber", False
    if "--dry-run" in tokens or "-n" in tokens and "dry run" in description.lower():
        return "green", False
    level, destructive = classify_command(command_name)
    # A flag never exceeds its command's own danger unless matched above.
    return level, destructive


def safety_note(name: str) -> str:
    """Return the plain-language reason a command carries its rating, if known."""
    return RED_COMMANDS.get(name) or AMBER_COMMANDS.get(name) or ""


def parse_command_list(text: str, product_version: str, source: str) -> list[dict]:
    """Parse `git help -a` into catalog entries for real, installed subcommands."""
    rows: list[dict] = []
    section = ""
    skipping = False
    seen: set[str] = set()
    for raw in text.splitlines():
        if not raw.strip():
            continue
        if not raw.startswith((" ", "\t")):
            section = raw.strip()
            skipping = any(section.startswith(skip) for skip in SECTIONS_TO_SKIP)
            continue
        if skipping or section.startswith("See 'git help"):
            continue
        match = re.match(r"\s+([a-z][\w-]*)\s{2,}(.+)$", raw)
        if not match:
            continue
        name, description = match.group(1), clean(match.group(2))
        if name in seen or not description:
            continue
        seen.add(name)
        level, destructive = classify_command(name)
        note = safety_note(name)
        rows.append(entry(
            "git", "shell-command", f"git {name}", f"{description}. {note}".strip() if note else description,
            source, product_version, context="Shell", category=section,
            safety_override=(level, destructive), task_override=task_group(name),
        ))
    return rows


def parse_subcommand_flags(command_name: str, text: str, product_version: str,
                           source: str) -> list[dict]:
    """Parse `git <command> -h` output into flag entries.

    git's usage output wraps: a long flag with an argument puts its description on the
    following line. Both shapes are handled so wrapped flags are not silently dropped.
    """
    rows: list[dict] = []
    pending: str | None = None
    seen: set[str] = set()
    for raw in text.splitlines():
        if not raw.strip() or raw.startswith(("usage:", "   or:")):
            pending = None
            continue
        # Same-line form:  "    -m, --[no-]message <message>   commit message"
        match = re.match(r"\s{2,}((?:-\w, )?--?\[?[\w\-\]\[]+[^\s]*(?:[ =]<[^>]+>)?)\s{2,}(.+)$", raw)
        if match:
            pending = None
            flag, description = _normalise_flag(match.group(1)), clean(match.group(2))
        elif pending is not None and re.match(r"\s{10,}\S", raw):
            flag, description = pending, clean(raw)
            pending = None
        else:
            candidate = re.match(r"\s{2,}((?:-\w, )?--?\[?[\w\-\]\[]+[^\s]*(?:[ =]<[^>]+>)?)\s*$", raw)
            pending = _normalise_flag(candidate.group(1)) if candidate else None
            continue
        if not flag or not description or flag in seen:
            continue
        seen.add(flag)
        level, destructive = classify_flag(command_name, flag, description)
        rows.append(entry(
            "git", "cli-flag", f"git {command_name} {flag}", description, source, product_version,
            context=f"git {command_name} invocation", category=f"git {command_name}",
            safety_override=(level, destructive), task_override=task_group(command_name),
        ))
    return rows


def _normalise_flag(raw: str) -> str:
    """Render a git usage flag as the form an operator would actually type.

    Three transformations, each fixing a way the raw text misleads:
      * `--[no-]force` -> `--force`; the affirmative is what people mean.
      * `-f, --force`  -> `-f / --force`, matching the separator used by every other
        adapter so one flag does not render two ways in the same catalog.
      * `--force-with-lease[=<refname>:<expect>]` -> `--force-with-lease`. ``clean``
        strips `<...>` as if it were an HTML tag, leaving the nonsense `[=:]` behind;
        dropping the whole argument placeholder keeps the flag copyable and true.
    """
    flag = clean(raw).strip()
    flag = flag.replace("[no-]", "")
    flag = re.sub(r"\s*[\[(<][^\[\](){}<>]*[\])>]\s*$", "", flag)
    flag = re.sub(r"\s*\[=.*$", "", flag)
    flag = re.sub(r"\s*=<.*$", "", flag)
    flag = flag.replace(",", " /")
    return re.sub(r"\s+", " ", flag).strip()


def parse_aliases(text: str, product_version: str, source: str) -> list[dict]:
    """Parse configured git aliases into override entries.

    Alias VALUES are catalogued (they are commands the operator configured), but the
    source is rendered through ``portable_path`` and no file contents beyond the alias
    mapping are read, so nothing host-specific leaks into a shared catalog.
    """
    rows: list[dict] = []
    for line in text.splitlines():
        match = re.match(r"^alias\.([\w-]+)\s+(.+)$", line.strip())
        if not match:
            continue
        name, target = match.group(1), clean(match.group(2))
        if not target:
            continue
        # An alias is exactly as dangerous as the command it expands to.
        first = target.split()[0] if target.split() else ""
        level, destructive = classify_command(first.lstrip("!"))
        if target.startswith("!"):
            # A shell alias can do anything; it is not a git subcommand.
            level, destructive = "amber", False
        rows.append(entry(
            "git", "shell-command", f"git {name}", f"Your configured alias for: git {target}",
            source, product_version, context="Shell", category="Command aliases",
            aliases=[f"git {target}"], provenance="override",
            safety_override=(level, destructive), task_override=task_group(first.lstrip("!")),
        ))
    return rows


def collect(product_version: str, *, subcommands: tuple[str, ...] | None = None,
            include_aliases: bool = True) -> list[dict]:
    """Collect git entries from the installed binary."""
    help_text = run("git", "help", "-a")
    if not help_text:
        # git is not installed here. Reporting nothing is correct; inventing entries
        # would describe a machine that does not exist.
        return []
    source = "local: git help -a"
    rows = parse_command_list(help_text, product_version, source)

    # Flags are expensive to collect (one subprocess per command), so only the commands a
    # newcomer actually meets are expanded. `git <cmd> -h` exits 129, hence run_lenient.
    targets = subcommands if subcommands is not None else (
        "add", "commit", "push", "pull", "status", "log", "diff", "branch",
        "checkout", "switch", "merge", "rebase", "reset", "restore", "clone",
        "stash", "tag", "remote", "fetch", "show", "init",
    )
    for name in targets:
        text = run_lenient("git", name, "-h")
        if text:
            rows += parse_subcommand_flags(name, text, product_version, f"local: git {name} -h")

    if include_aliases:
        alias_text = run("git", "config", "--get-regexp", r"^alias\.")
        if alias_text.strip():
            config = Path.home() / ".gitconfig"
            rows += parse_aliases(alias_text, product_version,
                                  f"local: git config --get-regexp alias. ({portable_path(config)})")
    return rows
