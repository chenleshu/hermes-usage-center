"""Local usage aggregation API for the Hermes usage-center plugin.

Mounted at /api/plugins/usage-center by the Hermes desktop/dashboard backend.
"""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
import json
import os
import queue
import re
import shutil
import sqlite3
import threading
import time as time_module
from collections import defaultdict
from datetime import datetime, time, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException
from hermes_cli.profiles import (
    get_profile_dir,
    normalize_profile_name,
    profile_exists,
    validate_profile_name,
)
from hermes_constants import (
    get_hermes_home,
    reset_hermes_home_override,
    set_hermes_home_override,
)

router = APIRouter()

LOCAL_TZ = ZoneInfo("Asia/Shanghai")
XAI_CACHE_MAX_AGE_SECONDS = 15 * 60
CODEX_CACHE_MAX_AGE_SECONDS = 5 * 60
ANTHROPIC_CACHE_MAX_AGE_SECONDS = 5 * 60
_xai_refresh_lock = threading.Lock()
_codex_refresh_lock = threading.Lock()
_anthropic_refresh_lock = threading.Lock()
_codex_cache: dict[str, dict[str, Any]] = {}
_anthropic_cache: dict[str, dict[str, Any]] = {}
CLAUDE_WINDOW_LABELS = {
    "Current session": "5小时窗",
    "Current week": "本周",
    "Opus week": "本周 Opus",
    "Sonnet week": "本周 Sonnet",
}

TOKEN_FIELDS = (
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "reasoning_tokens",
)

ANSI_RE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x1b]*(?:\x1b\\|\x07))")
XAI_WEEKLY_RE = re.compile(r"Weekly\s+limit:\s*(\d+(?:\.\d+)?)%", re.IGNORECASE)
XAI_RESET_RE = re.compile(
    r"Next\s+reset:\s*([A-Za-z]+\s+\d{1,2},\s*\d{1,2}:\d{2})",
    re.IGNORECASE,
)


def resolve_profile_home(profile: str | None) -> tuple[str, Path]:
    """Resolve a REST profile parameter without mutating process-wide state."""
    requested = str(profile or "").strip()
    if not requested:
        return "current", get_hermes_home()
    try:
        canonical = normalize_profile_name(requested)
        validate_profile_name(canonical)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not profile_exists(canonical):
        raise HTTPException(status_code=404, detail=f"Hermes profile {canonical!r} does not exist")
    return canonical, get_profile_dir(canonical)


@contextmanager
def _profile_scope(home: Path):
    """Scope Hermes credential/config reads to one profile for this context."""
    token = set_hermes_home_override(home)
    try:
        yield
    finally:
        reset_hermes_home_override(token)


def parse_xai_usage(
    output: str,
    *,
    now: datetime | None = None,
    tz: ZoneInfo | None = None,
) -> dict[str, Any]:
    """Parse the official weekly quota lines emitted by Grok Build ``/usage``."""
    local_tz = tz or ZoneInfo("Asia/Shanghai")
    current = (now or datetime.now(local_tz)).astimezone(local_tz)
    plain = ANSI_RE.sub("", output or "")
    weekly = XAI_WEEKLY_RE.search(plain)
    reset = XAI_RESET_RE.search(plain)
    if weekly is None or reset is None:
        raise ValueError("Grok /usage output did not contain weekly quota and reset time")

    used = max(0.0, min(100.0, float(weekly.group(1))))
    parsed = None
    for fmt in ("%B %d, %H:%M", "%b %d, %H:%M"):
        try:
            parsed = datetime.strptime(reset.group(1), fmt)
            break
        except ValueError:
            continue
    if parsed is None:
        raise ValueError("Grok /usage reset time was not understood")
    reset_at = parsed.replace(year=current.year, tzinfo=local_tz)
    if reset_at < current:
        reset_at = reset_at.replace(year=current.year + 1)

    return {
        "provider": "xai-oauth",
        "status": "available",
        "used_percent": used,
        "remaining_percent": max(0.0, 100.0 - used),
        "reset_at": reset_at.isoformat(),
        "source": "grok_build_usage",
        "confidence": "official_client",
    }


def read_xai_cache(
    path: str | Path,
    *,
    now: datetime | None = None,
    max_age_seconds: int = 900,
) -> dict[str, Any]:
    """Read the sanitized Grok usage cache and surface freshness explicitly."""
    cache_path = Path(path)
    if not cache_path.exists():
        return {
            "provider": "xai-oauth",
            "status": "unavailable",
            "reason": "No Grok usage sample has been collected yet",
        }
    try:
        data = json.loads(cache_path.read_text(encoding="utf-8"))
        fetched_at = datetime.fromisoformat(str(data["fetched_at"]).replace("Z", "+00:00"))
        current = now or datetime.now(fetched_at.tzinfo)
        age = max(0.0, (current.astimezone(fetched_at.tzinfo) - fetched_at).total_seconds())
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
        return {
            "provider": "xai-oauth",
            "status": "unavailable",
            "reason": f"Grok usage cache is unreadable: {type(exc).__name__}",
        }
    result = dict(data)
    result["age_seconds"] = round(age)
    if age > max(1, int(max_age_seconds)):
        result["status"] = "stale"
    return result


def serialize_account_usage(
    snapshot: Any,
    *,
    default_provider: str = "openai-codex",
) -> dict[str, Any]:
    """Convert Hermes' account snapshot into a credential-free JSON shape."""
    if snapshot is None:
        return {
            "provider": default_provider,
            "status": "unavailable",
            "reason": "No account usage data returned",
            "windows": [],
        }

    windows = []
    for window in snapshot.windows:
        used = window.used_percent
        used_value = None if used is None else max(0.0, min(100.0, float(used)))
        reset_at = window.reset_at.isoformat() if window.reset_at else None
        windows.append(
            {
                "label": window.label,
                "used_percent": used_value,
                "remaining_percent": None if used_value is None else 100.0 - used_value,
                "reset_at": reset_at,
                "detail": window.detail,
            }
        )

    return {
        "provider": snapshot.provider,
        "status": "available" if snapshot.available else "unavailable",
        "source": snapshot.source,
        "fetched_at": snapshot.fetched_at.isoformat(),
        "title": snapshot.title,
        "plan": snapshot.plan,
        "windows": windows,
        "details": list(snapshot.details),
        "reason": snapshot.unavailable_reason,
    }


def _start_of_day(value: datetime) -> datetime:
    return datetime.combine(value.date(), time.min, tzinfo=value.tzinfo)


def _period_starts(now: datetime) -> dict[str, datetime]:
    day = _start_of_day(now)
    return {
        "today": day,
        "week": day - timedelta(days=day.weekday()),
        "month": day.replace(day=1),
    }


PROVIDER_ALIASES = {
    "xai-oauth": "xai-oauth",
    "xai": "xai-oauth",
    "grok": "xai-oauth",
    "openai-codex": "openai-codex",
    "openai": "openai-codex",
    "codex": "openai-codex",
    "anthropic": "anthropic",
    "claude": "anthropic",
}


def canonical_provider(provider: str | None, model: str | None = None) -> str:
    key = str(provider or "").strip().lower()
    if key in PROVIDER_ALIASES:
        return PROVIDER_ALIASES[key]
    if key and key not in {"auto", "unknown"}:
        return key
    model_l = str(model or "").strip().lower()
    if model_l.startswith("grok") or "grok" in model_l:
        return "xai-oauth"
    if model_l.startswith("gpt") or "codex" in model_l:
        return "openai-codex"
    if any(token in model_l for token in ("claude", "sonnet", "opus", "haiku")):
        return "anthropic"
    return key or "unknown"


def parse_reset_at(value: Any, tz: ZoneInfo) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=tz)
    return parsed.astimezone(tz)


def infer_cycle_start(
    reset_at: datetime | None,
    now: datetime,
    label: str | None = None,
) -> tuple[datetime | None, str]:
    """Infer the open quota window from official reset time and label.

    Remaining hours alone is not enough: a weekly window with 3 hours left
    is still a 7-day cycle, not a 5-hour one.
    """
    if reset_at is None:
        return None, "unknown"
    text = str(label or "").lower()
    if any(token in text for token in ("5小时", "5-hour", "5 hour", "5h")):
        return reset_at - timedelta(hours=5), "5h"
    if any(token in text for token in ("周", "week")):
        return reset_at - timedelta(days=7), "7d"
    if any(token in text for token in ("月", "month")):
        return reset_at - timedelta(days=30), "30d"
    hours = (reset_at - now).total_seconds() / 3600
    if hours <= 0:
        return now, "due"
    if hours <= 8:
        return reset_at - timedelta(hours=5), "5h"
    if hours <= 8 * 24:
        return reset_at - timedelta(days=7), "7d"
    return reset_at - timedelta(days=30), "30d"


def provider_cycle_window(data: dict[str, Any] | None, now: datetime) -> dict[str, Any] | None:
    if not data:
        return None
    tz = now.tzinfo or LOCAL_TZ
    candidates = list(data.get("windows") or [])
    if not candidates and data.get("reset_at"):
        candidates = [{
            "reset_at": data.get("reset_at"),
            "remaining_percent": data.get("remaining_percent"),
            "label": data.get("label") or "额度",
        }]
    usable = []
    for window in candidates:
        reset = parse_reset_at(window.get("reset_at"), tz)
        if reset is None:
            continue
        remaining = window.get("remaining_percent")
        usable.append((window, reset, remaining))
    if not usable:
        return None
    window, reset, remaining = min(
        usable,
        key=lambda item: 1000 if item[2] is None else float(item[2]),
    )
    start, kind = infer_cycle_start(reset, now, window.get("label"))
    if start is None:
        return None
    return {
        "kind": kind,
        "start": start,
        "reset_at": reset,
        "label": window.get("label") or "额度",
    }


def aggregate_reset_cycles(
    db_path: str | Path,
    provider_windows: dict[str, dict[str, Any]],
    *,
    now: datetime,
    tz: ZoneInfo,
    fallback_start: datetime,
) -> dict[str, Any]:
    """Sum local tokens since each provider's inferred reset-cycle start."""
    by_provider: dict[str, dict[str, Any]] = {}
    by_model: dict[str, dict[str, Any]] = {}
    earliest = fallback_start
    for window in provider_windows.values():
        start = window.get("start")
        if isinstance(start, datetime) and start < earliest:
            earliest = start

    conn = sqlite3.connect(f"file:{Path(db_path).as_posix()}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        has_model_usage = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_model_usage'"
        ).fetchone()
        if has_model_usage:
            rows = conn.execute(
                """
                SELECT u.session_id AS id, u.model, u.billing_provider, s.started_at,
                       COALESCE(u.api_call_count, 0) AS api_call_count,
                       COALESCE(u.input_tokens, 0) AS input_tokens,
                       COALESCE(u.output_tokens, 0) AS output_tokens,
                       COALESCE(u.cache_read_tokens, 0) AS cache_read_tokens,
                       COALESCE(u.cache_write_tokens, 0) AS cache_write_tokens,
                       COALESCE(u.reasoning_tokens, 0) AS reasoning_tokens,
                       COALESCE(u.estimated_cost_usd, 0) AS estimated_cost_usd,
                       COALESCE(u.actual_cost_usd, 0) AS actual_cost_usd
                  FROM session_model_usage u
                  JOIN sessions s ON s.id = u.session_id
                 WHERE s.started_at >= ?
                UNION ALL
                SELECT s.id, s.model, s.billing_provider, s.started_at,
                       COALESCE(s.api_call_count, 0),
                       COALESCE(s.input_tokens, 0),
                       COALESCE(s.output_tokens, 0),
                       COALESCE(s.cache_read_tokens, 0),
                       COALESCE(s.cache_write_tokens, 0),
                       COALESCE(s.reasoning_tokens, 0),
                       COALESCE(s.estimated_cost_usd, 0),
                       COALESCE(s.actual_cost_usd, 0)
                  FROM sessions s
                 WHERE s.started_at >= ?
                   AND NOT EXISTS (
                       SELECT 1 FROM session_model_usage u WHERE u.session_id = s.id
                   )
                """,
                (earliest.timestamp(), earliest.timestamp()),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT id, source, model, started_at, billing_provider,
                       COALESCE(api_call_count, 0) AS api_call_count,
                       COALESCE(input_tokens, 0) AS input_tokens,
                       COALESCE(output_tokens, 0) AS output_tokens,
                       COALESCE(cache_read_tokens, 0) AS cache_read_tokens,
                       COALESCE(cache_write_tokens, 0) AS cache_write_tokens,
                       COALESCE(reasoning_tokens, 0) AS reasoning_tokens,
                       COALESCE(estimated_cost_usd, 0) AS estimated_cost_usd,
                       COALESCE(actual_cost_usd, 0) AS actual_cost_usd
                  FROM sessions
                 WHERE started_at >= ?
                """,
                (earliest.timestamp(),),
            ).fetchall()
    finally:
        conn.close()

    def _bucket(kind: str, start: datetime, reset: datetime | None, label: str) -> dict[str, Any]:
        total = _empty_totals()
        total["kind"] = kind
        total["start"] = start.isoformat()
        total["reset_at"] = reset.isoformat() if reset else None
        total["label"] = label
        total["source"] = "local_since_reset"
        return total

    for row in rows:
        started = datetime.fromtimestamp(float(row["started_at"]), tz=tz)
        provider = canonical_provider(row["billing_provider"], row["model"])
        model = str(row["model"] or "unknown")
        window = provider_windows.get(provider)
        if window:
            start, kind, reset, label = window["start"], window["kind"], window["reset_at"], window.get("label") or "额度"
        else:
            start, kind, reset, label = fallback_start, "calendar_week", None, "自然周"
        if started < start:
            continue
        if provider not in by_provider:
            by_provider[provider] = _bucket(kind, start, reset, label)
        if model not in by_model:
            by_model[model] = _bucket(kind, start, reset, label)
        _add_row(by_provider[provider], row)
        _add_row(by_model[model], row)

    return {"by_provider": by_provider, "by_model": by_model}


def _empty_totals() -> dict[str, Any]:
    return {
        "sessions": 0,
        "api_calls": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "reasoning_tokens": 0,
        "total_tokens": 0,
        "estimated_cost_usd": 0.0,
        "actual_cost_usd": 0.0,
    }


def _add_row(total: dict[str, Any], row: sqlite3.Row) -> None:
    total["sessions"] += 1
    total["api_calls"] += int(row["api_call_count"] or 0)
    token_total = 0
    for field in TOKEN_FIELDS:
        value = int(row[field] or 0)
        total[field] += value
        token_total += value
    total["total_tokens"] += token_total
    total["estimated_cost_usd"] += float(row["estimated_cost_usd"] or 0.0)
    total["actual_cost_usd"] += float(row["actual_cost_usd"] or 0.0)


def get_session_usage(db_path: str | Path, session_id: str | None) -> dict[str, Any] | None:
    """Return the selected session's totals and latest actually-used provider."""
    if not session_id:
        return None
    conn = sqlite3.connect(f"file:{Path(db_path).as_posix()}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            """
            SELECT id, source, model, billing_provider, started_at,
                   COALESCE(api_call_count, 0) AS api_call_count,
                   COALESCE(input_tokens, 0) AS input_tokens,
                   COALESCE(output_tokens, 0) AS output_tokens,
                   COALESCE(cache_read_tokens, 0) AS cache_read_tokens,
                   COALESCE(cache_write_tokens, 0) AS cache_write_tokens,
                   COALESCE(reasoning_tokens, 0) AS reasoning_tokens,
                   COALESCE(estimated_cost_usd, 0) AS estimated_cost_usd,
                   COALESCE(actual_cost_usd, 0) AS actual_cost_usd,
                   cost_status
              FROM sessions WHERE id = ?
            """,
            (session_id,),
        ).fetchone()
        if row is None:
            return None
        latest = None
        columns = {
            item[1]
            for item in conn.execute("PRAGMA table_info(session_model_usage)").fetchall()
        }
        if columns:
            order_column = "last_seen" if "last_seen" in columns else "rowid"
            latest = conn.execute(
                f"""
                SELECT model, billing_provider
                  FROM session_model_usage
                 WHERE session_id = ?
                 ORDER BY COALESCE({order_column}, 0) DESC
                 LIMIT 1
                """,
                (session_id,),
            ).fetchone()
    finally:
        conn.close()

    tokens = {field: int(row[field] or 0) for field in TOKEN_FIELDS}
    return {
        "session_id": row["id"],
        "source": row["source"],
        "model": (latest["model"] if latest else None) or row["model"] or "unknown",
        "provider": (latest["billing_provider"] if latest else None)
        or row["billing_provider"]
        or "unknown",
        "started_at": datetime.fromtimestamp(float(row["started_at"]), tz=LOCAL_TZ).isoformat(),
        "api_calls": int(row["api_call_count"] or 0),
        **tokens,
        "total_tokens": sum(tokens.values()),
        "estimated_cost_usd": float(row["estimated_cost_usd"] or 0.0),
        "actual_cost_usd": float(row["actual_cost_usd"] or 0.0),
        "cost_status": row["cost_status"] or "unavailable",
    }


def aggregate_usage(
    db_path: str | Path,
    *,
    now: datetime | None = None,
    tz: ZoneInfo | None = None,
    trend_days: int = 30,
) -> dict[str, Any]:
    """Aggregate Hermes session usage into natural local periods.

    Hermes currently persists usage per session rather than per API request.
    Every session is therefore attributed to the local date on which it began.
    The response exposes that limitation explicitly in ``quality``.
    """
    local_tz = tz or ZoneInfo("Asia/Shanghai")
    current = (now or datetime.now(local_tz)).astimezone(local_tz)
    starts = _period_starts(current)
    trend_days = max(1, min(int(trend_days), 365))
    day_start = _start_of_day(current)
    trend_start = day_start - timedelta(days=trend_days - 1)
    rolling_starts = {
        "7d": day_start - timedelta(days=6),
        "30d": day_start - timedelta(days=29),
        "90d": day_start - timedelta(days=89),
    }
    cutoff = min(trend_start, starts["month"], rolling_starts["90d"])

    conn = sqlite3.connect(f"file:{Path(db_path).as_posix()}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT id, source, model, started_at, billing_provider,
                   COALESCE(api_call_count, 0) AS api_call_count,
                   COALESCE(input_tokens, 0) AS input_tokens,
                   COALESCE(output_tokens, 0) AS output_tokens,
                   COALESCE(cache_read_tokens, 0) AS cache_read_tokens,
                   COALESCE(cache_write_tokens, 0) AS cache_write_tokens,
                   COALESCE(reasoning_tokens, 0) AS reasoning_tokens,
                   COALESCE(estimated_cost_usd, 0) AS estimated_cost_usd,
                   COALESCE(actual_cost_usd, 0) AS actual_cost_usd,
                   cost_status
              FROM sessions
             WHERE started_at >= ?
             ORDER BY started_at
            """,
            (cutoff.timestamp(),),
        ).fetchall()
        has_model_usage = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_model_usage'"
        ).fetchone()
        if has_model_usage:
            usage_rows = conn.execute(
                """
                SELECT u.session_id AS id, u.model, u.billing_provider, s.started_at,
                       COALESCE(u.api_call_count, 0) AS api_call_count,
                       COALESCE(u.input_tokens, 0) AS input_tokens,
                       COALESCE(u.output_tokens, 0) AS output_tokens,
                       COALESCE(u.cache_read_tokens, 0) AS cache_read_tokens,
                       COALESCE(u.cache_write_tokens, 0) AS cache_write_tokens,
                       COALESCE(u.reasoning_tokens, 0) AS reasoning_tokens,
                       COALESCE(u.estimated_cost_usd, 0) AS estimated_cost_usd,
                       COALESCE(u.actual_cost_usd, 0) AS actual_cost_usd
                  FROM session_model_usage u
                  JOIN sessions s ON s.id = u.session_id
                 WHERE s.started_at >= ?
                UNION ALL
                SELECT s.id, s.model, s.billing_provider, s.started_at,
                       COALESCE(s.api_call_count, 0),
                       COALESCE(s.input_tokens, 0),
                       COALESCE(s.output_tokens, 0),
                       COALESCE(s.cache_read_tokens, 0),
                       COALESCE(s.cache_write_tokens, 0),
                       COALESCE(s.reasoning_tokens, 0),
                       COALESCE(s.estimated_cost_usd, 0),
                       COALESCE(s.actual_cost_usd, 0)
                  FROM sessions s
                 WHERE s.started_at >= ?
                   AND NOT EXISTS (
                       SELECT 1 FROM session_model_usage u WHERE u.session_id = s.id
                   )
                """,
                (cutoff.timestamp(), cutoff.timestamp()),
            ).fetchall()
        else:
            usage_rows = rows
    finally:
        conn.close()

    periods = {name: _empty_totals() for name in starts}
    rolling = {name: _empty_totals() for name in rolling_starts}
    daily: dict[str, dict[str, Any]] = defaultdict(_empty_totals)
    dimensions: dict[str, dict[str, dict[str, Any]]] = {
        "model": defaultdict(_empty_totals),
        "provider": defaultdict(_empty_totals),
        "source": defaultdict(_empty_totals),
    }
    dimension_sessions: dict[str, dict[str, set[str]]] = {
        "model": defaultdict(set),
        "provider": defaultdict(set),
        "source": defaultdict(set),
    }
    provider_periods: dict[str, dict[str, dict[str, Any]]] = defaultdict(
        lambda: {name: _empty_totals() for name in starts}
    )
    provider_period_sessions: dict[str, dict[str, set[str]]] = defaultdict(
        lambda: {name: set() for name in starts}
    )
    model_periods: dict[str, dict[str, dict[str, Any]]] = defaultdict(
        lambda: {name: _empty_totals() for name in starts}
    )
    model_period_sessions: dict[str, dict[str, set[str]]] = defaultdict(
        lambda: {name: set() for name in starts}
    )

    for row in rows:
        started = datetime.fromtimestamp(float(row["started_at"]), tz=local_tz)
        for name, boundary in starts.items():
            if started >= boundary:
                _add_row(periods[name], row)
        for name, boundary in rolling_starts.items():
            if started >= boundary:
                _add_row(rolling[name], row)
        if started >= trend_start:
            _add_row(daily[started.date().isoformat()], row)
        if started >= rolling_starts["90d"]:
            name = str(row["source"] or "unknown")
            _add_row(dimensions["source"][name], row)
            dimension_sessions["source"][name].add(str(row["id"]))

    for row in usage_rows:
        started = datetime.fromtimestamp(float(row["started_at"]), tz=local_tz)
        provider = str(row["billing_provider"] or "unknown")
        model = str(row["model"] or "unknown")
        if started >= starts["month"]:
            for name, boundary in starts.items():
                if started >= boundary:
                    _add_row(provider_periods[provider][name], row)
                    provider_period_sessions[provider][name].add(str(row["id"]))
                    _add_row(model_periods[model][name], row)
                    model_period_sessions[model][name].add(str(row["id"]))
        if started < rolling_starts["90d"]:
            continue
        for dimension, column in (
            ("model", "model"),
            ("provider", "billing_provider"),
        ):
            name = str(row[column] or "unknown")
            _add_row(dimensions[dimension][name], row)
            dimension_sessions[dimension][name].add(str(row["id"]))

    def _dimension_rows(name: str) -> list[dict[str, Any]]:
        values = []
        for key, value in dimensions[name].items():
            value["sessions"] = len(dimension_sessions[name][key])
            values.append({"name": key, **value})
        return sorted(
            values,
            key=lambda item: (-item["total_tokens"], item["name"]),
        )

    for buckets_map, session_map in (
        (provider_periods, provider_period_sessions),
        (model_periods, model_period_sessions),
    ):
        for key, buckets in buckets_map.items():
            for name, total in buckets.items():
                total["sessions"] = len(session_map[key][name])

    return {
        "periods": periods,
        "rolling": rolling,
        "daily": [
            {"date": day, **values}
            for day, values in sorted(daily.items())
        ],
        "by_model": _dimension_rows("model"),
        "by_provider": _dimension_rows("provider"),
        "by_provider_periods": {
            provider: buckets
            for provider, buckets in sorted(provider_periods.items())
        },
        "by_model_periods": {
            model: buckets
            for model, buckets in sorted(model_periods.items())
        },
        "by_source": _dimension_rows("source"),
        "quality": {
            "local_usage": "session_aggregate",
            "time_attribution": "session_started_at",
            "failures": "unavailable",
            "latency": "unavailable",
        },
    }


def _atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temp.write_text(
        json.dumps(value, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    os.replace(temp, path)


def _xai_cache_path(home: Path | None = None) -> Path:
    return (home or get_hermes_home()) / "usage-center" / "xai-usage.json"


def collect_xai_usage(
    profile_home: Path | None = None,
    *,
    timeout_seconds: float = 35.0,
) -> dict[str, Any]:
    """Collect Grok's official weekly quota through a short-lived ConPTY.

    The raw TUI transcript is kept only in memory and never logged or persisted.
    Only the parsed quota/reset fields are atomically written to the cache.
    """
    if not _xai_refresh_lock.acquire(blocking=False):
        raise RuntimeError("Grok usage refresh is already running")
    process = None
    stop = threading.Event()
    try:
        grok = shutil.which("grok")
        if not grok:
            raise RuntimeError("Grok Build executable was not found")
        try:
            from winpty import PtyProcess
        except ImportError as exc:
            raise RuntimeError("pywinpty is required for Grok usage collection") from exc

        process = PtyProcess.spawn([grok, "--minimal"], dimensions=(40, 140))
        chunks: queue.Queue[str] = queue.Queue()

        def reader() -> None:
            while not stop.is_set():
                try:
                    value = process.read(4096)
                except Exception:
                    return
                if value:
                    chunks.put(value)

        threading.Thread(target=reader, daemon=True, name="usage-center-grok-reader").start()
        deadline = time_module.monotonic() + max(10.0, float(timeout_seconds))
        transcript: list[str] = []

        # Wait for the interactive prompt. A fixed upper bound keeps a broken
        # login/startup path from pinning the gateway forever.
        startup_deadline = min(deadline, time_module.monotonic() + 12.0)
        while time_module.monotonic() < startup_deadline:
            try:
                transcript.append(chunks.get(timeout=0.25))
            except queue.Empty:
                pass
            plain = ANSI_RE.sub("", "".join(transcript))
            if "Grok" in plain and ">" in plain:
                break

        process.write("/usage")
        time_module.sleep(0.6)
        process.write("\r")
        while time_module.monotonic() < deadline:
            try:
                transcript.append(chunks.get(timeout=0.25))
            except queue.Empty:
                pass
            plain = ANSI_RE.sub("", "".join(transcript))
            if XAI_WEEKLY_RE.search(plain) and XAI_RESET_RE.search(plain):
                break
        else:
            raise RuntimeError("Timed out waiting for Grok /usage")

        result = parse_xai_usage("".join(transcript), tz=LOCAL_TZ)
        result["fetched_at"] = datetime.now(LOCAL_TZ).isoformat()
        _atomic_write_json(_xai_cache_path(profile_home), result)
        return result
    finally:
        stop.set()
        if process is not None:
            try:
                process.write("\x03")
            except Exception:
                pass
            try:
                process.terminate(force=True)
            except Exception:
                pass
        _xai_refresh_lock.release()


def _refresh_xai_background(profile_home: Path) -> None:
    try:
        collect_xai_usage(profile_home)
    except Exception:
        # The summary endpoint will continue to expose the last sample as stale.
        # Raw terminal output and credentials are deliberately never logged.
        return


def schedule_xai_refresh(profile_home: Path) -> bool:
    if _xai_refresh_lock.locked():
        return False
    threading.Thread(
        target=_refresh_xai_background,
        args=(profile_home,),
        daemon=True,
        name="usage-center-grok-refresh",
    ).start()
    return True


def get_codex_usage(profile_home: Path | None = None, *, force: bool = False) -> dict[str, Any]:
    home = (profile_home or get_hermes_home()).resolve()
    cache_key = str(home).casefold()
    now_mono = time_module.monotonic()
    entry = _codex_cache.get(cache_key, {"value": None, "saved_at": 0.0})
    cached = entry["value"]
    if not force and cached is not None:
        if now_mono - float(entry["saved_at"]) <= CODEX_CACHE_MAX_AGE_SECONDS:
            return dict(cached)
    with _codex_refresh_lock:
        now_mono = time_module.monotonic()
        entry = _codex_cache.get(cache_key, {"value": None, "saved_at": 0.0})
        cached = entry["value"]
        if not force and cached is not None:
            if now_mono - float(entry["saved_at"]) <= CODEX_CACHE_MAX_AGE_SECONDS:
                return dict(cached)
        try:
            from agent.account_usage import fetch_account_usage

            with _profile_scope(home):
                value = serialize_account_usage(fetch_account_usage("openai-codex"))
        except Exception as exc:
            value = {
                "provider": "openai-codex",
                "status": "unavailable",
                "reason": f"Codex usage lookup failed: {type(exc).__name__}",
                "windows": [],
            }
        _codex_cache[cache_key] = {
            "value": value,
            "saved_at": time_module.monotonic(),
        }
        return dict(value)


def _localize_claude_windows(value: dict[str, Any]) -> dict[str, Any]:
    """Keep official percentages; only translate known Claude window labels."""
    result = dict(value)
    windows = []
    for window in result.get("windows") or []:
        item = dict(window)
        label = str(item.get("label") or "")
        item["label"] = CLAUDE_WINDOW_LABELS.get(label, label)
        windows.append(item)
    result["windows"] = windows
    return result


def get_anthropic_usage(profile_home: Path | None = None, *, force: bool = False) -> dict[str, Any]:
    home = (profile_home or get_hermes_home()).resolve()
    cache_key = str(home).casefold()
    now_mono = time_module.monotonic()
    entry = _anthropic_cache.get(cache_key, {"value": None, "saved_at": 0.0})
    cached = entry["value"]
    if not force and cached is not None:
        if now_mono - float(entry["saved_at"]) <= ANTHROPIC_CACHE_MAX_AGE_SECONDS:
            return dict(cached)
    with _anthropic_refresh_lock:
        now_mono = time_module.monotonic()
        entry = _anthropic_cache.get(cache_key, {"value": None, "saved_at": 0.0})
        cached = entry["value"]
        if not force and cached is not None:
            if now_mono - float(entry["saved_at"]) <= ANTHROPIC_CACHE_MAX_AGE_SECONDS:
                return dict(cached)
        try:
            from agent.account_usage import fetch_account_usage

            with _profile_scope(home):
                value = _localize_claude_windows(
                    serialize_account_usage(
                        fetch_account_usage("anthropic"),
                        default_provider="anthropic",
                    )
                )
        except Exception as exc:
            value = {
                "provider": "anthropic",
                "status": "unavailable",
                "reason": f"Claude usage lookup failed: {type(exc).__name__}",
                "windows": [],
            }
        _anthropic_cache[cache_key] = {
            "value": value,
            "saved_at": time_module.monotonic(),
        }
        return dict(value)


def build_summary(
    *,
    trend_days: int = 30,
    session_id: str | None = None,
    profile: str | None = None,
) -> dict[str, Any]:
    profile_name, home = resolve_profile_home(profile)
    generated_at = datetime.now(LOCAL_TZ)
    try:
        usage = aggregate_usage(
            home / "state.db",
            now=generated_at,
            tz=LOCAL_TZ,
            trend_days=trend_days,
        )
        usage_status = "available"
    except Exception as exc:
        usage = {
            "periods": {},
            "rolling": {},
            "daily": [],
            "by_model": [],
            "by_provider": [],
            "by_provider_periods": {},
            "by_model_periods": {},
            "by_source": [],
            "quality": {"local_usage": "unavailable"},
            "reason": f"Local usage lookup failed: {type(exc).__name__}",
        }
        usage_status = "unavailable"

    try:
        current_session = get_session_usage(home / "state.db", session_id)
    except (OSError, sqlite3.Error, ValueError):
        current_session = None

    xai = read_xai_cache(
        _xai_cache_path(home),
        now=generated_at,
        max_age_seconds=XAI_CACHE_MAX_AGE_SECONDS,
    )
    refresh_scheduled = False
    if xai.get("status") in {"stale", "unavailable"}:
        refresh_scheduled = schedule_xai_refresh(home)

    codex = get_codex_usage(home)
    anthropic = get_anthropic_usage(home)
    provider_payloads = {
        "openai-codex": codex,
        "xai-oauth": xai,
        "anthropic": anthropic,
    }
    provider_windows = {}
    for key, payload in provider_payloads.items():
        window = provider_cycle_window(payload, generated_at)
        if window:
            provider_windows[key] = window
    week_start = _period_starts(generated_at)["week"]
    try:
        cycles = aggregate_reset_cycles(
            home / "state.db",
            provider_windows,
            now=generated_at,
            tz=LOCAL_TZ,
            fallback_start=week_start,
        )
    except (OSError, sqlite3.Error, ValueError):
        cycles = {"by_provider": {}, "by_model": {}}
    for key, payload in provider_payloads.items():
        cycle = cycles["by_provider"].get(key)
        if cycle is None and key in provider_windows:
            window = provider_windows[key]
            cycle = _empty_totals()
            cycle["kind"] = window["kind"]
            cycle["start"] = window["start"].isoformat()
            cycle["reset_at"] = window["reset_at"].isoformat() if window.get("reset_at") else None
            cycle["label"] = window.get("label") or "额度"
            cycle["source"] = "local_since_reset"
        if cycle:
            payload["cycle"] = cycle
    usage["cycle_by_model"] = cycles.get("by_model") or {}
    usage["cycle_by_provider"] = cycles.get("by_provider") or {}

    return {
        "profile": profile_name,
        "generated_at": generated_at.isoformat(),
        "timezone": str(LOCAL_TZ),
        "local_usage_status": usage_status,
        "current_session": current_session,
        "usage": usage,
        "providers": provider_payloads,
        "refresh": {
            "xai_scheduled": refresh_scheduled,
            "local_seconds": 30,
            "codex_seconds": CODEX_CACHE_MAX_AGE_SECONDS,
            "xai_seconds": XAI_CACHE_MAX_AGE_SECONDS,
            "anthropic_seconds": ANTHROPIC_CACHE_MAX_AGE_SECONDS,
        },
    }


@router.get("/health")
async def health(profile: str | None = None) -> dict[str, Any]:
    profile_name, home = resolve_profile_home(profile)
    return {
        "ok": True,
        "plugin": "usage-center",
        "profile": profile_name,
        "state_db": (home / "state.db").exists(),
        "grok_cli": bool(shutil.which("grok")),
        "claude_cli": bool(shutil.which("claude")),
    }


@router.get("/summary")
async def summary(
    days: int = 30,
    session_id: str | None = None,
    profile: str | None = None,
) -> dict[str, Any]:
    return await asyncio.to_thread(
        build_summary,
        trend_days=max(1, min(days, 365)),
        session_id=session_id,
        profile=profile,
    )


@router.post("/refresh/codex")
async def refresh_codex(profile: str | None = None) -> dict[str, Any]:
    _, home = resolve_profile_home(profile)
    return await asyncio.to_thread(get_codex_usage, home, force=True)


@router.post("/refresh/xai")
async def refresh_xai(profile: str | None = None) -> dict[str, Any]:
    _, home = resolve_profile_home(profile)
    try:
        return await asyncio.to_thread(collect_xai_usage, home)
    except Exception as exc:
        return {
            "provider": "xai-oauth",
            "status": "unavailable",
            "reason": f"Grok usage refresh failed: {type(exc).__name__}",
        }


@router.post("/refresh/anthropic")
async def refresh_anthropic(profile: str | None = None) -> dict[str, Any]:
    _, home = resolve_profile_home(profile)
    return await asyncio.to_thread(get_anthropic_usage, home, force=True)
