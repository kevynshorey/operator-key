"""Pin release runners while observing the next Ubuntu image separately."""

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
VERIFY_JOBS = {
    "frontend",
    "browser",
    "python",
    "rust",
    "audit",
    "secrets",
    "no-machine-state",
}


def jobs_in(workflow: str) -> dict[str, str]:
    text = (WORKFLOWS / workflow).read_text(encoding="utf-8")
    jobs_text = text.split("\njobs:\n", 1)[1]
    headings = list(re.finditer(r"^  ([a-z][a-z0-9-]*):\s*$", jobs_text, re.M))
    return {
        match.group(1): jobs_text[match.end() : headings[index + 1].start()]
        if index + 1 < len(headings)
        else jobs_text[match.end() :]
        for index, match in enumerate(headings)
    }


def job_field(job: str, name: str) -> str | None:
    match = re.search(rf"^    {re.escape(name)}:\s*(.+)$", job, re.M)
    return match.group(1).strip() if match else None


class RunnerCompatibilityTests(unittest.TestCase):
    def test_required_verification_and_release_package_runners_remain_on_24_04(self):
        verify = jobs_in("verify.yml")
        self.assertTrue(VERIFY_JOBS.issubset(verify))
        self.assertEqual(set(jobs_in("release.yml")), {"verify", "package"})
        for name in VERIFY_JOBS:
            with self.subTest(job=name):
                self.assertEqual(job_field(verify[name], "runs-on"), "ubuntu-24.04")
        self.assertEqual(
            job_field(jobs_in("release.yml")["package"], "runs-on"), "ubuntu-24.04"
        )
        for name, body in verify.items():
            if name not in VERIFY_JOBS and name != "ubuntu26-compat":
                self.assertEqual(job_field(body, "runs-on"), "ubuntu-24.04")

    def test_26_04_probe_cannot_block_releases_or_required_ci(self):
        probe = jobs_in("verify.yml")["ubuntu26-compat"]
        self.assertEqual(job_field(probe, "runs-on"), "ubuntu-26.04")
        self.assertEqual(job_field(probe, "continue-on-error"), "true")
        self.assertIsNotNone(job_field(probe, "timeout-minutes"))
        self.assertIsNone(job_field(probe, "needs"))
        self.assertEqual(
            job_field(probe, "if"), "${{ !startsWith(github.ref, 'refs/tags/') }}"
        )
        self.assertNotIn("action-gh-release", probe)
        self.assertNotIn("upload-artifact", probe)

    def test_26_04_probe_exercises_package_build_and_reports_compatibility(self):
        probe = jobs_in("verify.yml")["ubuntu26-compat"]
        for expected in (
            "getconf GNU_LIBC_VERSION",
            "libwebkit2gtk-4.1-dev",
            "libgtk-3-dev",
            "libayatana-appindicator3-dev",
            "librsvg2-dev",
            "npm ci",
            "bash scripts/build-release.sh",
            "objdump -T",
            "dpkg-deb --field",
        ):
            with self.subTest(expected=expected):
                self.assertIn(expected, probe)


if __name__ == "__main__":
    unittest.main()
