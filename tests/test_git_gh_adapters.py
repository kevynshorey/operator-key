"""Tests for the git and gh catalog adapters.

These cover the classification decisions that matter most: a command's safety rating is
what a newcomer relies on to decide whether it is safe to run, so a wrong rating in
either direction is a product failure, not a cosmetic one.
"""
from __future__ import annotations

import unittest

from scripts.adapters import gh, git
from scripts.adapters.common import entry, safety

GIT_HELP = """See 'git help <command>' to read about a specific subcommand

Main Porcelain Commands
   add                     Add file contents to the index
   clean                   Remove untracked files from the working tree
   commit                  Record changes to the repository
   init                    Create an empty Git repository or reinitialize an existing one
   log                     Show commit logs
   push                    Update remote refs along with associated objects
   rebase                  Reapply commits on top of another base tip
   reset                   Set `HEAD` or the index to a known state
   status                  Show the working tree status

Ancillary Commands / Manipulators
   filter-branch           Rewrite branches
   reflog                  Manage reflog information

Low-level Commands / Manipulators
   apply                   Apply a patch to files and/or to the index

External commands
   clang-format

Command aliases
   st                      status
"""

GIT_PUSH_HELP = """usage: git push [<options>] [<repository> [<refspec>...]]

    -v, --[no-]verbose    be more verbose
    --[no-]all            push all branches
    -f, --[no-]force      force updates
    --[no-]force-with-lease[=<refname>:<expect>]
                          require old value of ref to be at this value
    -n, --[no-]dry-run    dry run
    --[no-]signed[=(yes|no|if-asked)]
                          GPG sign the push
"""

GH_ROOT_HELP = """Work seamlessly with GitHub from the command line.

USAGE
  gh <command> <subcommand> [flags]

CORE COMMANDS
  auth:          Authenticate gh and git with GitHub
  pr:            Manage pull requests
  repo:          Manage repositories

HELP TOPICS
  actions:       Learn about working with GitHub Actions

FLAGS
  --help      Show help for command
"""

GH_PR_HELP = """Work with GitHub pull requests.

USAGE
  gh pr <command> [flags]

GENERAL COMMANDS
  create:        Create a pull request
  list:          List pull requests in a repository

TARGETED COMMANDS
  diff:          View changes in a pull request
  merge:         Merge a pull request

FLAGS
  -R, --repo [HOST/]OWNER/REPO   Select another repository
"""

GH_PR_CREATE_HELP = """Create a pull request on GitHub.

FLAGS
  -a, --assignee login       Assign people by their login. Use "@me" to self-assign.
  -B, --base branch          The branch into which you want your code merged
  -d, --draft                Mark pull request as a draft
  -t, --title string         Title for the pull request

INHERITED FLAGS
  --help   Show help for command
"""


class GitCommandParsing(unittest.TestCase):
    def setUp(self):
        self.rows = git.parse_command_list(GIT_HELP, "2.55.0", "local: git help -a")
        self.by_command = {row["command"]: row for row in self.rows}

    def test_parses_porcelain_commands_with_descriptions(self):
        self.assertIn("git status", self.by_command)
        self.assertEqual(
            self.by_command["git log"]["description"], "Show commit logs"
        )

    def test_skips_low_level_and_external_sections(self):
        # Plumbing is not what an operator searching by intent is looking for, and
        # `clang-format` is not a git command at all.
        self.assertNotIn("git apply", self.by_command)
        self.assertNotIn("git clang-format", self.by_command)

    def test_skips_the_alias_section_so_parse_aliases_owns_it(self):
        # `git help -a` lists aliases with no provenance and no target. Cataloguing them
        # here would create a duplicate that dedupe resolves to whichever came first,
        # discarding the override provenance the alias parser attaches.
        self.assertNotIn("git st", self.by_command)

    def test_read_only_commands_are_green(self):
        for command in ("git status", "git log"):
            self.assertEqual(self.by_command[command]["safety_level"], "green", command)
            self.assertFalse(self.by_command[command]["destructive"], command)

    def test_history_destroying_commands_are_red_and_destructive(self):
        for command in ("git clean", "git filter-branch"):
            row = self.by_command[command]
            self.assertEqual(row["safety_level"], "red", command)
            self.assertTrue(row["destructive"], command)

    def test_state_changing_commands_are_amber_not_green(self):
        # The generic keyword classifier rates all four of these green, because their
        # descriptions talk about recording and reapplying rather than destroying.
        for command in ("git commit", "git push", "git rebase", "git reset"):
            row = self.by_command[command]
            self.assertEqual(row["safety_level"], "amber", command)
            self.assertFalse(row["destructive"], command)

    def test_bare_reflog_is_not_red(self):
        # `git reflog` with no subcommand is `git reflog show`: read-only, and the single
        # best tool for recovering apparently-lost commits. Rating it red is a false alarm
        # that also excludes it from the recovery lesson where it is the right answer.
        self.assertNotEqual(self.by_command["git reflog"]["safety_level"], "red")
        self.assertFalse(self.by_command["git reflog"]["destructive"])

    def test_safety_note_is_appended_so_the_rating_is_explained(self):
        self.assertIn("cannot be recovered", self.by_command["git clean"]["description"])

    def test_task_groups_are_stated_not_inferred(self):
        # `classify` files "Record changes to the repository" under capture-and-input
        # because the description contains "record", scattering the version-control
        # workflow across unrelated groups.
        self.assertEqual(self.by_command["git commit"]["task_group"], "development")
        self.assertEqual(self.by_command["git status"]["task_group"], "review-and-verify")
        self.assertEqual(self.by_command["git reset"]["task_group"], "debug-and-recover")
        self.assertEqual(self.by_command["git init"]["task_group"], "configuration")

    def test_unknown_commands_are_not_assumed_safe(self):
        rows = git.parse_command_list(
            "Main Porcelain Commands\n   frobnicate              Does something new\n",
            "2.55.0", "local: git help -a",
        )
        self.assertEqual(rows[0]["safety_level"], "amber")

    def test_returns_nothing_when_git_is_absent(self):
        self.assertEqual(git.parse_command_list("", "unknown", "local: git help -a"), [])


class GitFlagParsing(unittest.TestCase):
    def setUp(self):
        self.rows = git.parse_subcommand_flags("push", GIT_PUSH_HELP, "2.55.0", "local: git push -h")
        self.by_command = {row["command"]: row for row in self.rows}

    def test_renders_the_affirmative_flag_an_operator_would_type(self):
        self.assertIn("git push --all", self.by_command)
        self.assertNotIn("git push --[no-]all", self.by_command)

    def test_joins_short_and_long_forms_with_the_shared_separator(self):
        self.assertIn("git push -v / --verbose", self.by_command)

    def test_strips_argument_placeholders_that_clean_would_mangle(self):
        # `clean` removes <...> as if it were an HTML tag, turning
        # `--force-with-lease[=<refname>:<expect>]` into the nonsense `--force-with-lease[=:]`.
        self.assertIn("git push --force-with-lease", self.by_command)
        for command in self.by_command:
            self.assertNotIn("[", command)
            self.assertNotIn("<", command)
            self.assertNotIn(",", command)

    def test_reads_wrapped_descriptions_from_the_following_line(self):
        self.assertIn("require old value", self.by_command["git push --force-with-lease"]["description"])

    def test_force_is_red_and_destructive(self):
        row = self.by_command["git push -f / --force"]
        self.assertEqual(row["safety_level"], "red")
        self.assertTrue(row["destructive"])

    def test_force_with_lease_is_not_treated_as_force(self):
        # --force-with-lease is the SAFE alternative: it refuses to overwrite work the
        # pusher has not seen. Inheriting --force's verdict would teach people to avoid
        # the very flag that protects them.
        row = self.by_command["git push --force-with-lease"]
        self.assertEqual(row["safety_level"], "amber")
        self.assertFalse(row["destructive"])

    def test_dry_run_is_green(self):
        self.assertEqual(self.by_command["git push -n / --dry-run"]["safety_level"], "green")

    def test_flags_inherit_their_command_task_group(self):
        self.assertEqual(self.by_command["git push --all"]["task_group"], "development")


class GitAliasParsing(unittest.TestCase):
    def test_alias_inherits_the_safety_of_its_target(self):
        rows = git.parse_aliases(
            "alias.st status\nalias.nuke clean -fdx\n", "2.55.0", "local: git config",
        )
        by_command = {row["command"]: row for row in rows}
        self.assertEqual(by_command["git st"]["safety_level"], "green")
        self.assertEqual(by_command["git nuke"]["safety_level"], "red")
        self.assertTrue(by_command["git nuke"]["destructive"])

    def test_alias_records_its_expansion_and_override_provenance(self):
        rows = git.parse_aliases("alias.st status\n", "2.55.0", "local: git config")
        self.assertEqual(rows[0]["provenance"]["kind"], "override")
        self.assertIn("git status", rows[0]["aliases"])

    def test_shell_alias_is_not_classified_as_a_git_subcommand(self):
        rows = git.parse_aliases("alias.deploy !./deploy.sh\n", "2.55.0", "local: git config")
        self.assertEqual(rows[0]["safety_level"], "amber")


class GhCommandParsing(unittest.TestCase):
    def setUp(self):
        self.root = {
            row["command"]: row
            for row in gh.parse_group("", GH_ROOT_HELP, "2.100.0", "local: gh --help")
        }
        self.pr = {
            row["command"]: row
            for row in gh.parse_group("pr", GH_PR_HELP, "2.100.0", "local: gh pr --help")
        }

    def test_parses_top_level_groups(self):
        self.assertIn("gh auth", self.root)
        self.assertIn("gh pr", self.root)

    def test_ignores_help_topics_that_are_not_commands(self):
        self.assertNotIn("gh actions", self.root)

    def test_parses_nested_subcommands_with_their_group(self):
        self.assertIn("gh pr create", self.pr)
        self.assertIn("gh pr merge", self.pr)

    def test_read_only_commands_are_green(self):
        self.assertEqual(self.pr["gh pr list"]["safety_level"], "green")
        self.assertEqual(self.pr["gh pr diff"]["safety_level"], "green")

    def test_publishing_commands_are_not_green(self):
        # The generic classifier rates both of these green: "Create a pull request" and
        # "Merge a pull request" contain no danger words. Both publish irreversibly to a
        # shared remote.
        for command in ("gh pr create", "gh pr merge"):
            row = self.pr[command]
            self.assertEqual(row["safety_level"], "amber", command)

    def test_deleting_commands_are_red(self):
        level, destructive = gh.classify("repo delete")
        self.assertEqual(level, "red")
        self.assertTrue(destructive)

    def test_unknown_delete_leaf_is_red_by_shape(self):
        level, destructive = gh.classify("widget delete")
        self.assertEqual(level, "red")
        self.assertTrue(destructive)

    def test_printing_a_token_is_red(self):
        # `gh auth token` writes a live credential to the terminal.
        level, destructive = gh.classify("auth token")
        self.assertEqual(level, "red")
        self.assertTrue(destructive)

    def test_task_groups_are_stated_not_inferred(self):
        self.assertEqual(self.pr["gh pr create"]["task_group"], "review-and-verify")
        self.assertEqual(self.root["gh auth"]["task_group"], "configuration")

    def test_returns_nothing_when_gh_is_absent(self):
        self.assertEqual(gh.parse_group("", "", "unknown", "local: gh --help"), [])


class GhFlagParsing(unittest.TestCase):
    def setUp(self):
        self.rows = gh.parse_flags(
            "pr create", GH_PR_CREATE_HELP, "2.100.0", "local: gh pr create --help",
        )
        self.by_command = {row["command"]: row for row in self.rows}

    def test_normalises_flags_the_same_way_git_does(self):
        # One concept must not render two ways inside one catalog, or search splits
        # between the spellings.
        self.assertIn("gh pr create -a / --assignee", self.by_command)
        for command in self.by_command:
            self.assertNotIn(",", command)

    def test_stops_at_inherited_flags(self):
        self.assertNotIn("gh pr create --help", self.by_command)

    def test_flags_inherit_the_command_verdict(self):
        self.assertEqual(self.by_command["gh pr create -d / --draft"]["safety_level"], "amber")


class SafetyWordBoundaries(unittest.TestCase):
    """Regression tests for substring matching in the shared safety classifier."""

    def test_skills_is_not_read_as_kill(self):
        # "s-KILL-s" made every skill command in the catalog red and destructive,
        # including read-only ones. A badge that fires on `hermes skills list` is a badge
        # operators learn to ignore before the day it fires on `git push --force`.
        for command in ("hermes skills list", "/skills", "hermes skills search"):
            level, destructive = safety(command, "List installed skills")
            self.assertEqual(level, "green", command)
            self.assertFalse(destructive, command)

    def test_forced_updates_display_flag_is_not_read_as_force(self):
        level, destructive = safety(
            "git pull --show-forced-updates", "check for forced-updates on all updated branches",
        )
        self.assertEqual(level, "green")
        self.assertFalse(destructive)

    def test_genuinely_destructive_commands_stay_red(self):
        for command, description in (
            ("git push --force", "force updates"),
            ("hermes peer kill", "Kill a peer"),
            ("/logout", "Log out"),
            ("gh repo delete", "Delete a repository"),
        ):
            level, destructive = safety(command, description)
            self.assertEqual(level, "red", command)
            self.assertTrue(destructive, command)

    def test_uninstall_is_not_downgraded_by_word_accurate_matching(self):
        # `uninstall` used to be caught only because it contains the substring `install`.
        level, _ = safety("hermes skills uninstall", "Removes a hub-installed skill")
        self.assertIn(level, {"amber", "red"})

    def test_explicit_override_beats_the_keyword_classifier(self):
        row = entry(
            "git", "shell-command", "git rebase", "Reapply commits on top of another base tip",
            "local: git help -a", "2.55.0", safety_override=("amber", False),
        )
        self.assertEqual(row["safety_level"], "amber")
        self.assertFalse(row["destructive"])

    def test_explicit_task_override_beats_the_keyword_classifier(self):
        row = entry(
            "git", "shell-command", "git commit", "Record changes to the repository",
            "local: git help -a", "2.55.0", task_override="development",
        )
        self.assertEqual(row["task_group"], "development")
        self.assertEqual(row["category"], "development")


class LenientRunner(unittest.TestCase):
    def test_reads_output_from_a_command_that_exits_non_zero(self):
        from scripts.adapters.common import run, run_lenient

        # `git <command> -h` prints its full option list and exits 129. The strict runner
        # uses check=True and silently returns "", so an adapter built on it would
        # catalog zero flags while the build stayed green.
        self.assertEqual(run("git", "push", "-h"), "")
        # The RAW output spells it `--[no-]force`; normalisation happens later in
        # `_normalise_flag`. Asserting on the raw spelling keeps this a test of the
        # runner rather than of the parser.
        self.assertIn("--[no-]force", run_lenient("git", "push", "-h"))

    def test_returns_empty_string_when_the_binary_is_missing(self):
        from scripts.adapters.common import run_lenient

        self.assertEqual(run_lenient("definitely-not-a-real-binary-xyz", "-h"), "")


if __name__ == "__main__":
    unittest.main()
