/**
 * Catalog freshness: telling the operator how much to trust what they are reading.
 *
 * Operator Key's value is that it reflects the machine it runs on. A catalog built five
 * days ago against older binaries looks exactly as authoritative as one built this
 * morning, which is precisely the failure this module exists to prevent.
 *
 * This matters twice as much for a cloned repository. The catalog checked into git was
 * generated on someone else's computer, so on a fresh clone EVERY entry is a claim about
 * a machine the operator has never seen. Saying so plainly is the difference between a
 * tool that is honest and one that quietly misleads.
 *
 * Nothing here fetches anything. `data/freshness.json` is written by
 * `scripts/check_updates.py` (run from cron, never from the app) and is ADVISORY: it can
 * never change a safety level, a command, or any catalog fact. The app stays offline.
 */

/** How confident we are about a single product's currency. */
export type DriftState = "current" | "behind" | "ahead" | "unknown";

/** Why a product's drift could not be determined. */
export type UpstreamStatus = "ok" | "unreachable" | "offline" | "no-public-feed" | "not-installed";

export interface ProductFreshness {
  readonly installed: string;
  readonly latest?: string;
  readonly drift: DriftState;
  readonly upstream_status: UpstreamStatus;
  readonly catalog_built_from: string;
  readonly catalog_matches_installed: boolean;
  readonly release_url?: string;
  readonly published_at?: string;
  /** What the last ONLINE check concluded, carried through offline runs. */
  readonly last_known_drift?: DriftState;
  readonly last_known_at?: string;
  /** False when the tool is absent here, which is not the same as being out of date. */
  readonly installed_here?: boolean;
}

export interface DocFreshness {
  readonly product: string;
  readonly url: string;
  readonly status: "unchanged" | "changed" | "first-seen" | "unreachable";
}

export interface FreshnessReport {
  readonly schema_version: string;
  readonly checked_at: string;
  readonly offline: boolean;
  readonly reachable: boolean;
  readonly catalog_generated_at: string;
  readonly products: Record<string, ProductFreshness>;
  readonly docs: Record<string, DocFreshness>;
}

/**
 * Severity of what we have to tell the operator.
 *
 * Deliberately tiered. Nagging about every patch release trains people to dismiss the
 * banner, which is the same failure mode as a false safety flag: the one warning that
 * mattered arrives to an audience that has already learned to ignore it.
 */
export type NoticeLevel = "none" | "info" | "attention";

export interface FreshnessNotice {
  readonly level: NoticeLevel;
  readonly headline: string;
  readonly detail: string;
  /** Products this notice concerns, for badging the product filters. */
  readonly products: readonly string[];
}

export interface FreshnessSummary {
  readonly checkedAt?: string;
  /** Whole days since the check ran; undefined when never checked. */
  readonly daysSinceCheck?: number;
  /** Whole days since the catalog itself was generated. */
  readonly catalogAgeDays?: number;
  readonly notices: readonly FreshnessNotice[];
  /** True when no check has ever run, so the UI can say so rather than imply freshness. */
  readonly neverChecked: boolean;
}

function daysBetween(fromIso: string, now: Date): number | undefined {
  if (!fromIso) return undefined;
  const then = new Date(fromIso);
  if (Number.isNaN(then.getTime())) return undefined;
  const elapsed = now.getTime() - then.getTime();
  if (elapsed < 0) return 0;
  return Math.floor(elapsed / 86_400_000);
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * Turn a raw report into what the operator should be told, and nothing more.
 *
 * `catalogAgeWarningDays` exists because "stale" is a judgement, not a fact: a week-old
 * catalog is fine if nothing shipped, and bad if three releases did.
 */
export function summarizeFreshness(
  report: FreshnessReport | undefined,
  now: Date = new Date(),
  catalogAgeWarningDays = 14,
): FreshnessSummary {
  if (!report) {
    return {
      neverChecked: true,
      notices: [
        {
          level: "info",
          headline: "Never checked for updates",
          detail:
            "This catalog has not been compared against upstream releases. Run scripts/check_updates.py to see whether your tools or their documentation have moved on.",
          products: [],
        },
      ],
    };
  }

  const notices: FreshnessNotice[] = [];
  const catalogAgeDays = daysBetween(report.catalog_generated_at, now);
  const daysSinceCheck = daysBetween(report.checked_at, now);

  // 0. The clone case. If nothing the catalog describes is actually installed here, the
  // whole catalog is a description of somebody else's computer. That has to be said
  // before any detail about individual versions, or the detail implies a relevance the
  // catalog has not earned.
  const known = Object.values(report.products);
  const anyInstalled = known.some((record) => record.installed_here !== false);

  if (known.length > 0 && !anyInstalled) {
    return {
      checkedAt: report.checked_at,
      daysSinceCheck,
      catalogAgeDays,
      neverChecked: false,
      notices: [
        {
          level: "attention",
          headline: "This catalog describes a different machine",
          detail:
            "None of the catalogued tools were found on this computer, so every command here comes from the machine that generated the catalog. Install the tools you use, then run scripts/build_catalog.py to make this yours.",
          products: [],
        },
      ],
    };
  }

  // Products absent from this machine are reported once, plainly, and then excluded from
  // every staleness verdict below: a tool you do not have cannot be out of date.
  const notInstalled = Object.entries(report.products)
    .filter(([, record]) => record.installed_here === false)
    .map(([product]) => product);

  if (notInstalled.length > 0) {
    notices.push({
      level: "info",
      headline: `${plural(notInstalled.length, "catalogued tool")} not installed here`,
      detail: `The catalog includes commands for ${notInstalled.join(", ")}, which were not found on this machine. Those entries describe the computer that generated the catalog, not this one.`,
      products: notInstalled,
    });
  }

  // 1. Catalog drift outranks everything: the catalog no longer describes this machine,
  // so entries on screen may be for versions that are not installed.
  const outOfSync = Object.entries(report.products)
    .filter(([, record]) => record.installed_here !== false && !record.catalog_matches_installed)
    .map(([product]) => product);

  if (outOfSync.length > 0) {
    notices.push({
      level: "attention",
      headline:
        outOfSync.length === 1
          ? `Catalog is out of date for ${outOfSync[0]}`
          : `Catalog is out of date for ${outOfSync.length} products`,
      detail:
        "The catalog was generated from different versions than the ones installed now, so some commands here may not match your machine. Regenerate it with scripts/build_catalog.py.",
      products: outOfSync,
    });
  }

  // 2. Upstream drift: your tools are behind. Worth knowing, not alarming. Drift found by
  // the last online check still counts during an offline run: it did not stop being true
  // because the network was unavailable this morning.
  const behind = Object.entries(report.products)
    .filter(
      ([, record]) =>
        record.installed_here !== false &&
        (record.drift === "behind" || record.last_known_drift === "behind"),
    )
    .map(([product]) => product);

  if (behind.length > 0) {
    const carriedOnly = behind.every(
      (product) => report.products[product].drift !== "behind",
    );
    notices.push({
      level: "info",
      headline: `${plural(behind.length, "tool")} behind upstream`,
      detail: carriedOnly
        ? `As of the last online check, newer releases existed for ${behind.join(", ")}. The most recent check could not reach upstream, so this may have moved on.`
        : `Newer releases exist for ${behind.join(", ")}. Updating then regenerating the catalog keeps these commands accurate.`,
      products: behind,
    });
  }

  // 3. Content drift: the version stayed put but the documentation moved, which is the
  // quietest way for a command's meaning to change under a catalog that looks current.
  const changedDocs = Object.values(report.docs ?? {})
    .filter((doc) => doc.status === "changed")
    .map((doc) => doc.product);
  const uniqueChangedDocs = [...new Set(changedDocs)];

  if (uniqueChangedDocs.length > 0) {
    notices.push({
      level: "attention",
      headline: "Documentation changed since the last check",
      detail: `Official docs for ${uniqueChangedDocs.join(", ")} changed without a version bump, so a command's behaviour may have moved. Regenerate the catalog to pick it up.`,
      products: uniqueChangedDocs,
    });
  }

  // 4. Age, only once it is old enough to matter, and only if nothing louder was said.
  if (
    notices.length === 0 &&
    catalogAgeDays !== undefined &&
    catalogAgeDays >= catalogAgeWarningDays
  ) {
    notices.push({
      level: "info",
      headline: `Catalog is ${plural(catalogAgeDays, "day")} old`,
      detail:
        "Nothing is known to have changed, but it has been a while since this was rebuilt from your installed tools.",
      products: [],
    });
  }

  // 5. The check itself could not reach anything. Say so plainly: silence here would
  // read as "all clear" when in fact we learned nothing about upstream.
  if (!report.reachable && !report.offline) {
    notices.push({
      level: "info",
      headline: "Could not reach update sources",
      detail:
        "The last check could not contact upstream releases or documentation, so drift is unknown rather than clear.",
      products: [],
    });
  }

  return { checkedAt: report.checked_at, daysSinceCheck, catalogAgeDays, notices, neverChecked: false };
}

/** The single most important level present, for deciding whether to show anything at all. */
export function highestLevel(summary: FreshnessSummary): NoticeLevel {
  if (summary.notices.some((notice) => notice.level === "attention")) return "attention";
  if (summary.notices.some((notice) => notice.level === "info")) return "info";
  return "none";
}

/** Products carrying a notice, so the UI can badge just those filters. */
export function affectedProducts(summary: FreshnessSummary): ReadonlySet<string> {
  const affected = new Set<string>();
  for (const notice of summary.notices) {
    for (const product of notice.products) affected.add(product);
  }
  return affected;
}

/** Parse and validate a freshness document, rejecting anything malformed. */
export function parseFreshness(value: unknown): FreshnessReport | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.checked_at !== "string") return undefined;
  if (typeof record.products !== "object" || record.products === null) return undefined;
  return {
    schema_version: typeof record.schema_version === "string" ? record.schema_version : "0",
    checked_at: record.checked_at,
    offline: record.offline === true,
    reachable: record.reachable === true,
    catalog_generated_at:
      typeof record.catalog_generated_at === "string" ? record.catalog_generated_at : "",
    products: record.products as Record<string, ProductFreshness>,
    docs: (typeof record.docs === "object" && record.docs !== null
      ? record.docs
      : {}) as Record<string, DocFreshness>,
  };
}
