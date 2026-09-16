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

function Header({ largeText, onLargeText, onClose, runtime, disabled = false }: { largeText: boolean; onLargeText: () => void; onClose: () => void; runtime: OperatorRuntime; disabled?: boolean }) {
  return (
    <header className="masthead">
      <div className="wordmark" aria-label="Operator Key">
        <span className="wordmark-index">OK—01</span>
        <span>OPERATOR KEY</span>
      </div>
      <div className="system-readout">
        <span><i className="signal-light" /> LOCAL CATALOG</span>
        <span>{runtime === "web" ? "WEB DECK · COPY ONLY" : "NO EXECUTION PATH"}</span>
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

export default function App({ loading = false, catalogData = catalogJson, hideOverlay: injectedHideOverlay, actions: injectedActions, runtime: injectedRuntime, intentReasoner: injectedIntentReasoner }: AppProps) {
  const parsed = useMemo(() => parseCatalog(catalogData), [catalogData]);
  const searchIndex = useMemo(
    () => parsed.ok ? createSearchIndex(parsed.catalog.entries) : undefined,
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

  useEffect(() => {
    const handleGlobalKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
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
  }, [clearReasoning, dismissOverlay, runtime]);

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

  return (
    <main className={`operator-shell runtime-${runtime}${largeText ? " large-text" : ""}${query.trim() ? " has-query" : ""}`} data-testid="operator-shell">
      <Header runtime={runtime} largeText={largeText} disabled={controlsLocked} onLargeText={() => setLargeText((value) => !value)} onClose={() => {
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
          <input
            autoFocus
            type="search"
            role="searchbox"
            aria-label="Operator intent"
            aria-controls="result-list"
            aria-activedescendant={selected ? `result-${selected.id}` : undefined}
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
          <kbd className="escape-key">ESC</kbd>
        </label>
        <div className="intent-composer-actions">
          <button type="button" className="spark-button" aria-label="Reason with Luna" disabled={sparkDisabled} onClick={() => { void reasonAboutIntent(); }}>
            <span aria-hidden="true">✦</span> {reasoningPending ? "Reasoning…" : "Reason with Luna"} <kbd>ALT+ENTER</kbd>
          </button>
          <div className="spark-copy">
            <p>Reasoning sends the entered intent and bounded command fields shown in the local catalog to OpenAI through local Codex; never source paths, provenance, files, secrets, terminal contents, or history.</p>
            <small className={sparkStatus?.available && sparkStatus.loggedIn && runtime === "native" ? "spark-ready" : ""}>{sparkUnavailableReason}</small>
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
        <span><kbd>ENTER</kbd> · COPY</span>
        <span>{runtime === "native" ? <><kbd>SHIFT+ENTER</kbd> · GUARDED INSERT</> : "LOCAL-ONLY · COPY-ONLY"}</span>
        <span className="execution-lock">{runtime === "native" ? "● EXECUTION DISABLED" : "● NATIVE COMPANION REQUIRED FOR INSERTION"}</span>
      </footer>
    </main>
  );
}
