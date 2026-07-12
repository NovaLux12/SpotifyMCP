"""
Pytest wrapper for the SPOTIFY_HEADLESS=1 auth flow tests.

The primary test suite lives at ``tests/auth.headless.test.ts`` and is run
via ``node --import tsx --test`` (see ``package.json``'s ``test`` script).
This wrapper invokes that suite as a subprocess and asserts it passes — so
``pytest`` is a single entry point that confirms the headless auth tests
are green end-to-end.

Why a wrapper and not native Python tests?
    The auth flow is implemented in TypeScript (``src/auth.ts``).
    Re-implementing the validation logic in Python would duplicate the
    spec and risk drift. Spawning ``npm test`` keeps Python as the
    CI/outer gate while the actual assertions run in the same language
    as the code under test.

Tests included:
    - test_node_test_suite_passes:        npm test exits 0 and includes the new tests
    - test_auth_ts_exports_headless_helpers: src/auth.ts exposes the helpers
    - test_auth_ts_uses_isHeadless_mode:    src/auth.ts routes through the helper
    - test_readme_documents_headless:       README has the SPOTIFY_HEADLESS section
    - test_package_json_has_test_script:    package.json has a ``test`` script
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
AUTH_TS = REPO / "src" / "auth.ts"
README = REPO / "README.md"
PACKAGE_JSON = REPO / "package.json"


def _npm_test() -> subprocess.CompletedProcess[str]:
    """Run the JS test suite via npm and return the completed process."""
    npm = shutil.which("npm")
    if npm is None:
        pytest.skip("npm not on PATH — cannot run node:test suite")

    return subprocess.run(
        [npm, "test", "--silent"],
        cwd=str(REPO),
        capture_output=True,
        text=True,
        timeout=120,
        env={**os.environ, "NO_COLOR": "1", "FORCE_COLOR": "0"},
    )


def test_node_test_suite_passes() -> None:
    """The node:test suite for SPOTIFY_HEADLESS must pass end-to-end."""
    result = _npm_test()

    assert result.returncode == 0, (
        "npm test failed.\n"
        f"--- STDOUT ---\n{result.stdout}\n"
        f"--- STDERR ---\n{result.stderr}"
    )

    # Sanity: confirm the new test cases actually ran (not silently skipped).
    combined = result.stdout + result.stderr
    assert "isHeadlessMode" in combined, (
        "Test output doesn't mention isHeadlessMode — is the new suite wired up?"
    )
    assert "parseCallbackUrl" in combined, (
        "Test output doesn't mention parseCallbackUrl — is the new suite wired up?"
    )
    assert "# pass 9" in combined, (
        f"Expected 9 passes (3 isHeadlessMode + 6 parseCallbackUrl); got:\n{combined}"
    )


def test_auth_ts_exports_headless_helpers() -> None:
    """src/auth.ts must export isHeadlessMode() and parseCallbackUrl() for tests."""
    assert AUTH_TS.is_file(), f"missing {AUTH_TS}"
    src = AUTH_TS.read_text(encoding="utf-8")

    assert "export function isHeadlessMode" in src, (
        "src/auth.ts should export `isHeadlessMode()` so the env-var gate is testable"
    )
    assert "export function parseCallbackUrl" in src, (
        "src/auth.ts should export `parseCallbackUrl()` so the pasted-URL "
        "extraction/validation is testable"
    )


def test_auth_ts_routes_through_isHeadless_mode() -> None:
    """runAuthFlow() must branch on isHeadlessMode() (not the raw env var)."""
    src = AUTH_TS.read_text(encoding="utf-8")
    assert "if (isHeadlessMode())" in src, (
        "runAuthFlow() should branch on isHeadlessMode(), not "
        "`process.env.SPOTIFY_HEADLESS === '1'` directly — keeps the gate "
        "in one testable place"
    )
    # Defensive: no remaining raw env reads of the headless flag in runAuthFlow.
    # (isHeadlessMode() is the only allowed site.)
    assert src.count("process.env.SPOTIFY_HEADLESS") == 1, (
        "SPOTIFY_HEADLESS should only be read once, inside isHeadlessMode(). "
        "Found multiple raw env reads — refactor."
    )


def test_readme_documents_headless_mode() -> None:
    """README must document the SPOTIFY_HEADLESS=1 paste-URL flow."""
    assert README.is_file(), f"missing {README}"
    readme = README.read_text(encoding="utf-8")
    assert "SPOTIFY_HEADLESS" in readme, (
        "README should mention SPOTIFY_HEADLESS so users discover the flow"
    )
    # The PR's section header should be present (case-insensitive).
    lowered = readme.lower()
    assert "headless" in lowered, "README should have a Headless / remote hosts section"


def test_package_json_has_test_script() -> None:
    """package.json must have a ``test`` script that runs the JS suite."""
    pkg = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))
    scripts = pkg.get("scripts", {})
    assert "test" in scripts, "package.json missing 'scripts.test'"

    test_script = scripts["test"]
    assert "--test" in test_script, (
        f"'test' script should invoke node:test (via --test); got: {test_script!r}"
    )
    assert "tests/" in test_script, (
        f"'test' script should point at the tests/ dir; got: {test_script!r}"
    )