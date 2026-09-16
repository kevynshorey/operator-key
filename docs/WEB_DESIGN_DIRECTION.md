# Operator Key Web Design Direction

**Status:** APPROVED

**production_approved:** true

**Installation:** The approved build was installed and end-to-end verified on 2026-09-16.

## Selected direction

The web deck combines a **Precision Console** foundation with **Calm Reference** readability. Raycast informs immediate search focus and deterministic keyboard selection; Linear informs contextual grouping and restrained information density; the Teenage Engineering OP–1 informs tactile, labeled instrument controls. These are principles, not copied layouts.

The hierarchy is promise → intent search → one dominant recommendation → three alternatives → copy. Search and the selected command remain above the fold at 1440×1000. The production direction chooser from the design lab is intentionally absent.

## Tokens

| Role | Token | Value |
|---|---|---|
| deepest graphite | `--graphite-950` | `#080b0d` |
| deck graphite | `--graphite-900` | `#111518` |
| raised panel | `--graphite-850` | `#151a1e` |
| etched border | `--etched` | `rgba(168,185,191,.22)` |
| warm instrument white | `--white` | `#f1eee5` |
| secondary steel | `--muted` | `#aeb5b6` |
| focus cyan | `--cyan` | `#31d7e8` |
| safe signal | `--green` | `#75e06f` |
| caution signal | `--amber` | `#f2b84b` |
| danger vermilion | `--red` | `#ff5d47` |

No remote fonts are required. Display copy uses the local condensed stack (`DIN Condensed`, `Roboto Condensed`, `Liberation Sans Narrow`); commands and telemetry use (`IBM Plex Mono`, `Cascadia Mono`, `DejaVu Sans Mono`); reading copy uses (`IBM Plex Sans`, `Noto Sans`). The macro spacing rhythm is 8px; etched-detail increments are 4px. Body and descriptive text is never intentionally tiny in the web composition.

## Responsive behavior

- **Desktop (≥851px):** result lane and dominant command share the workspace; telemetry stays compact; three alternatives form one row.
- **Tablet:** metadata collapses to two columns while search and the active recommendation remain primary.
- **Mobile (≤620px):** lanes stack, result cards and alternatives use one column, actions span full width, selectors stay bounded, and primary controls are at least 44px high. Keyboard hints are visually de-emphasized.
- **Large text:** the existing explicit control scales labels, result rows, telemetry, and actions without hiding filters.
- **Reduced motion:** `prefers-reduced-motion: reduce` removes the signal animation and collapses transition/animation duration.

## Capability matrix

| Capability | Web deck | Native companion |
|---|---:|---:|
| Search checked-in local catalog | Yes | Yes |
| Product/task/interface/safety filters | Yes | Yes |
| Copy selected literal command | Browser clipboard with safe fallback | Validated native bridge |
| Insert literal text | No; explicitly disabled | Guarded terminal-compatible entries only |
| Execute/send Enter | Never | Never |
| Cloud, secrets, config, terminal access | None | Existing narrow native boundary only |
| Escape / close | Clears or resets search; no Tauri call | Existing overlay close behavior |

Red entries remain copy-only in both runtimes. Web insertion always explains: “Install/open the native Operator Key companion to insert into a confirmed terminal.”

## Rollout and rollback

1. Review this branch in ordinary browser mode at 1440×1000, 390×844, large text, and reduced motion.
2. Measure task-to-copy comprehension and validate catalog relevance before approval.
3. Keep native overlay behavior isolated behind runtime detection; web-only styling is scoped to `.runtime-web`.
4. Roll back by reverting the browser-deck commit. The baseline native shell remains independently buildable and no installed binary, binding, or configuration is changed.
