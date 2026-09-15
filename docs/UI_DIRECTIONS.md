# Operator Key UI Directions

## Reference constraint

This milestone uses behavioral references from Raycast, Alfred, and Walker/Omarchy. AI Black Magic and 21st.dev were unavailable because authentication was not available during the design pass; no output from either source is represented or implied here.

## Direction A — Instrument Console

A single graphite command surface modeled on test equipment and aircraft checklist panels. Search is the fixed upper control deck; a narrow result lane drives one dominant command readout with physical keycaps, a signal trace, safety state, context, version, provenance, and conflict telemetry.

- **Raycast reference:** one dominant action and compact alternatives establish a predictable action hierarchy.
- **Alfred reference:** large command type supports recognition and gradual shortcut learning.
- **Walker/Omarchy reference:** uninterrupted keyboard flow, dense launcher rows, and native dark-shell affinity.
- **Visual system:** instrument white on graphite, electric cyan for navigation, signal green/amber/vermilion for explicit state, etched 1px borders, square technical geometry.

## Direction B — Routing Diagram

Results appear as four product lanes connected to a central intent bus. Equivalent commands line up horizontally, making cross-agent comparison and shortcut conflicts the primary visual story.

- Strongest for conflict exploration and teaching product equivalence.
- Weaker for quick scanning because every query incurs spatial movement.
- Requires more horizontal space and has higher large-text complexity.

## Direction C — Field Manual

A typographic command manual with a large Alfred-like answer at top and a compact reference table below. Product and safety filters behave like indexed section tabs; details expand inline.

- Strongest for long descriptions and accessibility at large text sizes.
- Familiar, calm, and low motion.
- Less distinctive as an always-on-top launcher and slower for comparing alternatives.

## Decision matrix

Scores are 1 (weak) to 5 (strong).

| Criterion | Weight | A: Instrument Console | B: Routing Diagram | C: Field Manual |
| --- | ---: | ---: | ---: | ---: |
| Sub-five-second lookup | 5 | 5 | 3 | 4 |
| Keyboard continuity | 5 | 5 | 4 | 4 |
| Safety/context visibility | 5 | 5 | 4 | 4 |
| Cross-product alternatives | 3 | 4 | 5 | 3 |
| Large-text resilience | 3 | 4 | 2 | 5 |
| 1120×720 fit | 4 | 5 | 3 | 4 |
| Omarchy-native character | 3 | 5 | 4 | 3 |
| **Weighted total / 140** |  | **134** | **99** | **112** |

## Selected direction

**Direction A — Instrument Console** is selected. It makes the active recommendation readable at distance without surrendering result density, keeps safety and context in the decision path, and carries a specific industrial identity without glass, purple gradients, or generic dashboard cards. Direction B remains a useful future pattern for a dedicated conflict explorer; Direction C informs large-text behavior and long-form metadata wrapping.

## Implementation intent

- **Typography:** condensed technical display stacks for commands and headings; humanist mono for keycaps and telemetry; compact sans-serif fallback for prose. No remote font dependency.
- **Color:** `#111518` graphite, `#f1eee5` instrument white, `#31d7e8` cyan, `#75e06f` green, `#f2b84b` amber, and `#ff5d47` vermilion.
- **Spacing:** 8px base rhythm with 4px row-level increments; the result/detail split uses approximately 34/66 percent.
- **Hierarchy:** intent input → recommended chord → consequence/context → alternatives → catalog/status footer.
- **Motion:** restrained trace and selection transitions only, fully removed under `prefers-reduced-motion`.
