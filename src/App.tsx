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
import { createSearchIndex, searchCatalog } from "./search";
import { hideOverlay, type HideOverlay } from "./overlay";
import {
  getActionAvailability,
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
import { buildOnboardingPath, type OnboardingPath } from "./onboarding";
import {
  highestLevel,
  parseFreshness,
  summarizeFreshness,
  type FreshnessSummary,
} from "./freshness";

const PRODUCT_LABELS: Record<Product, string> = {
  omarchy: "Omarchy",
  hermes: "Hermes",
  "claude-code": "Claude Code",
  codex: "Codex",
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
}: {
  entry: CatalogEntry;
  catalog: Catalog;
  availability: ActionAvailability;
  actionPending: boolean;
  onCopy: () => void;
  onInsert: () => void;
}) {
  const conflicts = catalog.conflicts.filter((conflict) => entry.conflict_ids.includes(conflict.id));
  return (
    <article className="detail-card" aria-labelledby="active-command-heading">
      <div className="detail-header">
        <span className="eyebrow">RECOMMENDED / {PRODUCT_LABELS[entry.product]}</span>
        <span className={`safety-pill safety-${entry.safety_level}`}>{entry.safety_level} · safety level</span>
      </div>
      <h2 id="active-command-heading">{entry.command}</h2>
      <p className="detail-description">{entry.description}</p>
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
        <button type="button" disabled={actionPending} onClick={onCopy}>
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
      <p className="sr-only" role="status" aria-live="polite">Luna reasoning complete with {recommendations.length} ordered {recommendations.length === 1 ? "command" : "commands"}.</p>
      <div className="intent-structure-header">
        <div>
          <span className="eyebrow">LUNA STRUCTURE / {plan.model}</span>
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
    <div className="starter-prompts" aria-label="Try one of these">
      <span>New here? Try</span>
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
 * Freshness is optional by design. A clone that has never run scripts/check_updates.py
 * must still build and run, and must say "never checked" rather than imply currency.
 * import.meta.glob resolves at build time and yields nothing when the file is absent.
 */
const freshnessModules = import.meta.glob<{ default: unknown }>("../data/freshness.json", {
  eager: true,
});
const freshnessData = Object.values(freshnessModules)[0]?.default;

/**
 * Tells the operator how far the catalog can be trusted right now.
 *
 * Deliberately not dismissible for the "attention" tier: a catalog that no longer matches
 * the installed tools undermines every command on screen, and a banner you can wave away
 * is one you will wave away.
 *
 * Only the attention tier claims a live region. `role="status"` is already the app's
 * channel for action feedback ("Copied"), and a standing advisory sitting in that channel
 * both steals announcements from real actions and makes "the status" ambiguous.
 */
function FreshnessBanner({ summary }: { summary: FreshnessSummary }) {
  const level = highestLevel(summary);
  if (level === "none") return null;

  return (
    <section
      className={`freshness-banner freshness-${level}`}
      role={level === "attention" ? "alert" : "note"}
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

export default function App({ loading = false, catalogData = catalogJson, hideOverlay: injectedHideOverlay, actions: injectedActions, runtime: injectedRuntime, intentReasoner: injectedIntentReasoner, freshness: injectedFreshness = freshnessData }: AppProps) {
  const parsed = useMemo(() => parseCatalog(catalogData), [catalogData]);
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
  const [actionStatus, setActionStatus] = useState<ActionStatus>();
  const [actionPending, setActionPending] = useState(false);
  const [largeText, setLargeText] = useState(false);
  const [apprenticeMode, setApprenticeMode] = useState(true);
  const [showGuide, setShowGuide] = useState(false);
  const [guideProduct, setGuideProduct] = useState<Product>("hermes");

  // Advisory only: this never gates or alters a catalog entry, it just tells the operator
  // how much to trust what they are looking at.
  const freshnessSummary = useMemo(
    () => summarizeFreshness(parseFreshness(injectedFreshness)),
    [injectedFreshness],
  );
  const [sparkStatus, setSparkStatus] = useState<SparkStatus>();
  const [sparkStatusPending, setSparkStatusPending] = useState(true);
  const [reasoningPending, setReasoningPending] = useState(false);
  const [activePlan, setActivePlan] = useState<ActiveIntentPlan>();
  const [reasoningError, setReasoningError] = useState<string>();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const resultRefs = useRef(new Map<string, HTMLLIElement>());
  const runtime = injectedRuntime ?? detectRuntime();
  const dismissOverlay = injectedHideOverlay ?? hideOverlay;
  const operatorActions = injectedActions ?? (runtime === "native" ? nativeActions : createBrowserActions());
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
    if (loading || !parsed.ok) return;
    let current = true;
    void intentReasoner.status()
      .then((status) => { if (current) setSparkStatus(status); })
      .catch((error: unknown) => {
        if (current) setSparkStatus({ available: false, loggedIn: false, model: "gpt-5.6-luna", message: `Luna status unavailable: ${error instanceof Error ? error.message : String(error)}` });
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
    return searchCatalog(searchIndex, query, { product, interface: interfaceType, task, safety }, 50);
  }, [searchIndex, query, product, interfaceType, task, safety]);
  const results = useMemo(() => {
    if (!searchIndex) return [];
    return searchCatalog(searchIndex, settledQuery, { product, interface: interfaceType, task, safety }, 50);
  }, [searchIndex, settledQuery, product, interfaceType, task, safety]);
  const displayedResults = useMemo(() => activePlan
    ? activePlan.recommendations.map(({ entry }) => ({ entry, score: 0, matchedTerms: [], unavailable: !entry.available }))
    : results, [activePlan, results]);
  const boundedIndex = Math.min(selectedIndex, Math.max(0, displayedResults.length - 1));
  const selected = displayedResults[boundedIndex]?.entry;
  const actionSelection = activePlan ? selected : query === settledQuery ? selected : liveResults[0]?.entry;

  const predictions = useMemo(
    () => predictionIndex && !activePlan ? predictIntent(predictionIndex, query, 5) : [],
    [predictionIndex, query, activePlan],
  );
  const ghost = predictions.find((item) => item.ghost.length > 0)?.ghost ?? "";
  const ghostCompletion = predictions.find((item) => item.ghost.length > 0)?.completion ?? "";
  const starters = useMemo(
    () => predictionIndex && !query.trim() ? starterPrompts(predictionIndex, 5) : [],
    [predictionIndex, query],
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
    if (!searchIndex || !apprenticeMode) return undefined;
    const text = query.trim();
    if (text.length < 2) return undefined;
    const looksLikeCommand = /^[$#>]\s/.test(text)          // copied shell prompt
      || /^[/-]/.test(text)                                  // slash command or flag
      || /[|;]|&&|>>|\s>\s/.test(text)                       // shell plumbing
      || /\s-{1,2}[a-z]/i.test(text)                         // a flag argument
      || /[~/]\w|\.\w{2,4}\b/.test(text)                     // a path or filename
      || /^(sudo|git|npm|npx|docker|curl|wget|chmod|chown|rm|ls|cd|cat|grep|tar|ssh|kill|make|python3?|node|systemctl)\b/i.test(text);
    if (!looksLikeCommand) return undefined;
    return explainCommand(searchIndex, text) ?? undefined;
  }, [searchIndex, query, apprenticeMode]);

  const onboardingPath = useMemo(
    () => searchIndex && showGuide ? buildOnboardingPath(searchIndex, guideProduct) : undefined,
    [searchIndex, showGuide, guideProduct],
  );

  const acceptPrediction = useCallback((completion: string) => {
    setQuery(completion);
    setSelectedIndex(0);
    setActionStatus(undefined);
  }, []);

  const selectEntryById = useCallback((entryId: string) => {
    const position = displayedResults.findIndex((result) => result.entry.id === entryId);
    if (position >= 0) {
      setSelectedIndex(position);
      return;
    }
    // A follow-up may point outside the current result lane; search for it directly.
    if (!parsed.ok) return;
    const target = parsed.catalog.entries.find((item) => item.id === entryId);
    if (target) {
      setQuery(target.command);
      setSelectedIndex(0);
      setActionStatus(undefined);
    }
  }, [displayedResults, parsed]);

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
        setReasoningError(`Luna returned ${mapped.error.code === "unknown-entry-id" ? "unknown" : "duplicate"} catalog ID “${mapped.error.entryId}”. No plan was activated.`);
        return;
      }
      setActivePlan({ plan, recommendations: mapped.recommendations });
      setSelectedIndex(0);
    } catch (error) {
      setReasoningError(`Luna reasoning failed: ${actionErrorMessage(error)}`);
    } finally {
      setReasoningPending(false);
    }
  };

  const copySelected = async () => {
    if (!actionSelection || controlsLocked) return;
    setActionPending(true);
    try {
      await operatorActions.copy(actionSelection);
      setActionStatus({ kind: "status", message: `Copied “${actionSelection.command}” to the clipboard.` });
    } catch (error) {
      setActionStatus({ kind: "alert", message: `Copy failed: ${actionErrorMessage(error)}` });
    } finally {
      setActionPending(false);
    }
  };

  const insertSelected = async () => {
    if (!actionSelection || controlsLocked) return;
    const availability = getActionAvailability(actionSelection, runtime);
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
      ? "Checking Luna status…"
      : sparkStatus?.message ?? "Luna status unavailable.";
  const sparkDisabled = runtime !== "native" || !query.trim() || controlsLocked || sparkStatusPending || !sparkStatus?.available || !sparkStatus.loggedIn;
  const lunaStatusMessage = reasoningPending ? "Luna reasoning in progress…" : sparkUnavailableReason;

  return (
    <main className={`operator-shell runtime-${runtime}${largeText ? " large-text" : ""}${query.trim() ? " has-query" : ""}`} data-testid="operator-shell">
      <Header runtime={runtime} largeText={largeText} disabled={controlsLocked} apprenticeMode={apprenticeMode} onApprenticeMode={() => setApprenticeMode((value) => !value)} onLargeText={() => setLargeText((value) => !value)} onClose={() => {
        if (runtime === "native") void dismissOverlay();
        else { setQuery(""); setProduct(undefined); setInterfaceType(undefined); setTask(undefined); setSafety(undefined); setSelectedIndex(0); setActionStatus(undefined); clearReasoning(); }
      }} />

      {runtime === "web" && <section className="web-hero" aria-label="Operator Key promise">
        <div><span>LOCAL COMMAND INSTRUMENT / {parsed.catalog.total.toLocaleString()} ENTRIES</span><h1>You remember the task. <strong>Operator Key remembers the keys.</strong></h1></div>
        <b>WEB DECK · COPY ONLY</b>
      </section>}

      <section className="search-deck" aria-label="Command search controls">
        <label className="search-field">
          <span className="search-index">DESCRIBE OUTCOME /</span>
          <span className="sr-only">Operator intent</span>
          <span className="input-stack">
            <input
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
              placeholder="Describe the outcome you want to achieve in a full sentence."
              onChange={(event) => {
                if (!controlsLocked) {
                  setQuery(event.target.value);
                  setSelectedIndex(0);
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
        <StarterPrompts prompts={starters} disabled={controlsLocked} onSelect={acceptPrediction} />
        {apprenticeMode && !showGuide && (
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
          <button type="button" className="spark-button" aria-label="Reason with Luna" aria-describedby="luna-availability" disabled={sparkDisabled} onClick={() => { void reasonAboutIntent(); }}>
            <span aria-hidden="true">✦</span> {reasoningPending ? "Reasoning…" : "Reason with Luna"} <kbd>ALT+ENTER</kbd>
          </button>
          <div className="spark-copy">
            <p>Reasoning sends the entered intent and bounded command fields shown in the local catalog to OpenAI through local Codex; never source paths, provenance, files, secrets, terminal contents, or history.</p>
            <small id="luna-availability" aria-live="polite" aria-atomic="true" className={!reasoningPending && sparkStatus?.available && sparkStatus.loggedIn && runtime === "native" ? "spark-ready" : ""}>{lunaStatusMessage}</small>
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

      {onboardingPath && (
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
        <section className="empty-panel" role="status">
          <span className="state-code">SEARCH / 000</span>
          <h2>No matching command</h2>
          <p>Every term must map to a command, alias, task, description, or product. Clear a filter or try fewer words.</p>
          <button type="button" disabled={controlsLocked} onClick={() => { if (!controlsLocked) { setQuery(""); setProduct(undefined); setInterfaceType(undefined); setTask(undefined); setSafety(undefined); clearReasoning(); } }}>Reset search plane</button>
        </section>
      ) : (
        <section className="workspace-grid">
          <section className="command-stage">
            <div className="command-scroll">
              {activePlan && <IntentStructure activePlan={activePlan} onReturn={() => { setActivePlan(undefined); setSelectedIndex(0); setReasoningError(undefined); }} />}
              {selected && (
                <DetailCard
                  entry={selected}
                  catalog={parsed.catalog}
                  availability={getActionAvailability(selected, runtime)}
                  actionPending={controlsLocked}
                  onCopy={() => { void copySelected(); }}
                  onInsert={() => { void insertSelected(); }}
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

          <aside className="result-lane" aria-label={activePlan ? "Luna recommended commands" : "Search results"}>
            <div className="lane-heading"><span>{activePlan ? "LUNA STRUCTURE" : "LOCAL MATCH"}</span><strong>{displayedResults.length.toString().padStart(2, "0")}</strong></div>
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
