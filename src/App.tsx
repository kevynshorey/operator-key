import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import catalogJson from "../data/catalog.json";
import {
  INTERFACES,
  PRODUCTS,
  SAFETY_LEVELS,
  TASK_GROUPS,
  parseCatalog,
  type Catalog,
  type CatalogEntry,
  type InterfaceType,
  type Product,
  type SafetyLevel,
  type TaskGroup,
} from "./catalog";
import { createSearchIndex, parseChordQuery, searchCatalog } from "./search";
import historyJson from "../data/shortcut-history.json";
import { lookupChordHistory, parseShortcutHistory, type ShortcutMove } from "./shortcutHistory";
import { hideOverlay, type HideOverlay } from "./overlay";
import {
  lookupActiveBindings,
  UNPROBED_SHORTCUT_ENVIRONMENT,
  type ShortcutEnvironmentReport,
} from "./shortcutEnvironment";
import {
  getActionAvailability,
  readCatalogSnapshot,
  readDesktopCapabilities,
  readBuildIdentity,
  readDesktopCompatibility,
  readShortcutEnvironment,
  UNKNOWN_BUILD_IDENTITY,
  UNKNOWN_DESKTOP_CAPABILITIES,
  UNKNOWN_DESKTOP_COMPATIBILITY,
  WEB_DESKTOP_CAPABILITIES,
  type BuildIdentity,
  type DesktopCapabilities,
  type DesktopCompatibilityReport,
  type DesktopFeature,
  type DesktopMode,
  type DesktopRequirement,
  type InstallKind,
  createBrowserActions,
  nativeActions,
  type ActionAvailability,
  type OperatorActions,
} from "./actions";
import { detectRuntime, type OperatorRuntime } from "./runtime";
import {
  BROWSER_SPARK_ERROR,
  buildIntentCandidateIds,
  createBrowserIntentReasoner,
  createNativeIntentReasoner,
  mapIntentPlanEntries,
  type IntentReasoner,
  type MappedSparkRecommendation,
  type SparkIntentPlan,
  type SparkStatus,
} from "./intent";
import { createPredictionIndex, predictIntent, starterPrompts, type PredictionSuggestion } from "./predict";
import { buildFollowUps, type FollowUp, type FollowUpPriority } from "./followups";
import { buildCommandLesson, createTeachingIndex, type CommandLesson } from "./teach";
import { explainCommand, type CommandExplanation } from "./explain";
import { buildLessons, type Lesson } from "./lessons";
import { buildOnboardingPath, type OnboardingPath } from "./onboarding";
import { loadPreferences, savePreferences, type Preferences } from "./preferences";
import { NativeSettingsPanel } from "./NativeSettingsPanel";
import {
  entryVersionVerdict,
  highestLevel,
  parseFreshness,
  summarizeFreshness,
  type EntryVersionVerdict,
  type FreshnessSummary,
} from "./freshness";

const PRODUCT_LABELS: Record<Product, string> = {
  omarchy: "Omarchy",
  hermes: "Hermes",
  "claude-code": "Claude Code",
  codex: "Codex",
  git: "Git",
  gh: "GitHub CLI",
};

const TASK_LABELS: Record<TaskGroup, string> = Object.fromEntries(
  TASK_GROUPS.map((task) => [task, task.replaceAll("-", " ")]),
) as Record<TaskGroup, string>;

const PRODUCT_TABS: Array<{ value?: Product; label: string }> = [
  { label: "All systems" },
  ...PRODUCTS.map((product) => ({ value: product, label: PRODUCT_LABELS[product] })),
];

const SAFETY_LABELS: Record<SafetyLevel, { icon: string; label: string }> = {
  green: { icon: "✓", label: "Safe" },
  amber: { icon: "▲", label: "Caution" },
  red: { icon: "!", label: "Danger" },
};

interface AppProps {
  loading?: boolean;
  catalogData?: unknown;
  hideOverlay?: HideOverlay;
  actions?: OperatorActions;
  runtime?: OperatorRuntime;
  intentReasoner?: IntentReasoner;
  /** Advisory freshness report; injected in tests, read from data/freshness.json at build. */
  freshness?: unknown;
  /**
   * What the host desktop can do. Injected in tests so each case states the desktop it
   * assumes; in the real app it is probed from the native side on mount.
   */
  desktopCapabilities?: DesktopCapabilities;
  /**
   * The structured compatibility report. Injected in tests so each case states the exact
   * desktop it describes, rather than depending on the machine running the suite.
   */
  desktopCompatibility?: DesktopCompatibilityReport;
  /**
   * What this build is. Injected in tests so each case states the install it describes,
   * rather than reporting whatever machine happens to run the suite.
   */
  buildIdentity?: BuildIdentity;
  /**
   * Advisory snapshot of the live shortcut environment. Injected in tests so each case
   * states the machine it describes; in the native app it is probed once on mount.
   * Never gates anything — an unavailable probe only changes wording, never behavior.
   */
  shortcutEnvironment?: ShortcutEnvironmentReport;
}

interface ActiveIntentPlan {
  plan: SparkIntentPlan;
  recommendations: MappedSparkRecommendation[];
}

interface ActionStatus {
  kind: "status" | "alert";
  message: string;
}

function KeyChord({ entry }: { entry: CatalogEntry }) {
  const display = entry.canonical_chord || entry.command;
  const keys = entry.canonical_chord ? display.split("+") : [display];
  return (
    <div className="key-trace" aria-label={`Command chord ${display}`}>
      {keys.map((key, index) => (
        <span className="key-unit" key={`${key}-${index}`}>
          <kbd>{key}</kbd>
          {index < keys.length - 1 && <span className="trace" aria-hidden="true" />}
        </span>
      ))}
    </div>
  );
}

function ProductMark({ product }: { product: Product }) {
  return <span className={`product-mark product-${product}`} aria-hidden="true" />;
}

function ResultRow({ entry, active, position, total, disabled, onSelect, setRowRef }: {
  entry: CatalogEntry;
  active: boolean;
  position: number;
  total: number;
  disabled: boolean;
  onSelect: () => void;
  setRowRef: (entryId: string, node: HTMLLIElement | null) => void;
}) {
  const safety = SAFETY_LABELS[entry.safety_level];
  const rowRef = useCallback(
    (node: HTMLLIElement | null) => setRowRef(entry.id, node),
    [entry.id, setRowRef],
  );
  return (
    <li
      ref={rowRef}
      id={`result-${entry.id}`}
      role="option"
      aria-selected={active}
      aria-disabled={disabled}
      aria-posinset={position}
      aria-setsize={total}
      data-product={entry.product}
      className={`result-row${active ? " is-active" : ""}${entry.available ? "" : " is-unavailable"}`}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => { if (!disabled) onSelect(); }}
    >
      <ProductMark product={entry.product} />
      <span className="result-copy">
        <strong>{entry.command}</strong>
        <small>{entry.description}{!entry.available && <span className="unavailable-label"> · unavailable</span>}</small>
      </span>
      <span className={`safety-label safety-${entry.safety_level}`} aria-label={`${safety.label} safety`}>
        <span className="safety-symbol" aria-hidden="true">{safety.icon}</span>
        {safety.label}
      </span>
      <span className="result-chord">{entry.canonical_chord || entry.interface}</span>
    </li>
  );
}

function Header({ largeText, onLargeText, onClose, runtime, disabled = false, apprenticeMode, onApprenticeMode }: { largeText: boolean; onLargeText: () => void; onClose: () => void; runtime: OperatorRuntime; disabled?: boolean; apprenticeMode?: boolean; onApprenticeMode?: () => void }) {
  return (
    <header className="masthead">
      <div className="wordmark" aria-label="Operator Key">
        <span className="wordmark-index">OK—01</span>
        <span>OPERATOR KEY</span>
      </div>
      <div className="system-readout">
        <span><i className="signal-light" /> LOCAL CATALOG</span>
        <span>{runtime === "web" ? "WEB DECK · COPY ONLY" : "NO EXECUTION PATH"}</span>
        {onApprenticeMode && (
          <button
            type="button"
            className="mode-toggle"
            aria-pressed={apprenticeMode}
            disabled={disabled}
            title={apprenticeMode
              ? "Apprentice mode explains each command and expands required follow-ups."
              : "Operator mode keeps explanations collapsed."}
            onClick={onApprenticeMode}
          >
            <span aria-hidden="true">{apprenticeMode ? "◉" : "○"}</span> {apprenticeMode ? "Apprentice" : "Operator"}
          </button>
        )}
        <button type="button" className="text-mode" aria-pressed={largeText} disabled={disabled} onClick={onLargeText}>
          <span aria-hidden="true">Aa</span> Large text
        </button>
        <button type="button" className="close-overlay" aria-label={runtime === "web" ? "Reset search" : "Close Operator Key"} disabled={disabled} onClick={onClose}>
          <span aria-hidden="true">{runtime === "web" ? "↺" : "×"}</span>
        </button>
      </div>
    </header>
  );
}

function ShellState({ kind, message, onClose, runtime }: { kind: "status" | "alert"; message: string; onClose: () => void; runtime: OperatorRuntime }) {
  return (
    <main className="state-shell" data-testid="operator-shell">
      <Header runtime={runtime} largeText={false} onLargeText={() => undefined} onClose={onClose} />
      <section className="state-panel" role={kind}>
        <span className="state-code">SYSTEM / CATALOG</span>
        <h1>{message}</h1>
        <p>The interface remains isolated. No command can execute from this state.</p>
      </section>
    </main>
  );
}

function DetailCard({
  entry,
  catalog,
  availability,
  actionPending,
  onCopy,
  onInsert,
  favorite,
  onFavorite,
  versionVerdict,
}: {
  entry: CatalogEntry;
  catalog: Catalog;
  availability: ActionAvailability;
  actionPending: boolean;
  onCopy: () => void;
  onInsert: () => void;
  favorite: boolean;
  onFavorite: () => void;
  versionVerdict?: EntryVersionVerdict;
}) {
  const conflicts = catalog.conflicts.filter((conflict) => entry.conflict_ids.includes(conflict.id));
  return (
    <article className="detail-card" aria-labelledby="active-command-heading">
      <div className="detail-header">
        <span className="eyebrow">RECOMMENDED / {PRODUCT_LABELS[entry.product]}</span>
        <span className={`safety-pill safety-${entry.safety_level}`}>{entry.safety_level} · safety level</span>
      </div>
      <h2 id="active-command-heading">{entry.command}</h2>
      <p className="command-context">{PRODUCT_LABELS[entry.product]} · {entry.context}</p>
      <p className="detail-description">{entry.description.length > 180 ? `${entry.description.slice(0, 177)}…` : entry.description}</p>
      {entry.description.length > 180 && <details className="full-description"><summary>Read full description</summary><p>{entry.description}</p></details>}
      <KeyChord entry={entry} />

      <dl className="telemetry-grid">
        <div>
          <dt>Active context</dt>
          <dd>{entry.context}</dd>
        </div>
        <div>
          <dt>Interface</dt>
          <dd>{entry.interface.replaceAll("-", " ")}</dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd>{entry.product_version || catalog.versions[entry.product]}</dd>
        </div>
        <div>
          <dt>Provenance</dt>
          <dd>{entry.provenance.kind} · {entry.provenance.status} · {entry.provenance.source}</dd>
        </div>
      </dl>

      {versionVerdict && (
        <aside
          role="note"
          aria-label={versionVerdict.headline}
          className={`version-verdict version-${versionVerdict.level}`}
        >
          <span className="version-verdict-tag">{versionVerdict.headline}</span>
          <span className="version-verdict-detail">{versionVerdict.detail}</span>
        </aside>
      )}

      {conflicts.length > 0 && (
        <aside className="conflict-panel" aria-label="Binding conflict">
          <span className="conflict-icon" aria-hidden="true">!</span>
          <div>
            <strong>Binding conflict</strong>
            <p>{conflicts.map((conflict) => conflict.context).join(" · ")}</p>
          </div>
        </aside>
      )}
      {!entry.available && (
        <aside className="availability-panel">
          <strong>Unavailable in detected setup</strong>
          <span>{entry.provenance.status}</span>
        </aside>
      )}
      {availability.warning && (
        <aside className="action-warning" role="alert">
          <strong>Danger action warning</strong>
          <span>{availability.warning}</span>
        </aside>
      )}
      <section className="action-panel" aria-label="Selection actions">
        <button type="button" disabled={actionPending || !availability.copy} title={!availability.copy ? "Clipboard access is unavailable in this runtime." : undefined} onClick={onCopy}>
          Copy command <kbd>Enter</kbd>
        </button>
        <button
          type="button"
          disabled={actionPending || !availability.insert}
          aria-describedby={availability.insertReason ? "insert-disabled-reason" : undefined}
          title={availability.insertReason}
          onClick={onInsert}
        >
          Insert into confirmed terminal <kbd>Shift+Enter</kbd>
        </button>
        <button type="button" className="favorite-toggle" disabled={actionPending} aria-pressed={favorite} onClick={onFavorite}>{favorite ? "Remove favorite" : "Save favorite"}</button>
        {availability.insertReason && <p id="insert-disabled-reason">{availability.insertReason}</p>}
        <small>Insertion types literal text only. Operator Key never sends Enter or executes it.</small>
      </section>
    </article>
  );
}

function IntentStructure({ activePlan, onReturn }: { activePlan: ActiveIntentPlan; onReturn: () => void }) {
  const { plan, recommendations } = activePlan;
  return (
    <section className="intent-structure" role="region" aria-labelledby="intent-structure-heading">
      <p className="sr-only" role="status" aria-live="polite">Reasoning complete with {recommendations.length} ordered {recommendations.length === 1 ? "command" : "commands"}.</p>
      <div className="intent-structure-header">
        <div>
          <span className="eyebrow">REASONED PLAN / {plan.model}</span>
          <h2 id="intent-structure-heading">INTENT STRUCTURE</h2>
        </div>
        <button type="button" onClick={onReturn}>Return to local search</button>
      </div>
      <p className="intent-summary">{plan.summary}</p>
      <div className="intent-context">
        <div><strong>Assumptions</strong>{plan.assumptions.length ? <ul>{plan.assumptions.map((item) => <li key={item}>{item}</li>)}</ul> : <span>None stated.</span>}</div>
        <div><strong>Gaps</strong>{plan.gaps.length ? <ul>{plan.gaps.map((item) => <li key={item}>{item}</li>)}</ul> : <span>None identified.</span>}</div>
      </div>
      <ol className="intent-steps">
        {recommendations.map((recommendation) => {
          const safety = SAFETY_LABELS[recommendation.entry.safety_level];
          return (
            <li key={recommendation.entry.id}>
              <span className="step-number">{recommendation.sequence}</span>
              <div className="step-command">
                <span>{PRODUCT_LABELS[recommendation.entry.product]}</span>
                <strong>{recommendation.entry.command}</strong>
              </div>
              <div className="step-reason">
                <p>{recommendation.purpose}</p>
                <small>Input hint · {recommendation.inputHint}</small>
              </div>
              <div className="step-signals">
                <span className={`confidence confidence-${recommendation.confidence}`}>{recommendation.confidence} confidence</span>
                <span className={`safety-label safety-${recommendation.entry.safety_level}`}>{safety.icon} {safety.label}</span>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const PRIORITY_LABELS: Record<FollowUpPriority, string> = {
  required: "Required",
  recommended: "Recommended",
  optional: "Optional",
};

function LearnPanel({ lesson, entry, expanded }: { lesson: CommandLesson; entry: CatalogEntry; expanded: boolean }) {
  return (
    <section className="learn-panel" aria-labelledby="learn-panel-heading">
      <div className="lane-heading">
        <span id="learn-panel-heading">LEARN / {entry.interface.replaceAll("-", " ").toUpperCase()}</span>
        <strong>{lesson.anatomy.length.toString().padStart(2, "0")}</strong>
      </div>
      <p className="learn-headline">{lesson.headline}</p>

      <details className="learn-section" open={expanded}>
        <summary>Anatomy — what each part means</summary>
        <ol className="anatomy-list">
          {lesson.anatomy.map((token, index) => (
            <li key={`${token.text}-${index}`} className={`anatomy-token role-${token.role}`}>
              <code>{token.text}</code>
              <span className="token-role">{token.role.replaceAll("-", " ")}</span>
              <p>
                {token.explanation}
                {token.sourcedFrom && <em className="token-source"> · from the local catalog</em>}
              </p>
            </li>
          ))}
        </ol>
      </details>

      {lesson.glossary.length > 0 && (
        <details className="learn-section" open={expanded}>
          <summary>Concepts used here ({lesson.glossary.length})</summary>
          <dl className="glossary-list">
            {lesson.glossary.map((item) => (
              <div key={item.term}>
                <dt>{item.term}</dt>
                <dd>{item.definition}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}

      <div className={`safety-briefing safety-${entry.safety_level}`}>
        <strong>Safety · {entry.safety_level}</strong>
        <p>{lesson.safetyBriefing}</p>
        <p className="practice-hint">{lesson.practiceHint}</p>
      </div>
    </section>
  );
}

function NextMovesPanel({ followUps, expanded, onSelectEntry }: {
  followUps: readonly FollowUp[];
  expanded: boolean;
  onSelectEntry: (entryId: string) => void;
}) {
  if (followUps.length === 0) return null;
  return (
    <section className="next-moves" aria-labelledby="next-moves-heading">
      <div className="lane-heading">
        <span id="next-moves-heading">NEXT MOVES</span>
        <strong>{followUps.length.toString().padStart(2, "0")}</strong>
      </div>
      <p className="next-moves-intro">Running the command is one step. These are the follow-ups this command warrants.</p>
      <ul className="followup-list">
        {followUps.map((followUp) => (
          <li key={followUp.kind} className={`followup followup-${followUp.kind}`}>
            <details open={expanded && followUp.priority === "required"}>
              <summary>
                <span className={`priority-tag priority-${followUp.priority}`}>{PRIORITY_LABELS[followUp.priority]}</span>
                <strong>{followUp.title}</strong>
                <em>{followUp.question}</em>
              </summary>
              <p className="followup-rationale">{followUp.rationale}</p>
              {followUp.actions.length > 0 ? (
                <ul className="followup-actions">
                  {followUp.actions.map((action) => (
                    <li key={action.entry.id}>
                      <button type="button" onClick={() => onSelectEntry(action.entry.id)}>
                        <span>{PRODUCT_LABELS[action.entry.product]}</span>
                        <strong>{action.entry.command}</strong>
                        <small>{action.entry.description}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="followup-empty">The local catalog holds no command for this step. Handle it with your own process.</p>
              )}
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PredictionRail({ suggestions, disabled, onAccept }: {
  suggestions: readonly PredictionSuggestion[];
  disabled: boolean;
  onAccept: (completion: string) => void;
}) {
  if (suggestions.length === 0) return null;
  return (
    // A group of shortcuts, not a listbox: the search box's aria-controls already points
    // at the real result listbox, and a second options collection would confuse it.
    <div className="prediction-rail" role="group" aria-label="Predicted intent">
      <span className="prediction-hint"><kbd>TAB</kbd> accept</span>
      {suggestions.map((suggestion, index) => (
        <button
          type="button"
          key={suggestion.completion}
          className={suggestion.ghost && index === 0 ? "is-lead" : suggestion.kind === "intent" ? "is-intent" : ""}
          disabled={disabled}
          title={suggestion.kind === "intent"
            ? `Search the catalog for "${suggestion.completion}"`
            : index === 0 ? "Press Tab to accept this completion" : undefined}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onAccept(suggestion.completion)}
        >
          {suggestion.kind === "intent" && <span className="intent-marker" aria-hidden="true">≈</span>}
          {suggestion.completion}
        </button>
      ))}
    </div>
  );
}

function StarterPrompts({ prompts, disabled, onSelect }: { prompts: readonly string[]; disabled: boolean; onSelect: (prompt: string) => void }) {
  if (prompts.length === 0) return null;
  return (
    <div className="starter-prompts" aria-label="Task starters">
      <span>Start a task</span>
      {prompts.map((prompt) => (
        <button type="button" key={prompt} disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={() => onSelect(prompt)}>
          {prompt}
        </button>
      ))}
    </div>
  );
}

/**
 * Reverse lookup: the operator pastes a command they ran or saw somewhere and learns what
 * it does. Risk warnings come from the text itself, so an unknown command is still
 * assessed honestly rather than presented as harmless.
 */
function ExplainPanel({ explanation, onSelectEntry }: {
  explanation: CommandExplanation;
  onSelectEntry: (entry: CatalogEntry) => void;
}) {
  const confidenceLabel = explanation.confidence === "exact"
    ? "KNOWN COMMAND"
    : explanation.confidence === "close"
      ? "CLOSEST MATCH"
      : "NOT IN CATALOG";

  return (
    <section className="explain-panel" aria-labelledby="explain-heading">
      <header>
        <span id="explain-heading">WHAT THIS DOES</span>
        <b className={`explain-confidence is-${explanation.confidence}`}>{confidenceLabel}</b>
      </header>

      <p className="explain-input"><code>{explanation.input}</code></p>
      <p className="explain-summary">{explanation.summary}</p>

      {explanation.risks.length > 0 && (
        <div className="explain-risks" role="note">
          <h4>Before you run this</h4>
          <ul>
            {explanation.risks.map((risk) => (
              <li key={risk.title} className={`risk-${risk.severity}`}>
                <b>{risk.title}</b>
                <span>{risk.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {explanation.anatomy.length > 0 && (
        <div className="explain-anatomy">
          <h4>Piece by piece</h4>
          <ul>
            {explanation.anatomy.map((token, index) => (
              <li key={`${token.text}-${index}`}>
                <code className={`token-${token.role}`}>{token.text}</code>
                <span className="token-role">{token.role.replaceAll("-", " ")}</span>
                <span className="token-explanation">{token.explanation}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {explanation.related.length > 0 && (
        <div className="explain-related">
          <h4>Related commands in the catalog</h4>
          <div className="explain-related-list">
            {explanation.related.map((entry) => (
              <button type="button" key={entry.id} onClick={() => onSelectEntry(entry)}>
                <code>{entry.command}</code>
                <span>{entry.description}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/** The guided "first 10 minutes" route for a newcomer, built from the real catalog. */
function OnboardingPanel({ path, onSelectEntry, onClose }: {
  path: OnboardingPath;
  onSelectEntry: (entry: CatalogEntry) => void;
  onClose: () => void;
}) {
  return (
    <section className="onboarding-panel" aria-labelledby="onboarding-heading">
      <header>
        <div>
          <span id="onboarding-heading">{path.title}</span>
          <p>{path.intro}</p>
        </div>
        <button type="button" className="onboarding-close" onClick={onClose} aria-label="Close guided path">
          CLOSE
        </button>
      </header>

      <ol className="onboarding-steps">
        {path.steps.map((step, index) => (
          <li key={step.id}>
            <div className="step-index" aria-hidden="true">{index + 1}</div>
            <div className="step-body">
              <h4>{step.title}</h4>
              <p className="step-why">{step.why}</p>
              <p className="step-do"><b>Do this:</b> {step.doThis}</p>
              {step.commands.length > 0 && (
                <div className="step-commands">
                  {step.commands.map((entry) => (
                    <button type="button" key={entry.id} onClick={() => onSelectEntry(entry)}>
                      <code>{entry.command}</code>
                      <span className={`safety-dot safety-${entry.safety_level}`} aria-hidden="true" />
                      <span className="step-command-desc">{entry.description}</span>
                    </button>
                  ))}
                </div>
              )}
              <p className="step-learned"><b>You learned:</b> {step.youLearned}</p>
            </div>
          </li>
        ))}
      </ol>

      <footer>
        Nothing here runs on its own. Every command is shown so you can read it, understand
        it, and decide for yourself.
      </footer>
    </section>
  );
}

/**
 * Render lesson prose, turning `backticked` spans into real code elements.
 *
 * Lesson text is authored in the same voice as the rest of the repo, where backticks mark
 * a command. Rendering it raw prints the backtick characters on screen, which teaches a
 * newcomer that the punctuation is part of the command they are supposed to type.
 */
function LessonProse({ text }: { text: string }) {
  // Split on backtick pairs, keeping the delimiters' contents: odd indices are code.
  const parts = text.split(/`([^`]+)`/g);
  return (
    <>
      {parts.map((part, index) => (
        index % 2 === 1
          ? <code className="lesson-code" key={index}>{part}</code>
          : <span key={index}>{part}</span>
      ))}
    </>
  );
}

/**
 * The lessons panel teaches a WORKFLOW, where the onboarding route teaches a PRODUCT.
 * "Open your first pull request" crosses git and gh, so it cannot be a per-product route.
 *
 * Every command shown here was resolved from the catalog, never written into the lesson
 * text, so a lesson cannot outlive the command it teaches. Where a reference did not
 * resolve on this machine the gap is stated rather than hidden: a lesson that silently
 * drops a step reads as complete while teaching one.
 */
function LessonsPanel({ lessons, selectedId, onSelectLesson, onSelectEntry, onClose }: {
  lessons: readonly Lesson[];
  selectedId: string;
  onSelectLesson: (id: string) => void;
  onSelectEntry: (entry: CatalogEntry) => void;
  onClose: () => void;
}) {
  const lesson = lessons.find((item) => item.id === selectedId) ?? lessons[0];
  if (!lesson) return null;
  return (
    <section className="onboarding-panel lessons-panel" aria-label="Lesson">
      <header>
        <div>
          <span id="lessons-heading">{lesson.title}</span>
          <p>{lesson.summary}</p>
        </div>
        <button type="button" className="onboarding-close" onClick={onClose} aria-label="Close lessons">
          CLOSE
        </button>
      </header>

      <div className="lesson-tabs" role="tablist" aria-label="Lessons">
        {lessons.map((item) => (
          <button
            type="button"
            key={item.id}
            role="tab"
            aria-selected={item.id === lesson.id}
            className={item.id === lesson.id ? "active" : ""}
            onClick={() => onSelectLesson(item.id)}
          >
            {item.title}
          </button>
        ))}
      </div>

      <p className="lesson-audience"><b>Who this is for:</b> {lesson.audience}</p>
      {/*
        role="note" rather than status/alert: this is a standing advisory, and the app
        already uses the status live region to announce actions like "Copied".
      */}
      {!lesson.complete && (
        <p className="lesson-caveat" role="note">{lesson.caveat}</p>
      )}

      <ol className="onboarding-steps">
        {lesson.steps.map((step, index) => (
          <li key={step.id}>
            <div className="step-index" aria-hidden="true">{index + 1}</div>
            <div className="step-body">
              <h4>{step.title}</h4>
              <p className="step-why"><LessonProse text={step.explain} /></p>
              {step.commands.length > 0 && (
                <div className="step-commands">
                  {step.commands.map((entry) => (
                    <button type="button" key={entry.id} onClick={() => onSelectEntry(entry)}>
                      <code>{entry.command}</code>
                      <span className={`safety-dot safety-${entry.safety_level}`} aria-hidden="true" />
                      <span className="step-command-desc">{entry.description}</span>
                    </button>
                  ))}
                </div>
              )}
              {step.missing.length > 0 && (
                <p className="lesson-missing">
                  Not on this machine:{" "}
                  {step.missing.map((ref) => `${ref.command}`).join(", ")}. Install{" "}
                  {[...new Set(step.missing.map((ref) => ref.product))].join(" and ")} and rebuild
                  the catalog to see it here.
                </p>
              )}
              {step.watchOut && (
                <p className="step-watchout"><b>Watch out:</b> <LessonProse text={step.watchOut} /></p>
              )}
            </div>
          </li>
        ))}
      </ol>

      {/*
        Deliberately worded differently from the guided-route footer. Both panels make the
        same promise, but an existing test queries that footer by regex, and duplicated
        prose turns a single-match query into an ambiguous one the moment both render.
      */}
      <footer>
        Reading only — this panel never runs anything. Every command above was read from
        this machine&apos;s catalog, so what you see is what this computer actually has.
      </footer>
    </section>
  );
}

/**
 * Freshness is optional by design. A clone that has never run scripts/check_updates.py
 * must still build and run, and must say "never checked" rather than imply currency.
 * import.meta.glob resolves at build time and yields nothing when the file is absent.
 */
const freshnessModules = import.meta.glob<{ default: unknown }>("../data/freshness.json", {
  eager: true,
});
const freshnessData = Object.values(freshnessModules)[0]?.default;

/**
 * The shipped moved-shortcut ledger, validated once at module load. Fail-closed: a
 * malformed ledger renders NO history rather than fabricated citations. Unlike
 * freshness.json this file is tracked — it states upstream release facts, not
 * machine state — so the eager import is unconditional.
 */
const shortcutHistory = parseShortcutHistory(historyJson);

/** Display form of a canonical chord: "shift+super+a" → "SUPER + SHIFT + A". */
function displayChord(canonical: string): string {
  const rank: Record<string, number> = { super: 0, ctrl: 1, alt: 2, shift: 3 };
  const parts = canonical.split("+").filter(Boolean);
  const modifiers = parts.filter((part) => part in rank).sort((a, b) => rank[a] - rank[b]);
  const keys = parts.filter((part) => !(part in rank));
  return [...modifiers, ...keys].map((part) => part.toUpperCase()).join(" + ");
}

/**
 * Where a retired binding went. Rendered ONLY in the empty-result view: if the live
 * catalog answered, history is noise. Speaks strictly in the past tense with bounded
 * version ranges — the ledger is upstream release history, never a claim about what is
 * bound on THIS machine (that is the runtime probe's job, and until it exists the
 * catalog's).
 *
 * role="note", never status/alert (those are the transient-feedback channels), and the
 * heading is a static landmark name per the house rule: content changes, the region's
 * name does not.
 */
function ShortcutHistoryPanel({ moves }: { moves: readonly ShortcutMove[] }) {
  if (moves.length === 0) return null;
  return (
    <aside className="history-panel" role="note" aria-label="Shortcut history">
      <span className="state-code">SHORTCUT HISTORY / ADVISORY</span>
      {moves.map((move) => (
        <div className="history-move" key={`${move.product}:${move.old_chord}:${move.current_chord}`}>
          <p>
            <strong>{move.description}</strong> is no longer on <code>{displayChord(move.old_chord)}</code>.
            Upstream {PRODUCT_LABELS[move.product]} moved it to <code>{displayChord(move.current_chord)}</code> —
            last shipped on the old chord in {move.last_version_with_old}, moved as of {move.first_version_with_new}.
            Historical record from the catalog ledger, not a probe of this machine.
          </p>
          <ul className="history-sources">
            {move.sources.map((url) => (
              <li key={url}>
                <a href={url} target="_blank" rel="noopener noreferrer">{url.replace("https://github.com/", "")}</a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </aside>
  );
}

/** What the verdict strip may say about one chord on this machine. */
interface ChordVerdict {
  state: "active" | "absent" | "unverifiable";
  chord: string;
  reason: string;
  bindings: readonly { chord: string; description: string; dispatcher: string }[];
}

/**
 * Local-machine verdict for a chord query. Advisory `role="note"` like every other
 * standing panel — never a live region, never a gate. The three states carry three
 * grades of certainty and the wording must not blur them:
 *   active       — the probe SAW this chord bound here; name what it does.
 *   absent       — the probe answered and this chord was not in the DETECTED set.
 *                  Detected, not universal: submaps and per-device layers exist,
 *                  so "not active in the detected binding set", never "impossible".
 *   unverifiable — no probe answer at all; say only that, plus the fixed reason.
 */
function ChordVerdictStrip({ verdict, keyboard }: {
  verdict: ChordVerdict;
  keyboard: { layouts: readonly string[]; activeKeymap: string | null };
}) {
  return (
    <aside className="verdict-strip" role="note" aria-label="Local binding check" data-verdict={verdict.state}>
      <span className="state-code">LOCAL BINDING CHECK / ADVISORY</span>
      {verdict.state === "active" && (
        <p>
          <code>{displayChord(verdict.chord)}</code> is active on this machine
          {verdict.bindings.length === 1
            ? <> as <strong>{verdict.bindings[0].description || verdict.bindings[0].dispatcher}</strong></>
            : <> with {verdict.bindings.length} bindings: {verdict.bindings.map((binding, index) => (
                <span key={`${binding.description}:${binding.dispatcher}:${index}`}>
                  {index > 0 ? ", " : ""}<strong>{binding.description || binding.dispatcher}</strong>
                </span>
              ))}</>}
          {keyboard.activeKeymap ? <> · keyboard: {keyboard.activeKeymap}</> : null}
        </p>
      )}
      {verdict.state === "absent" && (
        <p>
          <code>{displayChord(verdict.chord)}</code> is not active in the detected binding set on this machine.
          The probe reads top-level Hyprland binds only — submap or per-device layers are not checked.
        </p>
      )}
      {verdict.state === "unverifiable" && (
        <p>
          Can&apos;t verify local bindings for <code>{displayChord(verdict.chord)}</code>.
          {verdict.reason ? <> {verdict.reason}.</> : null} The catalog answer is unaffected.
        </p>
      )}
    </aside>
  );
}

/**
 * Tells the operator how far the catalog can be trusted right now.
 *
 * Deliberately not dismissible for the "attention" tier: a catalog that no longer matches
 * the installed tools undermines every command on screen, and a banner you can wave away
 * is one you will wave away.
 *
 * Always `role="note"`, never `alert` or `status`. Those are the app's channels for
 * transient, action-triggered feedback ("Copied", "clipboard unavailable"). A standing
 * advisory sitting in one steals announcements from real actions, makes "the status"
 * ambiguous, and answers every other surface's alert query — which is exactly what
 * happened when the attention tier claimed `alert`: five unrelated tests broke the moment
 * a real freshness report existed on disk. CI never caught it, because the report is
 * gitignored machine state and absent on a runner.
 */
function FreshnessBanner({ summary }: { summary: FreshnessSummary }) {
  const level = highestLevel(summary);
  if (level === "none") return null;

  return (
    <section
      className={`freshness-banner freshness-${level}`}
      role="note"
      aria-label="Catalog freshness"
    >
      <div className="freshness-head">
        <span className="freshness-tag">{level === "attention" ? "CHECK" : "NOTE"}</span>
        <span className="freshness-meta">
          {summary.neverChecked
            ? "never checked for updates"
            : summary.daysSinceCheck === 0
              ? "checked today"
              : `checked ${summary.daysSinceCheck}d ago`}
        </span>
      </div>
      <ul className="freshness-notices">
        {summary.notices.map((notice) => (
          <li key={notice.headline} className={`freshness-${notice.level}`}>
            <b>{notice.headline}</b>
            <span>{notice.detail}</span>
          </li>
        ))}
      </ul>
      <p className="freshness-foot">
        This comes from a separate offline check, not from the app. Nothing here changes a
        command or how it is classified.
      </p>
    </section>
  );
}

/**
 * Say how much of Operator Key this desktop runs, and exactly what is missing.
 *
 * Mode wording is deliberately non-alarming: a Wayland desktop that cannot insert is
 * "Partly supported", not broken, because search and copy genuinely work there.
 */
const DESKTOP_MODE_SUMMARY: Record<DesktopMode, string> = {
  supported: "Fully supported: search, copy, and guarded terminal insertion are available.",
  degraded: "Partly supported: search works, and some desktop actions need the prerequisites below.",
  unsupported: "Search and learning work. Desktop actions need the prerequisites below.",
};

const DESKTOP_FEATURE_LABEL: Record<DesktopFeature, string> = {
  search: "Local catalog search",
  copy: "Native copy",
  insert: "Terminal insertion",
};

/** List what the operator must add before an unavailable feature can work. */
function DesktopPrerequisites({ requirements }: { requirements: DesktopRequirement[] }) {
  const unmet = requirements.filter((item) => !item.met && item.unmetPrerequisites.length > 0);
  if (!unmet.length) return null;
  return (
    <div className="desktop-prerequisites">
      {unmet.map((item) => (
        <div key={item.feature}>
          <h3>To enable {DESKTOP_FEATURE_LABEL[item.feature].toLowerCase()}, install or switch to:</h3>
          <ul>{item.unmetPrerequisites.map((prerequisite) => <li key={prerequisite}>{prerequisite}</li>)}</ul>
        </div>
      ))}
    </div>
  );
}

/**
 * Point a native operator at the reviewed shortcut installer.
 *
 * Deliberately read-only guidance. Compositor configuration is changed only by the
 * installer, in a terminal, after the operator types an exact confirmation phrase — so
 * this section shows the command rather than offering a button that would bypass that
 * gate. It also cannot know whether the shortcut is already installed, so it never
 * claims a state: it describes the preview step, which changes nothing.
 */
function GlobalShortcutSetup() {
  return (
    <section className="shortcut-setup" aria-label="Global shortcut">
      <h2>Global shortcut</h2>
      <p>
        To open Operator Key with a keyboard shortcut on Hyprland, run the installer from a
        terminal in a checkout of the project repository. Operator Key does not change your
        desktop configuration by itself.
      </p>
      <p className="shortcut-command"><code>python3 scripts/install-omarchy-binding.py</code></p>
      <p>
        That is the preview step and it is read-only: it prints the exact shortcut, the
        config block, a backup path and a rollback plan without editing anything. Re-run it
        with <code>--apply</code> to install, which asks you to type a confirmation phrase
        first.
      </p>
      <p>
        The installer is not part of the .deb and .rpm packages. If you use a package
        build, get it and the full walkthrough in <code>docs/INSTALL.md</code> from the
        repository at <code>github.com/kevynshorey/operator-key</code>, then run the
        command above from that directory.
      </p>
    </section>
  );
}

/**
 * What to do to get a newer version, phrased for how this copy actually arrived.
 *
 * Keyed by install kind because the routes genuinely differ: a packaged install is the
 * package manager's business, a hand-copied binary is downloaded again, a build tree is
 * rebuilt. `unknown` maps to nothing at all — no instruction beats a confident wrong one
 * that sends someone to a package manager that never installed this.
 */
const UPGRADE_ROUTE: Record<InstallKind, string | undefined> = {
  systemPackage: "Installed by a package manager. Upgrade it the same way you installed it.",
  userBinary: "Installed by hand. Download the current release and replace the binary.",
  developmentBuild: "Running from a build tree. Rebuild to pick up newer code.",
  unknown: undefined,
};

/**
 * State what this build is, so the app answers the question it asks of every command.
 *
 * Operator Key marks a catalogued command whose tool version is not the installed one,
 * while saying nothing about itself — the gap that let an installed 0.2.2 sit unnoticed
 * beside a published 0.2.3. Deliberately carries no filesystem path: this panel is what
 * someone screenshots into a bug report.
 */
function BuildIdentityPanel({ identity }: { identity: BuildIdentity }) {
  const route = UPGRADE_ROUTE[identity.installKind];

  return (
    <section className="build-identity" aria-label="This build">
      <h2>This build</h2>
      <dl>
        <div>
          <dt>Version: </dt>
          <dd>{identity.version || "Unknown"}</dd>
        </div>
      </dl>
      {route && <p>{route}</p>}
    </section>
  );
}

export default function App({ loading = false, catalogData: injectedCatalogData, hideOverlay: injectedHideOverlay, actions: injectedActions, runtime: injectedRuntime, intentReasoner: injectedIntentReasoner, freshness: injectedFreshness = freshnessData, desktopCapabilities: injectedDesktopCapabilities, desktopCompatibility: injectedDesktopCompatibility, buildIdentity: injectedBuildIdentity, shortcutEnvironment: injectedShortcutEnvironment }: AppProps) {
  const [preferences, setPreferences] = useState<Preferences>(() => loadPreferences());
  useEffect(() => { savePreferences(preferences); }, [preferences]);
  // The native side may have applied an operator's sidecar catalog. Until it answers, the
  // build-time import stands; both sides must agree on command text or every action fails
  // the native mismatch check.
  const [nativeCatalog, setNativeCatalog] = useState<unknown | undefined>(undefined);
  const catalogData = injectedCatalogData ?? catalogJson;
  const parsed = useMemo(() => parseCatalog(nativeCatalog ?? catalogData), [nativeCatalog, catalogData]);
  const searchIndex = useMemo(
    () => parsed.ok ? createSearchIndex(parsed.catalog.entries) : undefined,
    [parsed],
  );
  const predictionIndex = useMemo(
    () => parsed.ok ? createPredictionIndex(parsed.catalog.entries) : undefined,
    [parsed],
  );
  const teachingIndex = useMemo(
    () => parsed.ok ? createTeachingIndex(parsed.catalog.entries) : undefined,
    [parsed],
  );
  const [query, setQuery] = useState("");
  const [settledQuery, setSettledQuery] = useState("");
  const [product, setProduct] = useState<Product>();
  const [interfaceType, setInterfaceType] = useState<InterfaceType>();
  const [task, setTask] = useState<TaskGroup>();
  const [safety, setSafety] = useState<SafetyLevel>();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pinnedEntryId, setPinnedEntryId] = useState<string>();
  const [explainPasted, setExplainPasted] = useState(false);
  const [actionStatus, setActionStatus] = useState<ActionStatus>();
  const [actionPending, setActionPending] = useState(false);
  const largeText = preferences.largeText;
  const apprenticeMode = preferences.apprenticeMode;
  const [view, setView] = useState<"find" | "learn" | "settings">("find");
  const recentCopies = preferences.recentCopies;
  const historyEnabled = preferences.historyEnabled;
  const favorites = preferences.favorites;
  const [learnSection, setLearnSection] = useState<"workflows" | "products">("workflows");
  const toggleFavorite = (entry: CatalogEntry) => setPreferences((p) => {
    const exists = p.favorites.some((item) => item.product === entry.product && item.command === entry.command);
    return { ...p, favorites: exists ? p.favorites.filter((item) => item.product !== entry.product || item.command !== entry.command) : [...p.favorites, { product: entry.product, command: entry.command }].slice(-200) };
  });
  const [showGuide, setShowGuide] = useState(false);
  const [guideProduct, setGuideProduct] = useState<Product>("hermes");
  const [showLessons, setShowLessons] = useState(false);
  const [lessonId, setLessonId] = useState("git-first-save");

  // Advisory only: this never gates or alters a catalog entry, it just tells the operator
  // how much to trust what they are looking at.
  const freshnessReport = useMemo(() => parseFreshness(injectedFreshness), [injectedFreshness]);
  const freshnessSummary = useMemo(
    () => summarizeFreshness(freshnessReport),
    [freshnessReport],
  );
  const [sparkStatus, setSparkStatus] = useState<SparkStatus>();
  const [sparkStatusPending, setSparkStatusPending] = useState(true);
  const [reasoningPending, setReasoningPending] = useState(false);
  const [activePlan, setActivePlan] = useState<ActiveIntentPlan>();
  const [reasoningError, setReasoningError] = useState<string>();
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const reasoningSettingsRef = useRef<HTMLElement | null>(null);
  const resultRefs = useRef(new Map<string, HTMLLIElement>());
  const runtime = injectedRuntime ?? detectRuntime();
  const dismissOverlay = injectedHideOverlay ?? hideOverlay;
  const operatorActions = injectedActions ?? (runtime === "native" ? nativeActions : createBrowserActions());
  // What this desktop can actually do. Unknown until the native side answers, so the
  // affected controls start disabled rather than promising an action that would fail.
  const [desktopCapabilities, setDesktopCapabilities] = useState<DesktopCapabilities>(
    injectedDesktopCapabilities ?? (runtime === "native" ? UNKNOWN_DESKTOP_CAPABILITIES : WEB_DESKTOP_CAPABILITIES),
  );
  // The actionable companion to the capability probe: what is missing and how to fix it.
  const [desktopCompatibility, setDesktopCompatibility] = useState<DesktopCompatibilityReport>(
    injectedDesktopCompatibility ?? UNKNOWN_DESKTOP_COMPATIBILITY,
  );
  const defaultIntentReasoner = useMemo(
    () => runtime === "native" ? createNativeIntentReasoner() : createBrowserIntentReasoner(),
    [runtime],
  );
  const intentReasoner = injectedIntentReasoner ?? defaultIntentReasoner;
  const controlsLocked = actionPending || reasoningPending;
  const clearReasoning = useCallback(() => {
    setActivePlan(undefined);
    setReasoningError(undefined);
  }, []);
  const setResultRef = useCallback((entryId: string, node: HTMLLIElement | null) => {
    if (node) resultRefs.current.set(entryId, node);
    else resultRefs.current.delete(entryId);
  }, []);

  useEffect(() => {
    if (runtime !== "native" || injectedDesktopCapabilities) return;
    let current = true;
    void readDesktopCapabilities().then((capabilities) => {
      if (current) setDesktopCapabilities(capabilities);
    });
    return () => { current = false; };
  }, [runtime, injectedDesktopCapabilities]);

  const [buildIdentity, setBuildIdentity] = useState<BuildIdentity>(
    injectedBuildIdentity ?? UNKNOWN_BUILD_IDENTITY,
  );

  // Live shortcut environment: probed once on native mount, injected in tests, and
  // honestly UNPROBED everywhere else (web builds, older native companions).
  const [shortcutEnvironment, setShortcutEnvironment] = useState<ShortcutEnvironmentReport>(
    injectedShortcutEnvironment ?? UNPROBED_SHORTCUT_ENVIRONMENT,
  );

  useEffect(() => {
    if (runtime !== "native" || injectedShortcutEnvironment) return;
    let current = true;
    void readShortcutEnvironment().then((report) => {
      if (current) setShortcutEnvironment(report);
    });
    return () => { current = false; };
  }, [runtime, injectedShortcutEnvironment]);

  useEffect(() => {
    if (runtime !== "native" || injectedBuildIdentity) return;
    let current = true;
    void readBuildIdentity().then((identity) => {
      if (current) setBuildIdentity(identity);
    });
    return () => { current = false; };
  }, [runtime, injectedBuildIdentity]);

  useEffect(() => {
    if (runtime !== "native" || injectedDesktopCompatibility) return;
    let current = true;
    void readDesktopCompatibility().then((report) => {
      if (current) setDesktopCompatibility(report);
    });
    return () => { current = false; };
  }, [runtime, injectedDesktopCompatibility]);

  useEffect(() => {
    // Tests inject `catalogData` directly and must not be overwritten by a native answer.
    if (runtime !== "native" || injectedCatalogData !== undefined) return;
    let current = true;
    void readCatalogSnapshot().then((snapshot) => {
      if (current && snapshot) setNativeCatalog(snapshot);
    });
    return () => { current = false; };
  }, [runtime, injectedCatalogData]);

  useEffect(() => {
    if (loading || !parsed.ok) return;
    let current = true;
    void intentReasoner.status()
      .then((status) => { if (current) setSparkStatus(status); })
      .catch((error: unknown) => {
        if (current) setSparkStatus({ available: false, loggedIn: false, model: "", provider: "disabled", configPath: "", message: `Reasoning status unavailable: ${error instanceof Error ? error.message : String(error)}` });
      })
      .finally(() => { if (current) setSparkStatusPending(false); });
    return () => { current = false; };
  }, [intentReasoner, loading, parsed]);

  useEffect(() => {
    const timeout = window.setTimeout(() => setSettledQuery(query), 120);
    return () => window.clearTimeout(timeout);
  }, [query]);

  const liveResults = useMemo(() => {
    if (!searchIndex) return [];
    return searchCatalog(searchIndex, task && query === TASK_LABELS[task] ? "" : query, { product, interface: interfaceType, task, safety }, 50);
  }, [searchIndex, query, product, interfaceType, task, safety]);
  const results = useMemo(() => {
    if (!searchIndex) return [];
    return searchCatalog(searchIndex, task && settledQuery === TASK_LABELS[task] ? "" : settledQuery, { product, interface: interfaceType, task, safety }, 50);
  }, [searchIndex, settledQuery, product, interfaceType, task, safety]);
  const displayedResults = useMemo(() => {
    const rows = activePlan
      ? activePlan.recommendations.map(({ entry }) => ({ entry, score: 0, matchedTerms: [], unavailable: !entry.available }))
      : results;
    if (!pinnedEntryId) return rows;
    const index = rows.findIndex(({ entry }) => entry.id === pinnedEntryId);
    return index > 0 ? [rows[index], ...rows.slice(0, index), ...rows.slice(index + 1)] : rows;
  }, [activePlan, results, pinnedEntryId]);
  const boundedIndex = Math.min(selectedIndex, Math.max(0, displayedResults.length - 1));
  const selected = displayedResults[boundedIndex]?.entry;
  const actionSelection = activePlan ? selected : query === settledQuery ? selected : liveResults[0]?.entry;

  // Forwarding address for a retired chord. The EMPTY-RESULT render branch is the
  // boundary that keeps history away from live results; this memo's results/plan
  // guards just skip ledger work while the operator is typing toward a real match.
  // Prose queries have no chord to look up, and the product filter narrows the
  // ledger the same way it narrows search.
  const historyMoves = useMemo(() => {
    if (!shortcutHistory || activePlan || results.length > 0) return [];
    const chord = parseChordQuery(settledQuery);
    if (!chord) return [];
    return lookupChordHistory(shortcutHistory, chord, product);
  }, [activePlan, results, settledQuery, product]);

  /**
   * Keyboard-aware verdict for a chord-shaped query: what THIS machine says about
   * the chord, independent of what the catalog ships. Three honest states —
   * active-here (with the local binding names), absent-from-detected-set, or
   * cannot-verify (probe unavailable). Advisory only; null for non-chord queries.
   */
  const chordVerdict = useMemo(() => {
    if (activePlan) return null;
    const chord = parseChordQuery(settledQuery);
    if (!chord) return null;
    if (shortcutEnvironment.status !== "ok") {
      return {
        state: "unverifiable" as const,
        chord,
        reason: shortcutEnvironment.unavailableReason ?? "",
        bindings: [] as readonly { chord: string; description: string; dispatcher: string }[],
      };
    }
    const bindings = lookupActiveBindings(shortcutEnvironment, chord);
    return bindings.length > 0
      ? { state: "active" as const, chord, reason: "", bindings }
      : { state: "absent" as const, chord, reason: "", bindings };
  }, [activePlan, settledQuery, shortcutEnvironment]);

  const predictions = useMemo(
    () => predictionIndex && !activePlan ? predictIntent(predictionIndex, query, 5) : [],
    [predictionIndex, query, activePlan],
  );
  const ghost = predictions.find((item) => item.ghost.length > 0)?.ghost ?? "";
  const ghostCompletion = predictions.find((item) => item.ghost.length > 0)?.completion ?? "";
  const starters = useMemo(
    () => predictionIndex && !query.trim() && !product && !interfaceType && !task && !safety ? starterPrompts(predictionIndex, 5) : [],
    [predictionIndex, query, product, interfaceType, task, safety],
  );
  const lesson = useMemo(
    () => teachingIndex && selected ? buildCommandLesson(teachingIndex, selected) : undefined,
    [teachingIndex, selected],
  );
  const followUps = useMemo(
    () => searchIndex && selected ? buildFollowUps(searchIndex, selected) : [],
    [searchIndex, selected],
  );

  // Reverse lookup only engages for text that actually looks like a command the operator
  // ran or pasted — not for the plain-English intent the search box is normally used for.
  // "review my code" is three lowercase words and must NOT be treated as a command, so
  // bare word sequences do not qualify: there has to be real shell or CLI syntax.
  const explanation = useMemo(() => {
    if (!searchIndex || (!apprenticeMode && !explainPasted)) return undefined;
    const text = query.trim();
    if (text.length < 2) return undefined;
    const looksLikeCommand = /^[$#>]\s/.test(text)          // copied shell prompt
      || /^[/-]/.test(text)                                  // slash command or flag
      || /[|;]|&&|>>|\s>\s/.test(text)                       // shell plumbing
      || /\s-{1,2}[a-z]/i.test(text)                         // a flag argument
      || /[~/]\w|\.\w{2,4}\b/.test(text)                     // a path or filename
      || /^(sudo|git|npm|npx|docker|curl|wget|chmod|chown|rm|ls|cd|cat|grep|tar|ssh|kill|make|python3?|node|systemctl)\b/i.test(text);
    if (!looksLikeCommand && !explainPasted) return undefined;
    return explainCommand(searchIndex, text) ?? undefined;
  }, [searchIndex, query, apprenticeMode, explainPasted]);

  const onboardingPath = useMemo(
    () => searchIndex && showGuide ? buildOnboardingPath(searchIndex, guideProduct) : undefined,
    [searchIndex, showGuide, guideProduct],
  );

  // Lessons resolve against the catalog, so they are rebuilt only when it changes.
  const lessons = useMemo(
    () => parsed.ok ? buildLessons(parsed.catalog.entries) : [],
    [parsed],
  );

  const acceptPrediction = useCallback((completion: string) => {
    setQuery(completion);
    setSelectedIndex(0);
    setActionStatus(undefined);
  }, []);

  const acceptStarter = useCallback((completion: string) => {
    const selectedTask = TASK_GROUPS.find((candidate) => TASK_LABELS[candidate] === completion);
    if (!selectedTask) return;
    setTask(selectedTask);
    setQuery(completion);
    setSelectedIndex(0);
    setActionStatus(undefined);
    searchInputRef.current?.focus();
  }, []);

  const selectEntryById = useCallback((entryId: string) => {
    const target = parsed.ok ? parsed.catalog.entries.find((item) => item.id === entryId) : undefined;
    if (!target) return;
    setView("find"); setShowLessons(false); setShowGuide(false);
    setProduct(target.product); setInterfaceType(undefined); setTask(undefined); setSafety(undefined);
    setActivePlan(undefined); setReasoningError(undefined); setExplainPasted(false);
    setQuery(target.command); setSelectedIndex(0); setActionStatus(undefined); setPinnedEntryId(target.id);
  }, [parsed]);

  useEffect(() => {
    const handleGlobalKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (controlsLocked) return;
      event.preventDefault();
      if (runtime === "web") {
        setQuery("");
        setSelectedIndex(0);
        setActionStatus(undefined);
        clearReasoning();
        setView("find");
      } else {
        void dismissOverlay();
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [clearReasoning, controlsLocked, dismissOverlay, runtime]);

  useEffect(() => {
    if (!selected) return;
    const row = resultRefs.current.get(selected.id);
    const list = row?.parentElement;
    if (!row || !list) return;
    const rowBounds = row.getBoundingClientRect();
    const listBounds = list.getBoundingClientRect();
    if (rowBounds.top < listBounds.top) list.scrollTop -= listBounds.top - rowBounds.top;
    else if (rowBounds.bottom > listBounds.bottom) list.scrollTop += rowBounds.bottom - listBounds.bottom;
  }, [selected, displayedResults]);

  if (loading) return <ShellState runtime={runtime} kind="status" message="Loading command catalog…" onClose={() => { if (runtime === "native") void dismissOverlay(); }} />;
  if (!parsed.ok) return <ShellState runtime={runtime} kind="alert" message={parsed.error} onClose={() => { if (runtime === "native") void dismissOverlay(); }} />;

  const selectProduct = (value?: Product) => {
    if (controlsLocked) return;
    setProduct(value);
    setSelectedIndex(0);
    setActionStatus(undefined);
    clearReasoning();
  };

  const actionErrorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

  const reasonAboutIntent = async () => {
    const intent = query.trim();
    if (!intent || controlsLocked || runtime !== "native" || sparkStatusPending || !sparkStatus?.available || !sparkStatus.loggedIn) return;
    setReasoningPending(true);
    setReasoningError(undefined);
    setActivePlan(undefined);
    setActionStatus(undefined);
    try {
      const candidateIds = buildIntentCandidateIds(
        parsed.catalog.entries,
        intent,
        { product, interface: interfaceType, task, safety },
        liveResults,
      );
      const plan = await intentReasoner.reason(intent, candidateIds);
      const mapped = mapIntentPlanEntries(plan, parsed.catalog.entries);
      if (!mapped.ok) {
        setReasoningError(`The model returned ${mapped.error.code === "unknown-entry-id" ? "an unknown" : "a duplicate"} catalog ID “${mapped.error.entryId}”. No plan was activated.`);
        return;
      }
      setActivePlan({ plan, recommendations: mapped.recommendations });
      setSelectedIndex(0);
    } catch (error) {
      setReasoningError(`Reasoning failed: ${actionErrorMessage(error)}`);
    } finally {
      setReasoningPending(false);
    }
  };

  const copySelected = async () => {
    if (!actionSelection || controlsLocked) return;
    const availability = getActionAvailability(actionSelection, runtime, desktopCapabilities);
    if (!availability.copy) {
      setActionStatus({ kind: "status", message: "Clipboard access is unavailable in this runtime." });
      return;
    }
    setActionPending(true);
    try {
      await operatorActions.copy(actionSelection);
      setActionStatus({ kind: "status", message: `Copied “${actionSelection.command}” to the clipboard.` });
      if (historyEnabled) setPreferences((p) => ({ ...p, recentCopies: [{ product: actionSelection.product, command: actionSelection.command }, ...p.recentCopies.filter((item) => item.product !== actionSelection.product || item.command !== actionSelection.command)].slice(0, 20) }));
    } catch (error) {
      setActionStatus({ kind: "alert", message: `Copy failed: ${actionErrorMessage(error)}` });
    } finally {
      setActionPending(false);
    }
  };

  const insertSelected = async () => {
    if (!actionSelection || controlsLocked) return;
    const availability = getActionAvailability(actionSelection, runtime, desktopCapabilities);
    if (!availability.insert) {
      setActionStatus({ kind: "status", message: availability.insertReason ?? "Terminal insertion is unavailable." });
      return;
    }
    setActionPending(true);
    try {
      await operatorActions.insert(actionSelection);
      setActionStatus({ kind: "status", message: `Inserted “${actionSelection.command}” without executing it.` });
    } catch (error) {
      setActionStatus({ kind: "alert", message: `Insert failed: ${actionErrorMessage(error)}` });
    } finally {
      setActionPending(false);
    }
  };

  const handleSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (controlsLocked) return;
    const input = event.currentTarget;
    const atEndOfInput = input.selectionStart === query.length && input.selectionEnd === query.length;

    if (event.key === "Tab" && ghost && !event.shiftKey) {
      event.preventDefault();
      acceptPrediction(ghostCompletion);
      return;
    }
    if (event.key === "ArrowRight" && ghost && atEndOfInput) {
      event.preventDefault();
      acceptPrediction(ghostCompletion);
      return;
    }
    if (event.key === "ArrowDown" && displayedResults.length) {
      event.preventDefault();
      setSelectedIndex((boundedIndex + 1) % displayedResults.length);
    } else if (event.key === "ArrowUp" && displayedResults.length) {
      event.preventDefault();
      setSelectedIndex((boundedIndex - 1 + displayedResults.length) % displayedResults.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (event.altKey) {
        void reasonAboutIntent();
      } else if (event.ctrlKey || event.metaKey) {
        setActionStatus({ kind: "status", message: "Execution is disabled. Ctrl+Enter performs no action." });
      } else if (event.shiftKey) {
        void insertSelected();
      } else {
        void copySelected();
      }
    }
  };

  const handleProductKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (controlsLocked) return;
    let target: number;
    if (event.key === "ArrowRight") target = (index + 1) % PRODUCT_TABS.length;
    else if (event.key === "ArrowLeft") target = (index - 1 + PRODUCT_TABS.length) % PRODUCT_TABS.length;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = PRODUCT_TABS.length - 1;
    else return;
    event.preventDefault();
    selectProduct(PRODUCT_TABS[target].value);
    tabRefs.current[target]?.focus();
  };

  const alternatives = displayedResults.filter((_, index) => index !== boundedIndex).slice(0, 3);
  const sparkUnavailableReason = runtime === "web"
    ? BROWSER_SPARK_ERROR
    : sparkStatusPending
      ? "Checking reasoning status…"
      : sparkStatus?.message ?? "Reasoning status unavailable.";
  const sparkDisabled = runtime !== "native" || !query.trim() || controlsLocked || sparkStatusPending || !sparkStatus?.available || !sparkStatus.loggedIn;
  const reasoningStatusMessage = reasoningPending ? "Reasoning in progress…" : sparkUnavailableReason;
  const configureReasoning = () => {
    setView("settings");
    window.setTimeout(() => {
      reasoningSettingsRef.current?.focus();
      reasoningSettingsRef.current?.scrollIntoView?.({ block: "start" });
    }, 0);
  };

  return (
    <main className={`operator-shell runtime-${runtime}${largeText ? " large-text" : ""}${query.trim() ? " has-query" : ""}${view !== "find" ? ` view-${view}` : ""}`} data-testid="operator-shell">
      <Header runtime={runtime} largeText={largeText} disabled={controlsLocked} apprenticeMode={apprenticeMode} onApprenticeMode={() => setPreferences((value) => ({ ...value, apprenticeMode: !value.apprenticeMode }))} onLargeText={() => setPreferences((value) => ({ ...value, largeText: !value.largeText }))} onClose={() => {
        if (runtime === "native") void dismissOverlay();
        else { if (controlsLocked) return; setQuery(""); setProduct(undefined); setInterfaceType(undefined); setTask(undefined); setSafety(undefined); setSelectedIndex(0); setActionStatus(undefined); clearReasoning(); setView("find"); }
      }} />

      <nav className="primary-nav" aria-label="Primary navigation">{([ ["find", "Find"], ["learn", "Learn"], ["settings", "Settings"] ] as const).map(([key, label]) => <button type="button" key={key} aria-current={view === key ? "page" : undefined} onClick={() => { setView(key); if (key === "learn") { setShowLessons(true); setShowGuide(false); } }}>{label}</button>)}</nav>
      {view === "learn" && <div className="learn-switch" role="tablist" aria-label="Learning library"><button role="tab" aria-selected={learnSection === "workflows"} onClick={() => setLearnSection("workflows")}>Workflow lessons</button><button role="tab" aria-selected={learnSection === "products"} onClick={() => setLearnSection("products")}>Product guides</button></div>}
      {view === "learn" && learnSection === "products" && <div className="product-guide-library" aria-label="Product guides">{PRODUCT_TABS.filter((tab) => tab.value).map((tab) => <button type="button" key={tab.label} onClick={() => { setGuideProduct(tab.value!); setShowGuide(true); setShowLessons(false); }}>{`First 10 minutes: ${tab.label}`}</button>)}</div>}
      {view === "settings" && <section className="settings-panel" aria-label="Settings">
        <h1>Settings</h1><p>Preferences stay on this device. No command is executed.</p>
        <label><input type="checkbox" checked={largeText} onChange={(event) => setPreferences((p) => ({ ...p, largeText: event.target.checked }))} /> Large text</label>
        <label><input type="checkbox" checked={apprenticeMode} onChange={(event) => setPreferences((p) => ({ ...p, apprenticeMode: event.target.checked }))} /> Explain commands</label>
        <label><input type="checkbox" checked={historyEnabled} onChange={(event) => setPreferences((p) => ({ ...p, historyEnabled: event.target.checked, recentCopies: event.target.checked ? p.recentCopies : [] }))} /> Keep local history of successful copies (off by default)</label>
        <button type="button" onClick={() => setPreferences((p) => ({ ...p, recentCopies: [] }))} disabled={!recentCopies.length}>Clear copy history</button><p>{recentCopies.length} recent copies saved locally.</p>
        {runtime === "native" && <GlobalShortcutSetup />}{runtime === "native" && <BuildIdentityPanel identity={buildIdentity} />}<section className="desktop-readiness" aria-label="Desktop readiness"><h2>Desktop readiness</h2><dl>
          <div><dt>Local catalog search: </dt><dd>Available</dd></div>
          {runtime === "web" ? <><div><dt>Browser copy: </dt><dd>Permission-dependent</dd></div><div><dt>Terminal insertion: </dt><dd>Unsupported</dd></div></> : <><div><dt>Native copy: </dt><dd>{desktopCapabilities.canCopy ? "Ready" : "Needs setup"}</dd></div><div><dt>Terminal insertion: </dt><dd>{desktopCapabilities.canCopy && desktopCapabilities.canInsert ? "Ready" : "Needs setup"}</dd></div></>}
        </dl>{runtime === "native" && <><p>{DESKTOP_MODE_SUMMARY[desktopCompatibility.mode]}</p><DesktopPrerequisites requirements={desktopCompatibility.requirements} /><p>Native copy requires Wayland and wl-copy. Terminal insertion requires Hyprland and wtype.</p></>}<p>Availability does not confirm that an operation succeeded. Operator Key does not press Enter and no command is executed.</p></section>
        <h2>Reasoning status</h2><p>{sparkStatusPending ? "Checking reasoning capability…" : sparkStatus?.message ?? "Reasoning status unavailable."}</p>
        {sparkStatus?.provider === "codex" && <p>Provider disclosure: Codex may contact its configured remote provider; review that provider's privacy terms.</p>}
        {sparkStatus?.provider === "opencode" && <p>Provider disclosure: OpenCode sends the entered intent and bounded command fields to OpenAI through your signed-in OpenCode account. Do not enter secrets or sensitive text you would not send to OpenAI.</p>}
        {(sparkStatus?.provider === "ollama" || sparkStatus?.provider === "openai-compatible") && <p>Provider disclosure: The configured local-compatible service may itself forward requests. Use a service you trust.</p>}
        <NativeSettingsPanel focusRef={reasoningSettingsRef} runtime={runtime} testCandidateId={parsed.catalog.entries.find((entry) => entry.available && entry.safety_level === "green" && entry.interface === "shell-command")?.id} onChanged={() => { setActivePlan(undefined); setReasoningError(undefined); setSparkStatusPending(true); void intentReasoner.status().then(setSparkStatus).catch((error: unknown) => setSparkStatus({ available: false, loggedIn: false, model: "", provider: "disabled", configPath: "", message: `Reasoning status unavailable: ${error instanceof Error ? error.message : String(error)}` })).finally(() => setSparkStatusPending(false)); }} />
      </section>}


      {view === "find" && (favorites.length > 0 || (historyEnabled && recentCopies.length > 0)) && <div className="quick-library" aria-label="Saved commands">
        {([["Favorites", favorites], ["Recent copies", historyEnabled ? recentCopies : []]] as const).map(([title, items]) => items.length > 0 && <details key={title}><summary>{title} <span>{items.length}</span></summary><div>{items.map((item) => {
          const target = parsed.catalog.entries.find((entry) => entry.product === item.product && entry.command === item.command);
          return <button type="button" key={`${item.product}:${item.command}`} disabled={!target || controlsLocked} onClick={() => target && selectEntryById(target.id)}>{item.command} <small>{PRODUCT_LABELS[item.product as Product] ?? item.product}{!target ? " · no longer in catalog" : ""}</small></button>;
        })}</div></details>)}
      </div>}
      <section className="search-deck" aria-label="Command search controls">
        <label className="search-field">
          <span className="search-index">DESCRIBE OUTCOME /</span>
          <span className="sr-only">Operator intent</span>
          <span className="input-stack">
            <input
              ref={searchInputRef}
              autoFocus
              type="search"
              role="searchbox"
              aria-label="Operator intent"
              aria-controls="result-list"
              aria-activedescendant={selected ? `result-${selected.id}` : undefined}
              aria-describedby={ghost ? "intent-ghost" : undefined}
              autoComplete="off"
              value={query}
              disabled={controlsLocked}
              placeholder="What do you want to do?"
              onChange={(event) => {
                if (!controlsLocked) {
                  setQuery(event.target.value);
                  setExplainPasted(false); setPinnedEntryId(undefined); setSelectedIndex(0);
                  setActionStatus(undefined);
                  clearReasoning();
                }
              }}
              onKeyDown={handleSearchKey}
            />
            {ghost && (
              <span className="ghost-text" aria-hidden="true">
                <span className="ghost-typed">{query}</span>
                <span className="ghost-completion">{ghost}</span>
              </span>
            )}
          </span>
          {ghost && <span id="intent-ghost" className="sr-only" aria-live="polite">Suggested completion: {ghostCompletion}. Press Tab to accept.</span>}
          <kbd className="escape-key">ESC</kbd>
        </label>
        <FreshnessBanner summary={freshnessSummary} />
        <PredictionRail suggestions={predictions} disabled={controlsLocked} onAccept={acceptPrediction} />
        <StarterPrompts prompts={starters} disabled={controlsLocked} onSelect={acceptStarter} />
        {apprenticeMode && !showGuide && !showLessons && (
          <div className="guide-invite lessons-invite">
            <span>Never used git or GitHub? Learn the workflow, not just the commands.</span>
            <div className="guide-invite-actions">
              {lessons.map((lesson) => (
                <button
                  type="button"
                  key={lesson.id}
                  disabled={controlsLocked}
                  onClick={() => { setLessonId(lesson.id); setShowLessons(true); }}
                >
                  {lesson.title}
                </button>
              ))}
            </div>
          </div>
        )}
        {apprenticeMode && !showGuide && !showLessons && (
          <div className="guide-invite">
            <span>New to this? Take the guided route instead of searching.</span>
            <div className="guide-invite-actions">
              {PRODUCT_TABS.filter((tab) => tab.value).map((tab) => (
                <button
                  type="button"
                  key={tab.label}
                  disabled={controlsLocked}
                  onClick={() => { setGuideProduct(tab.value as Product); setShowGuide(true); }}
                >
                  First 10 minutes: {tab.label}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="intent-composer-actions">
          <button type="button" className="explain-paste-button" onClick={() => { setExplainPasted(true); }} disabled={controlsLocked || query.trim().length < 2}>Explain pasted command</button>
          <button type="button" className="spark-button" aria-label="Reason about this intent" aria-describedby="reasoning-availability" disabled={sparkDisabled} onClick={() => { void reasonAboutIntent(); }}>
            <span aria-hidden="true">✦</span> {reasoningPending ? "Reasoning…" : "Reason"} <kbd>ALT+ENTER</kbd>
          </button>
          {runtime === "native" && !sparkStatusPending && sparkStatus?.provider === "disabled" && <button type="button" className="configure-reasoning" onClick={configureReasoning}>Configure reasoning</button>}
          <div className="spark-copy">
            {sparkStatus?.provider === "codex" && <p>Reasoning sends the entered intent and bounded command fields shown in the local catalog through local Codex; never source paths, provenance, files, secrets, terminal contents, or history.</p>}
            {sparkStatus?.provider === "opencode" && <p>Reasoning sends the entered intent and bounded command fields shown in the local catalog to OpenAI through the signed-in OpenCode account; never source paths, provenance, files, secrets, terminal contents, or history.</p>}
            {(sparkStatus?.provider === "ollama" || sparkStatus?.provider === "openai-compatible") && <p>Reasoning sends the entered intent and bounded command fields shown in the local catalog to your configured service; never source paths, provenance, files, secrets, terminal contents, or history.</p>}
            <small id="reasoning-availability" aria-live="polite" aria-atomic="true" className={!reasoningPending && sparkStatus?.available && sparkStatus.loggedIn && runtime === "native" ? "spark-ready" : ""}>{reasoningStatusMessage}</small>
          </div>
          {reasoningError && <p className="spark-error" role="alert">{reasoningError}</p>}
        </div>

        <div className="product-tabs" role="radiogroup" aria-label="Product lanes" data-scroll-affordance="horizontal">
          {PRODUCT_TABS.map((tab, index) => {
            const active = product === tab.value;
            const count = tab.value ? parsed.catalog.counts[tab.value] : parsed.catalog.total;
            return (
              <button
                type="button"
                role="radio"
                aria-checked={active}
                disabled={controlsLocked}
                tabIndex={active ? 0 : -1}
                key={tab.label}
                ref={(node) => { tabRefs.current[index] = node; }}
                onClick={() => selectProduct(tab.value)}
                onKeyDown={(event) => handleProductKey(event, index)}
              >
                {tab.value && <ProductMark product={tab.value} />}
                {tab.label}<span>{count}</span>
              </button>
            );
          })}
        </div>

        <div className="control-rail">
          <div className="task-chips" aria-label="Task filters" data-scroll-affordance="horizontal">
            <button type="button" disabled={controlsLocked} className={!task ? "is-active" : ""} aria-pressed={!task} onClick={() => { if (!controlsLocked) { setTask(undefined); setSelectedIndex(0); clearReasoning(); } }}>Any task</button>
            {TASK_GROUPS.map((taskName) => (
              <button type="button" disabled={controlsLocked} key={taskName} className={task === taskName ? "is-active" : ""} aria-pressed={task === taskName} onClick={() => { if (!controlsLocked) { setTask(task === taskName ? undefined : taskName); setSelectedIndex(0); clearReasoning(); } }}>
                {TASK_LABELS[taskName]}
              </button>
            ))}
          </div>
          <div className="select-filters">
            <label>Interface
              <select disabled={controlsLocked} aria-label="Interface filter" value={interfaceType ?? ""} onChange={(event) => { if (!controlsLocked) { setInterfaceType((event.target.value || undefined) as InterfaceType | undefined); setSelectedIndex(0); clearReasoning(); } }}>
                <option role="presentation" value="">All</option>
                {INTERFACES.map((item) => <option role="presentation" key={item} value={item}>{item.replaceAll("-", " ")}</option>)}
              </select>
            </label>
            <label>Safety
              <select disabled={controlsLocked} aria-label="Safety filter" value={safety ?? ""} onChange={(event) => { if (!controlsLocked) { setSafety((event.target.value || undefined) as SafetyLevel | undefined); setSelectedIndex(0); clearReasoning(); } }}>
                <option role="presentation" value="">All</option>
                {SAFETY_LEVELS.map((item) => <option role="presentation" key={item} value={item}>{item}</option>)}
              </select>
            </label>
          </div>
        </div>
      </section>

      {view === "learn" && learnSection === "workflows" && showLessons && lessons.length > 0 && (
        <LessonsPanel
          lessons={lessons}
          selectedId={lessonId}
          onSelectLesson={setLessonId}
          onSelectEntry={(entry) => { selectEntryById(entry.id); }}
          onClose={() => { setShowLessons(false); setView("find"); }}
        />
      )}

      {view === "learn" && learnSection === "products" && onboardingPath && (
        <OnboardingPanel
          path={onboardingPath}
          onSelectEntry={(entry) => { selectEntryById(entry.id); setShowGuide(false); }}
          onClose={() => setShowGuide(false)}
        />
      )}

      {/* Reverse lookup sits above results: when someone pastes a command they ran, the
          explanation IS the answer, and it must appear even if search finds nothing. */}
      {explanation && !showGuide && (
        <ExplainPanel explanation={explanation} onSelectEntry={(entry) => selectEntryById(entry.id)} />
      )}

      {displayedResults.length === 0 ? (
        <>
          {/* The advisory stack leads: for a retired chord the ledger IS the answer, so
              it stays first and above the fold at the 820x560 minimum; the local
              verdict is glanceable confirmation beneath it. Both sit OUTSIDE the
              role="status" live region — a standing advisory read from inside it
              would be announced as transient status and hijack that channel. */}
          <ShortcutHistoryPanel moves={historyMoves} />
          {chordVerdict && <ChordVerdictStrip verdict={chordVerdict} keyboard={shortcutEnvironment.keyboard} />}
          <section className="empty-panel" role="status">
            <span className="state-code">SEARCH / 000</span>
            <h2>No matching command</h2>
            <p>Every term must map to a command, alias, task, description, or product. Clear a filter or try fewer words.</p>
            <button type="button" disabled={controlsLocked} onClick={() => { if (!controlsLocked) { setQuery(""); setProduct(undefined); setInterfaceType(undefined); setTask(undefined); setSafety(undefined); clearReasoning(); } }}>Reset search plane</button>
          </section>
        </>
      ) : (
        <>
        {chordVerdict && <ChordVerdictStrip verdict={chordVerdict} keyboard={shortcutEnvironment.keyboard} />}
        <section className="workspace-grid">
          <section className="command-stage">
            <div className="command-scroll">
              {activePlan && <IntentStructure activePlan={activePlan} onReturn={() => { setActivePlan(undefined); setSelectedIndex(0); setReasoningError(undefined); }} />}
              {selected && (
                <DetailCard
                  entry={selected}
                  favorite={favorites.some((item) => item.product === selected.product && item.command === selected.command)}
                  onFavorite={() => toggleFavorite(selected)}
                  catalog={parsed.catalog}
                  availability={getActionAvailability(selected, runtime, desktopCapabilities)}
                  actionPending={controlsLocked}
                  onCopy={() => { void copySelected(); }}
                  onInsert={() => { void insertSelected(); }}
                  versionVerdict={entryVersionVerdict(selected.product, selected.product_version, freshnessReport)}
                />
              )}
              {selected && lesson && <LearnPanel lesson={lesson} entry={selected} expanded={apprenticeMode} />}
              {selected && <NextMovesPanel followUps={followUps} expanded={apprenticeMode} onSelectEntry={selectEntryById} />}
            </div>
            <section className="alternatives" aria-label="Alternatives">
              <div className="lane-heading"><span>{activePlan ? "NEXT STEPS" : "ALTERNATIVES"}</span><strong>{alternatives.length.toString().padStart(2, "0")}</strong></div>
              <div className="alternative-grid">
                {alternatives.map(({ entry }, index) => (
                  <button type="button" disabled={controlsLocked} key={entry.id} onClick={() => { if (!controlsLocked) setSelectedIndex(displayedResults.findIndex((result) => result.entry.id === entry.id)); }}>
                    <span>{PRODUCT_LABELS[entry.product]}</span>
                    <strong>{entry.command}</strong>
                    <small>{entry.context}</small>
                    <em>{index + 1}</em>
                  </button>
                ))}
              </div>
            </section>
          </section>

          <aside className="result-lane" aria-label={activePlan ? "Recommended commands" : "Search results"}>
            <div className="lane-heading"><span>{activePlan ? "REASONED PLAN" : "LOCAL MATCH"}</span><strong>{displayedResults.length.toString().padStart(2, "0")}</strong></div>
            <ul id="result-list" role="listbox" aria-label="Command results" aria-busy={controlsLocked}>
              {displayedResults.map(({ entry }, index) => (
                <ResultRow
                  key={entry.id}
                  entry={entry}
                  active={index === boundedIndex}
                  position={index + 1}
                  total={displayedResults.length}
                  disabled={controlsLocked}
                  onSelect={() => { if (!controlsLocked) setSelectedIndex(index); }}
                  setRowRef={setResultRef}
                />
              ))}
            </ul>
          </aside>
        </section>
        </>
      )}

      {actionStatus && <div className={`action-status action-${actionStatus.kind}`} role={actionStatus.kind}>{actionStatus.message}</div>}
      <footer className="status-footer">
        <span>{parsed.catalog.total.toLocaleString()} commands ready</span>
        <span><b>{displayedResults.length}</b> shown</span>
        <span><kbd>↑</kbd><kbd>↓</kbd> select</span>
        <span><kbd>TAB</kbd> · COMPLETE</span>
        <span><kbd>ENTER</kbd> · COPY</span>
        <span>{runtime === "native" ? <><kbd>SHIFT+ENTER</kbd> · GUARDED INSERT</> : "LOCAL-ONLY · COPY-ONLY"}</span>
        <span className="execution-lock">{runtime === "native" ? "● EXECUTION DISABLED" : "● NATIVE COMPANION REQUIRED FOR INSERTION"}</span>
      </footer>
    </main>
  );
}
