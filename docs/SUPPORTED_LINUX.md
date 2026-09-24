# Linux package compatibility policy

Operator Key's official `.deb` compatibility baseline is Ubuntu 24.04 LTS on amd64
(x86-64). Public packages are built on the pinned `ubuntu-24.04` GitHub runner,
and their main executable must not require a GLIBC symbol newer than
`GLIBC_2.39`. The Debian package must declare its WebKitGTK 4.1 and GTK 3
runtime dependencies. Do not move the release builder to a newer distribution
merely because `ubuntu-latest` changes.

Ubuntu 24.04 and Debian 13 ship `libgtk-3-0t64`, so new packages declare that
dependency explicitly. Tauri also emits the older `libgtk-3-0` name, which the
`-0t64` package provides as a versioned virtual package. The older published
v0.2.4 `.deb` declares only the older name; its actual installability on Debian
13 must be measured from the published bytes, not inferred from the package
index or from a new candidate build.

## Release gate

Before a new tag can publish packages, CI checks the **exact collected `.deb`
bytes** it is about to upload, installs them in disposable Ubuntu 24.04 and
Debian 13 containers with their normal package repositories, resolves ELF
libraries, and opens an Operator Key window as an unprivileged user under Xvfb.
The same package checks run on pull requests. A failed dependency install,
missing library, raised GLIBC floor, early exit or missing window fails the
release. The Ubuntu 26.04 build is a separate non-required forward probe, not
a reason to change the public build floor.

Debian 13 is an additional `.deb` target only when this install/launch gate is
green for the exact release candidate. A matching GLIBC number alone does not
establish that a package works there. Historical releases predate this gate;
do not retroactively describe them as install-tested without a separate run on
the published download.

## What a launch check does—and does not—prove

The headless launch verifies that the package manager can install the package,
its native executable links, and an application window appears. It does not
prove a fully rendered browser view, a physical shortcut, guarded terminal
insertion, or compatibility with every desktop. Local catalog search is the
portable core. Guarded insertion requires Wayland, Hyprland, an allowlisted
terminal and the local helpers; see the in-app readiness report. Full native
behavior still needs separate desktop verification of the published artifact.

The `.rpm` asset is built and checksummed, but **no RPM distribution is yet
certified** by the `.deb` gate. RPM installation and launch must be checked on
a named, supported RPM distribution before making an official RPM compatibility
claim; do not infer it from Ubuntu or Debian results. Other distributions and
architectures are not covered by this policy. Revisit the minimum only after an
explicit product decision, regression tests, and release-note notice.
