"""Release compatibility is about the package bytes, not just a green build."""

import io
import hashlib
import json
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

from scripts.ci import check_deb_compat as compat
from scripts.ci import check_release_checksums as checksums
from test_ci_runner_compat import jobs_in, job_field, ROOT


RUNTIME_DEPENDS = "libwebkit2gtk-4.1-0, libgtk-3-0t64"


def tar_bytes(name: str, data: bytes, *, kind=tarfile.REGTYPE) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        info = tarfile.TarInfo(name)
        info.type = kind
        info.mode = 0o755 if name.endswith("operator-key") else 0o644
        info.size = len(data) if kind == tarfile.REGTYPE else 0
        archive.addfile(info, io.BytesIO(data) if kind == tarfile.REGTYPE else None)
    return output.getvalue()


def ar_member(name: str, data: bytes) -> bytes:
    header = (
        f"{name + '/':<16}{'0':<12}{'0':<6}{'0':<6}{'100644':<8}{len(data):<10}`\n"
    ).encode("ascii")
    assert len(header) == 60
    return header + data + (b"\n" if len(data) % 2 else b"")


def deb_bytes(*, depends=RUNTIME_DEPENDS, binary_kind=tarfile.REGTYPE) -> bytes:
    control = (
        f"Package: operator-key\nVersion: 0.2.4\nDepends: {depends}\n"
    ).encode()
    return (
        b"!<arch>\n"
        + ar_member("debian-binary", b"2.0\n")
        + ar_member("control.tar.gz", tar_bytes("control", control))
        + ar_member(
            "data.tar.gz", tar_bytes("usr/bin/operator-key", b"\x7fELF fixture", kind=binary_kind)
        )
    )


class PackageCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.deb = Path(self.temp.name) / "candidate.deb"
        self.deb.write_bytes(deb_bytes())

    def test_a_package_with_the_existing_floor_and_required_dependencies_passes(self):
        result = compat.check_package(
            self.deb, symbol_reader=lambda _: "0000 (GLIBC_2.34)\n0000 (GLIBC_2.39)"
        )
        self.assertEqual(result["max_glibc"], "2.39")
        self.assertEqual(result["depends"], RUNTIME_DEPENDS)

    def test_a_newer_glibc_symbol_fails_even_when_older_symbols_exist(self):
        with self.assertRaisesRegex(ValueError, "GLIBC_2.40"):
            compat.check_package(
                self.deb,
                symbol_reader=lambda _: "0000 (GLIBC_2.39)\n0000 (GLIBC_2.40)",
            )

    def test_glibc_symbols_are_compared_numerically(self):
        result = compat.check_package(
            self.deb, symbol_reader=lambda _: "GLIBC_2.9\nGLIBC_2.39"
        )
        self.assertEqual(result["max_glibc"], "2.39")

    def test_a_missing_or_unreadable_symbol_table_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "GLIBC"):
            compat.check_package(self.deb, symbol_reader=lambda _: "not an ELF table")

    def test_missing_webkit_dependency_fails_before_publication(self):
        self.deb.write_bytes(deb_bytes(depends="libgtk-3-0t64"))
        with self.assertRaisesRegex(ValueError, "libwebkit2gtk-4.1-0"):
            compat.check_package(self.deb, symbol_reader=lambda _: "GLIBC_2.39")

    def test_legacy_gtk_dependency_can_reach_real_install_gate_via_t64_provides(self):
        self.deb.write_bytes(deb_bytes(depends="libwebkit2gtk-4.1-0, libgtk-3-0"))
        self.assertEqual(
            compat.check_package(self.deb, symbol_reader=lambda _: "GLIBC_2.39")["max_glibc"],
            "2.39",
        )

    def test_missing_both_gtk_dependency_names_fails(self):
        self.deb.write_bytes(deb_bytes(depends="libwebkit2gtk-4.1-0"))
        with self.assertRaisesRegex(ValueError, "libgtk-3-0"):
            compat.check_package(self.deb, symbol_reader=lambda _: "GLIBC_2.39")

    def test_package_without_exact_regular_binary_fails(self):
        self.deb.write_bytes(deb_bytes(binary_kind=tarfile.SYMTYPE))
        with self.assertRaisesRegex(ValueError, "regular"):
            compat.check_package(self.deb, symbol_reader=lambda _: "GLIBC_2.39")

    def test_malformed_ar_never_passes_from_an_unrelated_local_binary(self):
        self.deb.write_bytes(b"not a Debian package")
        with self.assertRaisesRegex(ValueError, "Debian"):
            compat.check_package(self.deb, symbol_reader=lambda _: "GLIBC_2.39")


class WorkflowCompatibilityTests(unittest.TestCase):
    def test_bundler_requests_gtk_package_available_on_both_target_distros(self):
        config = json.loads((ROOT / "src-tauri" / "tauri.conf.json").read_text())
        self.assertEqual(config["bundle"]["linux"]["deb"]["depends"], ["libgtk-3-0t64"])

    def test_pull_requests_build_and_test_both_distros_as_a_required_job(self):
        job = jobs_in("verify.yml")["package-compat"]
        self.assertEqual(job_field(job, "runs-on"), "ubuntu-24.04")
        self.assertIsNone(job_field(job, "continue-on-error"))
        self.assertIn("bash scripts/build-release.sh", job)
        self.assertIn("python3 scripts/ci/check_deb_compat.py", job)
        self.assertIn("ubuntu-24.04", job)
        self.assertIn("debian-13", job)
        self.assertIn("scripts/ci/smoke-deb-in-container.sh", job)
        self.assertEqual(job_field(job, "if"), "${{ !startsWith(github.ref, 'refs/tags/') }}")

    def test_release_gates_exact_collected_package_before_upload_and_publish(self):
        job = jobs_in("release.yml")["package"]
        ordered = (
            "name: Collect artefacts and checksums",
            "python3 scripts/ci/check_release_checksums.py",
            "python3 scripts/ci/check_deb_compat.py",
            "scripts/ci/smoke-deb-in-container.sh",
            "uses: actions/upload-artifact@v7",
            "name: Publish release",
        )
        positions = [job.index(marker) for marker in ordered]
        self.assertEqual(positions, sorted(positions))
        self.assertIn('debs=(release-artefacts/*.deb)', job)
        self.assertIn('python3 scripts/ci/check_deb_compat.py "${debs[0]}"', job)
        self.assertIn('bash scripts/ci/smoke-deb-in-container.sh "${debs[0]}"', job)
        self.assertIn('test "${#debs[@]}" -eq 1', job)
        self.assertIn('test "${#rpms[@]}" -eq 1', job)
        self.assertIn('check_release_checksums.py release-artefacts/SHA256SUMS "${debs[0]}" "${rpms[0]}"', job)
        self.assertIn("ubuntu-24.04", job)
        self.assertIn("debian-13", job)

    def test_manual_dispatch_can_test_branch_without_publishing(self):
        job = jobs_in("release.yml")["package"]
        tag_step = job.index("name: Confirm the tag matches the declared version")
        build_step = job.index("name: Build packages")
        self.assertIn("if: startsWith(github.ref, 'refs/tags/v')", job[tag_step:build_step])
        publish_step = job[job.index("name: Publish release"):]
        self.assertIn("if: startsWith(github.ref, 'refs/tags/v')", publish_step)

    def test_stale_cached_bundles_cannot_enter_candidate_or_release_selection(self):
        release = jobs_in("release.yml")["package"]
        candidate = jobs_in("verify.yml")["package-compat"]
        self.assertIn('version=$(node -p "require(\'./package.json\').version")', release)
        self.assertIn('version=$(node -p "require(\'./package.json\').version")', candidate)
        self.assertIn('-name "*_${version}_amd64.deb"', release)
        self.assertIn('-name "*-${version}-*.x86_64.rpm"', release)
        self.assertIn('debs=(src-tauri/target/release/bundle/deb/*_"$version"_amd64.deb)', candidate)

    def test_published_package_recheck_is_explicit_read_only_and_hash_bound(self):
        jobs = jobs_in("verify.yml")
        self.assertIn("published-compat", jobs)
        job = jobs["published-compat"]
        self.assertEqual(job_field(job, "runs-on"), "ubuntu-24.04")
        self.assertEqual(
            job_field(job, "if"),
            "${{ github.event_name == 'workflow_dispatch' && inputs.published_tag != '' }}",
        )
        self.assertIsNone(job_field(job, "continue-on-error"))
        for marker in (
            'GH_TOKEN: ${{ github.token }}',
            'PUBLISHED_TAG: ${{ inputs.published_tag }}',
            'gh release download "$PUBLISHED_TAG"',
            'python3 scripts/ci/check_release_checksums.py',
            'python3 scripts/ci/check_deb_compat.py',
            'scripts/ci/smoke-deb-in-container.sh',
            'ubuntu-24.04',
            'debian-13',
        ):
            with self.subTest(marker=marker):
                self.assertIn(marker, job)
        self.assertNotIn("Publish release", job)
        self.assertLess(job.index('python3 scripts/ci/check_release_checksums.py'),
                        job.index('python3 scripts/ci/check_deb_compat.py'))

    def test_published_recheck_checks_exact_downloaded_files_before_smoke(self):
        job = jobs_in("verify.yml")["published-compat"]
        self.assertIn('check_release_checksums.py "$RUNNER_TEMP/published/SHA256SUMS" "${debs[0]}" "${rpms[0]}"', job)

    def test_container_smoke_requires_real_install_link_and_window(self):
        outer = (ROOT / "scripts" / "ci" / "smoke-deb-in-container.sh").read_text()
        inner = (ROOT / "scripts" / "ci" / "container-launch-smoke.sh").read_text()
        self.assertIn("docker run --rm", outer)
        self.assertIn("readonly", outer)
        for expected in ("apt-get install", "ldd", "runuser", "xvfb-run", "xwininfo", "timeout"):
            with self.subTest(expected=expected):
                self.assertIn(expected, inner)

    def test_container_smoke_rejects_unapproved_distro_before_docker(self):
        script = ROOT / "scripts" / "ci" / "smoke-deb-in-container.sh"
        result = subprocess.run(
            ["bash", str(script), "unimportant.deb", "random-distro"],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsupported distro", result.stderr.lower())

    def test_support_policy_describes_scope_without_claiming_untested_platforms(self):
        policy = (ROOT / "docs" / "SUPPORTED_LINUX.md").read_text()
        self.assertIn("Ubuntu 24.04 LTS", policy)
        self.assertIn("Debian 13", policy)
        self.assertIn("GLIBC_2.39", policy)
        self.assertIn("amd64", policy)
        self.assertIn("RPM", policy)
        self.assertIn("Hyprland", policy)
        self.assertIn("SUPPORTED_LINUX.md", (ROOT / "docs" / "INSTALL.md").read_text())


class ExactReleaseChecksumTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.manifest = root / "SHA256SUMS"
        self.deb = root / "operator.deb"
        self.rpm = root / "operator.rpm"
        self.deb.write_bytes(b"deb bytes")
        self.rpm.write_bytes(b"rpm bytes")
        self.deb_line = hashlib.sha256(self.deb.read_bytes()).hexdigest() + "  " + self.deb.name
        self.rpm_line = hashlib.sha256(self.rpm.read_bytes()).hexdigest() + "  " + self.rpm.name
        self.manifest.write_text(self.deb_line + "\n" + self.rpm_line + "\n")

    def verify(self):
        return checksums.verify(self.manifest, self.deb, self.rpm)

    def test_exact_manifest_names_and_digests_pass(self):
        self.verify()

    def test_missing_deb_is_rejected_even_when_rpm_checksum_is_correct(self):
        self.manifest.write_text(self.rpm_line + "\n")
        with self.assertRaisesRegex(ValueError, "missing|exactly"):
            self.verify()

    def test_missing_rpm_is_rejected(self):
        self.manifest.write_text(self.deb_line + "\n")
        with self.assertRaisesRegex(ValueError, "missing|exactly"):
            self.verify()

    def test_repeated_asset_entry_is_rejected(self):
        self.manifest.write_text(self.deb_line + "\n" + self.deb_line + "\n" + self.rpm_line + "\n")
        with self.assertRaisesRegex(ValueError, "duplicate|exactly"):
            self.verify()

    def test_wrong_digest_is_rejected(self):
        self.deb.write_bytes(b"different deb bytes")
        with self.assertRaisesRegex(ValueError, "digest|checksum"):
            self.verify()

    def test_unselected_asset_is_rejected(self):
        self.manifest.write_text(self.deb_line + "\n" + self.rpm_line + "\n" + self.deb_line.replace("operator.deb", "other.deb") + "\n")
        with self.assertRaisesRegex(ValueError, "unexpected|exactly"):
            self.verify()


if __name__ == "__main__":
    unittest.main()
