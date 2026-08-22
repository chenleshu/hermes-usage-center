from __future__ import annotations

import importlib.util
import json
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from zoneinfo import ZoneInfo


PLUGIN_API = (
    Path(__file__).resolve().parents[1]
    / "dashboard"
    / "plugin_api.py"
)


def load_plugin_api():
    spec = importlib.util.spec_from_file_location("usage_center_plugin_api_test", PLUGIN_API)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load usage-center plugin API")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class UsageAggregationTests(unittest.TestCase):
    def test_natural_periods_are_attributed_by_session_start_in_local_timezone(self):
        api = load_plugin_api()
        tz = ZoneInfo("Asia/Shanghai")
        now = datetime(2026, 8, 8, 12, 0, tzinfo=tz)

        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "state.db"
            conn = sqlite3.connect(db_path)
            conn.execute(
                """
                CREATE TABLE sessions (
                    id TEXT PRIMARY KEY,
                    source TEXT,
                    model TEXT,
                    started_at REAL,
                    input_tokens INTEGER,
                    output_tokens INTEGER,
                    cache_read_tokens INTEGER,
                    cache_write_tokens INTEGER,
                    reasoning_tokens INTEGER,
                    estimated_cost_usd REAL,
                    actual_cost_usd REAL,
                    cost_status TEXT,
                    api_call_count INTEGER,
                    billing_provider TEXT
                )
                """
            )

            def add(sid: str, when: datetime, tokens: int) -> None:
                conn.execute(
                    "INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        sid,
                        "desktop",
                        "gpt-5.6-sol",
                        when.timestamp(),
                        tokens,
                        10,
                        5,
                        0,
                        2,
                        0.25,
                        0.0,
                        "estimated",
                        1,
                        "openai-codex",
                    ),
                )

            add("today", datetime(2026, 8, 8, 1, 0, tzinfo=tz), 100)
            add("week", datetime(2026, 8, 4, 1, 0, tzinfo=tz), 200)
            add("month", datetime(2026, 8, 1, 1, 0, tzinfo=tz), 300)
            add("older", datetime(2026, 7, 31, 23, 59, tzinfo=tz), 400)
            conn.commit()
            conn.close()

            result = api.aggregate_usage(db_path, now=now, tz=tz, trend_days=30)

        self.assertEqual(result["periods"]["today"]["input_tokens"], 100)
        self.assertEqual(result["periods"]["week"]["input_tokens"], 300)
        self.assertEqual(result["periods"]["month"]["input_tokens"], 600)
        self.assertEqual(result["periods"]["today"]["total_tokens"], 117)
        self.assertEqual(result["periods"]["month"]["api_calls"], 3)
        self.assertEqual(result["rolling"]["7d"]["input_tokens"], 300)
        self.assertEqual(result["rolling"]["30d"]["input_tokens"], 1000)
        self.assertEqual(result["by_model"][0]["name"], "gpt-5.6-sol")
        self.assertEqual(result["by_model"][0]["input_tokens"], 1000)
        self.assertEqual(result["by_provider"][0]["name"], "openai-codex")
        self.assertEqual(result["by_source"][0]["name"], "desktop")
        self.assertEqual(result["quality"]["time_attribution"], "session_started_at")
        self.assertEqual(result["by_provider_periods"]["openai-codex"]["today"]["input_tokens"], 100)
        self.assertEqual(result["by_provider_periods"]["openai-codex"]["week"]["input_tokens"], 300)
        self.assertEqual(result["by_provider_periods"]["openai-codex"]["month"]["input_tokens"], 600)
        self.assertEqual(result["by_provider_periods"]["openai-codex"]["today"]["sessions"], 1)

    def test_model_distribution_uses_session_model_usage_when_available(self):
        api = load_plugin_api()
        tz = ZoneInfo("Asia/Shanghai")
        now = datetime(2026, 8, 8, 12, 0, tzinfo=tz)
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "state.db"
            conn = sqlite3.connect(db_path)
            conn.execute(
                """
                CREATE TABLE sessions (
                    id TEXT PRIMARY KEY, source TEXT, model TEXT, started_at REAL,
                    input_tokens INTEGER, output_tokens INTEGER,
                    cache_read_tokens INTEGER, cache_write_tokens INTEGER,
                    reasoning_tokens INTEGER, estimated_cost_usd REAL,
                    actual_cost_usd REAL, cost_status TEXT,
                    api_call_count INTEGER, billing_provider TEXT
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE session_model_usage (
                    session_id TEXT, model TEXT, billing_provider TEXT,
                    api_call_count INTEGER, input_tokens INTEGER,
                    output_tokens INTEGER, cache_read_tokens INTEGER,
                    cache_write_tokens INTEGER, reasoning_tokens INTEGER,
                    estimated_cost_usd REAL, actual_cost_usd REAL,
                    last_seen REAL
                )
                """
            )
            started = datetime(2026, 8, 8, 1, 0, tzinfo=tz).timestamp()
            conn.execute(
                "INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    "switched", "desktop", "final-model", started,
                    300, 30, 0, 0, 0, 0.0, 0.0, "unavailable", 3, "final-provider",
                ),
            )
            conn.executemany(
                "INSERT INTO session_model_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    ("switched", "model-a", "provider-a", 1, 100, 10, 0, 0, 0, 0.0, 0.0, started + 1),
                    ("switched", "model-b", "provider-b", 2, 200, 20, 0, 0, 0, 0.0, 0.0, started + 2),
                ],
            )
            conn.commit()
            conn.close()

            result = api.aggregate_usage(db_path, now=now, tz=tz, trend_days=30)
            current = api.get_session_usage(db_path, "switched")

        self.assertEqual([row["name"] for row in result["by_model"]], ["model-b", "model-a"])
        self.assertEqual([row["name"] for row in result["by_provider"]], ["provider-b", "provider-a"])
        self.assertEqual(current["model"], "model-b")
        self.assertEqual(current["provider"], "provider-b")
        self.assertEqual(current["total_tokens"], 330)


class XaiUsageParsingTests(unittest.TestCase):
    def test_parses_official_grok_weekly_usage_and_reset_from_ansi_output(self):
        api = load_plugin_api()
        tz = ZoneInfo("Asia/Shanghai")
        now = datetime(2026, 8, 8, 12, 0, tzinfo=tz)
        raw = (
            "\x1b[2mWeekly limit: 2%\x1b[22m\r\n"
            "Next reset: August 14, 16:58\r\n"
        )

        result = api.parse_xai_usage(raw, now=now, tz=tz)

        self.assertEqual(result["used_percent"], 2)
        self.assertEqual(result["remaining_percent"], 98)
        self.assertEqual(result["reset_at"], "2026-08-14T16:58:00+08:00")
        self.assertEqual(result["source"], "grok_build_usage")

    def test_stale_cache_keeps_last_value_but_marks_it_stale(self):
        api = load_plugin_api()
        tz = ZoneInfo("Asia/Shanghai")
        now = datetime(2026, 8, 8, 12, 0, tzinfo=tz)
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "xai-usage.json"
            cache.write_text(
                json.dumps(
                    {
                        "provider": "xai-oauth",
                        "status": "available",
                        "used_percent": 2,
                        "remaining_percent": 98,
                        "reset_at": "2026-08-14T16:58:00+08:00",
                        "fetched_at": "2026-08-08T11:00:00+08:00",
                    }
                ),
                encoding="utf-8",
            )

            result = api.read_xai_cache(cache, now=now, max_age_seconds=900)

        self.assertEqual(result["status"], "stale")
        self.assertEqual(result["remaining_percent"], 98)


class AccountUsageSerializationTests(unittest.TestCase):
    def test_serializes_codex_snapshot_without_exposing_credentials(self):
        api = load_plugin_api()
        reset = datetime(2026, 8, 10, 3, 0, tzinfo=timezone.utc)
        snapshot = SimpleNamespace(
            provider="openai-codex",
            source="codex_backend_usage",
            fetched_at=datetime(2026, 8, 8, 4, 0, tzinfo=timezone.utc),
            title="Codex limits",
            plan="Plus",
            windows=(
                SimpleNamespace(
                    label="Weekly",
                    used_percent=41.0,
                    reset_at=reset,
                    detail=None,
                ),
            ),
            details=("Banked resets: 2",),
            unavailable_reason=None,
            available=True,
        )

        result = api.serialize_account_usage(snapshot)

        self.assertEqual(result["status"], "available")
        self.assertEqual(result["windows"][0]["remaining_percent"], 59.0)
        self.assertEqual(result["windows"][0]["reset_at"], reset.isoformat())
        self.assertNotIn("token", str(result).lower())

    def test_codex_cache_is_isolated_by_profile_home(self):
        api = load_plugin_api()
        api._codex_cache.clear()
        calls = []

        def fetch_account_usage(_provider):
            active_home = api.get_hermes_home().resolve()
            calls.append(active_home)
            return SimpleNamespace(
                provider="openai-codex",
                source="usage_api",
                fetched_at=datetime(2026, 8, 19, tzinfo=timezone.utc),
                title="Codex limits",
                plan=active_home.name,
                windows=(),
                details=(),
                unavailable_reason=None,
                available=True,
            )

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first_home = root / "first"
            second_home = root / "second"
            first_home.mkdir()
            second_home.mkdir()
            with patch("agent.account_usage.fetch_account_usage", side_effect=fetch_account_usage):
                first = api.get_codex_usage(first_home)
                first_cached = api.get_codex_usage(first_home)
                second = api.get_codex_usage(second_home)

        self.assertEqual(first["plan"], "first")
        self.assertEqual(first_cached["plan"], "first")
        self.assertEqual(second["plan"], "second")
        self.assertEqual(calls, [first_home.resolve(), second_home.resolve()])


class AnthropicUsageTests(unittest.TestCase):
    def test_localizes_known_claude_window_labels_only(self):
        api = load_plugin_api()
        result = api._localize_claude_windows(
            {
                "provider": "anthropic",
                "windows": [
                    {"label": "Current session", "remaining_percent": 100},
                    {"label": "Current week", "remaining_percent": 83},
                    {"label": "Custom", "remaining_percent": 10},
                ],
            }
        )
        self.assertEqual(
            [window["label"] for window in result["windows"]],
            ["5小时窗", "本周", "Custom"],
        )

    def test_none_snapshot_uses_requested_provider(self):
        api = load_plugin_api()
        result = api.serialize_account_usage(None, default_provider="anthropic")
        self.assertEqual(result["provider"], "anthropic")
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["windows"], [])

    def test_anthropic_cache_is_isolated_by_profile_home(self):
        api = load_plugin_api()
        api._anthropic_cache.clear()
        calls = []

        def fetch_account_usage(provider):
            self.assertEqual(provider, "anthropic")
            active_home = api.get_hermes_home().resolve()
            calls.append(active_home)
            return SimpleNamespace(
                provider="anthropic",
                source="oauth_usage_api",
                fetched_at=datetime(2026, 8, 19, tzinfo=timezone.utc),
                title="Account limits",
                plan=None,
                windows=(
                    SimpleNamespace(
                        label="Current session",
                        used_percent=0.0,
                        reset_at=datetime(2026, 8, 19, 13, 20, tzinfo=timezone.utc),
                        detail=None,
                    ),
                ),
                details=(),
                unavailable_reason=None,
                available=True,
            )

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first_home = root / "first"
            second_home = root / "second"
            first_home.mkdir()
            second_home.mkdir()
            with patch("agent.account_usage.fetch_account_usage", side_effect=fetch_account_usage):
                first = api.get_anthropic_usage(first_home)
                first_cached = api.get_anthropic_usage(first_home)
                second = api.get_anthropic_usage(second_home)

        self.assertEqual(first["windows"][0]["label"], "5小时窗")
        self.assertEqual(first["windows"][0]["remaining_percent"], 100.0)
        self.assertEqual(first_cached["windows"][0]["label"], "5小时窗")
        self.assertEqual(second["provider"], "anthropic")
        self.assertEqual(calls, [first_home.resolve(), second_home.resolve()])


class ProfileRoutingTests(unittest.TestCase):
    def test_named_profile_resolves_to_its_own_home(self):
        api = load_plugin_api()
        with tempfile.TemporaryDirectory() as tmp:
            expected = Path(tmp) / "profiles" / "research"
            expected.mkdir(parents=True)
            with (
                patch.object(api, "profile_exists", return_value=True),
                patch.object(api, "get_profile_dir", return_value=expected),
            ):
                name, home = api.resolve_profile_home("Research")

        self.assertEqual(name, "research")
        self.assertEqual(home, expected)

    def test_missing_profile_is_reported_as_not_found(self):
        api = load_plugin_api()
        with patch.object(api, "profile_exists", return_value=False):
            with self.assertRaises(api.HTTPException) as raised:
                api.resolve_profile_home("missing")

        self.assertEqual(raised.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
