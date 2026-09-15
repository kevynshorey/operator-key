import { describe, expect, it } from "vitest";
import styles from "./styles.css?raw";

function compact(value: string): string {
  return value.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
}

describe("responsive and accessible style contract", () => {
  const css = compact(styles);

  it("keeps required filters and metadata visible at the supported 820x560 viewport", () => {
    expect(css).not.toMatch(/\.select-filters\s*\{[^}]*display:\s*none/);
    expect(css).not.toMatch(/\.telemetry-grid div:nth-child\(n\+3\)\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/\.operator-shell[^{]*\{[^}]*overflow-y:\s*auto/);
  });

  it("gives the task rail a visible overflow affordance and safe trailing space", () => {
    expect(css).toMatch(/\.task-chips[^{]*\{[^}]*overflow-x:\s*auto/);
    expect(css).not.toMatch(/\.task-chips::-webkit-scrollbar\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/\.task-chips[^{]*\{[^}]*padding-right:\s*(?:1[6-9]|[2-9]\d)px/);
  });

  it("does not reduce whole unavailable rows below AA contrast", () => {
    expect(css).not.toMatch(/\.result-row\.is-unavailable\s*\{[^}]*opacity\s*:/);
  });

  it("scales every compact interface family in large-text mode", () => {
    for (const selector of [
      ".masthead", ".product-tabs button", ".task-chips button", ".select-filters label",
      ".select-filters select", ".lane-heading", ".result-chord", ".safety-label",
      ".telemetry-grid dt", ".telemetry-grid dd", ".alternative-grid span",
      ".alternative-grid small", ".alternative-grid em", ".status-footer",
    ]) {
      expect(css, `${selector} needs a large-text rule`).toContain(`.large-text ${selector}`);
    }
  });

  it("reflows large text at narrow supported widths instead of squeezing content", () => {
    expect(css).toMatch(/@media \(max-width: 850px\)[\s\S]*\.large-text \.workspace-grid\s*\{[^}]*display:\s*block/);
    expect(css).toMatch(/\.large-text \.alternative-grid\s*\{[^}]*grid-template-columns:\s*1fr/);
    expect(css).toMatch(/\.large-text \.product-tabs\s*\{[^}]*overflow-x:\s*auto/);
  });
});