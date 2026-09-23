import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { invoke } from "@tauri-apps/api/core";

// `invoke` is a module import, not a global: stubbing globalThis leaves the real binding
// in place and the assertion below passes vacuously.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("no native host in tests")),
}));
import type { BuildIdentity } from "./actions";

/**
 * Operator Key's whole argument is that a command should say when it came from a version
 * you do not have. The app itself could not state its own version, which is how an
 * installed 0.2.2 sat unnoticed on this machine beside a published 0.2.3.
 */
const identity = (overrides: Partial<BuildIdentity> = {}): BuildIdentity => ({
  version: "0.2.3",
  installKind: "userBinary",
  ...overrides,
});

/** The panel lives in Settings, so every case has to open Settings first. */
async function openBuildSection() {
  await userEvent.click(screen.getByRole("button", { name: "Settings" }));
  return screen.getByRole("region", { name: /this build/i });
}

describe("build identity in Settings", () => {
  it("states the running version", async () => {
    render(<App runtime="native" buildIdentity={identity()} />);

    expect(within(await openBuildSection()).getByText("0.2.3")).toBeInTheDocument();
  });

  it("tells a packaged install to use its package manager", async () => {
    render(<App runtime="native" buildIdentity={identity({ installKind: "systemPackage" })} />);

    // The upgrade route has to match how the app actually arrived, or the instruction
    // sends someone to a command that will not work on their machine.
    expect(within(await openBuildSection()).getByText(/package manager/i)).toBeInTheDocument();
  });

  it("tells a hand-installed binary to download the release again", async () => {
    render(<App runtime="native" buildIdentity={identity({ installKind: "userBinary" })} />);

    const section = within(await openBuildSection());
    expect(section.getByText(/download/i)).toBeInTheDocument();
    expect(section.queryByText(/package manager/i)).toBeNull();
  });

  it("tells a development build to rebuild rather than reinstall", async () => {
    render(<App runtime="native" buildIdentity={identity({ installKind: "developmentBuild" })} />);

    const section = within(await openBuildSection());
    expect(section.getByText(/rebuild/i)).toBeInTheDocument();
    expect(section.queryByText(/package manager/i)).toBeNull();
  });

  it("offers no upgrade instruction when the install is unrecognised", async () => {
    // Fail-safe: silence beats sending someone to the wrong package manager.
    render(<App runtime="native" buildIdentity={identity({ installKind: "unknown" })} />);

    const panel = await openBuildSection();
    const section = within(panel);
    expect(section.queryByText(/package manager/i)).toBeNull();
    expect(section.queryByText(/rebuild/i)).toBeNull();
    // Named routes are not enough: the panel must offer NO instruction at all, or an
    // unrecognised install quietly inherits whichever wording happens to be listed first.
    expect(section.queryByText(/download/i)).toBeNull();
    expect(panel.querySelector("p")).toBeNull();
  });

  it("says the version is unknown rather than printing an empty field", async () => {
    render(<App runtime="native" buildIdentity={{ version: "", installKind: "unknown" }} />);

    expect(within(await openBuildSection()).getByText(/unknown/i)).toBeInTheDocument();
  });

  it("never renders a filesystem path", async () => {
    // This panel is what someone screenshots into a bug report.
    render(<App runtime="native" buildIdentity={identity()} />);

    expect((await openBuildSection()).textContent ?? "").not.toMatch(/\/home\/|\/Users\//);
  });

  it("is absent in a web build, which has no install to describe", async () => {
    // A web page has no installed binary, so a panel reading "Version: Unknown" with no
    // upgrade route is noise that implies a broken probe rather than an absent concept.
    render(<App runtime="web" />);
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(screen.queryByRole("region", { name: /this build/i })).toBeNull();
  });

  it("does not probe the native side in a web build", async () => {
    // The JSX gate hides the panel, but the effect has its own runtime check. Without
    // pinning it here, removing that check would fire a native invoke in the browser with
    // no visible symptom, and no test would notice.
    render(<App runtime="web" />);
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(invoke).not.toHaveBeenCalledWith("build_identity");
  });
});
