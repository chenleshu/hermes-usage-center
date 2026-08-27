from __future__ import annotations

import importlib.util
import json
import sqlite3
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
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
        self.assertEqual(result["by_model_periods"]["gpt-5.6-sol"]["today"]["input_tokens"], 100)
        self.assertEqual(result["by_model_periods"]["gpt-5.6-sol"]["week"]["input_tokens"], 300)
        self.assertEqual(result["by_model_periods"]["gpt-5.6-sol"]["month"]["input_tokens"], 600)

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
        self.assertEqual(result["by_model_periods"]["model-b"]["today"]["input_tokens"], 200)
        self.assertEqual(result["by_model_periods"]["model-a"]["today"]["input_tokens"], 100)


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
        self.assertEqual(result["windows"][0]["remaining_percent"], 98)
        self.assertEqual(result["windows"][0]["label"], "周额度")

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
        self.assertEqual(result["windows"][0]["remaining_percent"], 98)

    def test_cache_without_windows_is_normalized_for_the_desktop(self):
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
                        "used_percent": 6,
                        "remaining_percent": 94,
                        "reset_at": "2026-08-28T16:58:00+08:00",
                        "fetched_at": "2026-08-08T11:59:00+08:00",
                    }
                ),
                encoding="utf-8",
            )
            result = api.read_xai_cache(cache, now=now, max_age_seconds=900)

        self.assertEqual(result["status"], "available")
        self.assertEqual(len(result["windows"]), 1)
        self.assertEqual(result["windows"][0]["remaining_percent"], 94)
        window = api.provider_cycle_window(result, now)
        self.assertIsNotNone(window)
        self.assertEqual(window["kind"], "7d")


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


class ResetCycleTests(unittest.TestCase):
    def test_infer_cycle_start_uses_seven_days_for_weekly_reset(self):
        api = load_plugin_api()
        tz = ZoneInfo("Asia/Shanghai")
        now = datetime(2026, 8, 8, 12, 0, tzinfo=tz)
        reset = datetime(2026, 8, 14, 16, 58, tzinfo=tz)
        start, kind = api.infer_cycle_start(reset, now)
        self.assertEqual(kind, "7d")
        self.assertEqual(start, reset - timedelta(days=7))

    def test_infer_cycle_start_uses_five_hours_for_short_window(self):
        api = load_plugin_api()
        tz = ZoneInfo("Asia/Shanghai")
        now = datetime(2026, 8, 8, 12, 0, tzinfo=tz)
        reset = datetime(2026, 8, 8, 15, 12, tzinfo=tz)
        start, kind = api.infer_cycle_start(reset, now)
        self.assertEqual(kind, "5h")
        self.assertEqual(start, reset - timedelta(hours=5))

    def test_reset_cycle_counts_only_rows_inside_the_window(self):
        api = load_plugin_api()
        tz = ZoneInfo("Asia/Shanghai")
        now = datetime(2026, 8, 8, 12, 0, tzinfo=tz)
        reset = datetime(2026, 8, 14, 16, 58, tzinfo=tz)
        start = reset - timedelta(days=7)
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
                "INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ("old", "desktop", "grok-4.6", (start - timedelta(hours=2)).timestamp(),
                 9000, 0, 0, 0, 0, 0.0, 0.0, "unavailable", 1, "xai-oauth"),
            )
            conn.execute(
                "INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ("new", "desktop", "grok-4.6", (start + timedelta(hours=2)).timestamp(),
                 400, 20, 0, 0, 0, 0.0, 0.0, "unavailable", 1, "xai-oauth"),
            )
            conn.commit()
            conn.close()
            result = api.aggregate_reset_cycles(
                db_path,
                {"xai-oauth": {"start": start, "kind": "7d", "reset_at": reset, "label": "周额度"}},
                now=now,
                tz=tz,
                fallback_start=start,
            )

        self.assertEqual(result["by_provider"]["xai-oauth"]["input_tokens"], 400)
        self.assertEqual(result["by_model"]["grok-4.6"]["input_tokens"], 400)
        self.assertEqual(result["by_provider"]["xai-oauth"]["kind"], "7d")

    def test_weekly_label_near_reset_stays_seven_days(self):
        api = load_plugin_api()
        tz = ZoneInfo("Asia/Shanghai")
        now = datetime(2026, 8, 14, 12, 0, tzinfo=tz)
        reset = datetime(2026, 8, 14, 16, 58, tzinfo=tz)
        start, kind = api.infer_cycle_start(reset, now, "周额度")
        self.assertEqual(kind, "7d")
        self.assertEqual(start, reset - timedelta(days=7))

    def test_explicit_third_party_provider_is_kept(self):
        api = load_plugin_api()
        self.assertEqual(api.canonical_provider("openrouter", "gpt-5.6-sol"), "openrouter")
        self.assertEqual(api.canonical_provider("auto", "grok-4.6"), "xai-oauth")
        self.assertEqual(api.canonical_provider("auto", "gpt-5.6-sol"), "openai-codex")
        self.assertEqual(api.canonical_provider("", "claude-opus-4-6"), "anthropic")


class JmsTrafficTests(unittest.TestCase):
    def test_parses_bandwidth_and_subscription_urls(self):
        api = load_plugin_api()
        counter = api.parse_jms_endpoint(
            "https://justmysocks6.net/members/getbwcounter.php?service=1436858&id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        )
        sub = api.parse_jms_endpoint(
            "https://jmssub.net/members/getsub.php?service=1436858&id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        )
        self.assertEqual(counter["service"], "1436858")
        self.assertEqual(counter["id"], "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
        self.assertEqual(counter["host"], "justmysocks6.net")
        self.assertEqual(sub["service"], "1436858")
        self.assertEqual(sub["id"], "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
        self.assertEqual(sub["host"], "justmysocks6.net")

    def test_converts_justmysocks_bytes_with_decimal_gigabytes(self):
        api = load_plugin_api()
        self.assertEqual(api.bytes_to_gb(1_000_000_000_000), 1000.0)
        self.assertAlmostEqual(api.bytes_to_gb(268_380_703_102), 268.380703102)

    def test_next_reset_is_los_angeles_midnight_on_the_billing_day(self):
        api = load_plugin_api()
        tz = ZoneInfo("Asia/Shanghai")
        now = datetime(2026, 8, 27, 12, 0, tzinfo=tz)
        reset = api.next_jms_reset(15, now)
        self.assertEqual(reset.tzinfo, ZoneInfo("America/Los_Angeles"))
        self.assertEqual(reset.isoformat(), "2026-09-15T00:00:00-07:00")

    def test_daily_deltas_split_growth_and_treat_counter_drop_as_reset(self):
        api = load_plugin_api()
        tz = ZoneInfo("Asia/Shanghai")
        samples = [
            {"ts": "2026-08-26T08:00:00+08:00", "used_b": 100_000_000_000},
            {"ts": "2026-08-26T12:00:00+08:00", "used_b": 110_000_000_000},
            {"ts": "2026-08-26T18:00:00+08:00", "used_b": 125_000_000_000},
            {"ts": "2026-08-27T08:00:00+08:00", "used_b": 125_000_000_000},
            {"ts": "2026-08-27T10:00:00+08:00", "used_b": 2_000_000_000},
            {"ts": "2026-08-27T18:00:00+08:00", "used_b": 5_000_000_000},
        ]
        daily = {row["date"]: row["used_b"] for row in api.jms_daily_deltas(samples, tz)}
        self.assertEqual(daily["2026-08-26"], 25_000_000_000)
        self.assertEqual(daily["2026-08-27"], 2_000_000_000 + 3_000_000_000)

    def test_daily_deltas_split_cross_midnight_interval_by_elapsed_time(self):
        api = load_plugin_api()
        tz = ZoneInfo("Asia/Shanghai")
        samples = [
            {"ts": "2026-08-27T22:00:00+08:00", "used_b": 100},
            {"ts": "2026-08-28T02:00:00+08:00", "used_b": 500},
        ]

        daily = {row["date"]: row["used_b"] for row in api.jms_daily_deltas(samples, tz)}

        self.assertEqual(daily, {"2026-08-27": 200, "2026-08-28": 200})

    def test_daily_deltas_split_cross_week_and_long_downtime_deterministically(self):
        api = load_plugin_api()
        tz = ZoneInfo("Asia/Shanghai")
        samples = [
            {"ts": "2026-08-30T18:00:00+08:00", "used_b": 1_000},
            {"ts": "2026-09-01T06:00:00+08:00", "used_b": 4_600},
        ]

        daily = {row["date"]: row["used_b"] for row in api.jms_daily_deltas(samples, tz)}

        self.assertEqual(
            daily,
            {
                "2026-08-30": 600,
                "2026-08-31": 2_400,
                "2026-09-01": 600,
            },
        )
        summary = api.summarize_jms(
            samples,
            now=datetime(2026, 9, 1, 12, 0, tzinfo=tz),
            tz=tz,
        )
        self.assertEqual(summary["today_b"], 600)
        self.assertEqual(summary["week_b"], 3_000)

    def test_summary_uses_latest_sample_and_local_today_week_totals(self):
        api = load_plugin_api()
        tz = ZoneInfo("Asia/Shanghai")
        now = datetime(2026, 8, 27, 20, 0, tzinfo=tz)
        samples = [
            {"ts": "2026-08-24T10:00:00+08:00", "used_b": 200_000_000_000, "limit_b": 1_000_000_000_000, "reset_day": 15},
            {"ts": "2026-08-25T10:00:00+08:00", "used_b": 220_000_000_000, "limit_b": 1_000_000_000_000, "reset_day": 15},
            {"ts": "2026-08-26T10:00:00+08:00", "used_b": 250_000_000_000, "limit_b": 1_000_000_000_000, "reset_day": 15},
            {"ts": "2026-08-27T20:00:00+08:00", "used_b": 268_380_703_102, "limit_b": 1_000_000_000_000, "reset_day": 15},
        ]
        summary = api.summarize_jms(samples, now=now, tz=tz)
        self.assertEqual(summary["used_b"], 268_380_703_102)
        self.assertEqual(summary["limit_b"], 1_000_000_000_000)
        self.assertEqual(summary["remaining_b"], 1_000_000_000_000 - 268_380_703_102)
        self.assertAlmostEqual(summary["used_gb"], 268.380703102)
        self.assertEqual(summary["limit_gb"], 1000.0)
        self.assertEqual(summary["today_b"], 10_812_178_295)
        self.assertEqual(summary["week_b"], 68_380_703_102)
        self.assertEqual(summary["reset_day"], 15)
        self.assertEqual(summary["reset_at"], "2026-09-15T00:00:00-07:00")

    def test_public_config_masks_uuid(self):
        api = load_plugin_api()
        public = api.public_jms_config({
            "host": "justmysocks6.net",
            "service": "1436858",
            "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        })
        self.assertTrue(public["configured"])
        self.assertEqual(public["service"], "1436858")
        self.assertEqual(public["host"], "justmysocks6.net")
        self.assertEqual(public["id_masked"], "aaaa…eeee")
        self.assertNotIn("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", json.dumps(public))

    def test_rejects_malformed_service_and_uuid(self):
        api = load_plugin_api()
        invalid = [
            "service=12x&id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "service=1436858&id=not-a-uuid",
            "service=1436858&id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee",
        ]
        for endpoint in invalid:
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                api.parse_jms_endpoint(endpoint)

    def test_fetch_url_encodes_query_parameters(self):
        api = load_plugin_api()
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({
            "bw_counter_b": 10,
            "monthly_bw_limit_b": 100,
            "bw_reset_day_of_month": 15,
        }).encode()
        config = {
            "host": "justmysocks6.net",
            "service": "1436858",
            "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        }
        with patch.object(api, "urlopen", return_value=response) as opened:
            api.fetch_jms_counter(config)
        self.assertEqual(
            opened.call_args.args[0].full_url,
            "https://justmysocks6.net/members/getbwcounter.php?service=1436858&id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        )

    def test_history_is_scoped_to_irreversible_service_uuid_fingerprint(self):
        api = load_plugin_api()
        first = {
            "host": "justmysocks6.net",
            "service": "1436858",
            "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        }
        second = {
            "host": "justmysocks6.net",
            "service": "1436858",
            "id": "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
        }
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            first_identity = api.jms_config_fingerprint(first)
            api.append_jms_sample(
                home,
                {
                    "ts": "2026-08-27T10:00:00+08:00",
                    "used_b": 10,
                    "limit_b": 100,
                    "reset_day": 15,
                    "id": first["id"],
                },
                identity=first_identity,
            )
            raw = (home / "usage-center" / "jms-history.json").read_text(encoding="utf-8")
            self.assertNotIn(first["id"], raw)
            self.assertIn(first_identity, raw)
            self.assertEqual(api.load_jms_samples(home, identity=first_identity)[0]["used_b"], 10)
            self.assertEqual(api.load_jms_samples(home, identity=api.jms_config_fingerprint(second)), [])

    def test_new_config_first_fetch_failure_never_surfaces_old_stale_samples(self):
        api = load_plugin_api()
        old_config = {
            "host": "justmysocks6.net",
            "service": "1436858",
            "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        }
        new_config = {
            "host": "justmysocks6.net",
            "service": "1436859",
            "id": "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
        }
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            api.save_jms_config(home, old_config)
            api.append_jms_sample(
                home,
                {"ts": "2026-08-27T10:00:00+08:00", "used_b": 90, "limit_b": 100, "reset_day": 15},
                identity=api.jms_config_fingerprint(old_config),
            )
            api.save_jms_config(home, new_config)
            with (
                patch.object(api, "resolve_profile_home", return_value=("test", home)),
                patch.object(api, "fetch_jms_counter", side_effect=OSError("offline")),
            ):
                result = api.build_jms(profile="test", force=True)

        self.assertEqual(result["status"], "unavailable")
        self.assertIsNone(result["usage"])
        self.assertEqual(result["sample_count"], 0)

    def test_delete_then_reconfigure_same_identity_does_not_restore_old_samples(self):
        api = load_plugin_api()
        config = {
            "host": "justmysocks6.net",
            "service": "1436858",
            "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        }
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            api.save_jms_config(home, config)
            api.append_jms_sample(
                home,
                {"ts": "2026-08-27T10:00:00+08:00", "used_b": 90, "limit_b": 100, "reset_day": 15},
                identity=api.jms_config_fingerprint(config),
            )
            api.clear_jms_config(home)
            api.save_jms_config(home, config)
            with (
                patch.object(api, "resolve_profile_home", return_value=("test", home)),
                patch.object(api, "fetch_jms_counter", side_effect=OSError("offline")),
            ):
                result = api.build_jms(profile="test", force=True)

        self.assertEqual(result["status"], "unavailable")
        self.assertIsNone(result["usage"])
        self.assertEqual(result["sample_count"], 0)

    def test_concurrent_forced_refreshes_serialize_fetch_and_append(self):
        api = load_plugin_api()
        config = {
            "host": "justmysocks6.net",
            "service": "1436858",
            "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        }
        active = 0
        max_active = 0
        sequence = 0
        state_lock = threading.Lock()

        def fetch(_config):
            nonlocal active, max_active, sequence
            with state_lock:
                active += 1
                max_active = max(max_active, active)
                sequence += 1
                current = sequence
            time.sleep(0.02)
            with state_lock:
                active -= 1
            return {
                "ts": f"2026-08-27T10:00:{current:02d}+08:00",
                "used_b": current,
                "limit_b": 100,
                "reset_day": 15,
            }

        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            api.save_jms_config(home, config)
            with (
                patch.object(api, "resolve_profile_home", return_value=("test", home)),
                patch.object(api, "fetch_jms_counter", side_effect=fetch),
                ThreadPoolExecutor(max_workers=6) as pool,
            ):
                results = list(pool.map(lambda _: api.build_jms(profile="test", force=True), range(6)))
            samples = api.load_jms_samples(home, identity=api.jms_config_fingerprint(config))

        self.assertEqual(max_active, 1)
        self.assertEqual(len(samples), 6)
        self.assertTrue(all(result["status"] == "available" for result in results))

    def test_config_save_waits_for_inflight_fetch_append_transaction(self):
        api = load_plugin_api()
        old_config = {
            "host": "justmysocks6.net",
            "service": "1436858",
            "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        }
        new_config = {
            "host": "justmysocks6.net",
            "service": "1436859",
            "id": "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
        }
        entered = threading.Event()
        release = threading.Event()

        def fetch(_config):
            entered.set()
            self.assertTrue(release.wait(timeout=2))
            return {
                "ts": "2026-08-27T10:00:00+08:00",
                "used_b": 10,
                "limit_b": 100,
                "reset_day": 15,
            }

        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            api.save_jms_config(home, old_config)
            with (
                patch.object(api, "resolve_profile_home", return_value=("test", home)),
                patch.object(api, "fetch_jms_counter", side_effect=fetch),
                ThreadPoolExecutor(max_workers=2) as pool,
            ):
                refresh_future = pool.submit(api.build_jms, profile="test", force=True)
                self.assertTrue(entered.wait(timeout=2))
                save_future = pool.submit(api.save_jms_config, home, new_config)
                time.sleep(0.03)
                self.assertFalse(save_future.done())
                release.set()
                refresh_future.result(timeout=2)
                save_future.result(timeout=2)

            self.assertEqual(api.load_jms_config(home)["service"], new_config["service"])
            self.assertEqual(
                api.load_jms_samples(home, identity=api.jms_config_fingerprint(new_config)),
                [],
            )


class DesktopJmsProfileIsolationTests(unittest.TestCase):
    def test_jms_query_key_uses_authoritative_profile(self):
        source = (PLUGIN_API.parents[1] / "desktop" / "plugin.js").read_text(encoding="utf-8")
        self.assertIn("function jmsQueryKey(profile)", source)
        self.assertIn("return ['usage-center', 'jms', profile || 'default']", source)
        use_jms = source[source.index("function useJms"):source.index("function JmsConfigForm")]
        self.assertIn("const profile = useHostState('profile')", use_jms)
        self.assertIn("queryKey: jmsQueryKey(profile)", use_jms)
        self.assertIn("placeholderData: () => undefined", use_jms)
        self.assertNotIn("queryKey: ['usage-center', 'jms']", source)


if __name__ == "__main__":
    unittest.main()
