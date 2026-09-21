"""Tests for the freshness checker.

The checker's job is to be HONEST, not optimistic: a wrong "you are up to date" is worse
than admitting it could not tell. These tests pin that contract, and pin the rule that
the checker never writes to the catalog.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts import check_updates

ROOT = Path(__file__).resolve().parents[1]


class VersionComparison(unittest.TestCase):
    def test_reads_numbers_out_of_varied_upstream_spellings(self):
        self.assertEqual(check_updates.normalize_version("rust-v0.155.1"), (0, 155, 1))
        self.assertEqual(check_updates.normalize_version("v2.1.278"), (2, 1, 278))
        self.assertEqual(check_updates.normalize_version("4.0.3-1"), (4, 0, 3))

    def test_detects_being_behind_across_spellings(self):
        self.assertEqual(check_updates.compare_versions("2.1.272", "v2.1.278"), "behind")
        self.assertEqual(check_updates.compare_versions("0.154.0", "rust-v0.155.1"), "behind")
        self.assertEqual(check_updates.compare_versions("4.0.3-1", "v4.0.4"), "behind")

    def test_compares_numerically_not_as_text(self):
        # "4.0.9" > "4.0.10" as strings; as versions it is older.
        self.assertEqual(check_updates.compare_versions("4.0.9", "v4.0.10"), "behind")

    def test_pads_so_shorter_versions_are_not_treated_as_older(self):
        self.assertEqual(check_updates.compare_versions("2.1", "v2.1.0"), "current")

    def test_says_unknown_rather_than_guessing(self):
        # A false "current" would tell an operator their catalog is trustworthy when it
        # may not be. Unparseable input must never resolve to a clean bill of health.
        self.assertEqual(check_updates.compare_versions("unknown", "v1.0.0"), "unknown")
        self.assertEqual(check_updates.compare_versions("1.0.0", ""), "unknown")
        self.assertEqual(check_updates.compare_versions("", ""), "unknown")


class ReportBuilding(unittest.TestCase):
    def _fake_http(self, payloads):
        def handler(url, headers=None, timeout=20):
            for fragment, response in payloads.items():
                if fragment in url:
                    return response
            return 0, b"", {}
        return handler

    def test_records_catalog_drift_without_any_network(self):
        # Catalog drift is a purely local fact: the catalog either was or was not built
        # from the binaries currently installed. It must be knowable offline.
        with mock.patch.object(check_updates, "installed_versions", return_value={
            "omarchy": "4.0.4", "hermes": "0.21.3", "claude-code": "2.1.278", "codex": "0.155.1",
        }), mock.patch.object(check_updates, "catalog_metadata", return_value={
            "generated_at": "2026-09-15T00:00:00+00:00",
            "versions": {"omarchy": "4.0.3-1", "hermes": "0.21.3", "claude-code": "2.1.272", "codex": "0.154.0"},
        }):
            with tempfile.TemporaryDirectory() as tmp:
                report = check_updates.build_report(offline=True, output=Path(tmp) / "f.json")

        self.assertFalse(report["products"]["claude-code"]["catalog_matches_installed"])
        self.assertTrue(report["products"]["hermes"]["catalog_matches_installed"])

    def test_offline_never_claims_a_drift_verdict(self):
        with mock.patch.object(check_updates, "installed_versions", return_value={"codex": "0.154.0"}), \
             mock.patch.object(check_updates, "catalog_metadata", return_value={"versions": {}}):
            with tempfile.TemporaryDirectory() as tmp:
                report = check_updates.build_report(offline=True, output=Path(tmp) / "f.json")
        self.assertEqual(report["products"]["codex"]["drift"], "unknown")


    def test_offline_run_preserves_drift_from_the_last_online_check(self):
        # Found in the live app: running --offline wiped the previous findings, so a
        # catalog with three tools behind upstream suddenly looked clean.
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "freshness.json"
            output.write_text(json.dumps({
                "checked_at": "2026-09-21T06:00:00+00:00",
                "products": {"codex": {"drift": "behind", "latest": "rust-v0.155.1"}},
                "docs": {},
            }), encoding="utf-8")

            with mock.patch.object(check_updates, "installed_versions", return_value={"codex": "0.154.0"}), \
                 mock.patch.object(check_updates, "catalog_metadata", return_value={"versions": {}}):
                report = check_updates.build_report(offline=True, output=output)

        record = report["products"]["codex"]
        self.assertEqual(record["drift"], "unknown")
        self.assertEqual(record["last_known_drift"], "behind")
        self.assertEqual(record["latest"], "rust-v0.155.1")


    def test_absent_tools_are_not_reported_as_stale(self):
        # A downloaded repo ships someone else's catalog. Telling an operator their
        # catalog is "out of date" for a tool they never installed is misleading.
        with mock.patch.object(check_updates, "installed_versions", return_value={
            "omarchy": "unknown", "hermes": "0.21.3",
        }), mock.patch.object(check_updates, "catalog_metadata", return_value={
            "versions": {"omarchy": "4.0.3-1", "hermes": "0.21.3"},
        }):
            with tempfile.TemporaryDirectory() as tmp:
                report = check_updates.build_report(offline=True, output=Path(tmp) / "f.json")

        omarchy = report["products"]["omarchy"]
        self.assertFalse(omarchy["installed_here"])
        self.assertFalse(omarchy["catalog_matches_installed"])
        self.assertEqual(omarchy["upstream_status"], "not-installed")

        hermes = report["products"]["hermes"]
        self.assertTrue(hermes["installed_here"])
        self.assertTrue(hermes["catalog_matches_installed"])

    def test_absent_tools_cost_no_network_requests(self):
        calls = []

        def spy(url, headers=None, timeout=20):
            calls.append(url)
            return 0, b"", {}

        with mock.patch.object(check_updates, "installed_versions", return_value={"omarchy": "unknown"}), \
             mock.patch.object(check_updates, "catalog_metadata", return_value={"versions": {}}), \
             mock.patch.object(check_updates, "http_get", spy):
            with tempfile.TemporaryDirectory() as tmp:
                check_updates.build_report(output=Path(tmp) / "f.json")

        self.assertEqual([c for c in calls if "releases" in c or "tags" in c], [])

    def test_summary_distinguishes_absent_from_stale(self):
        report = {
            "checked_at": "2026-09-21T00:00:00+00:00",
            "catalog_generated_at": "2026-09-15T00:00:00+00:00",
            "products": {
                "omarchy": {"installed": "unknown", "installed_here": False,
                            "catalog_matches_installed": False, "drift": "unknown"},
                "hermes": {"installed": "0.21.3", "installed_here": True,
                           "catalog_matches_installed": True, "drift": "unknown"},
            },
            "docs": {},
        }
        text = check_updates.summarize(report)
        self.assertIn("not installed", text)
        self.assertNotIn("STALE", text)

    def test_unreachable_upstream_reports_unknown_not_current(self):
        with mock.patch.object(check_updates, "installed_versions", return_value={"codex": "0.154.0"}), \
             mock.patch.object(check_updates, "catalog_metadata", return_value={"versions": {}}), \
             mock.patch.object(check_updates, "http_get", self._fake_http({})):
            with tempfile.TemporaryDirectory() as tmp:
                report = check_updates.build_report(output=Path(tmp) / "f.json")
        self.assertEqual(report["products"]["codex"]["drift"], "unknown")
        self.assertEqual(report["products"]["codex"]["upstream_status"], "unreachable")

    def test_product_without_a_public_feed_is_reported_honestly(self):
        # Hermes has no release feed we trust. Saying so is correct; inventing a source
        # would produce a confident answer with nothing behind it.
        with mock.patch.object(check_updates, "installed_versions", return_value={"hermes": "0.21.3"}), \
             mock.patch.object(check_updates, "catalog_metadata", return_value={"versions": {}}), \
             mock.patch.object(check_updates, "http_get", self._fake_http({})):
            with tempfile.TemporaryDirectory() as tmp:
                report = check_updates.build_report(output=Path(tmp) / "f.json")
        self.assertEqual(report["products"]["hermes"]["upstream_status"], "no-public-feed")
        self.assertEqual(report["products"]["hermes"]["drift"], "unknown")

    def test_picks_newest_tag_numerically_not_by_feed_order(self):
        tags = json.dumps([{"name": "v4.0.9"}, {"name": "v4.0.10"}, {"name": "v4.0.2"}]).encode()
        with mock.patch.object(check_updates, "http_get", self._fake_http({"tags": (200, tags, {})})):
            result = check_updates.check_release("omarchy", {"kind": "github_tags", "repo": "omacom/omarchy"})
        self.assertEqual(result["latest"], "v4.0.10")

    def test_ignores_release_candidates_when_stable_tags_exist(self):
        # Found by running the real weekly check: git tags `v2.56.0-rc1` in the same feed
        # as its stable tags, so an operator on the current stable release was told they
        # were "behind" software that is not released yet. Same false-alarm failure mode as
        # a safety badge that fires on a read-only command.
        tags = json.dumps([
            {"name": "v2.56.0-rc1"},
            {"name": "v2.55.0"},
            {"name": "v2.54.0"},
        ]).encode()
        with mock.patch.object(check_updates, "http_get", self._fake_http({"tags": (200, tags, {})})):
            result = check_updates.check_release("git", {"kind": "github_tags", "repo": "git/git"})
        self.assertEqual(result["latest"], "v2.55.0")

    def test_falls_back_to_prereleases_when_nothing_stable_exists(self):
        # A project that has only ever tagged pre-releases still deserves an answer;
        # reporting "unknown" there would be its own dishonesty.
        tags = json.dumps([{"name": "v0.1.0-alpha"}, {"name": "v0.2.0-alpha"}]).encode()
        with mock.patch.object(check_updates, "http_get", self._fake_http({"tags": (200, tags, {})})):
            result = check_updates.check_release("git", {"kind": "github_tags", "repo": "git/git"})
        self.assertEqual(result["latest"], "v0.2.0-alpha")

    def test_prerelease_pattern_does_not_reject_real_versions(self):
        # `rust-v0.155.1` is codex's normal stable spelling: rejecting it as a pre-release
        # would silently drop the only feed that product has.
        for stable in ("v2.56.0", "rust-v0.155.1", "4.0.3-1", "v2.101.0", "v0.21.3"):
            self.assertIsNone(check_updates.PRERELEASE.search(stable), stable)
        for pre in ("v2.56.0-rc1", "v1.0.0-beta.2", "v1.0.0-alpha", "v1.2.3-nightly"):
            self.assertIsNotNone(check_updates.PRERELEASE.search(pre), pre)

    def test_detects_documentation_changing_at_an_unchanged_version(self):
        # The subtle rot: the version stays put while a command's meaning moves.
        previous = {"docs": {"claude_commands": {"sha256": "old-digest", "etag": "\"abc\""}}}
        with mock.patch.object(check_updates, "http_get", self._fake_http({"claude.com": (200, b"new body", {})})):
            result = check_updates.check_doc(
                "claude_commands",
                {"product": "claude-code", "url": "https://code.claude.com/docs/en/commands.md"},
                previous,
            )
        self.assertEqual(result["status"], "changed")

    def test_treats_304_as_unchanged_without_a_body(self):
        previous = {"docs": {"claude_commands": {"sha256": "digest", "last_modified": "Mon, 21 Sep 2026 21:14:39 GMT"}}}
        with mock.patch.object(check_updates, "http_get", self._fake_http({"claude.com": (304, b"", {})})):
            result = check_updates.check_doc(
                "claude_commands",
                {"product": "claude-code", "url": "https://code.claude.com/docs/en/commands.md"},
                previous,
            )
        self.assertEqual(result["status"], "unchanged")
        self.assertEqual(result["sha256"], "digest")


class TrustBoundary(unittest.TestCase):
    def test_checker_never_writes_to_the_catalog(self):
        # The catalog's authority comes from local generation. If a network fetch could
        # edit it, every downstream safety guarantee would rest on a web page.
        source = (ROOT / "scripts" / "check_updates.py").read_text(encoding="utf-8")
        self.assertNotIn("catalog.json\").write", source)
        self.assertNotIn("CATALOG.write_text", source)

    def test_catalog_is_only_ever_read(self):
        source = (ROOT / "scripts" / "check_updates.py").read_text(encoding="utf-8")
        for line in source.splitlines():
            if "CATALOG" in line and "write" in line.lower():
                self.fail(f"checker must not write the catalog: {line.strip()}")


class DocSourceHygiene(unittest.TestCase):
    def test_doc_urls_match_the_build_script(self):
        # A docs URL that redirects silently makes the catalog cite provenance it no
        # longer reads. Both files must agree on the address actually fetched.
        build = (ROOT / "scripts" / "build_catalog.py").read_text(encoding="utf-8")
        for source in check_updates.DOC_SOURCES.values():
            self.assertIn(source["url"], build, f"{source['url']} missing from build_catalog.py DOCS")


if __name__ == "__main__":
    unittest.main()
