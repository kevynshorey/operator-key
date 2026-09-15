# Operator Key Design Intent

## Direction

Industrial instrument panel, not a generic productivity dashboard. The interface should feel like a dependable control surface: fast, legible, calm under pressure, and unmistakably keyboard-first.

## Visual language

- Background: near-black graphite, not pure black.
- Primary text: warm instrument white.
- Navigation accent: electric cyan.
- Safe action: signal green.
- Caution: amber.
- Destructive: vermilion red.
- Panels: thin etched borders with restrained depth; no glassmorphism.
- Typography: condensed technical display face for command labels, highly legible humanist mono for keys and commands, readable serif-free body face for explanations.

## Spacing rhythm

Use an 8px base with dense 4px increments inside command rows. Search and result hierarchy should be generous while the reference table may be compact. The active result must remain visually dominant from two metres away.

## Interaction hierarchy

1. The user states an intent.
2. The recommended command appears immediately.
3. Product alternatives are one Tab away.
4. Safety and active context are visible before action.
5. Enter copies; Shift+Enter inserts; execution is separately gated.

## Signature element

The result card renders the actual key chord as physical keycaps connected by a thin signal trace. When the active application changes, the trace animates to the corresponding application lane without moving the search field.

## Accessibility

- Complete keyboard operation.
- Screen-reader labels for every chord and action.
- Color never carries safety meaning alone.
- Minimum AA contrast; AAA for primary command text.
- Large-text mode and reduced-motion mode.
- No time-limited interactions.

## Inspiration principles

- Alfred/Raycast: immediate intent search and predictable keyboard navigation.
- Aircraft checklist panels: explicit state, consequence, and confirmation.
- Linear command menus: dense information without visual noise.

These are behavioral references only; the visual implementation must remain original and Omarchy-native.
