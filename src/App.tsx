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
  nativeActions,
  type ActionAvailability,
  type OperatorActions,
} from "./actions";

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

function Header({ largeText, onLargeText, onClose }: { largeText: boolean; onLargeText: () => void; onClose: () => void }) {
  return (
    <header className="masthead">
      <div className="wordmark" aria-label="Operator Key">
        <span className="wordmark-index">OK—01</span>
        <span>OPERATOR KEY</span>
      </div>
      <div className="system-readout">
        <span><i className="signal-light" /> LOCAL CATALOG</span>
        <span>NO EXECUTION PATH</span>
        <button type="button" className="text-mode" aria-pressed={largeText} onClick={onLargeText}>
          <span aria-hidden="true">Aa</span> Large text
        </button>
        <button type="button" className="close-overlay" aria-label="Close Operator Key" onClick={onClose}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
    </header>
  );
}

function ShellState({ kind, message, onClose }: { kind: "status" | "alert"; message: string; onClose: () => void }) {
  return (
    <main className="state-shell" data-testid="operator-shell">
      <Header largeText={false} onLargeText={() => undefined} onClose={onClose} />
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

export default function App({ loading = false, catalogData = catalogJson, hideOverlay: injectedHideOverlay, actions: injectedActions }: AppProps) {
  const parsed = useMemo(() => parseCatalog(catalogData), [catalogData]);
  const searchIndex = useMemo(
    () => parsed.ok ? createSearchIndex(parsed.catalog.entries) : undefined,
    [parsed],
  );
  const [query, setQuery] = useState("");
  const [product, setProduct] = useState<Product>();
  const [interfaceType, setInterfaceType] = useState<InterfaceType>();
  const [task, setTask] = useState<TaskGroup>();
  const [safety, setSafety] = useState<SafetyLevel>();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [actionStatus, setActionStatus] = useState<ActionStatus>();
  const [actionPending, setActionPending] = useState(false);
  const [largeText, setLargeText] = useState(false);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const resultRefs = useRef(new Map<string, HTMLLIElement>());
  const dismissOverlay = injectedHideOverlay ?? hideOverlay;
  const operatorActions = injectedActions ?? nativeActions;
  const setResultRef = useCallback((entryId: string, node: HTMLLIElement | null) => {
    if (node) resultRefs.current.set(entryId, node);
    else resultRefs.current.delete(entryId);
  }, []);

  const results = useMemo(() => {
    if (!searchIndex) return [];
    return searchCatalog(searchIndex, query, { product, interface: interfaceType, task, safety }, 50);
  }, [searchIndex, query, product, interfaceType, task, safety]);
  const boundedIndex = Math.min(selectedIndex, Math.max(0, results.length - 1));
  const selected = results[boundedIndex]?.entry;

  useEffect(() => {
    const handleGlobalKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void dismissOverlay();
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [dismissOverlay]);

  useEffect(() => {
    if (!selected) return;
    resultRefs.current.get(selected.id)?.scrollIntoView?.({ block: "nearest" });
  }, [selected, results]);

  if (loading) return <ShellState kind="status" message="Loading command catalog…" onClose={() => { void dismissOverlay(); }} />;
  if (!parsed.ok) return <ShellState kind="alert" message={parsed.error} onClose={() => { void dismissOverlay(); }} />;

  const selectProduct = (value?: Product) => {
    if (actionPending) return;
    setProduct(value);
    setSelectedIndex(0);
    setActionStatus(undefined);
  };

  const actionErrorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

  const copySelected = async () => {
    if (!selected || actionPending) return;
    setActionPending(true);
    try {
      await operatorActions.copy(selected);
      setActionStatus({ kind: "status", message: `Copied “${selected.command}” to the clipboard.` });
    } catch (error) {
      setActionStatus({ kind: "alert", message: `Copy failed: ${actionErrorMessage(error)}` });
    } finally {
      setActionPending(false);
    }
  };

  const insertSelected = async () => {
    if (!selected || actionPending) return;
    const availability = getActionAvailability(selected);
    if (!availability.insert) {
      setActionStatus({ kind: "status", message: availability.insertReason ?? "Terminal insertion is unavailable." });
      return;
    }
    setActionPending(true);
    try {
      await operatorActions.insert(selected);
      setActionStatus({ kind: "status", message: `Inserted “${selected.command}” without executing it.` });
    } catch (error) {
      setActionStatus({ kind: "alert", message: `Insert failed: ${actionErrorMessage(error)}` });
    } finally {
      setActionPending(false);
    }
  };

  const handleSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (actionPending) return;
    if (event.key === "ArrowDown" && results.length) {
      event.preventDefault();
      setSelectedIndex((boundedIndex + 1) % results.length);
    } else if (event.key === "ArrowUp" && results.length) {
      event.preventDefault();
      setSelectedIndex((boundedIndex - 1 + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        setActionStatus({ kind: "status", message: "Execution is disabled. Ctrl+Enter performs no action." });
      } else if (event.shiftKey) {
        void insertSelected();
      } else {
        void copySelected();
      }
    }
  };

  const handleProductKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (actionPending) return;
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

  const alternatives = results.filter((_, index) => index !== boundedIndex).slice(0, 3);

  return (
    <main className={`operator-shell${largeText ? " large-text" : ""}`} data-testid="operator-shell">
      <Header largeText={largeText} onLargeText={() => setLargeText((value) => !value)} onClose={() => { void dismissOverlay(); }} />

      <section className="search-deck" aria-label="Command search controls">
        <label className="search-field">
          <span className="search-index">INTENT /</span>
          <span className="sr-only">Operator intent</span>
          <input
            autoFocus
            type="search"
            role="searchbox"
            aria-label="Operator intent"
            aria-controls="result-list"
            aria-activedescendant={selected ? `result-${selected.id}` : undefined}
            value={query}
            disabled={actionPending}
            placeholder="What do you need to do?"
            onChange={(event) => { if (!actionPending) { setQuery(event.target.value); setSelectedIndex(0); setActionStatus(undefined); } }}
            onKeyDown={handleSearchKey}
          />
          <kbd className="escape-key">ESC</kbd>
        </label>

        <div className="product-tabs" role="radiogroup" aria-label="Product lanes">
          {PRODUCT_TABS.map((tab, index) => {
            const active = product === tab.value;
            const count = tab.value ? parsed.catalog.counts[tab.value] : parsed.catalog.total;
            return (
              <button
                type="button"
                role="radio"
                aria-checked={active}
                disabled={actionPending}
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
          <div className="task-chips" aria-label="Task filters">
            <button type="button" disabled={actionPending} className={!task ? "is-active" : ""} aria-pressed={!task} onClick={() => { if (!actionPending) { setTask(undefined); setSelectedIndex(0); } }}>Any task</button>
            {TASK_GROUPS.map((taskName) => (
              <button type="button" disabled={actionPending} key={taskName} className={task === taskName ? "is-active" : ""} aria-pressed={task === taskName} onClick={() => { if (!actionPending) { setTask(task === taskName ? undefined : taskName); setSelectedIndex(0); } }}>
                {TASK_LABELS[taskName]}
              </button>
            ))}
          </div>
          <div className="select-filters">
            <label>Interface
              <select disabled={actionPending} aria-label="Interface filter" value={interfaceType ?? ""} onChange={(event) => { if (!actionPending) { setInterfaceType((event.target.value || undefined) as InterfaceType | undefined); setSelectedIndex(0); } }}>
                <option role="presentation" value="">All</option>
                {INTERFACES.map((item) => <option role="presentation" key={item} value={item}>{item.replaceAll("-", " ")}</option>)}
              </select>
            </label>
            <label>Safety
              <select disabled={actionPending} aria-label="Safety filter" value={safety ?? ""} onChange={(event) => { if (!actionPending) { setSafety((event.target.value || undefined) as SafetyLevel | undefined); setSelectedIndex(0); } }}>
                <option role="presentation" value="">All</option>
                {SAFETY_LEVELS.map((item) => <option role="presentation" key={item} value={item}>{item}</option>)}
              </select>
            </label>
          </div>
        </div>
      </section>

      {results.length === 0 ? (
        <section className="empty-panel" role="status">
          <span className="state-code">SEARCH / 000</span>
          <h2>No matching command</h2>
          <p>Every term must map to a command, alias, task, description, or product. Clear a filter or try fewer words.</p>
          <button type="button" disabled={actionPending} onClick={() => { if (!actionPending) { setQuery(""); setProduct(undefined); setInterfaceType(undefined); setTask(undefined); setSafety(undefined); } }}>Reset search plane</button>
        </section>
      ) : (
        <section className="workspace-grid">
          <aside className="result-lane" aria-label="Search results">
            <div className="lane-heading"><span>MATCHES</span><strong>{results.length.toString().padStart(2, "0")}</strong></div>
            <ul id="result-list" role="listbox" aria-label="Command results">
              {results.map(({ entry }, index) => (
                <ResultRow
                  key={entry.id}
                  entry={entry}
                  active={index === boundedIndex}
                  position={index + 1}
                  total={results.length}
                  disabled={actionPending}
                  onSelect={() => { if (!actionPending) setSelectedIndex(index); }}
                  setRowRef={setResultRef}
                />
              ))}
            </ul>
          </aside>

          <section className="command-stage">
            {selected && (
              <DetailCard
                entry={selected}
                catalog={parsed.catalog}
                availability={getActionAvailability(selected)}
                actionPending={actionPending}
                onCopy={() => { void copySelected(); }}
                onInsert={() => { void insertSelected(); }}
              />
            )}
            <section className="alternatives" aria-label="Alternatives">
              <div className="lane-heading"><span>ALTERNATIVES</span><strong>{alternatives.length.toString().padStart(2, "0")}</strong></div>
              <div className="alternative-grid">
                {alternatives.map(({ entry }, index) => (
                  <button type="button" disabled={actionPending} key={entry.id} onClick={() => { if (!actionPending) setSelectedIndex(results.findIndex((result) => result.entry.id === entry.id)); }}>
                    <span>{PRODUCT_LABELS[entry.product]}</span>
                    <strong>{entry.command}</strong>
                    <small>{entry.context}</small>
                    <em>{index + 1}</em>
                  </button>
                ))}
              </div>
            </section>
          </section>
        </section>
      )}

      {actionStatus && <div className={`action-status action-${actionStatus.kind}`} role={actionStatus.kind}>{actionStatus.message}</div>}
      <footer className="status-footer">
        <span>{parsed.catalog.total.toLocaleString()} commands ready</span>
        <span><b>{results.length}</b> shown</span>
        <span><kbd>↑</kbd><kbd>↓</kbd> select</span>
        <span><kbd>ENTER</kbd> · COPY</span>
        <span><kbd>SHIFT+ENTER</kbd> · GUARDED INSERT</span>
        <span className="execution-lock">● EXECUTION DISABLED</span>
      </footer>
    </main>
  );
}
