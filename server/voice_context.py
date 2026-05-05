"""Runtime voice context hints for Rey Voice.

The Realtime speech model needs tiny disambiguation hints, not full memory.
This module keeps those hints fresh from OpenClaw/Memento while preserving a
small committed seed file for hand-written aliases like taxes != Texas.
"""

from __future__ import annotations

import json
import logging
import re
import subprocess
import time
from pathlib import Path
from typing import Any

import config

logger = logging.getLogger(__name__)

_HINT_ENTITY_TYPES = {"project", "product", "event", "integration", "config", "decision"}
_NOISY_ENTITY_NAMES = {
    "email triage log",
    "cron jobs",
}
_DEFAULT_LIMIT = 24


def _resolve_path(raw_path: str) -> Path:
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = Path(__file__).with_name(raw_path)
    return path


def _load_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return {}
    except Exception:
        logger.warning("Could not read voice context JSON from %s", path, exc_info=True)
        return {}


def _write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def _dedupe_hints(hints: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for hint in hints:
        name = str(hint.get("name") or "").strip()
        meaning = str(hint.get("meaning") or "").strip()
        if not name or not meaning:
            continue
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        aliases = [str(a).strip() for a in hint.get("aliases", []) if str(a).strip()]
        out.append({
            "name": name,
            "aliases": aliases[:8],
            "meaning": meaning,
            "route_to_openclaw": bool(hint.get("route_to_openclaw", True)),
            **({"source": hint["source"]} if hint.get("source") else {}),
        })
    return out


def load_voice_context_data() -> dict[str, Any]:
    """Load generated hints if available, merged over committed seed hints."""
    seed_path = _resolve_path(config.VOICE_CONTEXT_SEED_PATH)
    generated_path = _resolve_path(config.VOICE_CONTEXT_GENERATED_PATH)
    seed = _load_json(seed_path)
    generated = _load_json(generated_path)

    hints = []
    hints.extend(seed.get("hints", []))
    hints.extend(generated.get("hints", []))

    return {
        "version": 2,
        "purpose": "Compact voice recognition and routing hints for OpenAI Realtime. Top-level only; not full memory.",
        "generated_at": generated.get("generated_at"),
        "seed_path": str(seed_path),
        "generated_path": str(generated_path),
        "hints": _dedupe_hints(hints),
    }


def _entity_score(entity: dict[str, Any]) -> int:
    name = str(entity.get("name") or "")
    etype = str(entity.get("entityType") or "").lower()
    observations = entity.get("observations") or []
    joined = "\n".join(str(o) for o in observations[:20]).lower()

    score = 0
    if etype in {"project", "product"}:
        score += 80
    elif etype in {"event", "integration", "decision"}:
        score += 45
    elif etype == "config":
        score += 25
    if re.search(r"2026-05|2026-04", joined):
        score += 20
    if any(token in joined for token in ["repo:", "live at", "patricio", "workspace", "server:", "project"]):
        score += 15
    if name.lower() in {"tenpace", "humanslivehere.com", "rey voice assistant", "openclaw"}:
        score += 100
    if name.lower() in _NOISY_ENTITY_NAMES:
        score -= 100
    return score


def _aliases_for_name(name: str) -> list[str]:
    aliases: list[str] = []
    lower = name.lower()
    if "." in name:
        aliases.append(name.replace(".", " dot "))
        aliases.append(name.split(".")[0])
    spaced = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", name).lower()
    if spaced != lower:
        aliases.append(spaced)
    compact = re.sub(r"[^a-z0-9]+", "", lower)
    if compact and compact != lower:
        aliases.append(compact)
    return list(dict.fromkeys(aliases))[:4]


def _meaning_for_entity(entity: dict[str, Any]) -> str:
    name = str(entity.get("name") or "").strip()
    etype = str(entity.get("entityType") or "known item").strip() or "known item"
    observations = [str(o).strip() for o in entity.get("observations") or [] if str(o).strip()]

    # Prefer stable topline observations over noisy dated logs.
    for obs in observations:
        if len(obs) > 220:
            continue
        if re.match(r"^\d{4}-\d{2}-\d{2}", obs):
            continue
        if any(prefix in obs.lower() for prefix in ["repo:", "live at", "server:", "mission:", "one-liner:", "status:"]):
            return f"{etype} in Patricio's memory: {obs}"

    return f"{etype} in Patricio's memory/work context. If Patricio mentions {name}, ask OpenClaw for the current details."


def generate_hints_from_memento(limit: int = _DEFAULT_LIMIT) -> dict[str, Any]:
    """Read Memento and generate compact top-level voice hints."""
    proc = subprocess.run(
        ["mcporter", "call", "memento.read_graph"],
        text=True,
        capture_output=True,
        timeout=config.VOICE_CONTEXT_REFRESH_TIMEOUT_SECONDS,
        check=True,
    )
    graph = json.loads(proc.stdout)
    entities = graph.get("entities", [])

    candidates = []
    for entity in entities:
        name = str(entity.get("name") or "").strip()
        etype = str(entity.get("entityType") or "").lower()
        if not name or etype not in _HINT_ENTITY_TYPES:
            continue
        score = _entity_score(entity)
        if score <= 20:
            continue
        candidates.append((score, entity))

    candidates.sort(key=lambda item: (-item[0], str(item[1].get("name") or "")))

    hints = []
    for _, entity in candidates[:limit]:
        name = str(entity.get("name") or "").strip()
        hints.append({
            "name": name,
            "aliases": _aliases_for_name(name),
            "meaning": _meaning_for_entity(entity),
            "route_to_openclaw": True,
            "source": "memento",
        })

    return {
        "version": 2,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "memento.read_graph",
        "hints": _dedupe_hints(hints),
    }


def refresh_voice_context_hints(force: bool = False) -> dict[str, Any]:
    """Refresh generated hints if stale, returning merged runtime data."""
    generated_path = _resolve_path(config.VOICE_CONTEXT_GENERATED_PATH)
    if not force and generated_path.exists():
        age = time.time() - generated_path.stat().st_mtime
        if age < config.VOICE_CONTEXT_REFRESH_SECONDS:
            return load_voice_context_data()

    try:
        generated = generate_hints_from_memento(limit=config.VOICE_CONTEXT_MAX_HINTS)
        _write_json(generated_path, generated)
        logger.info("Refreshed %s generated voice context hints", len(generated.get("hints", [])))
    except Exception:
        logger.warning("Could not refresh generated voice context hints", exc_info=True)

    return load_voice_context_data()


def build_voice_context_prompt() -> str:
    """Return prompt text for Realtime disambiguation/routing."""
    data = refresh_voice_context_hints(force=False)
    lines = []
    for hint in data.get("hints", []):
        name = hint.get("name")
        meaning = hint.get("meaning")
        aliases = ", ".join(hint.get("aliases") or [])
        route = " Call ask_openclaw when mentioned." if hint.get("route_to_openclaw") else ""
        if name and meaning:
            alias_text = f" Aliases/mishearings: {aliases}." if aliases else ""
            lines.append(f"- {name}: {meaning}{alias_text}{route}")

    if not lines:
        return ""

    return "Voice context primer. Use these only for disambiguation and routing; do not recite them:\n" + "\n".join(lines)
