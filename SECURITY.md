# Security Policy

## Status of this project

Operator Key is **not complete** and has not had an independent security review. It is
published so its design can be examined and improved. Treat it as pre-release software.

An internal audit was performed on 2026-09-21; its findings and their remediation are
recorded in `docs/AUDIT-2026-09-21.md`.

## Reporting a vulnerability

Please report suspected vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/kevynshorey/operator-key/security/advisories/new).
That channel is private and does not create a public issue.

Please do not open a public issue for a suspected vulnerability.

What helps most: the commit or release you tested, the platform, the steps to reproduce,
and what an attacker gains. A proof of concept is welcome but not required.

Expect an acknowledgement within 7 days. Fixes are prioritised by whether they cross a
trust boundary, and progress is reported on the advisory.

## What this software does and does not do

Understanding the design makes reports more useful.

**It never executes a command.** Operator Key searches, explains, copies and — on a
supported desktop — types command text into a terminal you already have focused. Pressing
Enter is always yours. There is no execution path in the codebase.

**It ships no model, no account and no credential.** Reasoning is disabled by default. If
you enable it, it talks to a model **you** run, at an address that must be on loopback. See
`docs/REASONING.md`.

**Command text is never model-authored.** A reasoning provider returns catalog IDs. The app
renders the command text from its own embedded catalog. A model cannot put a command in
front of you that the catalog does not already contain — a plan referencing an unknown ID
is rejected.

**The catalog is built from your own machine.** `scripts/build_catalog.py` reads `--help`
output from locally installed binaries. Network access is used only to check upstream
version numbers, and is optional.

## Trust boundaries worth attacking

If you are looking for where the interesting bugs would be:

| Boundary | Where | What must hold |
|---|---|---|
| Terminal insertion | `src-tauri/src/actions.rs` | Only green/amber, terminal-compatible catalog entries with no control characters; target window must be an allowlisted terminal; required binary must exist on PATH |
| Reasoning transport | `src-tauri/src/provider.rs` | Every resolved address must be loopback; no credential written to disk or into an error |
| Provider response | `src-tauri/src/intent.rs` | Closed schema, bounded strings, contiguous sequence, every ID from the supplied candidate set |
| Subprocess lifecycle | `src-tauri/src/actions.rs`, `intent.rs` | argv only, never a shell; own process group; group killed on timeout and on normal exit |
| Catalog generation | `scripts/` | Safety classification must not be downgraded by word-boundary tricks |

## Scope

In scope: the application, the catalog builder, and the installer.

Out of scope: vulnerabilities in the tools Operator Key catalogues (report those upstream),
and the security of a model server you choose to run.
