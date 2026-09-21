"""GitHub CLI (`gh`) local command and flag adapter.

Catalogued from `gh --help` and `gh <group> --help` on this machine. As with git, safety
is classified from what each command DOES rather than from words in its description: the
generic classifier rates `gh pr merge` green (its text says "Merge a pull request") and
`gh pr create` green, though both publish irreversibly to a shared remote.

Nothing here reads credentials. `gh auth token` is catalogued as a command that exists --
it is never run, and the catalog never contains a token.
"""
from __future__ import annotations

import re

from .common import clean, entry, run


def normalise_flag(raw: str) -> str:
    """Render a gh flag the way every other adapter renders flags.

    gh prints `-c, --clone`; git prints `-f, --force`. The git adapter already rewrites
    the comma to ` / `, so leaving gh's spelling alone would make the same concept render
    two different ways inside one catalog and split search results between them.
    """
    flag = clean(raw).strip()
    flag = re.sub(r"\s*[\[(<][^\[\](){}<>]*[\])>]\s*$", "", flag)
    flag = flag.replace(",", " /")
    return re.sub(r"\s+", " ", flag).strip()

# Publishes to a shared remote, deletes, or changes account state. Never appropriate for
# an onboarding route to auto-suggest.
RED_COMMANDS: dict[str, str] = {
    "repo delete": "Permanently deletes the repository on GitHub for everyone.",
    "repo archive": "Makes the repository read-only for all collaborators.",
    "repo rename": "Changes the repository URL; existing clones and links break.",
    "auth logout": "Removes stored credentials; you must authenticate again to continue.",
    "auth token": "Prints a live access token to the terminal, where it can be captured.",
    "secret delete": "Removes a secret that running workflows may depend on.",
    "release delete": "Deletes a published release and its assets.",
    "gist delete": "Permanently deletes a gist.",
    "ssh-key delete": "Removes an SSH key; access using that key stops working.",
    "gpg-key delete": "Removes a GPG key used to verify signed commits.",
    "variable delete": "Removes an Actions variable workflows may depend on.",
    "label delete": "Deletes a label from the repository.",
    "cache delete": "Deletes Actions caches, slowing subsequent runs.",
}

# Writes to GitHub or changes local configuration. Real consequences, reversible.
AMBER_COMMANDS: dict[str, str] = {
    "auth login": "Authenticates this machine to a GitHub account.",
    "auth refresh": "Changes the scopes stored for this machine's credentials.",
    "auth switch": "Changes which account subsequent commands act as.",
    "auth setup-git": "Changes git's credential configuration.",
    "repo create": "Creates a new repository on GitHub, public or private as chosen.",
    "repo fork": "Creates a copy of the repository under your account.",
    "repo clone": "Downloads a repository into a new local directory.",
    "repo edit": "Changes repository settings, including visibility.",
    "repo sync": "Updates a repository from its upstream, and can overwrite commits.",
    "repo set-default": "Changes which repository gh commands target here.",
    "repo unarchive": "Returns an archived repository to writable state.",
    "pr create": "Opens a pull request; reviewers are notified and the branch becomes visible.",
    "pr merge": "Merges the pull request into the base branch for everyone.",
    "pr close": "Closes the pull request without merging.",
    "pr reopen": "Reopens a previously closed pull request.",
    "pr edit": "Changes the pull request's title, body, or labels.",
    "pr comment": "Posts a public comment on the pull request.",
    "pr review": "Submits a review, which can approve or block a merge.",
    "pr ready": "Marks a draft pull request ready and requests review.",
    "pr revert": "Creates a pull request undoing a merged one.",
    "pr checkout": "Switches your working tree to the pull request's branch.",
    "pr update-branch": "Updates the pull request branch from its base.",
    "pr lock": "Prevents further comments on the pull request.",
    "pr unlock": "Re-enables comments on the pull request.",
    "issue create": "Opens a new issue, notifying watchers.",
    "issue close": "Closes the issue.",
    "issue reopen": "Reopens the issue.",
    "issue edit": "Changes the issue's fields.",
    "issue comment": "Posts a public comment on the issue.",
    "issue pin": "Pins the issue to the repository's issue list.",
    "issue unpin": "Unpins the issue.",
    "issue transfer": "Moves the issue to a different repository.",
    "issue develop": "Creates a linked branch for the issue.",
    "release create": "Publishes a release, which users may download immediately.",
    "release edit": "Changes a published release.",
    "release upload": "Adds assets to a published release.",
    "gist create": "Publishes a gist; public gists are visible to anyone.",
    "gist edit": "Changes an existing gist.",
    "secret set": "Stores a secret for Actions workflows.",
    "variable set": "Sets an Actions variable.",
    "label create": "Adds a label to the repository.",
    "label edit": "Changes an existing label.",
    "label clone": "Copies labels from another repository.",
    "workflow run": "Triggers a workflow run, which executes code on GitHub.",
    "workflow enable": "Allows a workflow to run again.",
    "workflow disable": "Stops a workflow from running.",
    "run cancel": "Stops an in-progress workflow run.",
    "run rerun": "Starts a workflow run again.",
    "run delete": "Deletes a workflow run's history.",
    "run watch": "Follows a run until it finishes.",
    "extension install": "Installs third-party code that gh will execute.",
    "extension remove": "Uninstalls a gh extension.",
    "extension upgrade": "Updates installed extension code.",
    "extension create": "Scaffolds a new extension.",
    "alias set": "Defines a gh shortcut that runs other commands.",
    "alias delete": "Removes a gh shortcut.",
    "config set": "Changes gh's configuration.",
    "ssh-key add": "Adds an SSH key granting access to your account.",
    "gpg-key add": "Adds a GPG signing key to your account.",
    "api": "Makes an arbitrary authenticated API request, including writes.",
    "codespace delete": "Deletes a codespace and any uncommitted work in it.",
    "codespace create": "Creates a billable cloud development environment.",
    "attestation verify": "Verifies an artifact attestation.",
}

# Read-only. Safe to demonstrate to a newcomer.
GREEN_COMMANDS: frozenset[str] = frozenset({
    "auth status", "repo list", "repo view", "pr list", "pr status", "pr view",
    "pr diff", "pr checks", "issue list", "issue status", "issue view",
    "release list", "release view", "release download", "gist list", "gist view",
    "run list", "run view", "workflow list", "workflow view", "label list",
    "secret list", "variable list", "search", "status", "browse", "config get",
    "config list", "alias list", "extension list", "ssh-key list", "gpg-key list",
    "org list", "ruleset list", "ruleset view", "cache list", "licenses",
    "repo gitignore", "repo license", "api --method GET",
})

# Stated rather than inferred: `classify` files most gh commands under
# help-and-reference because their one-line descriptions read like documentation.
GROUP_TASKS: dict[str, str] = {
    "auth": "configuration",
    "config": "configuration",
    "alias": "configuration",
    "extension": "configuration",
    "ssh-key": "configuration",
    "gpg-key": "configuration",
    "secret": "configuration",
    "variable": "configuration",
    "repo": "development",
    "gist": "development",
    "codespace": "development",
    "pr": "review-and-verify",
    "issue": "review-and-verify",
    "project": "review-and-verify",
    "release": "development",
    "run": "debug-and-recover",
    "workflow": "development",
    "cache": "configuration",
    "label": "configuration",
    "ruleset": "configuration",
    "org": "help-and-reference",
    "search": "help-and-reference",
}
READ_ONLY_LEAVES = frozenset({"list", "view", "status", "diff", "checks", "browse"})


def task_group(path: str) -> str:
    """Return the catalog task group for a gh command path like 'pr merge'."""
    parts = path.split()
    group = parts[0] if parts else ""
    leaf = parts[-1] if parts else ""
    if group in {"", "api", "browse", "status", "licenses", "attestation", "copilot",
                 "agent-task", "completion", "preview", "discussion"}:
        return "help-and-reference" if leaf in READ_ONLY_LEAVES or not parts else "development"
    return GROUP_TASKS.get(group, "development")


GROUPS = (
    "auth", "repo", "pr", "issue", "release", "gist", "run", "workflow",
    "label", "secret", "variable", "alias", "config", "extension", "ssh-key",
    "gpg-key", "org", "ruleset", "cache", "search", "project", "codespace",
)

# Section headings in `gh <group> --help` that introduce subcommand lists.
COMMAND_SECTION = re.compile(
    r"^(CORE COMMANDS|GENERAL COMMANDS|TARGETED COMMANDS|AVAILABLE COMMANDS|"
    r"ADDITIONAL COMMANDS|GITHUB ACTIONS COMMANDS|COMMANDS)\s*$"
)
OTHER_SECTION = re.compile(r"^[A-Z][A-Z /]+$")


def version(binary: str = "gh") -> str:
    """Read the installed gh version, or 'unknown' when gh is absent."""
    text = run(binary, "--version").strip()
    match = re.search(r"gh version ([^\s]+)", text)
    if match:
        return match.group(1)
    return text.splitlines()[0] if text else "unknown"


def classify(path: str) -> tuple[str, bool]:
    """Return (safety_level, destructive) for a gh command path like 'pr merge'."""
    if path in RED_COMMANDS:
        return "red", True
    if path in GREEN_COMMANDS:
        return "green", False
    if path in AMBER_COMMANDS:
        return "amber", False
    leaf = path.split()[-1] if path.split() else ""
    if leaf in {"delete", "remove", "destroy"}:
        return "red", True
    if leaf in {"list", "view", "status", "diff", "checks", "browse"}:
        return "green", False
    # Unassessed commands are not assumed safe.
    return "amber", False


def safety_note(path: str) -> str:
    return RED_COMMANDS.get(path) or AMBER_COMMANDS.get(path) or ""


def parse_group(group: str, text: str, product_version: str, source: str) -> list[dict]:
    """Parse `gh <group> --help` into subcommand entries."""
    rows: list[dict] = []
    in_commands = False
    heading = ""
    seen: set[str] = set()
    for raw in text.splitlines():
        stripped = raw.strip()
        if COMMAND_SECTION.match(stripped):
            in_commands, heading = True, stripped.title()
            continue
        if stripped and OTHER_SECTION.match(stripped) and not COMMAND_SECTION.match(stripped):
            in_commands = False
            continue
        if not in_commands or not stripped:
            continue
        match = re.match(r"^([a-z][\w-]*):\s+(.+)$", stripped)
        if not match:
            continue
        name, description = match.group(1), clean(match.group(2))
        path = f"{group} {name}".strip() if group else name
        if path in seen or not description:
            continue
        seen.add(path)
        level, destructive = classify(path)
        note = safety_note(path)
        rows.append(entry(
            "gh", "shell-command", f"gh {path}",
            f"{description}. {note}".strip() if note else description,
            source, product_version, context="Shell", category=heading or "Commands",
            safety_override=(level, destructive), task_override=task_group(path),
        ))
    return rows


def parse_flags(path: str, text: str, product_version: str, source: str) -> list[dict]:
    """Parse the FLAGS section of `gh <command> --help`."""
    rows: list[dict] = []
    in_flags = False
    seen: set[str] = set()
    level, destructive = classify(path)
    for raw in text.splitlines():
        stripped = raw.strip()
        if stripped == "FLAGS":
            in_flags = True
            continue
        if stripped in {"INHERITED FLAGS", "EXAMPLES", "LEARN MORE", "ARGUMENTS", "JSON FIELDS"}:
            in_flags = False
            continue
        if not in_flags or not stripped:
            continue
        match = re.match(r"^((?:-\w, )?--[\w-]+)(?:\s+[\w<>\[\]|.\"']+)?\s{2,}(.+)$", stripped)
        if not match:
            continue
        flag, description = normalise_flag(match.group(1)), clean(match.group(2))
        if not description or flag in seen:
            continue
        seen.add(flag)
        flag_level, flag_destructive = level, destructive
        if flag in {"--yes", "-y"} or "confirm" in description.lower():
            # A flag that skips confirmation is at least as dangerous as its command.
            flag_level, flag_destructive = ("red", True) if destructive else ("amber", False)
        rows.append(entry(
            "gh", "cli-flag", f"gh {path} {flag}", description, source, product_version,
            context=f"gh {path} invocation", category=f"gh {path}",
            safety_override=(flag_level, flag_destructive), task_override=task_group(path),
        ))
    return rows


def collect(product_version: str, *, groups: tuple[str, ...] | None = None,
            flag_commands: tuple[str, ...] | None = None) -> list[dict]:
    """Collect gh entries from the installed binary."""
    root = run("gh", "--help")
    if not root:
        return []
    rows = parse_group("", root, product_version, "local: gh --help")

    for group in (groups if groups is not None else GROUPS):
        text = run("gh", group, "--help")
        if text:
            rows += parse_group(group, text, product_version, f"local: gh {group} --help")

    # Flags only for the commands a first-PR walkthrough actually uses.
    for path in (flag_commands if flag_commands is not None else (
        "repo create", "repo clone", "repo view", "pr create", "pr list",
        "pr view", "pr merge", "pr checkout", "issue create", "issue list",
        "auth login", "auth status",
    )):
        text = run("gh", *path.split(), "--help")
        if text:
            rows += parse_flags(path, text, product_version, f"local: gh {path} --help")
    return rows
