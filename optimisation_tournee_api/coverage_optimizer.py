from __future__ import annotations

import hashlib
import json
import math
import os
import sys
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from datetime import date, datetime, timedelta
from typing import Any

try:
    from ortools.sat.python import cp_model
except Exception:  # pragma: no cover
    cp_model = None


DATE_FMT = "%Y-%m-%d"
DEFAULT_WORKING_DAYS = [0, 1, 2, 3, 4, 5, 6]
DEFAULT_SERVICE_MINUTES = 12.0
DEFAULT_DRIVE_SPEED_KMH = 30.0
DEFAULT_STOP_HANDLING_MINUTES = 5.0
RATIO_SCALE = 100
GREEDY_CP_SAT_CANDIDATE_THRESHOLD = 150_000
CAPACITY_MODE_VALIDATED_VISIT = "validated_visit_capacity"
CAPACITY_MODE_SALES_PROXY = "sales_activity_proxy"
CAPACITY_MODE_CONFIGURED_HARD = "configured_hard_capacity"
CAPACITY_MODE_UNKNOWN = "unknown"
PLANNING_MODE_RECOVERY = "recovery_coverage"
PLANNING_MODE_SALES = "sales_coverage"
UNKNOWN_OPERATIONAL_STATUS = "unknown"
UNKNOWN_OPERATIONAL_STATUS_LABEL = "Capacite terrain non mesuree"
DEFAULT_COVERAGE_WINDOW_DAYS = 14
DEFAULT_DAILY_MAX_MODE = "flexible"
DAILY_MAX_MODE_STRICT = "strict"
DAILY_MAX_MODE_FLEXIBLE = "flexible"


def is_perf_debug_enabled() -> bool:
    return str(os.getenv("COVERAGE_PERF_DEBUG", "")).strip().lower() in {"1", "true", "yes", "on"}


def is_perf_timings_enabled() -> bool:
    return str(os.getenv("COVERAGE_PERF_TIMINGS", "")).strip().lower() in {"1", "true", "yes", "on"}


def is_perf_observability_enabled() -> bool:
    return is_perf_debug_enabled() or is_perf_timings_enabled()


def _build_perf_entry(stage: str, started_at: float) -> dict[str, Any]:
    return {
        "stage": str(stage or "unknown"),
        "duration_ms": max(0, int(round((time.perf_counter() - started_at) * 1000))),
    }


def _attach_perf_meta(result: dict[str, Any], performance_entries: list[dict[str, Any]]) -> dict[str, Any]:
    if not is_perf_observability_enabled():
        return result

    debug_enabled = is_perf_debug_enabled()
    allowed_timing_only_stages = {
        "python_normalization",
        "python_candidates",
        "python_candidate_context_build",
        "context_build_records",
        "context_build_key_maps",
        "context_build_client_indexes",
        "context_build_slot_indexes",
        "context_build_score_components",
        "context_build_stop_minutes",
        "context_finalize",
        "python_solver_build_assignment_records",
        "python_solver_build_candidate_indexes",
        "python_greedy_total",
        "python_solver_build_visit_order",
        "python_solver_build_statistics",
        "python_solver_total",
        "python_total",
    }
    next_result = dict(result or {})
    meta = next_result.get("meta") if isinstance(next_result.get("meta"), dict) else {}
    meta = {
        **meta,
        "performance": {
            "stages": [
                {
                    "stage": str(entry.get("stage") or "unknown"),
                    "duration_ms": max(0, int(entry.get("duration_ms") or 0)),
                }
                for entry in performance_entries
                if entry and entry.get("stage") and (
                    debug_enabled or str(entry.get("stage") or "") in allowed_timing_only_stages
                )
            ]
        },
    }
    next_result["meta"] = meta
    return next_result


def _attach_debug_path_meta(result: dict[str, Any], debug_path: dict[str, Any] | None) -> dict[str, Any]:
    if not is_perf_debug_enabled() or not isinstance(debug_path, dict):
        return result

    next_result = dict(result or {})
    meta = next_result.get("meta") if isinstance(next_result.get("meta"), dict) else {}
    meta = {
        **meta,
        "debug_path": {
            "solver_function": str(debug_path.get("solver_function") or "unknown"),
            "cp_sat_solve_reached": bool(debug_path.get("cp_sat_solve_reached")),
            "cp_sat_candidate_threshold_reached": bool(debug_path.get("cp_sat_candidate_threshold_reached")),
        }
    }
    next_result["meta"] = meta
    return next_result


def _attach_solver_selection_meta(result: dict[str, Any], solver_selection: dict[str, Any] | None) -> dict[str, Any]:
    if not is_perf_debug_enabled() or not isinstance(solver_selection, dict):
        return result

    next_result = dict(result or {})
    meta = next_result.get("meta") if isinstance(next_result.get("meta"), dict) else {}
    meta = {
        **meta,
        "solver_selection": {
            "selected_solver": str(solver_selection.get("selected_solver") or "unknown"),
            "selection_reason": str(solver_selection.get("selection_reason") or "unknown"),
            "clients_count": max(0, int(solver_selection.get("clients_count") or 0)),
            "slots_count": max(0, int(solver_selection.get("slots_count") or 0)),
            "candidate_pairs_count": max(0, int(solver_selection.get("candidate_pairs_count") or 0)),
            "planning_mode": str(solver_selection.get("planning_mode") or PLANNING_MODE_RECOVERY),
            "sales_coverage_mode": bool(solver_selection.get("sales_coverage_mode")),
            "ortools_available": bool(solver_selection.get("ortools_available")),
            "simple_balanced_solver_eligible": bool(solver_selection.get("simple_balanced_solver_eligible")),
            "cp_sat_solve_reached": bool(solver_selection.get("cp_sat_solve_reached")),
            "cp_sat_status": (
                None
                if solver_selection.get("cp_sat_status") is None
                else str(solver_selection.get("cp_sat_status"))
            ),
            "thresholds": dict(solver_selection.get("thresholds") or {}),
        }
    }
    next_result["meta"] = meta
    return next_result


def _attach_greedy_meta(result: dict[str, Any], greedy_meta: dict[str, Any] | None) -> dict[str, Any]:
    if not is_perf_debug_enabled() or not isinstance(greedy_meta, dict):
        return result

    next_result = dict(result or {})
    meta = next_result.get("meta") if isinstance(next_result.get("meta"), dict) else {}
    meta = {
        **meta,
        "greedy": {
            key: value
            for key, value in greedy_meta.items()
        }
    }
    next_result["meta"] = meta
    return next_result


def _attach_greedy_trace_meta(result: dict[str, Any], greedy_trace: dict[str, Any] | None) -> dict[str, Any]:
    if not is_perf_debug_enabled() or not isinstance(greedy_trace, dict):
        return result

    next_result = dict(result or {})
    meta = next_result.get("meta") if isinstance(next_result.get("meta"), dict) else {}
    meta = {
        **meta,
        "greedy_trace": {
            key: value
            for key, value in greedy_trace.items()
        }
    }
    next_result["meta"] = meta
    return next_result


def _attach_input_fingerprints_meta(result: dict[str, Any], input_fingerprints: dict[str, Any] | None) -> dict[str, Any]:
    if not is_perf_debug_enabled() or not isinstance(input_fingerprints, dict):
        return result

    next_result = dict(result or {})
    meta = next_result.get("meta") if isinstance(next_result.get("meta"), dict) else {}
    meta = {
        **meta,
        "input_fingerprints": {
            key: value
            for key, value in input_fingerprints.items()
        }
    }
    next_result["meta"] = meta
    return next_result


def _attach_result_hashes_meta(result: dict[str, Any], result_hashes: dict[str, Any] | None) -> dict[str, Any]:
    if not is_perf_debug_enabled() or not isinstance(result_hashes, dict):
        return result

    next_result = dict(result or {})
    meta = next_result.get("meta") if isinstance(next_result.get("meta"), dict) else {}
    meta = {
        **meta,
        "result_hashes": {
            key: value
            for key, value in result_hashes.items()
        }
    }
    next_result["meta"] = meta
    return next_result


def _attach_candidate_context_meta(result: dict[str, Any], candidate_context_meta: dict[str, Any] | None) -> dict[str, Any]:
    if not is_perf_debug_enabled() or not isinstance(candidate_context_meta, dict):
        return result

    next_result = dict(result or {})
    meta = next_result.get("meta") if isinstance(next_result.get("meta"), dict) else {}
    meta = {
        **meta,
        "candidate_context": {
            key: value
            for key, value in candidate_context_meta.items()
        }
    }
    next_result["meta"] = meta
    return next_result


def build_candidate_context_meta(
    context: CoverageOptimizationContext | None,
    candidate_context: CandidatePlanningContext | None,
    *,
    reused_by_wrapper: bool,
    reused_by_greedy: bool,
    reused_by_fingerprints: bool,
) -> dict[str, Any] | None:
    if candidate_context is None:
        return None
    diagnostics = context.diagnostics if context is not None else {}
    return {
        "candidate_records_count": int(candidate_context.candidate_records_count),
        "candidate_record_build_calls": int(diagnostics.get("candidate_record_build_calls") or 0),
        "candidate_index_build_calls": int(diagnostics.get("candidate_index_build_calls") or 0),
        "estimated_candidate_context_bytes": int(candidate_context.estimated_candidate_context_bytes),
        "duplicated_candidate_record_copies": 0,
        "context_reused_by_wrapper": bool(reused_by_wrapper),
        "context_reused_by_greedy": bool(reused_by_greedy),
        "context_reused_by_fingerprints": bool(reused_by_fingerprints),
    }


def _increment_context_counter(context: CoverageOptimizationContext | None, key: str) -> None:
    if context is None:
        return
    context.diagnostics[key] = int(context.diagnostics.get(key) or 0) + 1


def _sorted_sequence_with_cache(
    cache: dict[tuple[Any, ...], tuple[Any, ...]],
    cache_key: tuple[Any, ...],
    values: list[Any],
    key_fn: Any,
    metrics: dict[str, Any] | None = None
) -> list[Any]:
    cached = cache.get(cache_key)
    if cached is not None:
        if metrics is not None:
            metrics["sort_cache_hits"] = int(metrics.get("sort_cache_hits") or 0) + 1
        return list(cached)

    ordered = tuple(sorted(values, key=key_fn))
    cache[cache_key] = ordered
    return list(ordered)


def _get_context_distance_km(
    context: CoverageOptimizationContext | None,
    lat1: float | None,
    lon1: float | None,
    lat2: float | None,
    lon2: float | None
) -> float | None:
    if context is None:
        return haversine_km(lat1, lon1, lat2, lon2)

    key = (
        None if lat1 is None else float(lat1),
        None if lon1 is None else float(lon1),
        None if lat2 is None else float(lat2),
        None if lon2 is None else float(lon2),
    )
    if key in context.distance_cache:
        context.diagnostics["distance_cache_hits"] = int(context.diagnostics.get("distance_cache_hits") or 0) + 1
        return context.distance_cache[key]

    distance = haversine_km(lat1, lon1, lat2, lon2)
    context.distance_cache[key] = distance
    context.diagnostics["distance_cache_misses"] = int(context.diagnostics.get("distance_cache_misses") or 0) + 1
    return distance


def _to_stable_json_value(value: Any) -> Any:
    if isinstance(value, tuple):
        return [_to_stable_json_value(item) for item in value]
    if isinstance(value, list):
        return [_to_stable_json_value(item) for item in value]
    if isinstance(value, dict):
        return {
            str(key): _to_stable_json_value(value[key])
            for key in sorted(value.keys(), key=lambda item: str(item))
        }
    return value


def _normalize_coverage_model_payload(logical_model: dict[str, Any]) -> dict[str, Any]:
    payload = dict(logical_model or {})

    payload["clients"] = sorted({str(value) for value in (payload.get("clients") or [])})
    payload["slots"] = sorted({str(value) for value in (payload.get("slots") or [])})

    candidate_pairs = {}
    for item in payload.get("candidate_pairs") or []:
        if not isinstance(item, dict):
            continue
        key = (
            str(item.get("client_id") or ""),
            str(item.get("slot_id") or "")
        )
        normalized_item = {
            "client_id": key[0],
            "slot_id": key[1],
            "slot_index": int(item.get("slot_index") or 0),
            "predicted_ca_cents": int(item.get("predicted_ca_cents") or 0),
            "predicted_load_units_centi": int(item.get("predicted_load_units_centi") or 0),
            "predicted_stop_minutes_centi": int(item.get("predicted_stop_minutes_centi") or 0),
            "distance_penalty": int(item.get("distance_penalty") or 0),
            "coverage_date_penalty": int(item.get("coverage_date_penalty") or 0),
            "recovery_urgency_date_penalty": int(item.get("recovery_urgency_date_penalty") or 0),
            "recovery_date_penalty": int(item.get("recovery_date_penalty") or 0),
            "expected_collection_date_penalty": int(item.get("expected_collection_date_penalty") or 0),
            "purchase_score_date_penalty": int(item.get("purchase_score_date_penalty") or 0),
            "purchase_timing_date_penalty": int(item.get("purchase_timing_date_penalty") or 0),
            "expected_order_date_penalty": int(item.get("expected_order_date_penalty") or 0),
            "reassignment_penalty": int(item.get("reassignment_penalty") or 0),
        }
        existing = candidate_pairs.get(key)
        if existing is None:
            candidate_pairs[key] = normalized_item
            continue
        if existing != normalized_item:
            raise ValueError(f"Conflicting candidate pair payload for {key[0]}::{key[1]}")
    payload["candidate_pairs"] = sorted(candidate_pairs.values(), key=lambda item: (item["client_id"], item["slot_id"]))

    variables = {}
    for item in payload.get("variables") or []:
        if not isinstance(item, dict):
            continue
        key = tuple(item.get("key") or [])
        variables[key] = {
            "key": list(key),
            "kind": str(item.get("kind") or ""),
            "domain": [int(value) for value in (item.get("domain") or [])]
        }
    payload["variables"] = [
        variables[key]
        for key in sorted(variables.keys(), key=lambda item: tuple(str(part) for part in item))
    ]

    constraints = {
        json.dumps(_to_stable_json_value(item), ensure_ascii=True, separators=(",", ":"), sort_keys=True)
        for item in (payload.get("constraints") or [])
    }
    payload["constraints"] = [
        json.loads(item)
        for item in sorted(constraints)
    ]

    objective_coefficients: dict[tuple[Any, ...], int] = defaultdict(int)
    for item in payload.get("objective") or []:
        if not isinstance(item, dict):
            continue
        key = tuple(item.get("key") or [])
        objective_coefficients[key] += int(item.get("coefficient") or 0)
    payload["objective"] = [
        {
            "key": list(key),
            "coefficient": int(coefficient)
        }
        for key, coefficient in sorted(objective_coefficients.items(), key=lambda item: tuple(str(part) for part in item[0]))
        if int(coefficient) != 0
    ]

    return payload


def compute_coverage_model_fingerprint(logical_model: dict[str, Any]) -> str:
    normalized_model = _normalize_coverage_model_payload(logical_model)
    serialized = json.dumps(
        _to_stable_json_value(normalized_model),
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True
    )
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def compute_stable_debug_hash(value: Any) -> str:
    serialized = json.dumps(
        _to_stable_json_value(value),
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
        default=str
    )
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _stable_json_encode(value: Any, chunks: list[str]) -> None:
    if isinstance(value, tuple):
        chunks.append("[")
        for index, item in enumerate(value):
            if index > 0:
                chunks.append(",")
            _stable_json_encode(item, chunks)
        chunks.append("]")
        return
    if isinstance(value, list):
        chunks.append("[")
        for index, item in enumerate(value):
            if index > 0:
                chunks.append(",")
            _stable_json_encode(item, chunks)
        chunks.append("]")
        return
    if isinstance(value, dict):
        chunks.append("{")
        first = True
        for key in sorted(value.keys(), key=lambda item: str(item)):
            if not first:
                chunks.append(",")
            first = False
            chunks.append(json.dumps(str(key), ensure_ascii=True))
            chunks.append(":")
            _stable_json_encode(value[key], chunks)
        chunks.append("}")
        return
    chunks.append(json.dumps(value, ensure_ascii=True, default=str, separators=(",", ":")))


def _compute_stable_debug_hash_from_json_chunks(chunks: list[str]) -> str:
    hasher = hashlib.sha256()
    for chunk in chunks:
        hasher.update(chunk.encode("utf-8"))
    return hasher.hexdigest()


def _build_candidate_pair_snapshot_from_record(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "client_id": str(record.get("client_id") or ""),
        "slot_id": str(record.get("slot_id") or ""),
        "slot_index": int(record.get("slot_index") or 0),
        "predicted_ca_cents": int(record.get("predicted_ca_cents") or 0),
        "predicted_load_units_centi": int(record.get("predicted_load_units_centi") or 0),
        "predicted_stop_minutes_centi": int(record.get("predicted_stop_minutes_centi") or 0),
        "distance_penalty": int(record.get("distance_penalty") or 0),
        "coverage_date_penalty": int(record.get("coverage_date_penalty") or 0),
        "recovery_date_penalty": int(record.get("recovery_date_penalty") or 0),
        "expected_collection_date_penalty": int(record.get("expected_collection_date_penalty") or 0),
        "purchase_score_date_penalty": int(record.get("purchase_score_date_penalty") or 0),
        "purchase_timing_date_penalty": int(record.get("purchase_timing_date_penalty") or 0),
        "expected_order_date_penalty": int(record.get("expected_order_date_penalty") or 0),
        "reassignment_penalty": int(record.get("reassignment_penalty") or 0),
    }


def _compute_candidate_pairs_snapshot_hash(
    assignments: list[dict[str, Any]] | None = None,
    candidate_context: CandidatePlanningContext | None = None
) -> str:
    chunks = ["["]
    if candidate_context is not None:
        ordered_indexes = candidate_context.candidate_indexes_sorted_for_input_hash
        if ordered_indexes is None:
            ordered_indexes = sorted(
                range(len(candidate_context.candidate_records)),
                key=lambda candidate_index: (
                    str(candidate_context.candidate_records[candidate_index].get("client_id") or ""),
                    str(candidate_context.candidate_records[candidate_index].get("slot_id") or "")
                )
            )
        for position, candidate_index in enumerate(ordered_indexes):
            if position > 0:
                chunks.append(",")
            _stable_json_encode(
                _build_candidate_pair_snapshot_from_record(candidate_context.candidate_records[candidate_index]),
                chunks
            )
    else:
        for position, assignment in enumerate(sorted(
            assignments or [],
            key=lambda item: (
                str(item.get("client_id") or ""),
                str(item.get("slot_id") or "")
            )
        )):
            if position > 0:
                chunks.append(",")
            _stable_json_encode(_build_candidate_pair_snapshot_from_record(assignment), chunks)
    chunks.append("]")
    return _compute_stable_debug_hash_from_json_chunks(chunks)


def _append_candidate_pairs_snapshot_json(
    chunks: list[str],
    *,
    assignments: list[dict[str, Any]] | None = None,
    candidate_context: CandidatePlanningContext | None = None,
) -> None:
    chunks.append("[")
    if candidate_context is not None:
        ordered_indexes = candidate_context.candidate_indexes_sorted_for_input_hash
        if ordered_indexes is None:
            ordered_indexes = sorted(
                range(len(candidate_context.candidate_records)),
                key=lambda candidate_index: (
                    str(candidate_context.candidate_records[candidate_index].get("client_id") or ""),
                    str(candidate_context.candidate_records[candidate_index].get("slot_id") or "")
                )
            )
        for position, candidate_index in enumerate(ordered_indexes):
            if position > 0:
                chunks.append(",")
            _stable_json_encode(
                _build_candidate_pair_snapshot_from_record(candidate_context.candidate_records[candidate_index]),
                chunks
            )
    else:
        for position, assignment in enumerate(sorted(
            assignments or [],
            key=lambda item: (
                str(item.get("client_id") or ""),
                str(item.get("slot_id") or "")
            )
        )):
            if position > 0:
                chunks.append(",")
            _stable_json_encode(_build_candidate_pair_snapshot_from_record(assignment), chunks)
    chunks.append("]")


def _compute_functional_input_hash_from_snapshots(
    *,
    request_params_snapshot: dict[str, Any],
    clients_snapshot: list[dict[str, Any]],
    slots_snapshot: list[dict[str, Any]],
    constraints_snapshot: dict[str, Any],
    predictions_snapshot: list[dict[str, Any]],
    history_profiles_snapshot: dict[str, Any],
    assignments: list[dict[str, Any]] | None = None,
    candidate_context: CandidatePlanningContext | None = None,
) -> str:
    chunks = ["{"]
    ordered_keys = (
        "candidate_pairs",
        "clients",
        "constraints",
        "history_profiles",
        "predictions",
        "request_params",
        "slots",
    )
    for index, key in enumerate(ordered_keys):
        if index > 0:
            chunks.append(",")
        chunks.append(json.dumps(key, ensure_ascii=True))
        chunks.append(":")
        if key == "candidate_pairs":
            _append_candidate_pairs_snapshot_json(
                chunks,
                assignments=assignments,
                candidate_context=candidate_context
            )
        elif key == "clients":
            _stable_json_encode(clients_snapshot, chunks)
        elif key == "constraints":
            _stable_json_encode(constraints_snapshot, chunks)
        elif key == "history_profiles":
            _stable_json_encode(history_profiles_snapshot, chunks)
        elif key == "predictions":
            _stable_json_encode(predictions_snapshot, chunks)
        elif key == "request_params":
            _stable_json_encode(request_params_snapshot, chunks)
        elif key == "slots":
            _stable_json_encode(slots_snapshot, chunks)
    chunks.append("}")
    return _compute_stable_debug_hash_from_json_chunks(chunks)


CANONICAL_COVERAGE_SUMMARY_FIELDS = (
    "planning_start_date",
    "planning_end_date",
    "clients_to_cover",
    "unique_clients_covered",
    "missing_clients_count",
    "duplicate_clients_count",
    "total_visits",
    "total_slots",
    "used_slots",
    "unused_slots",
    "total_capacity",
    "required_average_per_slot",
    "required_minimum_max_per_slot",
    "total_predicted_ca",
    "predicted_ca_known_count",
    "predicted_ca_unknown_count",
    "predicted_ca_is_complete",
    "total_ca_shortfall",
    "solver_status",
    "coverage_rate",
    "average_clients_per_route",
    "routes_count",
    "active_clients",
    "unique_clients_planned",
    "missing_clients",
    "duplicate_clients",
    "predicted_ca",
    "total_estimated_km",
)


def _coverage_hash_sort_value(value: Any) -> tuple[int, str]:
    if value is None:
        return (0, "")
    if isinstance(value, bool):
        return (1, "1" if value else "0")
    if isinstance(value, (int, float)):
        return (2, repr(value))
    return (3, str(value))


def _normalize_canonical_hash_value(value: Any) -> Any:
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            return None
        return int(value) if value.is_integer() else value
    return value


def build_canonical_coverage_result_snapshot(result: dict[str, Any]) -> dict[str, Any]:
    result = result or {}
    summary = result.get("summary") if isinstance(result.get("summary"), dict) else {}
    diagnostics = result.get("diagnostics") if isinstance(result.get("diagnostics"), dict) else {}
    planned_assignments = []

    for block in result.get("blocks") or []:
        if not isinstance(block, dict):
            continue
        slot_id = block.get("slot_id")
        date_value = block.get("date")
        commercial_code = block.get("commercial_code")
        for client in block.get("clients") or []:
            if not isinstance(client, dict):
                continue
            planned_assignments.append({
                "slot_id": slot_id,
                "date": date_value,
                "commercial_code": commercial_code,
                "visit_order": _normalize_canonical_hash_value(client.get("visit_order")),
                "client_id": None if client.get("client_id") is None else str(client.get("client_id")),
                "client_code": None if client.get("client_code") is None else str(client.get("client_code")),
                "predicted_ca": _normalize_canonical_hash_value(client.get("predicted_ca")),
                "recommended_quantity": _normalize_canonical_hash_value(client.get("recommended_quantity")),
                "purchase_prediction_score": _normalize_canonical_hash_value(client.get("purchase_prediction_score")),
                "recovery_priority_score": _normalize_canonical_hash_value(client.get("recovery_priority_score")),
            })

    planned_assignments.sort(
        key=lambda item: (
            _coverage_hash_sort_value(item.get("date")),
            _coverage_hash_sort_value(item.get("commercial_code")),
            _coverage_hash_sort_value(item.get("slot_id")),
            _coverage_hash_sort_value(item.get("visit_order")),
            _coverage_hash_sort_value(item.get("client_id")),
            _coverage_hash_sort_value(item.get("client_code")),
        )
    )
    summary_snapshot = {
        field: _normalize_canonical_hash_value(summary.get(field))
        for field in CANONICAL_COVERAGE_SUMMARY_FIELDS
        if field in summary
    }
    unassigned_client_ids = sorted(
        [None if value is None else str(value) for value in (diagnostics.get("missing_clients") or [])],
        key=_coverage_hash_sort_value
    )
    duplicate_client_ids = sorted(
        [None if value is None else str(value) for value in (diagnostics.get("duplicate_clients") or [])],
        key=_coverage_hash_sort_value
    )
    return {
        "planned_assignments": planned_assignments,
        "unassigned_client_ids": unassigned_client_ids,
        "duplicate_client_ids": duplicate_client_ids,
        "summary": summary_snapshot,
    }


def compute_coverage_functional_result_hash(result: dict[str, Any]) -> str:
    return compute_stable_debug_hash(build_canonical_coverage_result_snapshot(result or {}))


def finalize_coverage_debug_result(
    result: dict[str, Any],
    *,
    performance_entries: list[dict[str, Any]] | None = None,
    debug_path: dict[str, Any] | None = None,
    solver_selection: dict[str, Any] | None = None,
    greedy_meta: dict[str, Any] | None = None,
    input_fingerprints: dict[str, Any] | None = None,
    greedy_trace: dict[str, Any] | None = None,
    candidate_context: CandidatePlanningContext | None = None,
    candidate_context_meta: dict[str, Any] | None = None,
    perf_context: CoverageOptimizationContext | None = None,
) -> dict[str, Any]:
    canonical_hash = None
    if is_perf_debug_enabled():
        _increment_context_counter(perf_context, "debug_result_hash_calls")
        canonical_hash = compute_coverage_functional_result_hash(result)
        if isinstance(greedy_trace, dict):
            greedy_trace.pop("final_functional_hash", None)
            greedy_trace["canonical_functional_result_hash"] = canonical_hash

    next_candidate_context_meta = candidate_context_meta
    if next_candidate_context_meta is None and candidate_context is not None:
        next_candidate_context_meta = build_candidate_context_meta(
            None,
            candidate_context,
            reused_by_wrapper=True,
            reused_by_greedy=bool(greedy_meta),
            reused_by_fingerprints=bool(input_fingerprints),
        )

    result_with_meta = _attach_candidate_context_meta(
        _attach_greedy_trace_meta(
            _attach_input_fingerprints_meta(
                _attach_greedy_meta(
                    _attach_solver_selection_meta(
                        _attach_perf_meta(_attach_debug_path_meta(result, debug_path), performance_entries or []),
                        solver_selection
                    ),
                    greedy_meta
                ),
                input_fingerprints
            ),
            greedy_trace
        ),
        next_candidate_context_meta
    )
    if not is_perf_debug_enabled():
        return result_with_meta
    result_hashes_started_at = time.perf_counter()
    result_hashes = {
        "python_solver_result_hash": compute_stable_debug_hash(result_with_meta),
        "canonical_functional_result_hash": canonical_hash,
    }
    if performance_entries is not None:
        debug_result_hash_entry = _build_perf_entry("python_debug_result_hashes", result_hashes_started_at)
        performance_entries.append(debug_result_hash_entry)
        result_meta = result_with_meta.get("meta") if isinstance(result_with_meta.get("meta"), dict) else None
        performance_meta = result_meta.get("performance") if isinstance(result_meta, dict) else None
        stages = performance_meta.get("stages") if isinstance(performance_meta, dict) else None
        if isinstance(stages, list):
            stages.append({
                "stage": str(debug_result_hash_entry.get("stage") or "unknown"),
                "duration_ms": max(0, int(debug_result_hash_entry.get("duration_ms") or 0)),
            })
    return _attach_result_hashes_meta(
        result_with_meta,
        result_hashes
    )


def _build_candidate_model_signature(assignment: dict[str, Any]) -> tuple[Any, ...]:
    return (
        str(assignment.get("client_id") or ""),
        str(assignment.get("slot_id") or ""),
        int(assignment.get("slot_index") or 0),
        int(assignment.get("predicted_ca_cents") or 0),
        int(assignment.get("predicted_load_units_centi") or 0),
        int(assignment.get("predicted_stop_minutes_centi") or 0),
        int(assignment.get("distance_penalty") or 0),
        int(assignment.get("coverage_date_penalty") or 0),
        int(assignment.get("recovery_urgency_date_penalty") or 0),
        int(assignment.get("recovery_date_penalty") or 0),
        int(assignment.get("expected_collection_date_penalty") or 0),
        int(assignment.get("purchase_score_date_penalty") or 0),
        int(assignment.get("purchase_timing_date_penalty") or 0),
        int(assignment.get("expected_order_date_penalty") or 0),
        int(assignment.get("reassignment_penalty") or 0),
    )


def deduplicate_assignment_candidates(
    assignments: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], dict[tuple[str, str], dict[str, Any]], int]:
    unique_assignments: list[dict[str, Any]] = []
    candidate_by_key: dict[tuple[str, str], dict[str, Any]] = {}
    removed_duplicates = 0

    for assignment in assignments:
        key = (
            str(assignment.get("client_id") or ""),
            str(assignment.get("slot_id") or "")
        )
        existing = candidate_by_key.get(key)
        if existing is None:
            candidate_by_key[key] = assignment
            unique_assignments.append(assignment)
            continue

        if _build_candidate_model_signature(existing) != _build_candidate_model_signature(assignment):
            raise RuntimeError(f"duplicate_candidate_pair_conflict:{key[0]}::{key[1]}")
        removed_duplicates += 1

    return unique_assignments, candidate_by_key, removed_duplicates


def build_solver_candidate_indices(
    assignments: list[dict[str, Any]],
    mandatory_clients: list[NormalizedClient],
    slots: list[NormalizedSlot],
    candidate_planning_context: CandidatePlanningContext | None = None,
) -> dict[str, Any]:
    if candidate_planning_context is not None and assignments is candidate_planning_context.candidate_records:
        candidate_keys = [
            (
                str(record.get("client_id") or ""),
                str(record.get("slot_id") or "")
            )
            for record in candidate_planning_context.candidate_records
        ]
        return {
            "assignments": candidate_planning_context.candidate_records,
            "candidate_by_client_slot": candidate_planning_context.candidate_record_by_key,
            "candidate_indexes_by_client": candidate_planning_context.candidate_indexes_by_client,
            "candidate_indexes_by_slot": candidate_planning_context.candidate_indexes_by_slot,
            "candidate_keys": candidate_keys,
            "removed_duplicate_candidate_pairs": 0
        }

    unique_assignments, candidate_by_key, removed_duplicates = deduplicate_assignment_candidates(assignments)
    candidate_indexes_by_client: dict[str, list[int]] = defaultdict(list)
    candidate_indexes_by_slot: dict[str, list[int]] = defaultdict(list)
    candidate_keys: list[tuple[str, str]] = []

    for index, assignment in enumerate(unique_assignments):
        client_id = str(assignment.get("client_id") or "")
        slot_id = str(assignment.get("slot_id") or "")
        candidate_indexes_by_client[client_id].append(index)
        candidate_indexes_by_slot[slot_id].append(index)
        candidate_keys.append((client_id, slot_id))

    for client in mandatory_clients:
        candidate_indexes_by_client.setdefault(client.client_id, [])
    for slot in slots:
        candidate_indexes_by_slot.setdefault(slot.slot_id, [])

    return {
        "assignments": unique_assignments,
        "candidate_by_client_slot": candidate_by_key,
        "candidate_indexes_by_client": {key: value[:] for key, value in candidate_indexes_by_client.items()},
        "candidate_indexes_by_slot": {key: value[:] for key, value in candidate_indexes_by_slot.items()},
        "candidate_keys": candidate_keys,
        "removed_duplicate_candidate_pairs": removed_duplicates
    }


def _status_name(status_code: int) -> str:
    if cp_model is None:
        return "UNKNOWN"
    mapping = {
        cp_model.OPTIMAL: "OPTIMAL",
        cp_model.FEASIBLE: "FEASIBLE",
        cp_model.INFEASIBLE: "INFEASIBLE",
        cp_model.MODEL_INVALID: "MODEL_INVALID",
        cp_model.UNKNOWN: "UNKNOWN",
    }
    return mapping.get(status_code, str(status_code))


@dataclass
class NormalizedSlot:
    slot_id: str
    date_iso: str
    commercial_code: str
    commercial_label: str
    max_visits: int
    min_ca: float
    user_preferred_min: int | None = None
    user_preferred_max: int | None = None
    recommended_min: int | None = None
    recommended_max: int | None = None
    effective_target_min: int | None = None
    effective_target_max: int | None = None
    hard_capacity_known: bool = False
    adjustment_reason: str | None = None
    max_load_units: float | None = None
    latitude: float | None = None
    longitude: float | None = None
    historical_soft_capacity: int | None = None
    sales_activity_proxy_per_day: int | None = None
    sales_proxy_source: str | None = None
    sales_proxy_confidence: str | None = None
    recommended_capacity: int | None = None
    hard_capacity: int | None = None
    capacity_source: str | None = None
    shift_start_time: str | None = None
    shift_end_time: str | None = None
    break_minutes: float = 0.0
    max_route_minutes: float | None = None
    depot_id: str | None = None
    depot_latitude: float | None = None
    depot_longitude: float | None = None
    time_constraint_source: str | None = None
    time_capacity_known: bool = False


@dataclass
class NormalizedClient:
    client_id: str
    client_code: str
    client_name: str
    address: str | None
    latitude: float | None
    longitude: float | None
    historical_commercial_code: str
    allowed_commercial_codes: list[str]
    commercial_zone: str | None
    route_code: str | None
    region: str | None
    predicted_ca: float | None
    predicted_ca_known: bool
    predicted_ca_source: str
    purchase_prediction_score: float | None
    predicted_purchase_date: str | None
    purchase_days_until_prediction: int | None
    recommended_quantity: float | None
    expected_order_value: float | None
    predicted_products: list[dict[str, Any]]
    purchase_prediction_known: bool
    purchase_prediction_source: str | None
    recovery_total_balance: float | None
    recovery_due_amount: float | None
    recovery_days_past_due: int | None
    recovery_expected_next_payment_date: str | None
    recovery_days_since_expected_payment: int | None
    recovery_payment_behavior_score: float | None
    recovery_expected_collection_amount: float | None
    recovery_priority_score: float | None
    recovery_data_known: bool
    recovery_source: str | None
    predicted_load_units: float
    service_minutes: float | None
    service_minutes_known: bool
    service_minutes_source: str | None
    estimated_stop_minutes_by_commercial_date: dict[str, float]
    last_real_visit_date: str | None
    next_visit_deadline: str | None
    visit_frequency_days: int
    is_mandatory: bool
    is_critical: bool
    invalid_gps: bool


@dataclass
class CoverageOptimizationContext:
    payload: dict[str, Any]
    collection_target_context: dict[str, Any] | None
    slots: list[NormalizedSlot]
    mandatory_clients: list[NormalizedClient]
    effective_constraints: dict[str, Any]
    required_average_per_slot: float
    required_minimum_max_per_slot: int
    slot_targets: dict[str, Any]
    slot_soft_capacities: dict[str, Any]
    operational: dict[str, Any]
    feasible_slots_by_client: dict[str, list[str]]
    capacity_by_commercial: Counter
    diagnostics: dict[str, int] = field(default_factory=dict)
    assignment_candidates: list[dict[str, Any]] | None = None
    assignment_index_by_key: dict[tuple[str, str], int] | None = None
    candidate_planning_context: CandidatePlanningContext | None = None
    distance_cache: dict[tuple[Any, Any, Any, Any], float | None] = field(default_factory=dict)
    estimated_stop_minutes_cache: dict[tuple[str, str], float | None] = field(default_factory=dict)


@dataclass
class CandidatePlanningContext:
    candidate_records: list[dict[str, Any]]
    candidate_record_by_key: dict[tuple[str, str], dict[str, Any]]
    candidate_record_index_by_key: dict[tuple[str, str], int]
    candidate_indexes_by_client: dict[str, list[int]]
    candidate_indexes_by_slot: dict[str, list[int]]
    candidate_indexes_sorted_for_input_hash: list[int] | None
    client_by_id: dict[str, NormalizedClient]
    slot_by_id: dict[str, NormalizedSlot]
    slot_index_by_id: dict[str, int]
    client_index_by_id: dict[str, int]
    candidate_records_count: int
    estimated_candidate_context_bytes: int


def _normalized_slot_input_snapshot(slot: NormalizedSlot) -> dict[str, Any]:
    return {
        "slot_id": slot.slot_id,
        "date_iso": slot.date_iso,
        "commercial_code": slot.commercial_code,
        "commercial_label": slot.commercial_label,
        "max_visits": int(slot.max_visits),
        "min_ca": slot.min_ca,
        "user_preferred_min": slot.user_preferred_min,
        "user_preferred_max": slot.user_preferred_max,
        "recommended_min": slot.recommended_min,
        "recommended_max": slot.recommended_max,
        "effective_target_min": slot.effective_target_min,
        "effective_target_max": slot.effective_target_max,
        "hard_capacity_known": bool(slot.hard_capacity_known),
        "adjustment_reason": slot.adjustment_reason,
        "max_load_units": slot.max_load_units,
        "latitude": slot.latitude,
        "longitude": slot.longitude,
        "historical_soft_capacity": slot.historical_soft_capacity,
        "sales_activity_proxy_per_day": slot.sales_activity_proxy_per_day,
        "sales_proxy_source": slot.sales_proxy_source,
        "sales_proxy_confidence": slot.sales_proxy_confidence,
        "recommended_capacity": slot.recommended_capacity,
        "hard_capacity": slot.hard_capacity,
        "capacity_source": slot.capacity_source,
        "shift_start_time": slot.shift_start_time,
        "shift_end_time": slot.shift_end_time,
        "break_minutes": slot.break_minutes,
        "max_route_minutes": slot.max_route_minutes,
        "depot_id": slot.depot_id,
        "depot_latitude": slot.depot_latitude,
        "depot_longitude": slot.depot_longitude,
        "time_constraint_source": slot.time_constraint_source,
        "time_capacity_known": bool(slot.time_capacity_known),
    }


def _normalized_client_input_snapshot(client: NormalizedClient) -> dict[str, Any]:
    return {
        "client_id": client.client_id,
        "client_code": client.client_code,
        "client_name": client.client_name,
        "address": client.address,
        "latitude": client.latitude,
        "longitude": client.longitude,
        "historical_commercial_code": client.historical_commercial_code,
        "allowed_commercial_codes": list(client.allowed_commercial_codes),
        "commercial_zone": client.commercial_zone,
        "route_code": client.route_code,
        "region": client.region,
        "predicted_ca": client.predicted_ca,
        "predicted_ca_known": bool(client.predicted_ca_known),
        "predicted_ca_source": client.predicted_ca_source,
        "purchase_prediction_score": client.purchase_prediction_score,
        "predicted_purchase_date": client.predicted_purchase_date,
        "purchase_days_until_prediction": client.purchase_days_until_prediction,
        "recommended_quantity": client.recommended_quantity,
        "expected_order_value": client.expected_order_value,
        "predicted_products": list(client.predicted_products),
        "purchase_prediction_known": bool(client.purchase_prediction_known),
        "purchase_prediction_source": client.purchase_prediction_source,
        "recovery_total_balance": client.recovery_total_balance,
        "recovery_due_amount": client.recovery_due_amount,
        "recovery_days_past_due": client.recovery_days_past_due,
        "recovery_expected_next_payment_date": client.recovery_expected_next_payment_date,
        "recovery_days_since_expected_payment": client.recovery_days_since_expected_payment,
        "recovery_payment_behavior_score": client.recovery_payment_behavior_score,
        "recovery_expected_collection_amount": client.recovery_expected_collection_amount,
        "recovery_priority_score": client.recovery_priority_score,
        "recovery_data_known": bool(client.recovery_data_known),
        "recovery_source": client.recovery_source,
        "predicted_load_units": client.predicted_load_units,
        "service_minutes": client.service_minutes,
        "service_minutes_known": bool(client.service_minutes_known),
        "service_minutes_source": client.service_minutes_source,
        "estimated_stop_minutes_by_commercial_date": dict(client.estimated_stop_minutes_by_commercial_date),
        "last_real_visit_date": client.last_real_visit_date,
        "next_visit_deadline": client.next_visit_deadline,
        "visit_frequency_days": int(client.visit_frequency_days),
        "is_mandatory": bool(client.is_mandatory),
        "is_critical": bool(client.is_critical),
        "invalid_gps": bool(client.invalid_gps),
    }


def build_coverage_input_fingerprints(
    payload: dict[str, Any],
    slots: list[NormalizedSlot],
    mandatory_clients: list[NormalizedClient],
    effective_constraints: dict[str, Any],
    assignments: list[dict[str, Any]] | None = None,
    candidate_context: CandidatePlanningContext | None = None,
) -> dict[str, Any]:
    request_params_snapshot = {
        "planning_mode": payload.get("planning_mode"),
        "planning_start_date": payload.get("planning_start_date"),
        "planning_end_date": payload.get("planning_end_date"),
        "planning_days": payload.get("planning_days"),
        "visit_frequency_days": payload.get("visit_frequency_days"),
        "strict_ca": payload.get("strict_ca"),
        "allow_partial_plan": payload.get("allow_partial_plan"),
        "allow_commercial_reassignment": payload.get("allow_commercial_reassignment"),
        "default_max_visits_per_slot": payload.get("default_max_visits_per_slot"),
        "min_daily_ca_per_commercial": payload.get("min_daily_ca_per_commercial"),
        "capacity_mode": payload.get("capacity_mode"),
        "time_capacity_known": payload.get("time_capacity_known"),
        "user_min_visits_per_slot": payload.get("user_min_visits_per_slot"),
        "user_max_visits_per_slot": payload.get("user_max_visits_per_slot"),
        "working_days": list(payload.get("working_days") or []),
        "depot": dict(payload.get("depot") or {}),
        "selected_commercial_codes": sorted(
            str(item.get("code") or "").strip()
            for item in (payload.get("commercials") or [])
            if isinstance(item, dict) and str(item.get("code") or "").strip()
        ),
        "input_duplicate_client_ids": sorted(str(value) for value in (payload.get("input_duplicate_client_ids") or [])),
        "input_duplicate_client_codes": sorted(str(value) for value in (payload.get("input_duplicate_client_codes") or [])),
    }
    clients_snapshot = [
        _normalized_client_input_snapshot(client)
        for client in sorted(mandatory_clients, key=lambda item: item.client_id)
    ]
    slots_snapshot = [
        _normalized_slot_input_snapshot(slot)
        for slot in sorted(slots, key=lambda item: item.slot_id)
    ]
    constraints_snapshot = _to_stable_json_value(effective_constraints or {})
    predictions_snapshot = [
        {
            "client_id": client.client_id,
            "client_code": client.client_code,
            "predicted_ca": client.predicted_ca,
            "predicted_ca_known": bool(client.predicted_ca_known),
            "purchase_prediction_score": client.purchase_prediction_score,
            "predicted_purchase_date": client.predicted_purchase_date,
            "purchase_days_until_prediction": client.purchase_days_until_prediction,
            "recommended_quantity": client.recommended_quantity,
            "expected_order_value": client.expected_order_value,
            "predicted_products": list(client.predicted_products),
            "purchase_prediction_known": bool(client.purchase_prediction_known),
            "purchase_prediction_source": client.purchase_prediction_source,
        }
        for client in sorted(mandatory_clients, key=lambda item: item.client_id)
    ]
    history_profiles_snapshot = {
        "clients": [
            {
                "client_id": client.client_id,
                "client_code": client.client_code,
                "historical_commercial_code": client.historical_commercial_code,
                "last_real_visit_date": client.last_real_visit_date,
                "next_visit_deadline": client.next_visit_deadline,
                "visit_frequency_days": client.visit_frequency_days,
                "recovery_total_balance": client.recovery_total_balance,
                "recovery_due_amount": client.recovery_due_amount,
                "recovery_days_past_due": client.recovery_days_past_due,
                "recovery_expected_next_payment_date": client.recovery_expected_next_payment_date,
                "recovery_days_since_expected_payment": client.recovery_days_since_expected_payment,
                "recovery_payment_behavior_score": client.recovery_payment_behavior_score,
                "recovery_expected_collection_amount": client.recovery_expected_collection_amount,
                "recovery_priority_score": client.recovery_priority_score,
                "recovery_data_known": bool(client.recovery_data_known),
                "recovery_source": client.recovery_source,
            }
            for client in sorted(mandatory_clients, key=lambda item: item.client_id)
        ],
        "slots": slots_snapshot,
    }
    candidate_pairs_snapshot_hash = _compute_candidate_pairs_snapshot_hash(
        assignments=assignments,
        candidate_context=candidate_context
    )
    return {
        "request_params_hash": compute_stable_debug_hash(request_params_snapshot),
        "clients_snapshot_hash": compute_stable_debug_hash(clients_snapshot),
        "slots_hash": compute_stable_debug_hash(slots_snapshot),
        "constraints_hash": compute_stable_debug_hash(constraints_snapshot),
        "predictions_hash": compute_stable_debug_hash(predictions_snapshot),
        "history_profiles_hash": compute_stable_debug_hash(history_profiles_snapshot),
        "input_candidate_pairs_snapshot_hash": candidate_pairs_snapshot_hash,
        "functional_input_hash": _compute_functional_input_hash_from_snapshots(
            request_params_snapshot=request_params_snapshot,
            clients_snapshot=clients_snapshot,
            slots_snapshot=slots_snapshot,
            constraints_snapshot=constraints_snapshot,
            predictions_snapshot=predictions_snapshot,
            history_profiles_snapshot=history_profiles_snapshot,
            assignments=assignments,
            candidate_context=candidate_context,
        ),
    }


def _hash_assignment_state(assigned_clients_by_slot: dict[str, list[NormalizedClient]]) -> str:
    return compute_stable_debug_hash([
        {
            "slot_id": slot_id,
            "client_ids": [client.client_id for client in clients]
        }
        for slot_id, clients in sorted(assigned_clients_by_slot.items(), key=lambda item: item[0])
    ])


@dataclass
class CoverageCpSatArtifacts:
    model: Any
    assignments: list[dict[str, Any]]
    candidate_keys: list[tuple[str, str]]
    candidate_indexes_by_client: dict[str, list[int]]
    candidate_indexes_by_slot: dict[str, list[int]]
    candidate_by_client_slot: dict[tuple[str, str], dict[str, Any]]
    x_vars_by_index: list[Any]
    x_var_by_key: dict[tuple[str, str], Any]
    unassigned_vars: dict[str, Any]
    slot_shortfall_vars: dict[str, Any]
    slot_load_vars: dict[str, Any]
    model_stats: dict[str, Any]
    solver_parameters: dict[str, Any]
    secondary_objective_terms: list[Any] | None = None
    target_collection_effective_var: Any | None = None


@dataclass
class CoverageModelBuilder:
    model: Any
    variable_specs: dict[tuple[Any, ...], dict[str, Any]] = field(default_factory=dict)
    objective_coefficients: dict[tuple[Any, ...], tuple[Any, int]] = field(default_factory=dict)
    constraint_signatures: set[tuple[Any, ...]] = field(default_factory=set)
    constraint_category_counts: Counter = field(default_factory=Counter)
    deduplicated_constraint_count: int = 0
    bool_var_count: int = 0
    int_var_count: int = 0

    def register_bool_var(self, semantic_key: tuple[Any, ...], var: Any) -> None:
        self.variable_specs[semantic_key] = {
            "kind": "bool",
            "domain": [0, 1]
        }
        self.bool_var_count += 1

    def register_int_var(self, semantic_key: tuple[Any, ...], lb: int, ub: int, var: Any) -> None:
        self.variable_specs[semantic_key] = {
            "kind": "int",
            "domain": [int(lb), int(ub)]
        }
        self.int_var_count += 1

    def add_objective_term(self, semantic_key: tuple[Any, ...], var: Any, coefficient: int) -> None:
        coeff = int(coefficient or 0)
        if coeff == 0:
            return
        current = self.objective_coefficients.get(semantic_key)
        if current is None:
            self.objective_coefficients[semantic_key] = (var, coeff)
            return
        self.objective_coefficients[semantic_key] = (current[0], int(current[1]) + coeff)

    def add_linear_constraint(
        self,
        terms: list[tuple[tuple[Any, ...], Any, int]],
        operator: str,
        rhs: int,
        category: str
    ) -> None:
        normalized_terms = tuple(
            sorted(
                (
                    tuple(semantic_key),
                    int(coefficient)
                )
                for semantic_key, _, coefficient in terms
                if int(coefficient or 0) != 0
            )
        )
        signature = ("linear", str(category or "unknown"), str(operator or "=="), normalized_terms, int(rhs))
        if signature in self.constraint_signatures:
            self.deduplicated_constraint_count += 1
            return
        self.constraint_signatures.add(signature)
        self.constraint_category_counts[str(category or "unknown")] += 1

        expression_terms = [var * int(coefficient) for _, var, coefficient in terms if int(coefficient or 0) != 0]
        linear_expression = sum(expression_terms) if expression_terms else 0
        if operator == "==":
            self.model.Add(linear_expression == int(rhs))
        elif operator == "<=":
            self.model.Add(linear_expression <= int(rhs))
        elif operator == ">=":
            self.model.Add(linear_expression >= int(rhs))
        else:
            raise ValueError(f"Unsupported linear operator: {operator}")

    def add_max_equality(
        self,
        target_key: tuple[Any, ...],
        target_var: Any,
        source_items: list[tuple[tuple[Any, ...], Any]],
        category: str
    ) -> None:
        normalized_sources = tuple(sorted(tuple(source_key) for source_key, _ in source_items))
        signature = ("max_equality", str(category or "unknown"), tuple(target_key), normalized_sources)
        if signature in self.constraint_signatures:
            self.deduplicated_constraint_count += 1
            return
        self.constraint_signatures.add(signature)
        self.constraint_category_counts[str(category or "unknown")] += 1
        if source_items:
            self.model.AddMaxEquality(target_var, [var for _, var in source_items])
        else:
            self.model.Add(target_var == 0)

    def build_objective_terms(self) -> list[Any]:
        return [
            var * int(coefficient)
            for _, (var, coefficient) in self.objective_coefficients.items()
            if int(coefficient or 0) != 0
        ]


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(float(value))
    except Exception:
        return default


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) else default
    except Exception:
        return default


def _safe_optional_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) else None
    except Exception:
        return None


def _safe_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return value != 0
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "yes", "y", "on"}:
        return True
    if normalized in {"0", "false", "no", "n", "off"}:
        return False
    return default


def normalize_planning_mode(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    return PLANNING_MODE_SALES if normalized == PLANNING_MODE_SALES else PLANNING_MODE_RECOVERY


def normalize_daily_max_mode(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    return DAILY_MAX_MODE_STRICT if normalized == DAILY_MAX_MODE_STRICT else DAILY_MAX_MODE_FLEXIBLE


def resolve_payload_planning_mode(payload: dict[str, Any] | None) -> str:
    if not isinstance(payload, dict):
        return PLANNING_MODE_RECOVERY
    return normalize_planning_mode(payload.get("planning_mode"))


def is_sales_coverage_mode(payload: dict[str, Any] | None) -> bool:
    return resolve_payload_planning_mode(payload) == PLANNING_MODE_SALES


def resolve_client_recovery_urgency_value(client: NormalizedClient) -> float:
    overdue_days = max(0, _safe_int(client.recovery_days_past_due, 0))
    payment_delay_days = max(0, _safe_int(client.recovery_days_since_expected_payment, 0))
    return float(max(overdue_days, payment_delay_days))


def normalize_time_of_day(value: Any) -> str | None:
    normalized = str(value or "").strip()
    match = normalized[:8].strip().replace(".", ":")
    parsed = None
    for fmt in ("%H:%M:%S", "%H:%M"):
        try:
            parsed = datetime.strptime(match, fmt)
            break
        except Exception:
            continue
    if parsed is None:
        return None
    return parsed.strftime("%H:%M:%S")


def is_known_predicted_ca(value: Any) -> bool:
    return value is not None and isinstance(value, (int, float)) and math.isfinite(value)


def is_known_recovery_number(value: Any) -> bool:
    return value is not None and isinstance(value, (int, float)) and math.isfinite(value)


def is_known_purchase_number(value: Any) -> bool:
    return value is not None and isinstance(value, (int, float)) and math.isfinite(value)


def resolve_client_predicted_ca_value(client: NormalizedClient) -> float:
    return max(0.0, float(client.predicted_ca)) if is_known_predicted_ca(client.predicted_ca) else 0.0


def resolve_client_purchase_prediction_score_value(client: NormalizedClient) -> float:
    if not is_known_purchase_number(client.purchase_prediction_score):
        return 0.0
    return max(0.0, min(100.0, float(client.purchase_prediction_score)))


def resolve_client_expected_order_value(client: NormalizedClient) -> float:
    if not is_known_purchase_number(client.expected_order_value):
        return 0.0
    return max(0.0, float(client.expected_order_value))


def resolve_client_purchase_timing_urgency(client: NormalizedClient) -> float:
    if client.purchase_days_until_prediction is None:
        return 0.0
    return round(max(0.0, 100.0 - float(max(0, client.purchase_days_until_prediction))), 2)


def resolve_client_recovery_priority_value(client: NormalizedClient) -> float:
    if not is_known_recovery_number(client.recovery_priority_score):
        return 0.0
    return max(0.0, min(100.0, float(client.recovery_priority_score)))


def resolve_client_expected_collection_value(client: NormalizedClient) -> float:
    if not is_known_recovery_number(client.recovery_expected_collection_amount):
        return 0.0
    return max(0.0, float(client.recovery_expected_collection_amount))


def _to_stable_money_decimal(value: Any) -> Decimal | None:
    parsed = _safe_optional_float(value)
    if parsed is None:
        return None
    try:
        decimal_value = Decimal(str(parsed))
    except (InvalidOperation, ValueError):
        return None
    if not decimal_value.is_finite():
        return None
    return decimal_value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _money_decimal_to_float(value: Decimal) -> float:
    return float(value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _resolve_candidate_recovery_expected_collection_decimal(candidate: Any) -> Decimal:
    raw_value = None
    if isinstance(candidate, dict):
        raw_value = candidate.get("recovery_expected_collection_amount")
    else:
        raw_value = getattr(candidate, "recovery_expected_collection_amount", None)
    if not is_known_recovery_number(raw_value):
        return Decimal("0.00")
    positive_value = float(raw_value)
    if positive_value <= 0.0:
        return Decimal("0.00")
    return _to_stable_money_decimal(positive_value) or Decimal("0.00")


def apply_collection_target_candidate_selection(
    ordered_candidates: list[Any],
    collection_target_context: dict[str, Any] | None,
) -> dict[str, Any]:
    candidates = list(ordered_candidates or [])
    raw_mode = None
    if isinstance(collection_target_context, dict):
        raw_mode = collection_target_context.get("mode")
    mode = "target_collection" if raw_mode == "target_collection" else "full_coverage"
    requested_target_decimal = (
        _to_stable_money_decimal(
            collection_target_context.get("requested_target_collection_amount")
            if isinstance(collection_target_context, dict)
            else None
        )
        if mode == "target_collection"
        else None
    )
    if requested_target_decimal is None or requested_target_decimal <= Decimal("0.00"):
        mode = "full_coverage"
        requested_target_decimal = None

    if not candidates:
        remaining_amount = requested_target_decimal or Decimal("0.00")
        return {
            "mode": mode,
            "requested_target_collection_amount": (
                _money_decimal_to_float(requested_target_decimal)
                if requested_target_decimal is not None
                else None
            ),
            "selected_candidates": [],
            "selected_candidates_count": 0,
            "selected_estimated_collection_amount": 0.0,
            "is_target_reached": mode == "full_coverage",
            "estimated_remaining_amount": _money_decimal_to_float(remaining_amount),
            "stop_reason": "no_candidates",
        }

    if mode == "full_coverage":
        selected_estimated_collection_amount_decimal = Decimal("0.00")
        for candidate in candidates:
            selected_estimated_collection_amount_decimal += _resolve_candidate_recovery_expected_collection_decimal(candidate)
        selected_estimated_collection_amount_decimal = selected_estimated_collection_amount_decimal.quantize(
            Decimal("0.01"),
            rounding=ROUND_HALF_UP,
        )
        return {
            "mode": "full_coverage",
            "requested_target_collection_amount": None,
            "selected_candidates": candidates[:],
            "selected_candidates_count": len(candidates),
            "selected_estimated_collection_amount": _money_decimal_to_float(
                selected_estimated_collection_amount_decimal
            ),
            "is_target_reached": True,
            "estimated_remaining_amount": 0.0,
            "stop_reason": "full_coverage",
        }

    requested_target_decimal = requested_target_decimal or Decimal("0.00")
    selected_candidates: list[Any] = []
    selected_estimated_collection_amount_decimal = Decimal("0.00")

    for candidate in candidates:
        selected_candidates.append(candidate)
        selected_estimated_collection_amount_decimal += _resolve_candidate_recovery_expected_collection_decimal(candidate)
        selected_estimated_collection_amount_decimal = selected_estimated_collection_amount_decimal.quantize(
            Decimal("0.01"),
            rounding=ROUND_HALF_UP,
        )
        if selected_estimated_collection_amount_decimal >= requested_target_decimal:
            return {
                "mode": "target_collection",
                "requested_target_collection_amount": _money_decimal_to_float(requested_target_decimal),
                "selected_candidates": selected_candidates,
                "selected_candidates_count": len(selected_candidates),
                "selected_estimated_collection_amount": _money_decimal_to_float(
                    selected_estimated_collection_amount_decimal
                ),
                "is_target_reached": True,
                "estimated_remaining_amount": 0.0,
                "stop_reason": "target_reached",
            }

    remaining_amount_decimal = max(
        Decimal("0.00"),
        requested_target_decimal - selected_estimated_collection_amount_decimal,
    ).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return {
        "mode": "target_collection",
        "requested_target_collection_amount": _money_decimal_to_float(requested_target_decimal),
        "selected_candidates": selected_candidates,
        "selected_candidates_count": len(selected_candidates),
        "selected_estimated_collection_amount": _money_decimal_to_float(selected_estimated_collection_amount_decimal),
        "is_target_reached": False,
        "estimated_remaining_amount": _money_decimal_to_float(remaining_amount_decimal),
        "stop_reason": "target_unreachable",
    }


def build_collection_target_context(
    clients: list[NormalizedClient],
    target_collection_amount: Any,
) -> dict[str, Any]:
    requested_target_decimal = _to_stable_money_decimal(target_collection_amount)
    target_collection_mode = (
        "target_collection"
        if requested_target_decimal is not None and requested_target_decimal > Decimal("0.00")
        else "full_coverage"
    )

    estimated_available_collection_decimal = Decimal("0.00")
    clients_with_collection_estimate_count = 0
    clients_without_collection_estimate_count = 0

    for client in clients or []:
        expected_collection_amount = getattr(client, "recovery_expected_collection_amount", None)
        if is_known_recovery_number(expected_collection_amount):
            clients_with_collection_estimate_count += 1
            positive_amount = max(0.0, float(expected_collection_amount))
            estimated_available_collection_decimal += Decimal(str(positive_amount))
            continue
        clients_without_collection_estimate_count += 1

    estimated_available_collection_decimal = estimated_available_collection_decimal.quantize(
        Decimal("0.01"),
        rounding=ROUND_HALF_UP,
    )

    if target_collection_mode == "full_coverage":
        return {
            "mode": "full_coverage",
            "requested_target_collection_amount": None,
            "estimated_available_collection_amount": _money_decimal_to_float(estimated_available_collection_decimal),
            "estimated_collection_gap_amount": None,
            "is_target_collection_reachable": None,
            "clients_with_collection_estimate_count": clients_with_collection_estimate_count,
            "clients_without_collection_estimate_count": clients_without_collection_estimate_count,
        }

    requested_target_decimal = requested_target_decimal or Decimal("0.00")
    estimated_collection_gap_decimal = max(
        Decimal("0.00"),
        requested_target_decimal - estimated_available_collection_decimal,
    ).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    is_target_collection_reachable = estimated_collection_gap_decimal == Decimal("0.00")

    return {
        "mode": "target_collection",
        "requested_target_collection_amount": _money_decimal_to_float(requested_target_decimal),
        "estimated_available_collection_amount": _money_decimal_to_float(estimated_available_collection_decimal),
        "estimated_collection_gap_amount": _money_decimal_to_float(estimated_collection_gap_decimal),
        "is_target_collection_reachable": is_target_collection_reachable,
        "clients_with_collection_estimate_count": clients_with_collection_estimate_count,
        "clients_without_collection_estimate_count": clients_without_collection_estimate_count,
    }


def resolve_collection_target_context(payload: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(payload, dict):
        return None
    context = payload.get("collection_target_context")
    return context if isinstance(context, dict) else None


def build_functional_metadata(
    *,
    payload: dict[str, Any] | None = None,
    collection_target_context: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    resolved_collection_target_context = (
        collection_target_context
        if isinstance(collection_target_context, dict)
        else resolve_collection_target_context(payload)
    )
    if resolved_collection_target_context is None:
        return None
    return {
        "collection_target_context": resolved_collection_target_context,
    }


def finalize_collection_target_context_from_assigned_clients(
    collection_target_context: dict[str, Any] | None,
    assigned_clients: list[Any],
) -> dict[str, Any] | None:
    if not isinstance(collection_target_context, dict):
        return None

    finalized_context = dict(collection_target_context)
    mode = "target_collection" if finalized_context.get("mode") == "target_collection" else "full_coverage"
    requested_target_decimal = (
        _to_stable_money_decimal(finalized_context.get("requested_target_collection_amount"))
        if mode == "target_collection"
        else None
    )
    if requested_target_decimal is None or requested_target_decimal <= Decimal("0.00"):
        mode = "full_coverage"
        requested_target_decimal = None

    assigned_collection_decimal = Decimal("0.00")
    for client in assigned_clients or []:
        assigned_collection_decimal += _resolve_candidate_recovery_expected_collection_decimal(client)
    assigned_collection_decimal = assigned_collection_decimal.quantize(
        Decimal("0.01"),
        rounding=ROUND_HALF_UP,
    )

    if mode == "full_coverage":
        finalized_context.update({
            "mode": "full_coverage",
            "requested_target_collection_amount": None,
            "estimated_assigned_collection_amount": _money_decimal_to_float(assigned_collection_decimal),
            "estimated_remaining_collection_amount": 0.0,
            "is_target_collection_reached": True,
            "collection_target_stop_reason": "full_coverage",
            "selected_estimated_collection_amount": _money_decimal_to_float(assigned_collection_decimal),
            "estimated_remaining_amount": 0.0,
            "is_target_reached": True,
            "stop_reason": "full_coverage",
        })
        return finalized_context

    requested_target_decimal = requested_target_decimal or Decimal("0.00")
    remaining_amount_decimal = max(
        Decimal("0.00"),
        requested_target_decimal - assigned_collection_decimal,
    ).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    is_target_reached = assigned_collection_decimal >= requested_target_decimal
    stop_reason = "target_reached" if is_target_reached else "target_unreachable"
    finalized_context.update({
        "mode": "target_collection",
        "requested_target_collection_amount": _money_decimal_to_float(requested_target_decimal),
        "estimated_assigned_collection_amount": _money_decimal_to_float(assigned_collection_decimal),
        "estimated_remaining_collection_amount": _money_decimal_to_float(remaining_amount_decimal),
        "is_target_collection_reached": is_target_reached,
        "collection_target_stop_reason": stop_reason,
        "selected_estimated_collection_amount": _money_decimal_to_float(assigned_collection_decimal),
        "estimated_remaining_amount": _money_decimal_to_float(remaining_amount_decimal),
        "is_target_reached": is_target_reached,
        "stop_reason": stop_reason,
    })
    return finalized_context


def resolve_client_coverage_urgency_component(client: NormalizedClient, planning_start_date: str | None) -> float:
    planning_start = parse_iso_date(planning_start_date)
    deadline = parse_iso_date(client.next_visit_deadline)
    if planning_start is None or deadline is None:
        return 100.0 if client.is_critical else 0.0
    gap_days = max(0, (deadline - planning_start).days)
    urgency = max(0.0, 100.0 - float(gap_days))
    if client.is_critical:
        urgency += 100.0
    return round(urgency, 2)


def client_has_overdue_recovery(client: NormalizedClient) -> bool:
    if client.recovery_days_past_due is not None and client.recovery_days_past_due > 0:
        return True
    return client.recovery_days_since_expected_payment is not None and client.recovery_days_since_expected_payment > 0


def summarize_recovery_clients(clients: list[NormalizedClient]) -> dict[str, Any]:
    if not clients:
        return {
            "recovery_clients_count": 0,
            "recovery_data_known_count": 0,
            "recovery_data_unknown_count": 0,
            "expected_collection_total": 0.0,
            "overdue_balance_total": 0.0,
            "high_recovery_priority_count": 0,
            "recovery_completeness": True
        }

    known_count = sum(1 for client in clients if client.recovery_data_known)
    unknown_count = len(clients) - known_count
    expected_collection_values = [
        resolve_client_expected_collection_value(client)
        for client in clients
        if is_known_recovery_number(client.recovery_expected_collection_amount)
    ]
    overdue_balance_values = [
        max(0.0, float(client.recovery_due_amount))
        for client in clients
        if client_has_overdue_recovery(client) and is_known_recovery_number(client.recovery_due_amount)
    ]
    high_priority_count = sum(
        1
        for client in clients
        if resolve_client_recovery_priority_value(client) >= 70.0
    )

    return {
        "recovery_clients_count": len(clients),
        "recovery_data_known_count": known_count,
        "recovery_data_unknown_count": unknown_count,
        "expected_collection_total": round(sum(expected_collection_values), 2) if expected_collection_values else (None if unknown_count > 0 else 0.0),
        "overdue_balance_total": round(sum(overdue_balance_values), 2) if overdue_balance_values else (None if unknown_count > 0 else 0.0),
        "high_recovery_priority_count": high_priority_count,
        "recovery_completeness": unknown_count == 0
    }


def build_recovery_summary(clients: list[NormalizedClient], planned_client_ids: set[str] | None = None) -> dict[str, Any]:
    planned_ids = planned_client_ids or set()
    clients_with_recovery_data = sum(1 for client in clients if client.recovery_data_known)
    clients_without_recovery_data = len(clients) - clients_with_recovery_data
    expected_collection_values = [
        resolve_client_expected_collection_value(client)
        for client in clients
        if is_known_recovery_number(client.recovery_expected_collection_amount)
    ]
    overdue_clients_planned = 0
    overdue_clients_unplanned = 0
    for client in clients:
        if not client_has_overdue_recovery(client):
            continue
        if client.client_id in planned_ids:
            overdue_clients_planned += 1
        else:
            overdue_clients_unplanned += 1

    return {
        "clients_with_recovery_data": clients_with_recovery_data,
        "clients_without_recovery_data": clients_without_recovery_data,
        "expected_collection_total_known": round(sum(expected_collection_values), 2) if expected_collection_values else (None if clients_without_recovery_data > 0 else 0.0),
        "expected_collection_completeness": clients_without_recovery_data == 0,
        "overdue_clients_planned": overdue_clients_planned,
        "overdue_clients_unplanned": overdue_clients_unplanned
    }


def summarize_purchase_prediction_clients(clients: list[NormalizedClient]) -> dict[str, Any]:
    if not clients:
        return {
            "purchase_prediction_known_count": 0,
            "purchase_prediction_unknown_count": 0,
            "predicted_order_value_total": 0.0,
            "recommended_quantity_total": 0.0,
            "high_purchase_priority_count": 0,
            "purchase_prediction_completeness": True
        }

    known_count = sum(1 for client in clients if client.purchase_prediction_known)
    unknown_count = len(clients) - known_count
    predicted_order_values = [
      resolve_client_expected_order_value(client)
      for client in clients
      if is_known_purchase_number(client.expected_order_value)
    ]
    recommended_quantities = [
      max(0.0, float(client.recommended_quantity))
      for client in clients
      if is_known_purchase_number(client.recommended_quantity)
    ]
    high_purchase_priority_count = sum(
      1
      for client in clients
      if resolve_client_purchase_prediction_score_value(client) >= 70.0
    )

    return {
        "purchase_prediction_known_count": known_count,
        "purchase_prediction_unknown_count": unknown_count,
        "predicted_order_value_total": round(sum(predicted_order_values), 2) if predicted_order_values else (None if unknown_count > 0 else 0.0),
        "recommended_quantity_total": round(sum(recommended_quantities), 2) if recommended_quantities else (None if unknown_count > 0 else 0.0),
        "high_purchase_priority_count": high_purchase_priority_count,
        "purchase_prediction_completeness": unknown_count == 0
    }


def build_purchase_prediction_summary(clients: list[NormalizedClient], planned_client_ids: set[str] | None = None) -> dict[str, Any]:
    planned_ids = planned_client_ids or set()
    clients_with_prediction = sum(1 for client in clients if client.purchase_prediction_known)
    clients_without_prediction = len(clients) - clients_with_prediction
    predicted_order_values = [
      resolve_client_expected_order_value(client)
      for client in clients
      if is_known_purchase_number(client.expected_order_value)
    ]
    high_purchase_priority_planned = 0
    high_purchase_priority_unplanned = 0
    for client in clients:
        if resolve_client_purchase_prediction_score_value(client) < 70.0:
            continue
        if client.client_id in planned_ids:
            high_purchase_priority_planned += 1
        else:
            high_purchase_priority_unplanned += 1

    return {
        "clients_with_prediction": clients_with_prediction,
        "clients_without_prediction": clients_without_prediction,
        "predicted_order_value_total_known": round(sum(predicted_order_values), 2) if predicted_order_values else (None if clients_without_prediction > 0 else 0.0),
        "predicted_order_value_completeness": clients_without_prediction == 0,
        "high_purchase_priority_planned": high_purchase_priority_planned,
        "high_purchase_priority_unplanned": high_purchase_priority_unplanned
    }


def summarize_predicted_ca_clients(clients: list[NormalizedClient]) -> dict[str, Any]:
    if not clients:
        return {
            "predicted_ca": 0.0,
            "predicted_ca_known_count": 0,
            "predicted_ca_unknown_count": 0,
            "predicted_ca_is_complete": True
        }

    known_values = [
        max(0.0, float(client.predicted_ca))
        for client in clients
        if is_known_predicted_ca(client.predicted_ca)
    ]
    known_count = len(known_values)
    unknown_count = len(clients) - known_count

    return {
        "predicted_ca": round(sum(known_values), 2) if known_count > 0 else None,
        "predicted_ca_known_count": known_count,
        "predicted_ca_unknown_count": unknown_count,
        "predicted_ca_is_complete": unknown_count == 0
    }


def normalize_capacity_mode(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {
        CAPACITY_MODE_VALIDATED_VISIT,
        CAPACITY_MODE_SALES_PROXY,
        CAPACITY_MODE_CONFIGURED_HARD,
        CAPACITY_MODE_UNKNOWN
    }:
        return normalized
    return CAPACITY_MODE_UNKNOWN


def canonical_client_code(raw_value: Any) -> str:
    raw_key = str(raw_value or "").strip()
    if not raw_key:
        return ""
    return raw_key.replace(" ", "")


def canonical_client_id(raw_value: Any) -> str:
    raw_key = str(raw_value or "").strip()
    if not raw_key:
        return ""
    return raw_key


def parse_iso_date(value: Any) -> date | None:
    if not value:
        return None
    text = str(value).strip()[:10]
    try:
        return datetime.strptime(text, DATE_FMT).date()
    except Exception:
        return None


def format_iso_date(value: date | None) -> str | None:
    return value.strftime(DATE_FMT) if isinstance(value, date) else None


def add_days(value: date, days: int) -> date:
    return value + timedelta(days=int(days or 0))


def haversine_km(lat1: float | None, lon1: float | None, lat2: float | None, lon2: float | None) -> float | None:
    if None in (lat1, lon1, lat2, lon2):
        return None

    try:
        lat1 = float(lat1)
        lon1 = float(lon1)
        lat2 = float(lat2)
        lon2 = float(lon2)
    except Exception:
        return None

    earth_radius_km = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2 +
        math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    )
    return earth_radius_km * (2 * math.atan2(math.sqrt(a), math.sqrt(1 - a)))


def is_valid_coordinate_pair(latitude: Any, longitude: Any) -> bool:
    lat = _safe_float(latitude, None)
    lon = _safe_float(longitude, None)
    if lat is None or lon is None:
        return False
    return -90 <= lat <= 90 and -180 <= lon <= 180


def resolve_last_real_visit_date(visits: list[dict[str, Any]] | None = None) -> str | None:
    latest: date | None = None
    for visit in visits or []:
        if str(visit.get("validation_status") or "").strip().lower() != "validated":
            continue
        check_in = parse_iso_date(visit.get("check_in_at") or visit.get("check_in_date"))
        if check_in and (latest is None or check_in > latest):
            latest = check_in
    return format_iso_date(latest)


def resolve_next_visit_deadline(
    explicit_deadline: Any,
    last_real_visit_date: Any,
    visit_frequency_days: int,
    planning_end_date: date
) -> str:
    explicit = parse_iso_date(explicit_deadline)
    if explicit:
        return explicit.strftime(DATE_FMT)

    last_real_visit = parse_iso_date(last_real_visit_date)
    if last_real_visit:
        return add_days(last_real_visit, visit_frequency_days).strftime(DATE_FMT)

    return planning_end_date.strftime(DATE_FMT)


def normalize_working_days(raw_working_days: Any) -> list[int]:
    if not isinstance(raw_working_days, list) or not raw_working_days:
        return DEFAULT_WORKING_DAYS[:]

    normalized = []
    for raw_value in raw_working_days:
        parsed = _safe_int(raw_value, -1)
        if 0 <= parsed <= 6 and parsed not in normalized:
            normalized.append(parsed)
    return normalized or DEFAULT_WORKING_DAYS[:]


def build_planning_dates(planning_start_date: str, planning_days: int, working_days: list[int]) -> list[str]:
    start_date = parse_iso_date(planning_start_date)
    if not start_date:
        raise ValueError("planning_start_date invalide")

    planning_dates = []
    for offset in range(max(0, planning_days)):
        current_date = add_days(start_date, offset)
        if current_date.weekday() in []:
            pass
        js_day_index = (current_date.weekday() + 1) % 7
        if js_day_index in working_days:
            planning_dates.append(current_date.strftime(DATE_FMT))
    return planning_dates


def normalize_payload(payload: dict[str, Any]) -> dict[str, Any]:
    planning_mode = normalize_planning_mode(payload.get("planning_mode"))
    sales_mode = planning_mode == PLANNING_MODE_SALES
    planning_start_date = str(
        payload.get("planning_start_date") or
        payload.get("start_date") or
        ""
    ).strip()
    planning_days = max(
        1,
        _safe_int(
            payload.get("planning_horizon_days") or payload.get("planning_days") or payload.get("period_days"),
            DEFAULT_COVERAGE_WINDOW_DAYS,
        ),
    )
    visit_frequency_days = max(
        1,
        _safe_int(
            payload.get("coverage_window_days") or payload.get("visit_frequency_days"),
            DEFAULT_COVERAGE_WINDOW_DAYS,
        ),
    )
    daily_max_mode = normalize_daily_max_mode(payload.get("daily_max_mode"))
    strict_ca = _safe_bool(payload.get("strict_ca"), False) if sales_mode else False
    allow_commercial_reassignment = _safe_bool(payload.get("allow_commercial_reassignment"), False)
    default_max_visits_per_slot = max(
        1,
        _safe_int(payload.get("default_max_visits_per_slot") or payload.get("max_visits"), 30)
    )
    min_daily_ca_per_commercial = (
        max(
            0.0,
            _safe_float(payload.get("min_daily_ca_per_commercial") or payload.get("min_daily_ca") or payload.get("min_total_ca"), 0.0)
        )
        if sales_mode
        else 0.0
    )
    allow_partial_plan = _safe_bool(payload.get("allow_partial_plan"), False)
    raw_capacity_mode = payload.get("capacity_mode")
    capacity_mode = normalize_capacity_mode(raw_capacity_mode)
    time_capacity_known = _safe_bool(payload.get("time_capacity_known"), False)
    user_min_visits_per_slot = max(
        0,
        _safe_int(
            payload.get("user_min_visits_per_slot") or
            payload.get("min_clients") or
            payload.get("min_visits"),
            0
        )
    )
    user_max_visits_per_slot = max(
        0,
        _safe_int(
            payload.get("user_max_visits_per_slot") or
            payload.get("max_clients_user") or
            payload.get("max_clients_soft"),
            0
        )
    )
    working_days = normalize_working_days(payload.get("working_days"))
    planning_dates = build_planning_dates(planning_start_date, planning_days, working_days)
    planning_start = parse_iso_date(planning_start_date)
    if not planning_start:
        raise ValueError("planning_start_date invalide")
    planning_end = add_days(planning_start, planning_days - 1)

    depot_raw = payload.get("depot") if isinstance(payload.get("depot"), dict) else {}
    depot = {
        "latitude": _safe_float(depot_raw.get("latitude"), None),
        "longitude": _safe_float(depot_raw.get("longitude"), None),
        "label": str(depot_raw.get("label") or depot_raw.get("nom") or "Depot").strip() or "Depot"
    }

    has_sales_proxy_signal = False
    has_hard_capacity_signal = False

    commercials_input = payload.get("commercials") if isinstance(payload.get("commercials"), list) else []
    commercials = []
    for raw_commercial in commercials_input:
        commercial_code = str(raw_commercial.get("code") or raw_commercial.get("commercial_code") or "").strip()
        if not commercial_code:
            continue
        available_dates = []
        for raw_date in (raw_commercial.get("available_dates") or planning_dates):
            parsed_date = parse_iso_date(raw_date)
            if not parsed_date:
                continue
            iso_date = parsed_date.strftime(DATE_FMT)
            if iso_date not in planning_dates:
                continue
            if iso_date not in available_dates:
                available_dates.append(iso_date)

        max_visits_by_date = {}
        for date_key, value in (raw_commercial.get("max_visits_by_date") or {}).items():
            parsed_date = parse_iso_date(date_key)
            if not parsed_date:
                continue
            max_visits_by_date[parsed_date.strftime(DATE_FMT)] = max(1, _safe_int(value, default_max_visits_per_slot))

        min_ca_by_date = {}
        for date_key, value in (raw_commercial.get("min_ca_by_date") or {}).items():
            parsed_date = parse_iso_date(date_key)
            if not parsed_date:
                continue
            min_ca_by_date[parsed_date.strftime(DATE_FMT)] = (
                max(0.0, _safe_float(value, min_daily_ca_per_commercial))
                if sales_mode
                else 0.0
            )

        max_load_units_by_date = {}
        for date_key, value in (raw_commercial.get("max_load_units_by_date") or {}).items():
            parsed_date = parse_iso_date(date_key)
            if not parsed_date:
                continue
            max_load_units_by_date[parsed_date.strftime(DATE_FMT)] = max(0.0, _safe_float(value, 0.0))

        historical_soft_capacity_by_date = {}
        for date_key, value in (raw_commercial.get("historical_soft_capacity_by_date") or {}).items():
            parsed_date = parse_iso_date(date_key)
            if not parsed_date:
                continue
            parsed_value = max(1, _safe_int(value, 0))
            if parsed_value > 0:
                historical_soft_capacity_by_date[parsed_date.strftime(DATE_FMT)] = parsed_value

        sales_activity_proxy_by_date = {}
        sales_proxy_raw = (
            raw_commercial.get("sales_activity_proxy_by_date") or
            raw_commercial.get("historical_soft_capacity_by_date") or
            {}
        )
        for date_key, value in sales_proxy_raw.items():
            parsed_date = parse_iso_date(date_key)
            if not parsed_date:
                continue
            parsed_value = max(1, _safe_int(value, 0))
            if parsed_value > 0:
                sales_activity_proxy_by_date[parsed_date.strftime(DATE_FMT)] = parsed_value
                has_sales_proxy_signal = True

        recommended_capacity_by_date = {}
        for date_key, value in (raw_commercial.get("recommended_capacity_by_date") or {}).items():
            parsed_date = parse_iso_date(date_key)
            if not parsed_date:
                continue
            recommended_capacity_by_date[parsed_date.strftime(DATE_FMT)] = max(1, _safe_int(value, default_max_visits_per_slot))

        user_preferred_min_by_date = {}
        for date_key, value in (raw_commercial.get("user_preferred_min_by_date") or {}).items():
            parsed_date = parse_iso_date(date_key)
            if not parsed_date:
                continue
            user_preferred_min_by_date[parsed_date.strftime(DATE_FMT)] = max(0, _safe_int(value, 0))

        user_preferred_max_by_date = {}
        for date_key, value in (raw_commercial.get("user_preferred_max_by_date") or {}).items():
            parsed_date = parse_iso_date(date_key)
            if not parsed_date:
                continue
            parsed_value = max(0, _safe_int(value, 0))
            if parsed_value > 0:
                user_preferred_max_by_date[parsed_date.strftime(DATE_FMT)] = parsed_value

        recommended_min_by_date = {}
        for date_key, value in (raw_commercial.get("recommended_min_by_date") or {}).items():
            parsed_date = parse_iso_date(date_key)
            if not parsed_date:
                continue
            parsed_value = max(1, _safe_int(value, 0))
            if parsed_value > 0:
                recommended_min_by_date[parsed_date.strftime(DATE_FMT)] = parsed_value

        recommended_max_by_date = {}
        for date_key, value in (raw_commercial.get("recommended_max_by_date") or {}).items():
            parsed_date = parse_iso_date(date_key)
            if not parsed_date:
                continue
            parsed_value = max(1, _safe_int(value, 0))
            if parsed_value > 0:
                recommended_max_by_date[parsed_date.strftime(DATE_FMT)] = parsed_value

        effective_target_min_by_date = {}
        for date_key, value in (raw_commercial.get("effective_target_min_by_date") or {}).items():
            parsed_date = parse_iso_date(date_key)
            if not parsed_date:
                continue
            effective_target_min_by_date[parsed_date.strftime(DATE_FMT)] = max(0, _safe_int(value, 0))

        effective_target_max_by_date = {}
        for date_key, value in (raw_commercial.get("effective_target_max_by_date") or {}).items():
            parsed_date = parse_iso_date(date_key)
            if not parsed_date:
                continue
            parsed_value = max(1, _safe_int(value, 0))
            if parsed_value > 0:
                effective_target_max_by_date[parsed_date.strftime(DATE_FMT)] = parsed_value

        hard_capacity_by_date = {}
        for date_key, value in (raw_commercial.get("hard_capacity_by_date") or {}).items():
            parsed_date = parse_iso_date(date_key)
            if not parsed_date:
                continue
            parsed_value = max(1, _safe_int(value, 0))
            if parsed_value > 0:
                hard_capacity_by_date[parsed_date.strftime(DATE_FMT)] = parsed_value
                has_hard_capacity_signal = True

        capacity_source_by_date = {}
        for date_key, value in (raw_commercial.get("capacity_source_by_date") or {}).items():
            parsed_date = parse_iso_date(date_key)
            if not parsed_date:
                continue
            capacity_source_by_date[parsed_date.strftime(DATE_FMT)] = str(value or "").strip()

        sales_proxy_source_by_date = {}
        for date_key, value in (
            raw_commercial.get("sales_proxy_source_by_date") or
            raw_commercial.get("capacity_source_by_date") or
            {}
        ).items():
            parsed_date = parse_iso_date(date_key)
            if not parsed_date:
                continue
            sales_proxy_source_by_date[parsed_date.strftime(DATE_FMT)] = str(value or "").strip()

        sales_proxy_confidence_by_date = {}
        for date_key, value in (raw_commercial.get("sales_proxy_confidence_by_date") or {}).items():
            parsed_date = parse_iso_date(date_key)
            if not parsed_date:
                continue
            sales_proxy_confidence_by_date[parsed_date.strftime(DATE_FMT)] = str(value or "").strip().lower()

        hard_capacity_known_by_date = {}
        for date_key, value in (raw_commercial.get("hard_capacity_known_by_date") or {}).items():
            parsed_date = parse_iso_date(date_key)
            if not parsed_date:
                continue
            hard_capacity_known_by_date[parsed_date.strftime(DATE_FMT)] = _safe_bool(value, False)

        adjustment_reason_by_date = {}
        for date_key, value in (raw_commercial.get("adjustment_reason_by_date") or {}).items():
            parsed_date = parse_iso_date(date_key)
            if not parsed_date:
                continue
            adjustment_reason_by_date[parsed_date.strftime(DATE_FMT)] = str(value or "").strip()

        shift_start_time_by_date = {}
        for date_key, value in (raw_commercial.get("shift_start_time_by_date") or {}).items():
            parsed_date = parse_iso_date(date_key)
            normalized_time = normalize_time_of_day(value)
            if not parsed_date or not normalized_time:
                continue
            shift_start_time_by_date[parsed_date.strftime(DATE_FMT)] = normalized_time

        shift_end_time_by_date = {}
        for date_key, value in (raw_commercial.get("shift_end_time_by_date") or {}).items():
            parsed_date = parse_iso_date(date_key)
            normalized_time = normalize_time_of_day(value)
            if not parsed_date or not normalized_time:
                continue
            shift_end_time_by_date[parsed_date.strftime(DATE_FMT)] = normalized_time

        max_route_minutes_by_date = {}
        for date_key, value in (raw_commercial.get("max_route_minutes_by_date") or {}).items():
            parsed_date = parse_iso_date(date_key)
            if not parsed_date:
                continue
            parsed_value = max(0.0, _safe_float(value, 0.0))
            if parsed_value > 0:
                max_route_minutes_by_date[parsed_date.strftime(DATE_FMT)] = parsed_value

        break_minutes_by_date = {}
        for date_key, value in (raw_commercial.get("break_minutes_by_date") or {}).items():
            parsed_date = parse_iso_date(date_key)
            if not parsed_date:
                continue
            parsed_value = max(0.0, _safe_float(value, 0.0))
            break_minutes_by_date[parsed_date.strftime(DATE_FMT)] = parsed_value

        depot_by_date = {}
        for date_key, raw_depot in (raw_commercial.get("depot_by_date") or {}).items():
            parsed_date = parse_iso_date(date_key)
            if not parsed_date or not isinstance(raw_depot, dict):
                continue
            depot_latitude = _safe_float(raw_depot.get("latitude"), None)
            depot_longitude = _safe_float(raw_depot.get("longitude"), None)
            if not is_valid_coordinate_pair(depot_latitude, depot_longitude):
                continue
            depot_by_date[parsed_date.strftime(DATE_FMT)] = {
              "id": str(raw_depot.get("id") or "").strip() or None,
              "latitude": depot_latitude,
              "longitude": depot_longitude
            }

        time_constraint_source_by_date = {}
        for date_key, value in (raw_commercial.get("time_constraint_source_by_date") or {}).items():
            parsed_date = parse_iso_date(date_key)
            if not parsed_date:
                continue
            time_constraint_source_by_date[parsed_date.strftime(DATE_FMT)] = str(value or "").strip()

        commercials.append({
            "code": commercial_code,
            "label": str(raw_commercial.get("label") or commercial_code).strip() or commercial_code,
            "available_dates": available_dates,
            "max_visits_by_date": max_visits_by_date,
            "min_ca_by_date": min_ca_by_date,
            "user_preferred_min_by_date": user_preferred_min_by_date,
            "user_preferred_max_by_date": user_preferred_max_by_date,
            "recommended_min_by_date": recommended_min_by_date,
            "recommended_max_by_date": recommended_max_by_date,
            "effective_target_min_by_date": effective_target_min_by_date,
            "effective_target_max_by_date": effective_target_max_by_date,
            "hard_capacity_known_by_date": hard_capacity_known_by_date,
            "adjustment_reason_by_date": adjustment_reason_by_date,
            "max_load_units_by_date": max_load_units_by_date,
            "historical_soft_capacity_by_date": historical_soft_capacity_by_date,
            "sales_activity_proxy_by_date": sales_activity_proxy_by_date,
            "sales_proxy_source_by_date": sales_proxy_source_by_date,
            "sales_proxy_confidence_by_date": sales_proxy_confidence_by_date,
            "recommended_capacity_by_date": recommended_capacity_by_date,
            "hard_capacity_by_date": hard_capacity_by_date,
            "capacity_source_by_date": capacity_source_by_date,
            "shift_start_time_by_date": shift_start_time_by_date,
            "shift_end_time_by_date": shift_end_time_by_date,
            "max_route_minutes_by_date": max_route_minutes_by_date,
            "break_minutes_by_date": break_minutes_by_date,
            "depot_by_date": depot_by_date,
            "time_constraint_source_by_date": time_constraint_source_by_date
        })

    clients_input = payload.get("clients") if isinstance(payload.get("clients"), list) else []
    deduped_clients: list[NormalizedClient] = []
    duplicate_client_ids: list[str] = []
    duplicate_client_codes: list[str] = []
    seen_client_ids: set[str] = set()

    for raw_client in clients_input:
        client_code = canonical_client_code(
            raw_client.get("client_code") or
            raw_client.get("nbr_client") or
            raw_client.get("code")
        )
        client_id = canonical_client_id(
            raw_client.get("client_id") or
            raw_client.get("id") or
            (client_code if client_code else "")
        )
        if not client_id:
            continue
        client_code = canonical_client_code(
            raw_client.get("client_code") or
            raw_client.get("nbr_client") or
            raw_client.get("code")
        )
        if not client_code:
            continue
        if client_id in seen_client_ids:
            duplicate_client_ids.append(client_id)
            duplicate_client_codes.append(client_code)
            continue
        seen_client_ids.add(client_id)

        historical_commercial_code = str(
            raw_client.get("historical_commercial_code") or
            raw_client.get("historical_user_code") or
            raw_client.get("user_code") or
            ""
        ).strip()
        route_code = str(raw_client.get("routing_code") or raw_client.get("route_code") or "").strip() or None
        region = str(raw_client.get("region") or "").strip() or None
        commercial_zone = str(
            raw_client.get("commercial_zone") or
            raw_client.get("zone_comm") or
            raw_client.get("commercia_zone") or
            route_code or
            region or
            ""
        ).strip() or None

        explicit_allowed = [
            str(value or "").strip()
            for value in (raw_client.get("allowed_commercial_codes") or [])
            if str(value or "").strip()
        ]
        if explicit_allowed:
            allowed_commercial_codes = explicit_allowed
        elif not allow_commercial_reassignment and historical_commercial_code:
            allowed_commercial_codes = [historical_commercial_code]
        else:
            allowed_commercial_codes = [item["code"] for item in commercials]

        latitude = _safe_float(raw_client.get("latitude"), None)
        longitude = _safe_float(raw_client.get("longitude"), None)
        invalid_gps = not is_valid_coordinate_pair(latitude, longitude)
        client_frequency_days = max(1, _safe_int(raw_client.get("visit_frequency_days"), visit_frequency_days))
        last_real_visit_date = str(raw_client.get("last_real_visit_date") or "").strip() or None
        next_visit_deadline = resolve_next_visit_deadline(
            raw_client.get("next_visit_deadline"),
            last_real_visit_date,
            client_frequency_days,
            planning_end
        )
        deadline_date = parse_iso_date(next_visit_deadline)
        is_critical = deadline_date is not None and deadline_date <= planning_end
        raw_predicted_ca = _safe_optional_float(raw_client.get("predicted_ca")) if sales_mode else None
        predicted_ca_known = (
            _safe_bool(raw_client.get("predicted_ca_known"), raw_predicted_ca is not None) and raw_predicted_ca is not None
            if sales_mode
            else False
        )
        predicted_ca_source = (
            str(
                raw_client.get("predicted_ca_source") or
                ("sales_history" if predicted_ca_known else "unavailable")
            ).strip() or ("sales_history" if predicted_ca_known else "unavailable")
        ) if sales_mode else "unavailable"
        normalized_predicted_ca = None
        if predicted_ca_known:
            normalized_predicted_ca = max(0.0, raw_predicted_ca if raw_predicted_ca is not None else 0.0)
        purchase_prediction_score = _safe_optional_float(raw_client.get("purchase_prediction_score")) if sales_mode else None
        if purchase_prediction_score is not None:
            purchase_prediction_score = max(0.0, min(100.0, purchase_prediction_score))
        predicted_purchase_date = (str(raw_client.get("predicted_purchase_date") or "").strip() or None) if sales_mode else None
        purchase_days_until_prediction_raw = raw_client.get("purchase_days_until_prediction")
        purchase_days_until_prediction = (
            None if purchase_days_until_prediction_raw in (None, "") else max(0, _safe_int(purchase_days_until_prediction_raw, 0))
        ) if sales_mode else None
        recommended_quantity = _safe_optional_float(raw_client.get("recommended_quantity")) if sales_mode else None
        if recommended_quantity is not None:
            recommended_quantity = max(0.0, recommended_quantity)
        expected_order_value = _safe_optional_float(raw_client.get("expected_order_value")) if sales_mode else None
        if expected_order_value is not None:
            expected_order_value = max(0.0, expected_order_value)
        predicted_products = []
        for raw_product in ((raw_client.get("predicted_products") or []) if sales_mode else []):
            if not isinstance(raw_product, dict):
                continue
            product_name = str(raw_product.get("name") or raw_product.get("nom") or "").strip()
            product_quantity = _safe_optional_float(raw_product.get("quantity") or raw_product.get("quantite"))
            if not product_name or product_quantity is None or product_quantity <= 0:
                continue
            predicted_products.append({
                "name": product_name,
                "quantity": round(max(0.0, product_quantity), 2)
            })
        purchase_prediction_source = (str(raw_client.get("purchase_prediction_source") or "").strip() or None) if sales_mode else None
        purchase_prediction_known = (
            any([
                purchase_prediction_score is not None,
                predicted_purchase_date is not None,
                purchase_days_until_prediction is not None,
                recommended_quantity is not None,
                expected_order_value is not None,
                bool(predicted_products)
            ]) or _safe_bool(raw_client.get("purchase_prediction_known"), False)
        ) if sales_mode else False
        recovery_total_balance = _safe_optional_float(raw_client.get("recovery_total_balance"))
        if recovery_total_balance is not None:
            recovery_total_balance = max(0.0, recovery_total_balance)
        recovery_due_amount = _safe_optional_float(raw_client.get("recovery_due_amount"))
        if recovery_due_amount is not None:
            recovery_due_amount = max(0.0, recovery_due_amount)
        recovery_days_past_due_raw = raw_client.get("recovery_days_past_due")
        recovery_days_past_due = None if recovery_days_past_due_raw in (None, "") else max(0, _safe_int(recovery_days_past_due_raw, 0))
        recovery_expected_next_payment_date = str(raw_client.get("recovery_expected_next_payment_date") or "").strip() or None
        recovery_days_since_expected_payment_raw = raw_client.get("recovery_days_since_expected_payment")
        recovery_days_since_expected_payment = None if recovery_days_since_expected_payment_raw in (None, "") else max(0, _safe_int(recovery_days_since_expected_payment_raw, 0))
        recovery_payment_behavior_score = _safe_optional_float(raw_client.get("recovery_payment_behavior_score"))
        if recovery_payment_behavior_score is not None:
            recovery_payment_behavior_score = max(0.0, min(100.0, recovery_payment_behavior_score))
        recovery_expected_collection_amount = _safe_optional_float(raw_client.get("recovery_expected_collection_amount"))
        if recovery_expected_collection_amount is not None:
            recovery_expected_collection_amount = max(0.0, recovery_expected_collection_amount)
        recovery_priority_score = _safe_optional_float(raw_client.get("recovery_priority_score"))
        if recovery_priority_score is not None:
            recovery_priority_score = max(0.0, min(100.0, recovery_priority_score))
        recovery_source = str(raw_client.get("recovery_source") or "").strip() or None
        recovery_data_known = any([
            recovery_total_balance is not None,
            recovery_due_amount is not None,
            recovery_days_past_due is not None,
            recovery_expected_next_payment_date is not None,
            recovery_days_since_expected_payment is not None,
            recovery_payment_behavior_score is not None,
            recovery_expected_collection_amount is not None,
            recovery_priority_score is not None
        ]) or _safe_bool(raw_client.get("recovery_data_known"), False)
        service_minutes = _safe_optional_float(raw_client.get("service_minutes"))
        service_minutes_known = _safe_bool(raw_client.get("service_minutes_known"), service_minutes is not None) and service_minutes is not None
        if service_minutes is not None:
            service_minutes = max(0.0, service_minutes)
        estimated_stop_minutes_by_commercial_date = {}
        for key, value in (raw_client.get("estimated_stop_minutes_by_commercial_date") or {}).items():
            parsed_value = _safe_optional_float(value)
            normalized_key = str(key or "").strip()
            if not normalized_key or parsed_value is None or parsed_value < 0:
                continue
            estimated_stop_minutes_by_commercial_date[normalized_key] = parsed_value

        deduped_clients.append(NormalizedClient(
            client_id=client_id,
            client_code=client_code,
            client_name=str(raw_client.get("client_name") or raw_client.get("nom") or client_code).strip() or client_code,
            address=str(raw_client.get("address") or raw_client.get("adresse") or "").strip() or None,
            latitude=latitude if not invalid_gps else None,
            longitude=longitude if not invalid_gps else None,
            historical_commercial_code=historical_commercial_code,
            allowed_commercial_codes=allowed_commercial_codes,
            commercial_zone=commercial_zone,
            route_code=route_code,
            region=region,
            predicted_ca=normalized_predicted_ca,
            predicted_ca_known=predicted_ca_known,
            predicted_ca_source=predicted_ca_source,
            purchase_prediction_score=purchase_prediction_score,
            predicted_purchase_date=predicted_purchase_date,
            purchase_days_until_prediction=purchase_days_until_prediction,
            recommended_quantity=recommended_quantity,
            expected_order_value=expected_order_value,
            predicted_products=predicted_products,
            purchase_prediction_known=purchase_prediction_known,
            purchase_prediction_source=purchase_prediction_source,
            recovery_total_balance=recovery_total_balance,
            recovery_due_amount=recovery_due_amount,
            recovery_days_past_due=recovery_days_past_due,
            recovery_expected_next_payment_date=recovery_expected_next_payment_date,
            recovery_days_since_expected_payment=recovery_days_since_expected_payment,
            recovery_payment_behavior_score=recovery_payment_behavior_score,
            recovery_expected_collection_amount=recovery_expected_collection_amount,
            recovery_priority_score=recovery_priority_score,
            recovery_data_known=recovery_data_known,
            recovery_source=recovery_source,
            predicted_load_units=max(0.0, _safe_float(raw_client.get("predicted_load_units"), 0.0)),
            service_minutes=service_minutes,
            service_minutes_known=service_minutes_known,
            service_minutes_source=str(raw_client.get("service_minutes_source") or "").strip() or None,
            estimated_stop_minutes_by_commercial_date=estimated_stop_minutes_by_commercial_date,
            last_real_visit_date=last_real_visit_date,
            next_visit_deadline=next_visit_deadline,
            visit_frequency_days=client_frequency_days,
            is_mandatory=_safe_bool(raw_client.get("is_mandatory"), True),
            is_critical=is_critical,
            invalid_gps=invalid_gps
        ))

    if capacity_mode == CAPACITY_MODE_UNKNOWN:
        if has_sales_proxy_signal:
            capacity_mode = CAPACITY_MODE_SALES_PROXY
        elif has_hard_capacity_signal:
            capacity_mode = CAPACITY_MODE_CONFIGURED_HARD

    operational_capacity_known = _safe_bool(
        payload.get("operational_capacity_known"),
        capacity_mode in {CAPACITY_MODE_VALIDATED_VISIT, CAPACITY_MODE_CONFIGURED_HARD}
    )

    normalized_payload = {
        "planning_mode": planning_mode,
        "planning_start_date": planning_start.strftime(DATE_FMT),
        "planning_end_date": planning_end.strftime(DATE_FMT),
        "planning_days": planning_days,
        "planning_horizon_days": planning_days,
        "visit_frequency_days": visit_frequency_days,
        "coverage_window_days": visit_frequency_days,
        "daily_max_mode": daily_max_mode,
        "strict_ca": strict_ca,
        "allow_partial_plan": allow_partial_plan,
        "allow_commercial_reassignment": allow_commercial_reassignment,
        "default_max_visits_per_slot": default_max_visits_per_slot,
        "min_daily_ca_per_commercial": min_daily_ca_per_commercial,
        "user_min_visits_per_slot": user_min_visits_per_slot,
        "user_max_visits_per_slot": user_max_visits_per_slot,
        "capacity_mode": capacity_mode,
        "time_capacity_known": time_capacity_known,
        "operational_capacity_known": operational_capacity_known,
        "working_days": working_days,
        "planning_dates": planning_dates,
        "depot": depot,
        "commercials": commercials,
        "clients": deduped_clients,
        "input_duplicate_client_ids": duplicate_client_ids,
        "input_duplicate_client_codes": duplicate_client_codes
    }

    if not sales_mode:
        normalized_payload["collection_target_context"] = build_collection_target_context(
            deduped_clients,
            payload.get("target_collection_amount"),
        )

    return normalized_payload


def build_slots(payload: dict[str, Any]) -> list[NormalizedSlot]:
    slots: list[NormalizedSlot] = []
    for commercial in payload["commercials"]:
        for date_iso in commercial["available_dates"]:
            requested_max_visits = commercial["max_visits_by_date"].get(date_iso, payload["default_max_visits_per_slot"])
            min_ca = commercial["min_ca_by_date"].get(date_iso, payload["min_daily_ca_per_commercial"])
            user_preferred_min = max(
                0,
                _safe_int(
                    commercial.get("user_preferred_min_by_date", {}).get(date_iso),
                    payload.get("user_min_visits_per_slot")
                )
            )
            user_preferred_max_raw = commercial.get("user_preferred_max_by_date", {}).get(
                date_iso,
                payload.get("user_max_visits_per_slot")
            )
            user_preferred_max = max(0, _safe_int(user_preferred_max_raw, 0)) if user_preferred_max_raw not in (None, "", 0, "0") else None
            max_load_units = commercial.get("max_load_units_by_date", {}).get(date_iso, 0.0)
            shift_start_time = commercial.get("shift_start_time_by_date", {}).get(date_iso)
            shift_end_time = commercial.get("shift_end_time_by_date", {}).get(date_iso)
            max_route_minutes = commercial.get("max_route_minutes_by_date", {}).get(date_iso)
            break_minutes = commercial.get("break_minutes_by_date", {}).get(date_iso, 0.0)
            depot_by_date = commercial.get("depot_by_date", {}).get(date_iso) or {}
            sales_activity_proxy_per_day = max(
                1,
                _safe_int(
                    commercial.get("sales_activity_proxy_by_date", {}).get(date_iso),
                    0
                )
            ) if commercial.get("sales_activity_proxy_by_date", {}).get(date_iso) not in (None, "", 0, "0") else None
            historical_soft_capacity = max(
                1,
                _safe_int(
                    commercial.get("historical_soft_capacity_by_date", {}).get(date_iso),
                    0
                )
            ) if commercial.get("historical_soft_capacity_by_date", {}).get(date_iso) not in (None, "", 0, "0") else None
            recommended_capacity = max(
                1,
                _safe_int(
                    commercial.get("recommended_capacity_by_date", {}).get(date_iso),
                    historical_soft_capacity or requested_max_visits
                )
            )
            recommended_min = max(
                1,
                _safe_int(
                    commercial.get("recommended_min_by_date", {}).get(date_iso),
                    recommended_capacity
                )
            )
            recommended_max = max(
                recommended_min,
                _safe_int(
                    commercial.get("recommended_max_by_date", {}).get(date_iso),
                    recommended_capacity
                )
            )
            effective_target_min = max(
                0,
                _safe_int(
                    commercial.get("effective_target_min_by_date", {}).get(date_iso),
                    user_preferred_min
                )
            )
            effective_target_max = max(
                1,
                _safe_int(
                    commercial.get("effective_target_max_by_date", {}).get(date_iso),
                    requested_max_visits
                )
            )
            hard_capacity = max(
                1,
                _safe_int(
                    commercial.get("hard_capacity_by_date", {}).get(date_iso),
                    0
                )
            ) if commercial.get("hard_capacity_by_date", {}).get(date_iso) not in (None, "", 0, "0") else None
            hard_capacity_known = _safe_bool(
                commercial.get("hard_capacity_known_by_date", {}).get(date_iso),
                hard_capacity is not None
            )
            effective_max_visits = max(
                1,
                _safe_int(
                    requested_max_visits,
                    max(
                        payload["default_max_visits_per_slot"],
                        effective_target_max,
                        recommended_max
                    )
                )
            )
            if hard_capacity is not None:
                effective_max_visits = min(effective_max_visits, hard_capacity)
                recommended_capacity = min(recommended_capacity, hard_capacity)
                recommended_min = min(recommended_min, hard_capacity)
                recommended_max = min(recommended_max, hard_capacity)
                effective_target_max = min(effective_target_max, hard_capacity)
            slots.append(NormalizedSlot(
                slot_id=f"{date_iso}::{commercial['code']}",
                date_iso=date_iso,
                commercial_code=commercial["code"],
                commercial_label=commercial["label"],
                max_visits=effective_max_visits,
                min_ca=max(0.0, _safe_float(min_ca, payload["min_daily_ca_per_commercial"])),
                user_preferred_min=user_preferred_min,
                user_preferred_max=user_preferred_max,
                recommended_min=recommended_min,
                recommended_max=recommended_max,
                effective_target_min=effective_target_min,
                effective_target_max=effective_target_max,
                hard_capacity_known=hard_capacity_known,
                adjustment_reason=str(
                    commercial.get("adjustment_reason_by_date", {}).get(date_iso) or
                    "user_range_accepted"
                ).strip() or "user_range_accepted",
                max_load_units=max(0.0, _safe_float(max_load_units, 0.0)) or None,
                historical_soft_capacity=historical_soft_capacity,
                sales_activity_proxy_per_day=sales_activity_proxy_per_day,
                sales_proxy_source=str(
                    commercial.get("sales_proxy_source_by_date", {}).get(date_iso) or
                    "global_sales_history_fallback"
                ).strip() or "global_sales_history_fallback",
                sales_proxy_confidence=str(
                    commercial.get("sales_proxy_confidence_by_date", {}).get(date_iso) or
                    "low"
                ).strip().lower() or "low",
                recommended_capacity=recommended_capacity,
                hard_capacity=hard_capacity,
                capacity_source=str(
                    commercial.get("capacity_source_by_date", {}).get(date_iso) or
                    ("fallback_operational_capacity" if historical_soft_capacity is None else "commercial_history")
                ).strip() or "fallback_operational_capacity",
                shift_start_time=normalize_time_of_day(shift_start_time),
                shift_end_time=normalize_time_of_day(shift_end_time),
                break_minutes=max(0.0, _safe_float(break_minutes, 0.0)),
                max_route_minutes=max(0.0, _safe_float(max_route_minutes, 0.0)) or None,
                depot_id=str(depot_by_date.get("id") or "").strip() or None,
                depot_latitude=_safe_float(depot_by_date.get("latitude"), None),
                depot_longitude=_safe_float(depot_by_date.get("longitude"), None),
                time_constraint_source=str(
                    commercial.get("time_constraint_source_by_date", {}).get(date_iso) or
                    commercial.get("capacity_source_by_date", {}).get(date_iso) or
                    ""
                ).strip() or None,
                time_capacity_known=_safe_bool(payload.get("time_capacity_known"), False) and (
                    max(0.0, _safe_float(max_route_minutes, 0.0)) > 0
                )
            ))
    slots.sort(key=lambda item: (item.date_iso, item.commercial_code))
    return slots


def resolve_effective_visit_bounds(
    payload: dict[str, Any],
    total_clients: int,
    slots: list[NormalizedSlot]
) -> dict[str, Any]:
    user_min_visits = max(0, _safe_int(payload.get("user_min_visits_per_slot"), 0))
    user_max_visits = max(0, _safe_int(payload.get("user_max_visits_per_slot"), 0))
    default_max_visits = max(1, _safe_int(payload.get("default_max_visits_per_slot"), 1))
    normalized_total_clients = max(0, _safe_int(total_clients, 0))
    normalized_total_slots = len(slots)
    operational_capacity_known = _safe_bool(payload.get("operational_capacity_known"), False)
    recommended_capacities = [
        max(1, _safe_int(slot.recommended_capacity, 0))
        for slot in slots
        if _safe_int(slot.recommended_capacity, 0) > 0
    ]
    recommended_min = min(recommended_capacities) if recommended_capacities else None
    recommended_max = max(recommended_capacities) if recommended_capacities else None
    numeric_hard_capacities = [
        max(1, _safe_int(slot.hard_capacity, 0))
        for slot in slots
        if slot.hard_capacity is not None and _safe_int(slot.hard_capacity, 0) > 0
    ]
    hard_capacity_known = any(slot.hard_capacity_known for slot in slots)
    all_numeric_hard_capacities_known = normalized_total_slots > 0 and len(numeric_hard_capacities) == normalized_total_slots
    max_numeric_hard_capacity = max(numeric_hard_capacities) if numeric_hard_capacities else None
    total_numeric_hard_capacity = sum(numeric_hard_capacities) if all_numeric_hard_capacities_known else None

    has_requested_range = normalized_total_slots > 0 and user_max_visits > 0 and user_min_visits <= user_max_visits
    requested_range_min_capacity = normalized_total_slots * user_min_visits if user_min_visits > 0 else 0
    requested_range_max_capacity = normalized_total_slots * user_max_visits if user_max_visits > 0 else 0
    user_range_mathematically_realisable = (
        has_requested_range and
        requested_range_min_capacity <= normalized_total_clients <= requested_range_max_capacity
    )

    effective_min_visits = user_min_visits if has_requested_range else 0
    effective_max_visits = user_max_visits if has_requested_range else default_max_visits
    required_average_ceiling = math.ceil(normalized_total_clients / normalized_total_slots) if normalized_total_slots > 0 and normalized_total_clients > 0 else 0
    if required_average_ceiling > 0:
        effective_max_visits = max(effective_max_visits, required_average_ceiling)

    if user_min_visits > 0 and normalized_total_slots > 0 and normalized_total_clients < requested_range_min_capacity:
        effective_min_visits = min(user_min_visits, normalized_total_clients // normalized_total_slots)

    adjustment_reason = "user_range_accepted"
    if all_numeric_hard_capacities_known and total_numeric_hard_capacity is not None and total_numeric_hard_capacity < normalized_total_clients:
        adjustment_reason = "insufficient_physical_capacity"
        if max_numeric_hard_capacity is not None:
            effective_max_visits = min(effective_max_visits, max_numeric_hard_capacity)
    elif has_requested_range and user_max_visits > 0 and required_average_ceiling > user_max_visits:
        adjustment_reason = (
            "user_range_below_required_load"
            if operational_capacity_known
            else "raised_max_for_full_coverage"
        )
    elif not operational_capacity_known:
        if (
            has_requested_range and
            user_range_mathematically_realisable and
            not any(
                _safe_int(slot.sales_activity_proxy_per_day, 0) > 0
                for slot in slots
            )
        ):
            adjustment_reason = "user_range_respected"
        else:
            adjustment_reason = "terrain_capacity_unknown"
    elif has_requested_range and recommended_max is not None and user_min_visits > recommended_max and required_average_ceiling <= user_max_visits:
        adjustment_reason = "user_range_above_recommended_capacity"
        effective_max_visits = min(effective_max_visits, recommended_max)

    if effective_max_visits > 0 and effective_min_visits > effective_max_visits:
        effective_min_visits = effective_max_visits

    return {
        "user_min_visits_per_slot": user_min_visits,
        "user_max_visits_per_slot": user_max_visits,
        "effective_min_visits_per_slot": max(0, effective_min_visits),
        "effective_max_visits_per_slot": max(1, effective_max_visits),
        "recommended_min_visits_per_slot": max(1, _safe_int(recommended_min, 1)) if recommended_min is not None else None,
        "recommended_max_visits_per_slot": max(1, _safe_int(recommended_max, default_max_visits)) if recommended_max is not None else None,
        "hard_capacity_known": hard_capacity_known,
        "adjustment_reason": adjustment_reason,
        "user_range_mathematically_realisable": user_range_mathematically_realisable,
        "enforce_user_visit_range": bool(has_requested_range and user_max_visits > 0)
    }


def apply_effective_visit_bounds_to_slots(
    payload: dict[str, Any],
    slots: list[NormalizedSlot],
    total_clients: int
) -> dict[str, Any]:
    bounds = resolve_effective_visit_bounds(payload, total_clients, slots)
    effective_max_visits = max(1, _safe_int(bounds.get("effective_max_visits_per_slot"), 1))
    effective_min_visits = max(0, _safe_int(bounds.get("effective_min_visits_per_slot"), 0))

    for slot in slots:
        slot.user_preferred_min = max(0, _safe_int(slot.user_preferred_min, payload.get("user_min_visits_per_slot")))
        slot.user_preferred_max = (
            max(1, _safe_int(slot.user_preferred_max, 0))
            if slot.user_preferred_max not in (None, "", 0, "0")
            else None
        )
        slot.effective_target_min = max(
            0,
            _safe_int(slot.effective_target_min, effective_min_visits),
            effective_min_visits
        )
        slot.effective_target_max = max(
            1,
            _safe_int(slot.effective_target_max, effective_max_visits),
            effective_max_visits
        )
        slot.recommended_min = max(1, _safe_int(slot.recommended_min, slot.recommended_capacity or 1))
        slot.recommended_max = max(slot.recommended_min, _safe_int(slot.recommended_max, slot.recommended_capacity or slot.recommended_min))
        slot.adjustment_reason = str(slot.adjustment_reason or bounds.get("adjustment_reason") or "user_range_accepted").strip() or "user_range_accepted"

        requested_slot_max = max(1, _safe_int(slot.max_visits, 1))
        resolved_slot_max = max(
            requested_slot_max,
            slot.effective_target_max,
            _safe_int(slot.recommended_max, 0),
            _safe_int(slot.user_preferred_max, 0)
        )

        if slot.hard_capacity is not None:
            resolved_slot_max = min(
                resolved_slot_max,
                max(1, _safe_int(slot.hard_capacity, resolved_slot_max))
            )

        if bounds.get("enforce_user_visit_range"):
            resolved_slot_max = min(
                resolved_slot_max,
                effective_max_visits
            )

        slot.max_visits = max(1, resolved_slot_max)

    payload.update(bounds)
    return bounds


def build_effective_constraints(payload: dict[str, Any], slots: list[NormalizedSlot] | None = None) -> dict[str, Any]:
    resolved_slots = slots or []
    recommended_capacities = [
        max(1, _safe_int(slot.recommended_capacity, 0))
        for slot in resolved_slots
        if _safe_int(slot.recommended_capacity, 0) > 0
    ]
    return {
        "user_preferred_min": max(0, _safe_int(payload.get("user_min_visits_per_slot"), 0)),
        "user_preferred_max": max(0, _safe_int(payload.get("user_max_visits_per_slot"), 0)),
        "recommended_min": min(recommended_capacities) if recommended_capacities else None,
        "recommended_max": max(recommended_capacities) if recommended_capacities else None,
        "effective_target_min": max(0, _safe_int(payload.get("effective_min_visits_per_slot"), 0)),
        "effective_target_max": max(
            1,
            _safe_int(
                payload.get("effective_max_visits_per_slot"),
                _safe_int(payload.get("default_max_visits_per_slot"), 1)
            )
        ),
        "hard_capacity_known": bool(payload.get("hard_capacity_known")),
        "time_capacity_known": bool(payload.get("time_capacity_known")),
        "user_min_clients": max(0, _safe_int(payload.get("user_min_visits_per_slot"), 0)),
        "user_max_clients": max(0, _safe_int(payload.get("user_max_visits_per_slot"), 0)),
        "effective_min_clients": max(0, _safe_int(payload.get("effective_min_visits_per_slot"), 0)),
        "effective_max_clients": max(
            1,
            _safe_int(
                payload.get("effective_max_visits_per_slot"),
                _safe_int(payload.get("default_max_visits_per_slot"), 1)
            )
        ),
        "adjustment_reason": str(payload.get("adjustment_reason") or "user_range_accepted"),
        "user_range_mathematically_realisable": bool(payload.get("user_range_mathematically_realisable")),
        "enforce_user_visit_range": bool(payload.get("enforce_user_visit_range"))
    }


def resolve_slot_min_visits(slot: NormalizedSlot, payload: dict[str, Any]) -> int:
    if not _safe_bool(payload.get("enforce_user_visit_range"), False):
        return 0

    effective_min = max(
        0,
        _safe_int(
            slot.effective_target_min,
            payload.get("effective_min_visits_per_slot")
        )
    )

    return min(
        effective_min,
        max(0, _safe_int(slot.max_visits, 0))
    )


def resolve_slot_sales_activity_proxy(slot: NormalizedSlot) -> int:
    proxy_capacity = _safe_int(slot.sales_activity_proxy_per_day, 0)
    if proxy_capacity > 0:
        return proxy_capacity
    return 0


def resolve_slot_soft_capacity(slot: NormalizedSlot) -> int:
    soft_capacity = _safe_int(slot.historical_soft_capacity, 0)
    if soft_capacity > 0:
        return soft_capacity

    recommended_capacity = _safe_int(slot.recommended_capacity, 0)
    if recommended_capacity > 0:
        return recommended_capacity

    return max(1, _safe_int(slot.max_visits, 1))


def resolve_slot_depot_coordinates(payload: dict[str, Any], slot: NormalizedSlot) -> tuple[float | None, float | None]:
    latitude = slot.depot_latitude if slot.depot_latitude is not None else payload["depot"].get("latitude")
    longitude = slot.depot_longitude if slot.depot_longitude is not None else payload["depot"].get("longitude")
    return latitude, longitude


def _resolve_client_estimated_stop_minutes_uncached(slot: NormalizedSlot, client: NormalizedClient) -> float | None:
    keys = [
        f"{slot.date_iso}::{slot.commercial_code}",
        slot.slot_id,
        slot.date_iso,
        f"{slot.commercial_code}::{slot.date_iso}"
    ]
    for key in keys:
        value = _safe_optional_float(client.estimated_stop_minutes_by_commercial_date.get(key))
        if value is not None and value >= 0:
            return value
    return None


def resolve_client_estimated_stop_minutes(
    slot: NormalizedSlot,
    client: NormalizedClient,
    context: CoverageOptimizationContext | None = None
) -> float | None:
    if context is None:
        return _resolve_client_estimated_stop_minutes_uncached(slot, client)

    cache_key = (slot.slot_id, client.client_id)
    if cache_key in context.estimated_stop_minutes_cache:
        return context.estimated_stop_minutes_cache[cache_key]

    value = _resolve_client_estimated_stop_minutes_uncached(slot, client)
    context.estimated_stop_minutes_cache[cache_key] = value
    return value


def build_client_priority_breakdown(
    payload: dict[str, Any],
    slot: NormalizedSlot,
    client: NormalizedClient,
    context: CoverageOptimizationContext | None = None
) -> tuple[dict[str, Any], list[str]]:
    sales_mode = is_sales_coverage_mode(payload)
    depot_lat, depot_lon = resolve_slot_depot_coordinates(payload, slot)
    distance_km = _get_context_distance_km(context, depot_lat, depot_lon, client.latitude, client.longitude)
    coverage_urgency = resolve_client_coverage_urgency_component(client, payload.get("planning_start_date"))
    recovery_urgency = None if sales_mode else (
        round(resolve_client_recovery_urgency_value(client), 2) if client.recovery_data_known else None
    )
    recovery_priority = None if sales_mode else (
        round(resolve_client_recovery_priority_value(client), 2) if client.recovery_data_known else None
    )
    expected_collection_amount = (
        None if sales_mode else (
            round(resolve_client_expected_collection_value(client), 2)
            if is_known_recovery_number(client.recovery_expected_collection_amount)
            else None
        )
    )
    purchase_prediction_score = round(resolve_client_purchase_prediction_score_value(client), 2) if client.purchase_prediction_known else None
    expected_order_value = (
        round(resolve_client_expected_order_value(client), 2)
        if is_known_purchase_number(client.expected_order_value)
        else None
    )
    purchase_timing_urgency = round(resolve_client_purchase_timing_urgency(client), 2) if client.purchase_prediction_known else None
    habitual_bonus = None
    if client.historical_commercial_code:
        habitual_bonus = 1 if client.historical_commercial_code == slot.commercial_code else 0

    reasons: list[str] = []
    if not sales_mode and client.recovery_data_known:
        if client.recovery_days_past_due is not None and client.recovery_days_past_due > 0:
            reasons.append("credit_overdue")
        if client.recovery_days_since_expected_payment is not None and client.recovery_days_since_expected_payment > 0:
            reasons.append("expected_payment_date_reached")
        if expected_collection_amount is not None and expected_collection_amount > 0:
            reasons.append("high_expected_collection")
    elif not sales_mode:
        reasons.append("recovery_data_unavailable")
    if client.purchase_prediction_known:
        if purchase_prediction_score is not None and purchase_prediction_score >= 70.0:
            reasons.append("high_purchase_prediction")
        if purchase_timing_urgency is not None and purchase_timing_urgency > 0:
            reasons.append("predicted_purchase_date_near")
        if expected_order_value is not None and expected_order_value > 0:
            reasons.append("high_expected_order_value")
    else:
        reasons.append("purchase_prediction_unavailable")
    if client.is_critical:
        reasons.append("coverage_deadline_near")
    if habitual_bonus == 1:
        reasons.append("habitual_commercial")

    return {
        "coverage_urgency": round(coverage_urgency, 2),
        "recovery_urgency": recovery_urgency,
        "recovery_priority": recovery_priority,
        "expected_collection_amount": expected_collection_amount,
        "purchase_prediction_score": purchase_prediction_score,
        "expected_order_value": expected_order_value,
        "purchase_timing_urgency": purchase_timing_urgency,
        "distance_penalty": round(distance_km, 2) if distance_km is not None else None,
        "habitual_commercial_bonus": habitual_bonus
    }, reasons


def build_slot_time_usage(
    payload: dict[str, Any],
    slot: NormalizedSlot,
    clients: list[NormalizedClient]
) -> dict[str, Any]:
    service_total = 0.0
    service_known_count = 0
    additive_stop_total = 0.0
    additive_stop_known = True
    for client in clients:
        if client.service_minutes_known and client.service_minutes is not None:
            service_total += max(0.0, float(client.service_minutes))
            service_known_count += 1
        additive_stop_minutes = resolve_client_estimated_stop_minutes(slot, client)
        if additive_stop_minutes is None:
            additive_stop_known = False
        else:
            additive_stop_total += max(0.0, float(additive_stop_minutes))

    service_total = round(service_total, 2) if service_known_count > 0 else None
    additive_stop_total = round(additive_stop_total, 2) if additive_stop_known else None
    known_travel_minutes = None
    if additive_stop_total is not None and service_total is not None:
        known_travel_minutes = round(max(0.0, additive_stop_total - service_total), 2)

    return {
        "service_minutes_total": service_total,
        "service_minutes_known_count": service_known_count,
        "estimated_stop_minutes_total": additive_stop_total,
        "known_travel_minutes": known_travel_minutes,
        "time_capacity_known": bool(slot.time_capacity_known and additive_stop_total is not None),
        "route_minutes_without_break": additive_stop_total,
        "route_minutes_with_break": round(additive_stop_total + slot.break_minutes, 2) if additive_stop_total is not None else None,
        "max_route_minutes": round(slot.max_route_minutes, 2) if slot.max_route_minutes is not None else None
    }


def resolve_slot_target_ceiling(slot: NormalizedSlot, total_clients: int) -> int:
    hard_capacity = _safe_int(slot.hard_capacity, 0)
    if hard_capacity > 0:
        return hard_capacity

    return max(1, _safe_int(slot.max_visits, 1))


def build_capacity_distribution_context(
    slots: list[NormalizedSlot],
    slot_targets: dict[str, int] | None = None,
    total_required_clients: int = 0
) -> dict[str, Any]:
    resolved_targets = {}
    resolved_soft_capacities = {}
    slot_ids_by_commercial: dict[str, list[str]] = defaultdict(list)
    commercial_soft_capacity_totals: Counter[str] = Counter()
    commercial_target_totals: Counter[str] = Counter()

    for slot in slots:
        soft_capacity = max(1, resolve_slot_soft_capacity(slot))
        weighted_target = max(1, _safe_int((slot_targets or {}).get(slot.slot_id), 0) or soft_capacity)
        resolved_soft_capacities[slot.slot_id] = soft_capacity
        resolved_targets[slot.slot_id] = weighted_target
        slot_ids_by_commercial[slot.commercial_code].append(slot.slot_id)
        commercial_soft_capacity_totals[slot.commercial_code] += soft_capacity
        commercial_target_totals[slot.commercial_code] += weighted_target

    total_historical_capacity = sum(commercial_soft_capacity_totals.values())
    normalized_total_required_clients = max(0, _safe_int(total_required_clients, 0))
    global_ratio_target = (
        normalized_total_required_clients / max(1, total_historical_capacity)
        if normalized_total_required_clients > 0
        else 1.0
    )

    return {
        "slot_targets": resolved_targets,
        "slot_soft_capacities": resolved_soft_capacities,
        "slot_ids_by_commercial": slot_ids_by_commercial,
        "commercial_soft_capacity_totals": dict(commercial_soft_capacity_totals),
        "commercial_target_totals": dict(commercial_target_totals),
        "total_historical_capacity": total_historical_capacity,
        "global_ratio_target": global_ratio_target
    }


def compute_weighted_slot_targets(
    slots: list[NormalizedSlot],
    total_clients: int,
    effective_min_visits_per_slot: int = 0
) -> tuple[dict[str, int], dict[str, int], dict[str, Any]]:
    if not slots:
        return {}, {}, {
            "total_historical_capacity": 0,
            "total_required_clients": max(0, total_clients),
            "operational_capacity_gap": max(0, total_clients),
            "required_capacity_multiplier": 0.0,
            "estimated_extra_slots_needed": 0,
            "estimated_extra_commercial_days_needed": 0,
            "max_weighted_target": 0,
            "max_target_overload_ratio": 0.0
        }

    normalized_total_clients = max(0, _safe_int(total_clients, 0))
    weights = [max(1, resolve_slot_soft_capacity(slot)) for slot in slots]
    lower_bounds = [
        min(max(0, _safe_int(effective_min_visits_per_slot, 0)), max(0, resolve_slot_target_ceiling(slot, normalized_total_clients)))
        for slot in slots
    ]
    upper_bounds = [
        max(0, resolve_slot_target_ceiling(slot, normalized_total_clients))
        for slot in slots
    ]
    historical_capacity_by_slot = {
        slot.slot_id: weights[index]
        for index, slot in enumerate(slots)
    }
    total_historical_capacity = sum(weights)
    targets = lower_bounds[:]
    reserved_minimum_clients = sum(lower_bounds)
    if reserved_minimum_clients > normalized_total_clients:
        targets = [0 for _ in slots]
        reserved_minimum_clients = 0
        lower_bounds = [0 for _ in slots]
    remaining_clients = max(0, normalized_total_clients - reserved_minimum_clients)
    remaining_indexes = {
        index
        for index in range(len(slots))
        if upper_bounds[index] > targets[index]
    }

    while remaining_indexes and remaining_clients > 0:
        total_weight = sum(weights[index] for index in remaining_indexes)
        if total_weight <= 0:
            break

        saturated_indexes = []
        for index in sorted(remaining_indexes):
            raw_share = remaining_clients * (weights[index] / total_weight)
            slot_capacity = max(0, upper_bounds[index] - targets[index])
            if raw_share >= slot_capacity - 1e-9:
                targets[index] += slot_capacity
                remaining_clients -= slot_capacity
                saturated_indexes.append(index)

        if not saturated_indexes:
            break

        for index in saturated_indexes:
            remaining_indexes.discard(index)

    if remaining_clients > 0 and remaining_indexes:
        total_weight = sum(weights[index] for index in remaining_indexes)
        base_targets: dict[int, int] = {}
        fractional_candidates: list[tuple[float, int, str]] = []
        assigned_now = 0

        for index in sorted(remaining_indexes):
            slot_capacity = max(0, upper_bounds[index] - targets[index])
            raw_share = remaining_clients * (weights[index] / max(1, total_weight))
            base_target = min(slot_capacity, int(math.floor(raw_share)))
            base_targets[index] = base_target
            assigned_now += base_target
            fractional_candidates.append((
                raw_share - math.floor(raw_share),
                weights[index],
                slots[index].slot_id
            ))

        for index, base_target in base_targets.items():
            targets[index] += base_target

        remainder = remaining_clients - assigned_now
        fractional_candidates.sort(key=lambda item: (-item[0], -item[1], item[2]))
        while remainder > 0:
            progressed = False
            for _, _, slot_id in fractional_candidates:
                slot_index = next(
                    (
                        index for index in remaining_indexes
                        if slots[index].slot_id == slot_id
                    ),
                    None
                )
                if slot_index is None:
                    continue
                if targets[slot_index] >= max(0, upper_bounds[slot_index]):
                    continue
                targets[slot_index] += 1
                remainder -= 1
                progressed = True
                if remainder <= 0:
                    break
            if not progressed:
                break

    target_by_slot_id = {
        slot.slot_id: targets[index]
        for index, slot in enumerate(slots)
    }
    operational_capacity_gap = max(0, normalized_total_clients - total_historical_capacity)
    average_historical_slot_capacity = (total_historical_capacity / len(slots)) if slots else 0.0
    estimated_extra_slots_needed = (
        math.ceil(operational_capacity_gap / average_historical_slot_capacity)
        if operational_capacity_gap > 0 and average_historical_slot_capacity > 0
        else 0
    )
    max_target_overload_ratio = 0.0
    for slot in slots:
        soft_capacity = max(1, historical_capacity_by_slot.get(slot.slot_id, 1))
        target_load = target_by_slot_id.get(slot.slot_id, 0)
        max_target_overload_ratio = max(
            max_target_overload_ratio,
            target_load / soft_capacity if soft_capacity > 0 else 0.0
        )

    return target_by_slot_id, historical_capacity_by_slot, {
        "total_historical_capacity": total_historical_capacity,
        "total_required_clients": normalized_total_clients,
        "operational_capacity_gap": operational_capacity_gap,
        "required_capacity_multiplier": round(
            (normalized_total_clients / max(1, total_historical_capacity)) if normalized_total_clients > 0 else 1.0,
            2
        ),
        "estimated_extra_slots_needed": estimated_extra_slots_needed,
        "estimated_extra_commercial_days_needed": estimated_extra_slots_needed,
        "max_weighted_target": max(target_by_slot_id.values(), default=0),
        "max_target_overload_ratio": round(max_target_overload_ratio, 2)
    }


def finalize_operational_metrics(
    payload: dict[str, Any],
    slots: list[NormalizedSlot],
    operational_metrics: dict[str, Any],
    planned_clients_total: int | None = None,
    max_overload_ratio: float = 1.0,
    physically_impossible: bool = False
) -> dict[str, Any]:
    metrics = dict(operational_metrics or {})
    capacity_mode = normalize_capacity_mode(payload.get("capacity_mode"))
    operational_capacity_known = _safe_bool(payload.get("operational_capacity_known"), False)
    sales_activity_proxy_total = sum(resolve_slot_sales_activity_proxy(slot) for slot in slots)
    total_required_clients = max(0, _safe_int(metrics.get("total_required_clients"), 0))
    resolved_planned_clients = max(
        0,
        _safe_int(planned_clients_total, total_required_clients)
    )
    sales_proxy_gap_clients = max(0, total_required_clients - sales_activity_proxy_total)
    required_to_sales_proxy_ratio = round(
        (total_required_clients / max(1, sales_activity_proxy_total)) if total_required_clients > 0 else 1.0,
        2
    )
    planned_to_sales_proxy_ratio = round(
        (resolved_planned_clients / max(1, sales_activity_proxy_total)) if resolved_planned_clients > 0 else 0.0,
        2
    )
    status_payload = determine_operational_status(
        operational_metrics=metrics,
        overload_clients=max(0, resolved_planned_clients - max(0, _safe_int(metrics.get("total_historical_capacity"), 0))),
        max_overload_ratio=max_overload_ratio,
        physically_impossible=physically_impossible,
        operational_capacity_known=operational_capacity_known
    )
    metrics.update({
        "capacity_mode": capacity_mode,
        "time_capacity_known": _safe_bool(payload.get("time_capacity_known"), False),
        "operational_capacity_known": operational_capacity_known,
        "sales_activity_proxy_total": sales_activity_proxy_total,
        "sales_proxy_gap_clients": sales_proxy_gap_clients,
        "required_to_sales_proxy_ratio": required_to_sales_proxy_ratio,
        "planned_clients_total": resolved_planned_clients,
        "planned_to_sales_proxy_ratio": planned_to_sales_proxy_ratio,
        "estimated_extra_slots_needed": metrics.get("estimated_extra_slots_needed")
        if operational_capacity_known
        else None,
        "estimated_extra_commercial_days": metrics.get("estimated_extra_commercial_days_needed")
        if operational_capacity_known
        else None,
        "estimated_extra_commercial_days_needed": metrics.get("estimated_extra_commercial_days_needed")
        if operational_capacity_known
        else None,
        "status": status_payload["status"],
        "status_label": status_payload["status_label"]
    })
    return metrics


def determine_operational_status(
    operational_metrics: dict[str, Any],
    overload_clients: int = 0,
    max_overload_ratio: float = 1.0,
    physically_impossible: bool = False,
    operational_capacity_known: bool = False
) -> dict[str, str]:
    if not operational_capacity_known:
        return {
            "status": UNKNOWN_OPERATIONAL_STATUS,
            "status_label": UNKNOWN_OPERATIONAL_STATUS_LABEL
        }

    if physically_impossible:
        return {
            "status": "physically_impossible",
            "status_label": "Physiquement impossible"
        }

    if operational_metrics.get("operational_capacity_gap", 0) <= 0 and overload_clients <= 0 and max_overload_ratio <= 1.0 + 1e-9:
        return {
            "status": "realistic",
            "status_label": "Realiste"
        }

    if (
        float(operational_metrics.get("required_capacity_multiplier", 1.0) or 1.0) <= 1.25 and
        max_overload_ratio <= 1.35
    ):
        return {
            "status": "under_tension",
            "status_label": "Sous tension"
        }

    return {
        "status": "critical_overload",
        "status_label": "Surcharge critique"
    }


def build_commercial_plan_summaries(
    slots: list[NormalizedSlot],
    blocks: list[dict[str, Any]],
    slot_targets: dict[str, int] | None = None
) -> list[dict[str, Any]]:
    block_by_slot_id = {
        str(block.get("slot_id") or "").strip(): block
        for block in blocks
    }
    slots_by_commercial: dict[str, list[NormalizedSlot]] = defaultdict(list)
    for slot in slots:
        slots_by_commercial[slot.commercial_code].append(slot)

    summaries = []
    for commercial_code, commercial_slots in sorted(slots_by_commercial.items(), key=lambda item: item[0]):
        planned_counts = []
        historical_soft_capacities = []
        sales_proxy_capacities = []
        sales_proxy_confidences = []
        weighted_targets = []
        proxy_gap_by_slot = []
        habitual_clients_total = 0
        reassigned_clients_total = 0
        locked_clients_total = 0
        hard_capacity_slots_count = 0
        for slot in sorted(commercial_slots, key=lambda item: item.date_iso):
            block = block_by_slot_id.get(slot.slot_id, {})
            planned_clients = _safe_int(block.get("clients_count"), 0)
            soft_capacity = resolve_slot_soft_capacity(slot)
            sales_proxy_capacity = resolve_slot_sales_activity_proxy(slot)
            weighted_target = max(1, _safe_int((slot_targets or {}).get(slot.slot_id), 0) or soft_capacity)
            planned_counts.append(planned_clients)
            historical_soft_capacities.append(soft_capacity)
            sales_proxy_capacities.append(sales_proxy_capacity)
            sales_proxy_confidences.append(str(slot.sales_proxy_confidence or "").strip().lower() or "low")
            weighted_targets.append(weighted_target)
            proxy_gap_by_slot.append(max(0, planned_clients - sales_proxy_capacity))
            if slot.hard_capacity is not None:
                hard_capacity_slots_count += 1
            for client in block.get("clients", []):
                historical_code = str(client.get("historical_commercial_code") or "").strip()
                allowed_codes = [
                    str(value or "").strip()
                    for value in (client.get("allowed_commercial_codes") or [])
                    if str(value or "").strip()
                ]
                if historical_code == commercial_code:
                    habitual_clients_total += 1
                elif historical_code:
                    reassigned_clients_total += 1
                if len(allowed_codes) == 1 and allowed_codes[0] == commercial_code:
                    locked_clients_total += 1

        total_historical_capacity = sum(historical_soft_capacities)
        total_sales_proxy = sum(sales_proxy_capacities)
        total_weighted_target = sum(weighted_targets)
        total_planned_clients = sum(planned_counts)
        proxy_gap_clients = max(0, total_planned_clients - total_sales_proxy)
        planned_to_sales_proxy_ratio = round(
            total_planned_clients / max(1, total_sales_proxy),
            2
        ) if planned_counts else 0.0
        habitual_share = round(habitual_clients_total / max(1, total_planned_clients), 2) if total_planned_clients else 0.0
        if hard_capacity_slots_count > 0:
            main_gap_reason = "hard_capacity_constraint"
        elif locked_clients_total > 0 and reassigned_clients_total == 0:
            main_gap_reason = "locked_commercial_constraints"
        elif total_planned_clients > total_weighted_target and habitual_share >= 0.6:
            main_gap_reason = "historical_commercial_preference"
        elif reassigned_clients_total > 0:
            main_gap_reason = "capacity_rebalancing"
        else:
            main_gap_reason = "weighted_capacity_distribution"
        confidence_label = "low"
        if sales_proxy_confidences and all(value == "medium" for value in sales_proxy_confidences):
            confidence_label = "medium"
        summaries.append({
            "commercial_code": commercial_code,
            "commercial_label": commercial_slots[0].commercial_label if commercial_slots else commercial_code,
            "slots_count": len(commercial_slots),
            "sales_activity_proxy_total": total_sales_proxy,
            "sales_activity_proxy_per_day": round(total_sales_proxy / max(1, len(commercial_slots)), 2),
            "sales_proxy_source": str(commercial_slots[0].sales_proxy_source or "global_sales_history_fallback").strip() or "global_sales_history_fallback",
            "sales_proxy_confidence": confidence_label,
            "historical_capacity_total": total_historical_capacity,
            "historical_capacity_avg_per_day": round(total_historical_capacity / max(1, len(commercial_slots)), 2),
            "weighted_target_total": total_weighted_target,
            "weighted_target_avg_per_day": round(total_weighted_target / max(1, len(commercial_slots)), 2),
            "planned_clients_total": total_planned_clients,
            "planned_clients_avg_per_day": round(total_planned_clients / max(1, len(commercial_slots)), 2),
            "planned_clients": total_planned_clients,
            "planned_clients_per_day": round(total_planned_clients / max(1, len(commercial_slots)), 2),
            "planned_clients_min": min(planned_counts) if planned_counts else 0,
            "planned_clients_max": max(planned_counts) if planned_counts else 0,
            "proxy_gap_clients": proxy_gap_clients,
            "planned_to_sales_proxy_ratio": planned_to_sales_proxy_ratio,
            "overload_clients": proxy_gap_clients,
            "overload_ratio": planned_to_sales_proxy_ratio,
            "overloaded_slots_count": sum(1 for value in proxy_gap_by_slot if value > 0),
            "habitual_clients_total": habitual_clients_total,
            "habitual_clients_share": habitual_share,
            "reassigned_clients_total": reassigned_clients_total,
            "locked_clients_total": locked_clients_total,
            "main_gap_reason": main_gap_reason
        })

    return summaries


def build_feasible_slot_ids_by_client(
    clients: list[NormalizedClient],
    slots: list[NormalizedSlot],
    context: CoverageOptimizationContext | None = None
) -> dict[str, list[str]]:
    if context is not None and clients is context.mandatory_clients and slots is context.slots and context.feasible_slots_by_client:
        return context.feasible_slots_by_client

    _increment_context_counter(context, "build_feasible_slot_ids_by_client_calls")
    slot_ids_by_client: dict[str, list[str]] = {}
    for client in clients:
        deadline = parse_iso_date(client.next_visit_deadline)
        feasible_slots = []
        for slot in slots:
            if client.allowed_commercial_codes and slot.commercial_code not in client.allowed_commercial_codes:
                continue
            slot_date = parse_iso_date(slot.date_iso)
            if deadline and slot_date and slot_date > deadline:
                continue
            if (
                slot.max_load_units is not None and
                slot.max_load_units > 0 and
                client.predicted_load_units > slot.max_load_units + 1e-9
            ):
                continue
            if slot.time_capacity_known and slot.max_route_minutes is not None and slot.max_route_minutes > 0:
                estimated_stop_minutes = resolve_client_estimated_stop_minutes(slot, client, context=context)
                if estimated_stop_minutes is None or estimated_stop_minutes > slot.max_route_minutes + 1e-9:
                    continue
            feasible_slots.append(slot.slot_id)
        slot_ids_by_client[client.client_id] = feasible_slots

    if context is not None and clients is context.mandatory_clients and slots is context.slots:
        context.feasible_slots_by_client = slot_ids_by_client
    return slot_ids_by_client


def is_normalized_coverage_payload(payload: dict[str, Any] | None) -> bool:
    return isinstance(payload, dict) and "planning_end_date" in payload and "clients" in payload and "commercials" in payload


def build_coverage_optimization_context(
    payload_or_raw: dict[str, Any],
    *,
    payload_already_normalized: bool = False
) -> CoverageOptimizationContext:
    payload = payload_or_raw if payload_already_normalized else normalize_payload(payload_or_raw)
    collection_target_context = resolve_collection_target_context(payload)
    slots = build_slots(payload)
    mandatory_clients = [client for client in payload["clients"] if client.is_mandatory]
    visit_bounds = apply_effective_visit_bounds_to_slots(payload, slots, len(mandatory_clients))
    effective_constraints = build_effective_constraints(payload, slots)
    total_slots = len(slots)
    clients_to_cover = len(mandatory_clients)
    required_average_per_slot = round((clients_to_cover / total_slots), 2) if total_slots > 0 else 0.0
    required_minimum_max_per_slot = math.ceil(clients_to_cover / total_slots) if total_slots > 0 and clients_to_cover > 0 else 0
    slot_targets, slot_soft_capacities, operational_metrics = compute_weighted_slot_targets(
        slots,
        clients_to_cover,
        effective_min_visits_per_slot=max(0, _safe_int(visit_bounds.get("effective_min_visits_per_slot"), 0))
    )
    analysis_operational_metrics = finalize_operational_metrics(
        payload=payload,
        slots=slots,
        operational_metrics=operational_metrics,
        planned_clients_total=clients_to_cover,
        max_overload_ratio=float(operational_metrics.get("max_target_overload_ratio", 0.0) or 0.0),
        physically_impossible=False
    )
    capacity_by_commercial = Counter()
    for slot in slots:
        capacity_by_commercial[slot.commercial_code] += slot.max_visits

    context = CoverageOptimizationContext(
        payload=payload,
        collection_target_context=collection_target_context,
        slots=slots,
        mandatory_clients=mandatory_clients,
        effective_constraints=effective_constraints,
        required_average_per_slot=required_average_per_slot,
        required_minimum_max_per_slot=required_minimum_max_per_slot,
        slot_targets=slot_targets,
        slot_soft_capacities=slot_soft_capacities,
        operational=analysis_operational_metrics,
        feasible_slots_by_client={},
        capacity_by_commercial=capacity_by_commercial,
        diagnostics={
            "normalize_payload_calls": 0 if payload_already_normalized else 1,
            "build_slots_calls": 1,
            "build_feasible_slot_ids_by_client_calls": 0,
            "build_assignment_candidates_calls": 0,
            "candidate_context_build_calls": 0,
            "candidate_record_build_calls": 0,
            "candidate_index_build_calls": 0,
            "build_coverage_input_fingerprints_calls": 0,
            "debug_fingerprint_calls": 0,
            "debug_trace_hash_calls": 0,
            "debug_result_hash_calls": 0,
            "solve_greedy_capacity_plan_calls": 0,
            "distance_cache_hits": 0,
            "distance_cache_misses": 0,
        }
    )
    context.feasible_slots_by_client = build_feasible_slot_ids_by_client(mandatory_clients, slots, context=context)
    return context


def compute_feasibility_from_context(context: CoverageOptimizationContext) -> dict[str, Any]:
    payload = context.payload
    slots = context.slots
    mandatory_clients = context.mandatory_clients
    effective_constraints = context.effective_constraints
    total_slots = len(slots)
    total_capacity = sum(slot.max_visits for slot in slots)
    clients_to_cover = len(mandatory_clients)
    required_average_per_slot = context.required_average_per_slot
    required_minimum_max_per_slot = context.required_minimum_max_per_slot
    slot_targets = context.slot_targets
    slot_soft_capacities = context.slot_soft_capacities
    analysis_operational_metrics = context.operational
    feasible_slots_by_client = context.feasible_slots_by_client
    capacity_by_commercial = context.capacity_by_commercial

    if total_slots == 0 and clients_to_cover > 0:
        return {
            "status": "infeasible",
            "reason": "no_available_slots",
            "clients_to_cover": clients_to_cover,
            "total_slots": total_slots,
            "configured_total_capacity": total_capacity,
            "missing_capacity": clients_to_cover,
            "required_average_per_slot": required_average_per_slot,
            "required_minimum_max_per_slot": required_minimum_max_per_slot,
            "details": [],
            "slot_targets": slot_targets,
            "slot_soft_capacities": slot_soft_capacities,
            "operational": analysis_operational_metrics,
            "effective_constraints": effective_constraints
        }

    locked_counts = Counter()
    for client in mandatory_clients:
        allowed_codes = sorted(set(client.allowed_commercial_codes))
        if len(allowed_codes) == 1:
            locked_counts[allowed_codes[0]] += 1

    for commercial_code, client_count in locked_counts.items():
        commercial_capacity = capacity_by_commercial.get(commercial_code, 0)
        if client_count > commercial_capacity:
            return {
                "status": "infeasible",
                "reason": "insufficient_commercial_capacity",
                "commercial": commercial_code,
                "clients_required": client_count,
                "capacity": commercial_capacity,
                "missing_capacity": client_count - commercial_capacity,
                "clients_to_cover": clients_to_cover,
                "total_slots": total_slots,
                "configured_total_capacity": total_capacity,
                "required_average_per_slot": required_average_per_slot,
                "required_minimum_max_per_slot": required_minimum_max_per_slot,
                "details": [],
                "slot_targets": slot_targets,
                "slot_soft_capacities": slot_soft_capacities,
                "operational": analysis_operational_metrics,
                "effective_constraints": effective_constraints
            }

    if total_capacity < clients_to_cover:
        return {
            "status": "infeasible",
            "reason": "insufficient_visit_capacity",
            "clients_to_cover": clients_to_cover,
            "total_slots": total_slots,
            "configured_total_capacity": total_capacity,
            "missing_capacity": clients_to_cover - total_capacity,
            "required_average_per_slot": required_average_per_slot,
            "required_minimum_max_per_slot": required_minimum_max_per_slot,
            "details": [],
            "slot_targets": slot_targets,
            "slot_soft_capacities": slot_soft_capacities,
            "operational": analysis_operational_metrics,
            "effective_constraints": effective_constraints
        }

    deadline_issues = []
    physical_unreachable_issues = []
    for client in mandatory_clients:
        feasible_slots = feasible_slots_by_client.get(client.client_id) or []
        if feasible_slots:
            continue
        max_slot_load = max(
            [
                float(slot.max_load_units or 0.0)
                for slot in slots
                if not client.allowed_commercial_codes or slot.commercial_code in client.allowed_commercial_codes
            ] or [0.0]
        )
        issue = {
            "client_id": client.client_id,
            "client_code": client.client_code,
            "next_visit_deadline": client.next_visit_deadline,
            "allowed_commercial_codes": client.allowed_commercial_codes
        }
        if client.predicted_load_units > 0 and max_slot_load > 0 and client.predicted_load_units > max_slot_load + 1e-9:
            issue["predicted_load_units"] = round(client.predicted_load_units, 2)
            issue["max_slot_load_units"] = round(max_slot_load, 2)
            physical_unreachable_issues.append(issue)
        else:
            deadline_issues.append(issue)

    if physical_unreachable_issues:
        return {
            "status": "infeasible",
            "reason": "physical_slot_unreachable",
            "clients_to_cover": clients_to_cover,
            "total_slots": total_slots,
            "configured_total_capacity": total_capacity,
            "missing_capacity": 0,
            "required_average_per_slot": required_average_per_slot,
            "required_minimum_max_per_slot": required_minimum_max_per_slot,
            "details": physical_unreachable_issues,
            "slot_targets": slot_targets,
            "slot_soft_capacities": slot_soft_capacities,
            "operational": analysis_operational_metrics
        }

    if deadline_issues:
        return {
            "status": "infeasible",
            "reason": "deadline_or_commercial_unreachable",
            "clients_to_cover": clients_to_cover,
            "total_slots": total_slots,
            "configured_total_capacity": total_capacity,
            "missing_capacity": 0,
            "required_average_per_slot": required_average_per_slot,
            "required_minimum_max_per_slot": required_minimum_max_per_slot,
            "details": deadline_issues,
            "slot_targets": slot_targets,
            "slot_soft_capacities": slot_soft_capacities,
            "operational": analysis_operational_metrics
        }

    return {
        "status": "feasible",
        "clients_to_cover": clients_to_cover,
        "total_slots": total_slots,
        "configured_total_capacity": total_capacity,
        "missing_capacity": 0,
        "required_average_per_slot": required_average_per_slot,
        "required_minimum_max_per_slot": required_minimum_max_per_slot,
        "details": [],
        "slots": slots,
        "mandatory_clients": mandatory_clients,
        "feasible_slots_by_client": feasible_slots_by_client,
        "slot_targets": slot_targets,
        "slot_soft_capacities": slot_soft_capacities,
        "operational": analysis_operational_metrics,
        "effective_constraints": effective_constraints
    }


def compute_feasibility(payload: dict[str, Any]) -> dict[str, Any]:
    context = build_coverage_optimization_context(
        payload,
        payload_already_normalized=is_normalized_coverage_payload(payload)
    )
    return compute_feasibility_from_context(context)


def build_coverage_analysis_summary_from_context(context: CoverageOptimizationContext) -> dict[str, Any]:
    payload = context.payload
    feasibility = compute_feasibility_from_context(context)
    slots = context.slots
    mandatory_clients = context.mandatory_clients
    feasible_slots_by_client = context.feasible_slots_by_client
    collection_target_context = context.collection_target_context

    strict_ca_issues = []
    total_required_ca = round(sum(max(0.0, float(slot.min_ca or 0.0)) for slot in slots), 2)
    total_possible_ca = round(sum(max(0.0, float(client.predicted_ca or 0.0)) for client in mandatory_clients), 2)

    for slot in slots:
        max_predicted_ca = round(sum(
            float(client.predicted_ca or 0.0)
            for client in mandatory_clients
            if slot.slot_id in feasible_slots_by_client.get(client.client_id, [])
        ), 2)
        if payload["strict_ca"] and round(float(slot.min_ca or 0.0), 2) > max_predicted_ca + 1e-9:
            strict_ca_issues.append({
                "slot_id": slot.slot_id,
                "commercial_code": slot.commercial_code,
                "date": slot.date_iso,
                "ca_target": round(float(slot.min_ca or 0.0), 2),
                "max_possible_ca": max_predicted_ca
            })

    strict_ca_possible = True
    strict_ca_reason = None
    if payload["strict_ca"]:
        if total_required_ca > total_possible_ca + 1e-9:
            strict_ca_possible = False
            strict_ca_reason = "daily_ca_target_unreachable"
        elif strict_ca_issues:
            strict_ca_possible = False
            strict_ca_reason = "daily_ca_target_unreachable"

    final_status = "feasible"
    final_reason = None
    if feasibility["status"] != "feasible":
        final_status = "infeasible"
        final_reason = feasibility.get("reason")
    elif not strict_ca_possible:
        final_status = "infeasible"
        final_reason = strict_ca_reason

    analysis_summary = {
        "status": final_status,
        "reason": final_reason,
        "feasibility": {
            "clients_to_cover": int(feasibility.get("clients_to_cover") or 0),
            "total_slots": int(feasibility.get("total_slots") or 0),
            "configured_total_capacity": int(feasibility.get("configured_total_capacity") or 0),
            "missing_capacity": int(feasibility.get("missing_capacity") or 0),
            "required_average_per_slot": round(float(feasibility.get("required_average_per_slot") or 0.0), 2),
            "required_minimum_max_per_slot": int(feasibility.get("required_minimum_max_per_slot") or 0),
            "commercial": feasibility.get("commercial"),
            "clients_required": int(feasibility.get("clients_required") or 0),
            "capacity": int(feasibility.get("capacity") or 0),
            "details": feasibility.get("details") or []
        },
        "strict_ca": {
            "enabled": bool(payload["strict_ca"]),
            "possible": strict_ca_possible,
            "reason": strict_ca_reason,
            "total_required_ca": total_required_ca,
            "total_possible_ca": total_possible_ca,
            "issues": strict_ca_issues
        },
        "operational": feasibility.get("operational") or {},
        "input_summary": {
            "planning_start_date": payload["planning_start_date"],
            "planning_end_date": payload["planning_end_date"],
            "planning_days": int(payload["planning_days"]),
            "planning_horizon_days": int(payload["planning_horizon_days"]),
            "visit_frequency_days": int(payload["visit_frequency_days"]),
            "coverage_window_days": int(payload["coverage_window_days"]),
            "daily_max_mode": str(payload["daily_max_mode"]),
            "working_days": payload["working_days"],
            "selected_commercials_count": len(payload["commercials"]),
            "mandatory_clients_count": len(mandatory_clients),
            "coverage_guarantee_status": "single_visit_only"
        }
    }
    if collection_target_context is not None:
        analysis_summary["collection_target_context"] = collection_target_context
    return analysis_summary


def build_candidate_planning_context(
    payload: dict[str, Any],
    slots: list[NormalizedSlot],
    mandatory_clients: list[NormalizedClient],
    feasible_slots_by_client: dict[str, list[str]],
    context: CoverageOptimizationContext | None = None,
    performance_entries: list[dict[str, Any]] | None = None,
) -> CandidatePlanningContext:
    if context is not None and context.candidate_planning_context is not None:
        return context.candidate_planning_context

    if context is not None:
        context.diagnostics["candidate_context_build_calls"] = int(context.diagnostics.get("candidate_context_build_calls") or 0) + 1
        context.diagnostics["candidate_record_build_calls"] = int(context.diagnostics.get("candidate_record_build_calls") or 0) + 1
        context.diagnostics["candidate_index_build_calls"] = int(context.diagnostics.get("candidate_index_build_calls") or 0) + 1

    sales_mode = is_sales_coverage_mode(payload)
    slot_index_by_id = {slot.slot_id: index for index, slot in enumerate(slots)}
    client_by_id = {client.client_id: client for client in mandatory_clients}
    slot_by_id = {slot.slot_id: slot for slot in slots}
    client_index_by_id = {client.client_id: index for index, client in enumerate(mandatory_clients)}
    planning_start = parse_iso_date(payload.get("planning_start_date"))
    candidate_records: list[dict[str, Any]] = []
    candidate_record_by_key: dict[tuple[str, str], dict[str, Any]] = {}
    candidate_record_index_by_key: dict[tuple[str, str], int] = {}
    candidate_indexes_by_client: dict[str, list[int]] = defaultdict(list)
    candidate_indexes_by_slot: dict[str, list[int]] = defaultdict(list)
    context_build_records_seconds = 0.0
    context_build_key_maps_seconds = 0.0
    context_build_client_indexes_seconds = 0.0
    context_build_slot_indexes_seconds = 0.0
    context_build_score_components_seconds = 0.0
    context_build_stop_minutes_seconds = 0.0

    for client in mandatory_clients:
        for slot_id in feasible_slots_by_client.get(client.client_id, []):
            record_started_at = time.perf_counter()
            slot = slot_by_id[slot_id]
            candidate_key = (client.client_id, slot_id)
            priority_breakdown, priority_reasons = build_client_priority_breakdown(payload, slot, client, context=context)
            slot_date = parse_iso_date(slot.date_iso)
            date_offset_days = max(0, (slot_date - planning_start).days) if slot_date and planning_start else 0
            coverage_urgency_component = float(priority_breakdown.get("coverage_urgency") or 0.0)
            recovery_urgency_component = 0.0 if sales_mode else float(priority_breakdown.get("recovery_urgency") or 0.0)
            recovery_priority_component = 0.0 if sales_mode else float(priority_breakdown.get("recovery_priority") or 0.0)
            expected_collection_component = 0.0 if sales_mode else float(priority_breakdown.get("expected_collection_amount") or 0.0)
            purchase_prediction_component = float(priority_breakdown.get("purchase_prediction_score") or 0.0) if sales_mode else 0.0
            expected_order_component = float(priority_breakdown.get("expected_order_value") or 0.0) if sales_mode else 0.0
            purchase_timing_component = float(priority_breakdown.get("purchase_timing_urgency") or 0.0) if sales_mode else 0.0
            stop_minutes_started_at = time.perf_counter()
            estimated_stop_minutes = resolve_client_estimated_stop_minutes(slot, client, context=context) or 0.0
            context_build_stop_minutes_seconds += time.perf_counter() - stop_minutes_started_at
            deadline = parse_iso_date(client.next_visit_deadline)
            deadline_gap = max(0, (deadline - slot_date).days) if deadline and slot_date else 0
            depot_lat, depot_lon = resolve_slot_depot_coordinates(payload, slot)
            distance_km = _get_context_distance_km(context, depot_lat, depot_lon, client.latitude, client.longitude) or 0.0
            distance_penalty = int(round((priority_breakdown.get("distance_penalty") or 0.0) * 100))

            record = {
                "client_id": client.client_id,
                "client_code": client.client_code,
                "slot_id": slot_id,
                "slot_index": slot_index_by_id[slot_id],
                "commercial_code": slot.commercial_code,
                "predicted_ca_cents": int(round(resolve_client_predicted_ca_value(client) * 100)),
                "predicted_load_units_centi": int(round(client.predicted_load_units * 100)),
                "predicted_stop_minutes_centi": int(round(estimated_stop_minutes * 100)),
                "distance_penalty": distance_penalty,
                "coverage_urgency_component": coverage_urgency_component,
                "recovery_urgency_component": recovery_urgency_component,
                "recovery_priority_component": recovery_priority_component,
                "expected_collection_component": expected_collection_component,
                "purchase_prediction_component": purchase_prediction_component,
                "expected_order_component": expected_order_component,
                "purchase_timing_component": purchase_timing_component,
                "coverage_date_penalty": int(round(coverage_urgency_component * date_offset_days * 100)),
                "recovery_urgency_date_penalty": int(round(recovery_urgency_component * date_offset_days * 100)),
                "recovery_date_penalty": int(round(recovery_priority_component * date_offset_days * 100)),
                "expected_collection_date_penalty": int(round(min(expected_collection_component, 1_000_000.0) * date_offset_days * 10)),
                "purchase_score_date_penalty": int(round(purchase_prediction_component * date_offset_days * 100)),
                "expected_order_date_penalty": int(round(min(expected_order_component, 1_000_000.0) * date_offset_days * 10)),
                "purchase_timing_date_penalty": int(round(purchase_timing_component * date_offset_days * 100)),
                "unassigned_recovery_urgency_weight": int(round(recovery_urgency_component * 100)),
                "unassigned_recovery_priority_weight": int(round(recovery_priority_component * 100)),
                "unassigned_expected_collection_weight": int(round(min(expected_collection_component, 1_000_000.0) * 10)),
                "unassigned_purchase_prediction_weight": int(round(purchase_prediction_component * 100)),
                "unassigned_expected_order_weight": int(round(min(expected_order_component, 1_000_000.0) * 10)),
                "priority_breakdown": priority_breakdown,
                "priority_reasons": priority_reasons,
                "reassignment_penalty": 1 if (
                    client.historical_commercial_code and
                    slot.commercial_code != client.historical_commercial_code
                ) else 0,
                "distance_km_rounded4": round(distance_km, 4),
                "deadline_gap": deadline_gap,
            }
            candidate_index = len(candidate_records)
            candidate_records.append(record)
            context_build_records_seconds += time.perf_counter() - record_started_at

            key_maps_started_at = time.perf_counter()
            candidate_record_by_key[candidate_key] = record
            candidate_record_index_by_key[candidate_key] = candidate_index
            context_build_key_maps_seconds += time.perf_counter() - key_maps_started_at

            client_indexes_started_at = time.perf_counter()
            candidate_indexes_by_client[client.client_id].append(candidate_index)
            context_build_client_indexes_seconds += time.perf_counter() - client_indexes_started_at

            slot_indexes_started_at = time.perf_counter()
            candidate_indexes_by_slot[slot_id].append(candidate_index)
            context_build_slot_indexes_seconds += time.perf_counter() - slot_indexes_started_at
            context_build_score_components_seconds += 0.0

    finalize_started_at = time.perf_counter()
    for client in mandatory_clients:
        candidate_indexes_by_client.setdefault(client.client_id, [])
    for slot in slots:
        candidate_indexes_by_slot.setdefault(slot.slot_id, [])
    candidate_indexes_sorted_for_input_hash = None
    if is_perf_debug_enabled():
        candidate_indexes_sorted_for_input_hash = sorted(
            range(len(candidate_records)),
            key=lambda candidate_index: (
                str(candidate_records[candidate_index].get("client_id") or ""),
                str(candidate_records[candidate_index].get("slot_id") or "")
            )
        )
    estimated_bytes = 0
    if is_perf_debug_enabled():
        estimated_bytes = (
            sys.getsizeof(candidate_records) +
            sum(sys.getsizeof(record) for record in candidate_records) +
            sys.getsizeof(candidate_record_by_key) +
            sys.getsizeof(candidate_record_index_by_key) +
            sum(sys.getsizeof(indexes) for indexes in candidate_indexes_by_client.values()) +
            sum(sys.getsizeof(indexes) for indexes in candidate_indexes_by_slot.values())
        )
    candidate_context = CandidatePlanningContext(
        candidate_records=candidate_records,
        candidate_record_by_key=candidate_record_by_key,
        candidate_record_index_by_key=candidate_record_index_by_key,
        candidate_indexes_by_client=dict(candidate_indexes_by_client),
        candidate_indexes_by_slot=dict(candidate_indexes_by_slot),
        candidate_indexes_sorted_for_input_hash=candidate_indexes_sorted_for_input_hash,
        client_by_id=client_by_id,
        slot_by_id=slot_by_id,
        slot_index_by_id=slot_index_by_id,
        client_index_by_id=client_index_by_id,
        candidate_records_count=len(candidate_records),
        estimated_candidate_context_bytes=max(0, int(estimated_bytes)),
    )
    if performance_entries is not None and is_perf_observability_enabled():
        performance_entries.append({"stage": "context_build_records", "duration_ms": max(0, int(round(context_build_records_seconds * 1000)))})
        performance_entries.append({"stage": "context_build_key_maps", "duration_ms": max(0, int(round(context_build_key_maps_seconds * 1000)))})
        performance_entries.append({"stage": "context_build_client_indexes", "duration_ms": max(0, int(round(context_build_client_indexes_seconds * 1000)))})
        performance_entries.append({"stage": "context_build_slot_indexes", "duration_ms": max(0, int(round(context_build_slot_indexes_seconds * 1000)))})
        performance_entries.append({"stage": "context_build_score_components", "duration_ms": max(0, int(round(context_build_score_components_seconds * 1000)))})
        performance_entries.append({"stage": "context_build_stop_minutes", "duration_ms": max(0, int(round(context_build_stop_minutes_seconds * 1000)))})
        performance_entries.append(_build_perf_entry("context_finalize", finalize_started_at))
    if context is not None:
        context.assignment_candidates = candidate_context.candidate_records
        context.assignment_index_by_key = candidate_context.candidate_record_index_by_key
        context.candidate_planning_context = candidate_context
    return candidate_context


def build_assignment_candidates(
    payload: dict[str, Any],
    slots: list[NormalizedSlot],
    mandatory_clients: list[NormalizedClient],
    feasible_slots_by_client: dict[str, list[str]],
    context: CoverageOptimizationContext | None = None
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    if context is not None and context.assignment_candidates is not None and context.assignment_index_by_key is not None:
        return context.assignment_candidates, context.assignment_index_by_key

    _increment_context_counter(context, "build_assignment_candidates_calls")
    candidate_context = build_candidate_planning_context(
        payload,
        slots,
        mandatory_clients,
        feasible_slots_by_client,
        context=context
    )
    return (
        candidate_context.candidate_records,
        candidate_context.candidate_record_index_by_key
    )


def can_use_simple_balanced_solver(
    payload: dict[str, Any],
    slots: list[NormalizedSlot],
    mandatory_clients: list[NormalizedClient]
) -> bool:
    return False


def solve_simple_balanced_plan(
    payload: dict[str, Any],
    slots: list[NormalizedSlot],
    mandatory_clients: list[NormalizedClient]
) -> dict[str, list[NormalizedClient]]:
    model = cp_model.CpModel()
    user_min_target = max(0, _safe_int(payload.get("user_min_visits_per_slot"), 0))
    user_max_target = max(0, _safe_int(payload.get("user_max_visits_per_slot"), 0))
    slot_indices_by_commercial = defaultdict(list)
    locked_clients_by_commercial: dict[str, list[NormalizedClient]] = defaultdict(list)
    flexible_clients: list[NormalizedClient] = []

    for index, slot in enumerate(slots):
        slot_indices_by_commercial[slot.commercial_code].append(index)

    all_commercial_codes = sorted(slot_indices_by_commercial.keys())
    for client in mandatory_clients:
        allowed = sorted(set(client.allowed_commercial_codes))
        if len(allowed) == 1:
            locked_clients_by_commercial[allowed[0]].append(client)
        else:
            flexible_clients.append(client)

    locked_load_vars: dict[int, Any] = {}
    flexible_load_vars: dict[int, Any] = {}
    total_load_vars: dict[int, Any] = {}
    objective_terms = []

    for commercial_code, slot_indexes in slot_indices_by_commercial.items():
        locked_count = len(locked_clients_by_commercial.get(commercial_code, []))
        target_floor = locked_count // max(1, len(slot_indexes))
        target_ceil = math.ceil(locked_count / max(1, len(slot_indexes))) if locked_count > 0 else 0
        locked_vars_for_commercial = []

        for slot_index in slot_indexes:
            slot = slots[slot_index]
            locked_var = model.NewIntVar(0, slot.max_visits, f"locked_load_{slot_index}")
            locked_load_vars[slot_index] = locked_var
            locked_vars_for_commercial.append(locked_var)

            under_var = model.NewIntVar(0, max(target_floor, 0), f"locked_under_{slot_index}")
            over_var = model.NewIntVar(0, max(target_ceil, slot.max_visits), f"locked_over_{slot_index}")
            model.Add(under_var >= target_floor - locked_var)
            model.Add(over_var >= locked_var - target_ceil)
            objective_terms.append(under_var * 100_000)
            objective_terms.append(over_var * 100_000)

        model.Add(sum(locked_vars_for_commercial) == locked_count)

    flexible_total = len(flexible_clients)
    target_floor = len(mandatory_clients) // max(1, len(slots))
    target_ceil = math.ceil(len(mandatory_clients) / max(1, len(slots))) if mandatory_clients else 0

    for slot_index, slot in enumerate(slots):
        locked_var = locked_load_vars.get(slot_index)
        if locked_var is None:
            locked_var = model.NewIntVar(0, 0, f"locked_load_{slot_index}")
            model.Add(locked_var == 0)
            locked_load_vars[slot_index] = locked_var

        flex_var = model.NewIntVar(0, slot.max_visits, f"flex_load_{slot_index}")
        slot_min_visits = resolve_slot_min_visits(slot, payload)
        total_var = model.NewIntVar(slot_min_visits, slot.max_visits, f"total_load_{slot_index}")
        model.Add(total_var == locked_var + flex_var)
        model.Add(total_var <= slot.max_visits)
        flexible_load_vars[slot_index] = flex_var
        total_load_vars[slot_index] = total_var

        under_var = model.NewIntVar(0, max(target_floor, 0), f"global_under_{slot_index}")
        over_var = model.NewIntVar(0, max(target_ceil, slot.max_visits), f"global_over_{slot_index}")
        model.Add(under_var >= target_floor - total_var)
        model.Add(over_var >= total_var - target_ceil)
        objective_terms.append(under_var * 1_000_000)
        objective_terms.append(over_var * 1_000_000)

        if user_min_target > 0:
            user_under_var = model.NewIntVar(0, max(user_min_target, 0), f"user_under_{slot_index}")
            model.Add(user_under_var >= user_min_target - total_var)
            objective_terms.append(user_under_var * 100_000)

        if user_max_target > 0:
            user_over_var = model.NewIntVar(0, max(user_max_target, slot.max_visits), f"user_over_{slot_index}")
            model.Add(user_over_var >= total_var - user_max_target)
            objective_terms.append(user_over_var * 100_000)

    model.Add(sum(flexible_load_vars.values()) == flexible_total)
    model.Minimize(sum(objective_terms))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max(5.0, min(90.0, _safe_float(payload.get("max_solver_seconds"), 15.0)))
    solver.parameters.num_search_workers = max(1, min(8, 4))
    solver.parameters.log_search_progress = False

    status = solver.Solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        raise RuntimeError("simple_balanced_solver_failed")

    assigned_clients_by_slot: dict[str, list[NormalizedClient]] = {slot.slot_id: [] for slot in slots}

    for commercial_code, slot_indexes in slot_indices_by_commercial.items():
        locked_clients = locked_clients_by_commercial.get(commercial_code, [])
        cursor = 0
        for slot_index in slot_indexes:
            count = int(solver.Value(locked_load_vars[slot_index]))
            if count <= 0:
                continue
            assigned_clients_by_slot[slots[slot_index].slot_id].extend(locked_clients[cursor:cursor + count])
            cursor += count
        if cursor != len(locked_clients):
            raise RuntimeError(f"locked_clients_unassigned:{commercial_code}")

    cursor = 0
    for slot_index, slot in enumerate(slots):
        count = int(solver.Value(flexible_load_vars[slot_index]))
        if count <= 0:
            continue
        assigned_clients_by_slot[slot.slot_id].extend(flexible_clients[cursor:cursor + count])
        cursor += count
    if cursor != len(flexible_clients):
        raise RuntimeError("flexible_clients_unassigned")

    return assigned_clients_by_slot


def rebalance_assignments_to_slot_targets(
    slots: list[NormalizedSlot],
    assigned_clients_by_slot: dict[str, list[NormalizedClient]],
    feasible_slots_by_client: dict[str, list[str]],
    slot_targets: dict[str, int],
    slot_load_units: dict[str, float],
    slot_time_minutes: dict[str, float],
    context: CoverageOptimizationContext | None = None,
    *,
    greedy_metrics: dict[str, Any] | None = None,
    feasible_slot_sets_by_client: dict[str, set[str]] | None = None,
    client_rebalance_sort_keys: dict[str, tuple[Any, ...]] | None = None,
    sort_cache: dict[tuple[Any, ...], tuple[Any, ...]] | None = None,
    stop_minutes_cache: dict[tuple[str, str], float] | None = None,
    decisions_sink: list[tuple[Any, ...]] | None = None
) -> None:
    slot_by_id = {slot.slot_id: slot for slot in slots}

    if feasible_slot_sets_by_client is None:
        feasible_slot_sets_by_client = {
            client_id: set(slot_ids or [])
            for client_id, slot_ids in feasible_slots_by_client.items()
        }
    if client_rebalance_sort_keys is None:
        client_rebalance_sort_keys = {}
    if sort_cache is None:
        sort_cache = {}
    if stop_minutes_cache is None:
        stop_minutes_cache = {}

    def get_stop_minutes(slot: NormalizedSlot, client: NormalizedClient) -> float:
        cache_key = (slot.slot_id, client.client_id)
        cached = stop_minutes_cache.get(cache_key)
        if cached is not None:
            return cached
        value = resolve_client_estimated_stop_minutes(slot, client, context=context) or 0.0
        stop_minutes_cache[cache_key] = value
        return value

    def can_fit_client(
        slot: NormalizedSlot,
        client: NormalizedClient,
        *,
        projected_count: int,
        projected_load_units: float,
        projected_time_minutes: float
    ) -> tuple[bool, float]:
        if greedy_metrics is not None:
            greedy_metrics["capacity_checks"] = int(greedy_metrics.get("capacity_checks") or 0) + 1

        stop_minutes = get_stop_minutes(slot, client)
        if projected_count > slot.max_visits:
            if greedy_metrics is not None:
                greedy_metrics["rejected_by_capacity"] = int(greedy_metrics.get("rejected_by_capacity") or 0) + 1
            return False, stop_minutes
        if (
            slot.max_load_units is not None and
            slot.max_load_units > 0 and
            projected_load_units > slot.max_load_units + 1e-9
        ):
            if greedy_metrics is not None:
                greedy_metrics["rejected_by_capacity"] = int(greedy_metrics.get("rejected_by_capacity") or 0) + 1
            return False, stop_minutes
        if (
            slot.time_capacity_known and
            slot.max_route_minutes is not None and
            slot.max_route_minutes > 0 and
            projected_time_minutes > slot.max_route_minutes + 1e-9
        ):
            if greedy_metrics is not None:
                greedy_metrics["rejected_by_capacity"] = int(greedy_metrics.get("rejected_by_capacity") or 0) + 1
            return False, stop_minutes
        return True, stop_minutes

    while True:
        if greedy_metrics is not None:
            greedy_metrics["rebalancing_iterations"] = int(greedy_metrics.get("rebalancing_iterations") or 0) + 1
        progressed = False
        underfilled_slot_ids = [
            slot.slot_id
            for slot in slots
            if len(assigned_clients_by_slot.get(slot.slot_id, [])) < max(0, _safe_int(slot_targets.get(slot.slot_id), 0))
        ]
        donor_slot_ids = [
            slot.slot_id
            for slot in slots
            if len(assigned_clients_by_slot.get(slot.slot_id, [])) > max(0, _safe_int(slot_targets.get(slot.slot_id), 0))
        ]

        if not underfilled_slot_ids or not donor_slot_ids:
            break

        for receiver_slot_id in underfilled_slot_ids:
            receiver_slot = slot_by_id.get(receiver_slot_id)
            if receiver_slot is None:
                continue
            receiver_target = max(0, _safe_int(slot_targets.get(receiver_slot_id), 0))
            while len(assigned_clients_by_slot.get(receiver_slot_id, [])) < receiver_target:
                moved = False
                donor_snapshot = tuple(
                    (
                        slot_id,
                        len(assigned_clients_by_slot.get(slot_id, [])),
                        max(0, _safe_int(slot_targets.get(slot_id), 0))
                    )
                    for slot_id in donor_slot_ids
                )
                ordered_donor_slot_ids = _sorted_sequence_with_cache(
                    sort_cache,
                    ("greedy_rebalance_donor_slots", donor_snapshot),
                    donor_slot_ids,
                    lambda slot_id: (
                        -(len(assigned_clients_by_slot.get(slot_id, [])) - max(0, _safe_int(slot_targets.get(slot_id), 0))),
                        slot_id
                    ),
                    greedy_metrics
                )
                for donor_slot_id in ordered_donor_slot_ids:
                    donor_clients = assigned_clients_by_slot.get(donor_slot_id, [])
                    donor_target = max(0, _safe_int(slot_targets.get(donor_slot_id), 0))
                    if len(donor_clients) <= donor_target:
                        continue
                    donor_client_snapshot = tuple(client.client_id for client in donor_clients)
                    movable_clients = _sorted_sequence_with_cache(
                        sort_cache,
                        ("greedy_rebalance_movable_clients", donor_slot_id, donor_client_snapshot),
                        donor_clients,
                        lambda client: client_rebalance_sort_keys.get(client.client_id) or (
                            0 if not client.is_critical else 1,
                            len(feasible_slots_by_client.get(client.client_id, [])),
                            resolve_client_recovery_priority_value(client),
                            resolve_client_expected_collection_value(client),
                            resolve_client_purchase_prediction_score_value(client),
                            resolve_client_purchase_timing_urgency(client),
                            resolve_client_expected_order_value(client),
                            -resolve_client_predicted_ca_value(client),
                            client.client_id
                        ),
                        greedy_metrics
                    )
                    for client in movable_clients:
                        if greedy_metrics is not None:
                            greedy_metrics["assignment_attempts"] = int(greedy_metrics.get("assignment_attempts") or 0) + 1
                        if receiver_slot_id not in feasible_slot_sets_by_client.get(client.client_id, set()):
                            if greedy_metrics is not None:
                                greedy_metrics["rejected_by_constraint"] = int(greedy_metrics.get("rejected_by_constraint") or 0) + 1
                            continue
                        can_fit_receiver, receiver_stop_minutes = can_fit_client(
                            receiver_slot,
                            client,
                            projected_count=len(assigned_clients_by_slot.get(receiver_slot_id, [])) + 1,
                            projected_load_units=slot_load_units[receiver_slot_id] + client.predicted_load_units,
                            projected_time_minutes=slot_time_minutes[receiver_slot_id] + get_stop_minutes(receiver_slot, client)
                        )
                        if not can_fit_receiver:
                            continue

                        donor_clients.remove(client)
                        slot_load_units[donor_slot_id] -= client.predicted_load_units
                        slot_time_minutes[donor_slot_id] -= get_stop_minutes(slot_by_id[donor_slot_id], client)
                        assigned_clients_by_slot[receiver_slot_id].append(client)
                        slot_load_units[receiver_slot_id] += client.predicted_load_units
                        slot_time_minutes[receiver_slot_id] += receiver_stop_minutes
                        if decisions_sink is not None:
                            decisions_sink.append(("rebalancing_move", client.client_id, donor_slot_id, receiver_slot_id))
                        moved = True
                        progressed = True
                        break
                    if moved:
                        break
                if not moved:
                    break
        if not progressed:
            break


def solve_greedy_capacity_plan(
    payload: dict[str, Any],
    slots: list[NormalizedSlot],
    mandatory_clients: list[NormalizedClient],
    feasible_slots_by_client: dict[str, list[str]],
    slot_targets: dict[str, int] | None = None,
    context: CoverageOptimizationContext | None = None,
    assignment_candidates: list[dict[str, Any]] | None = None,
    assignment_index_by_key: dict[tuple[str, str], int] | None = None,
    candidate_planning_context: CandidatePlanningContext | None = None,
    performance_entries: list[dict[str, Any]] | None = None,
    greedy_meta_sink: dict[str, Any] | None = None,
    greedy_trace_sink: dict[str, Any] | None = None
) -> tuple[dict[str, list[NormalizedClient]], list[str]]:
    _ = assignment_index_by_key
    total_started_at = time.perf_counter()
    greedy_stage_entries: list[dict[str, Any]] = []
    sales_mode = is_sales_coverage_mode(payload)
    collection_target_context = resolve_collection_target_context(payload)
    requested_target_collection_decimal = (
        _to_stable_money_decimal(collection_target_context.get("requested_target_collection_amount"))
        if isinstance(collection_target_context, dict) and collection_target_context.get("mode") == "target_collection"
        else None
    )
    target_collection_mode = (
        not sales_mode and
        requested_target_collection_decimal is not None and
        requested_target_collection_decimal > Decimal("0.00")
    )
    assigned_collection_decimal = Decimal("0.00")
    _increment_context_counter(context, "solve_greedy_capacity_plan_calls")

    prepare_indices_started_at = time.perf_counter()
    if candidate_planning_context is None and context is not None:
        candidate_planning_context = context.candidate_planning_context
    assigned_clients_by_slot: dict[str, list[NormalizedClient]] = {slot.slot_id: [] for slot in slots}
    slot_by_id = (
        candidate_planning_context.slot_by_id
        if candidate_planning_context is not None
        else {slot.slot_id: slot for slot in slots}
    )
    slot_depot_by_id = {slot.slot_id: resolve_slot_depot_coordinates(payload, slot) for slot in slots}
    client_by_id = (
        candidate_planning_context.client_by_id
        if candidate_planning_context is not None
        else {client.client_id: client for client in mandatory_clients}
    )
    feasible_slot_ids_by_client = (
        {
            client_id: [
                str(candidate_planning_context.candidate_records[candidate_index].get("slot_id") or "")
                for candidate_index in candidate_indexes
            ]
            for client_id, candidate_indexes in candidate_planning_context.candidate_indexes_by_client.items()
        }
        if candidate_planning_context is not None
        else {
            client.client_id: list(feasible_slots_by_client.get(client.client_id, []))
            for client in mandatory_clients
        }
    )
    feasible_slot_sets_by_client = {
        client_id: set(slot_ids)
        for client_id, slot_ids in feasible_slot_ids_by_client.items()
    }
    feasible_slot_count_by_client = {
        client_id: len(slot_ids)
        for client_id, slot_ids in feasible_slot_ids_by_client.items()
    }
    current_load_by_slot = {slot.slot_id: 0 for slot in slots}
    slot_load_units = {slot.slot_id: 0.0 for slot in slots}
    slot_time_minutes = {slot.slot_id: 0.0 for slot in slots}
    stop_minutes_cache: dict[tuple[str, str], float] = {}
    score_component_cache: dict[tuple[str, str], dict[str, Any]] = {}
    sort_cache: dict[tuple[Any, ...], tuple[Any, ...]] = {}
    distance_calc_seconds = 0.0
    capacity_check_seconds = 0.0
    priority_static_seconds = 0.0
    priority_date_seconds = 0.0
    priority_distance_seconds = 0.0
    priority_score_assembly_seconds = 0.0
    priority_sort_seconds = 0.0
    assignment_decisions: list[tuple[Any, ...]] = []
    greedy_metrics: dict[str, Any] = {
        "clients_count": len(mandatory_clients),
        "slots_count": len(slots),
        "candidate_pairs_count": (
            len(assignment_candidates)
            if assignment_candidates is not None
            else sum(len(slot_ids) for slot_ids in feasible_slot_ids_by_client.values())
        ),
        "assigned_clients_count": 0,
        "unassigned_clients_count": 0,
        "mandatory_clients_count": len(mandatory_clients),
        "assignment_attempts": 0,
        "candidate_evaluations": 0,
        "capacity_checks": 0,
        "rejected_by_capacity": 0,
        "rejected_by_constraint": 0,
        "rebalancing_iterations": 0,
        "repair_iterations": 0,
        "distance_calls": 0,
        "distance_cache_hits": 0,
        "distance_cache_misses": 0,
        "full_candidate_scans": 0,
        "repeated_sorts_count": 0,
        "sort_cache_hits": 0,
        "score_cache_hits": 0,
        "score_cache_misses": 0,
        "number_of_priority_records": 0,
        "priority_distance_unique_computations": 0,
        "priority_score_computations": 0,
        "priority_date_computations": 0,
        "priority_sort_item_count": 0,
    }
    greedy_stage_entries.append(_build_perf_entry("python_greedy_prepare_indices", prepare_indices_started_at))
    candidate_context_reuse_greedy_started_at = time.perf_counter()
    greedy_stage_entries.append(_build_perf_entry("python_candidate_context_reuse_greedy", candidate_context_reuse_greedy_started_at))

    prepare_capacities_started_at = time.perf_counter()
    user_min_target = max(0, _safe_int(payload.get("user_min_visits_per_slot"), 0))
    user_max_target = max(0, _safe_int(payload.get("user_max_visits_per_slot"), 0))
    distribution_context = build_capacity_distribution_context(slots, slot_targets, len(mandatory_clients))
    resolved_slot_targets = distribution_context["slot_targets"]
    resolved_slot_soft_capacities = distribution_context["slot_soft_capacities"]
    commercial_soft_capacity_totals = distribution_context["commercial_soft_capacity_totals"]
    commercial_target_totals = distribution_context["commercial_target_totals"]
    global_ratio_target = float(distribution_context["global_ratio_target"] or 1.0)
    commercial_planned_clients: Counter[str] = Counter()
    slot_target_by_id = {
        slot.slot_id: max(1, _safe_int(resolved_slot_targets.get(slot.slot_id), 0) or resolve_slot_soft_capacity(slot))
        for slot in slots
    }
    slot_soft_capacity_by_id = {
        slot.slot_id: max(1, _safe_int(resolved_slot_soft_capacities.get(slot.slot_id), 0) or resolve_slot_soft_capacity(slot))
        for slot in slots
    }
    commercial_soft_total_by_code = {
        commercial_code: max(1, _safe_int(soft_total, 0))
        for commercial_code, soft_total in commercial_soft_capacity_totals.items()
    }
    commercial_target_total_by_code = {
        commercial_code: max(1, _safe_int(commercial_target_totals.get(commercial_code), 0))
        for commercial_code in commercial_soft_total_by_code
    }
    top_ratio_code: str | None = None
    top_ratio_value = 0.0
    second_ratio_value = 0.0

    def refresh_commercial_ratios() -> None:
        nonlocal top_ratio_code, top_ratio_value, second_ratio_value
        top_ratio_code = None
        top_ratio_value = 0.0
        second_ratio_value = 0.0
        for commercial_code, soft_total in commercial_soft_total_by_code.items():
            current_ratio = commercial_planned_clients.get(commercial_code, 0) / max(1, soft_total)
            if top_ratio_code is None or current_ratio > top_ratio_value:
                second_ratio_value = top_ratio_value
                top_ratio_value = current_ratio
                top_ratio_code = commercial_code
            elif current_ratio > second_ratio_value:
                second_ratio_value = current_ratio

    refresh_commercial_ratios()
    greedy_stage_entries.append(_build_perf_entry("python_greedy_prepare_capacities", prepare_capacities_started_at))

    prepare_priorities_started_at = time.perf_counter()
    planning_start = parse_iso_date(payload.get("planning_start_date"))
    client_sort_keys: dict[str, tuple[Any, ...]] = {}
    client_repair_sort_keys: dict[str, tuple[Any, ...]] = {}
    client_rebalance_sort_keys: dict[str, tuple[Any, ...]] = {}

    for client in mandatory_clients:
        static_started_at = time.perf_counter()
        deadline = parse_iso_date(client.next_visit_deadline)
        deadline_ordinal = deadline.toordinal() if deadline else 999999999
        feasible_count = feasible_slot_count_by_client.get(client.client_id, 0)
        coverage_urgency = resolve_client_coverage_urgency_component(client, payload.get("planning_start_date"))
        recovery_urgency = resolve_client_recovery_urgency_value(client)
        recovery_priority = resolve_client_recovery_priority_value(client)
        expected_collection = resolve_client_expected_collection_value(client)
        purchase_score = resolve_client_purchase_prediction_score_value(client)
        purchase_timing = resolve_client_purchase_timing_urgency(client)
        expected_order = resolve_client_expected_order_value(client)
        predicted_ca = resolve_client_predicted_ca_value(client)
        if sales_mode:
            client_sort_keys[client.client_id] = (
                0 if client.is_critical else 1,
                -coverage_urgency,
                feasible_count,
                deadline_ordinal,
                -purchase_score,
                -purchase_timing,
                -expected_order,
                0 if client.historical_commercial_code else 1,
                -predicted_ca,
                client.client_id
            )
        else:
            client_sort_keys[client.client_id] = (
                -recovery_urgency,
                -recovery_priority,
                -expected_collection,
                0 if client.is_critical else 1,
                -coverage_urgency,
                feasible_count,
                deadline_ordinal,
                0 if client.historical_commercial_code else 1,
                client.client_id
            )
        priority_static_seconds += time.perf_counter() - static_started_at
        if sales_mode:
            client_repair_sort_keys[client.client_id] = (
                0 if not client.is_critical else 1,
                -feasible_count,
                purchase_score,
                purchase_timing,
                expected_order,
                predicted_ca,
                client.client_id
            )
            client_rebalance_sort_keys[client.client_id] = (
                0 if not client.is_critical else 1,
                feasible_count,
                purchase_score,
                purchase_timing,
                expected_order,
                -predicted_ca,
                client.client_id
            )
        else:
            client_repair_sort_keys[client.client_id] = (
                recovery_urgency,
                recovery_priority,
                expected_collection,
                0 if not client.is_critical else 1,
                -feasible_count,
                coverage_urgency,
                client.client_id
            )
            client_rebalance_sort_keys[client.client_id] = (
                recovery_urgency,
                recovery_priority,
                expected_collection,
                0 if not client.is_critical else 1,
                feasible_count,
                coverage_urgency,
                client.client_id
            )

    def compute_uncached_score_components(
        client: NormalizedClient,
        slot: NormalizedSlot,
        *,
        instrument_priority: bool = False
    ) -> dict[str, Any]:
        nonlocal distance_calc_seconds
        nonlocal priority_date_seconds
        nonlocal priority_distance_seconds
        nonlocal priority_score_assembly_seconds
        cache_key = (client.client_id, slot.slot_id)
        greedy_metrics["distance_calls"] = int(greedy_metrics.get("distance_calls") or 0) + 1
        if instrument_priority:
            greedy_metrics["priority_score_computations"] = int(greedy_metrics.get("priority_score_computations") or 0) + 1

        distance_started_at = time.perf_counter()
        depot_lat, depot_lon = slot_depot_by_id[slot.slot_id]
        distance_km = _get_context_distance_km(context, depot_lat, depot_lon, client.latitude, client.longitude) or 0.0
        distance_elapsed = time.perf_counter() - distance_started_at
        distance_calc_seconds += distance_elapsed
        if instrument_priority:
            priority_distance_seconds += distance_elapsed
            if context is not None:
                coord_key = (
                    None if depot_lat is None else float(depot_lat),
                    None if depot_lon is None else float(depot_lon),
                    None if client.latitude is None else float(client.latitude),
                    None if client.longitude is None else float(client.longitude),
                )
                if coord_key in context.distance_cache:
                    greedy_metrics["priority_distance_unique_computations"] = len(context.distance_cache)

        date_started_at = time.perf_counter()
        slot_date = parse_iso_date(slot.date_iso)
        deadline = parse_iso_date(client.next_visit_deadline)
        deadline_gap = max(0, (deadline - slot_date).days) if deadline and slot_date else 0
        day_offset = max(0, (slot_date - planning_start).days) if slot_date and planning_start else 0
        date_elapsed = time.perf_counter() - date_started_at
        if instrument_priority:
            priority_date_seconds += date_elapsed
            greedy_metrics["priority_date_computations"] = int(greedy_metrics.get("priority_date_computations") or 0) + 1

        assembly_started_at = time.perf_counter()
        components = {
            "coverage_date_penalty": int(round(resolve_client_coverage_urgency_component(client, payload.get("planning_start_date")) * day_offset * 100)),
            "recovery_urgency_date_penalty": 0 if sales_mode else int(round(resolve_client_recovery_urgency_value(client) * day_offset * 100)),
            "recovery_date_penalty": 0 if sales_mode else int(round(resolve_client_recovery_priority_value(client) * day_offset * 100)),
            "expected_collection_date_penalty": 0 if sales_mode else int(round(min(resolve_client_expected_collection_value(client), 1_000_000.0) * day_offset * 10)),
            "purchase_score_date_penalty": int(round(resolve_client_purchase_prediction_score_value(client) * day_offset * 100)) if sales_mode else 0,
            "purchase_timing_date_penalty": int(round(resolve_client_purchase_timing_urgency(client) * day_offset * 100)) if sales_mode else 0,
            "expected_order_date_penalty": int(round(min(resolve_client_expected_order_value(client), 1_000_000.0) * day_offset * 10)) if sales_mode else 0,
            "reassignment_penalty": 1 if (
                client.historical_commercial_code and
                slot.commercial_code != client.historical_commercial_code
            ) else 0,
            "distance_km_rounded4": round(distance_km, 4),
            "deadline_gap": deadline_gap,
        }
        if instrument_priority:
            priority_score_assembly_seconds += time.perf_counter() - assembly_started_at
        score_component_cache[cache_key] = components
        return components

    def build_score_components(client: NormalizedClient, slot: NormalizedSlot) -> dict[str, Any]:
        cache_key = (client.client_id, slot.slot_id)
        cached = score_component_cache.get(cache_key)
        if cached is not None:
            greedy_metrics["score_cache_hits"] = int(greedy_metrics.get("score_cache_hits") or 0) + 1
            greedy_metrics["distance_cache_hits"] = int(greedy_metrics.get("distance_cache_hits") or 0) + 1
            return cached

        if candidate_planning_context is not None:
            record = candidate_planning_context.candidate_record_by_key.get(cache_key)
            if record is not None:
                components = {
                    "coverage_date_penalty": int(record.get("coverage_date_penalty") or 0),
                    "recovery_urgency_date_penalty": int(record.get("recovery_urgency_date_penalty") or 0),
                    "recovery_date_penalty": int(record.get("recovery_date_penalty") or 0),
                    "expected_collection_date_penalty": int(record.get("expected_collection_date_penalty") or 0),
                    "purchase_score_date_penalty": int(record.get("purchase_score_date_penalty") or 0),
                    "purchase_timing_date_penalty": int(record.get("purchase_timing_date_penalty") or 0),
                    "expected_order_date_penalty": int(record.get("expected_order_date_penalty") or 0),
                    "reassignment_penalty": int(record.get("reassignment_penalty") or 0),
                    "distance_km_rounded4": float(record.get("distance_km_rounded4") or 0.0),
                    "deadline_gap": int(record.get("deadline_gap") or 0),
                }
                score_component_cache[cache_key] = components
                greedy_metrics["score_cache_hits"] = int(greedy_metrics.get("score_cache_hits") or 0) + 1
                greedy_metrics["distance_cache_hits"] = int(greedy_metrics.get("distance_cache_hits") or 0) + 1
                return components

        greedy_metrics["score_cache_misses"] = int(greedy_metrics.get("score_cache_misses") or 0) + 1
        greedy_metrics["distance_cache_misses"] = int(greedy_metrics.get("distance_cache_misses") or 0) + 1
        return compute_uncached_score_components(client, slot, instrument_priority=False)

    candidate_records_for_priority = (
        candidate_planning_context.candidate_records
        if candidate_planning_context is not None
        else (assignment_candidates or [])
    )
    if candidate_records_for_priority:
        greedy_metrics["number_of_priority_records"] = len(candidate_records_for_priority)

    priority_sort_started_at = time.perf_counter()
    sorted_mandatory_clients = sorted(mandatory_clients, key=lambda client: client_sort_keys[client.client_id])
    priority_sort_seconds += time.perf_counter() - priority_sort_started_at
    greedy_metrics["priority_sort_item_count"] = len(sorted_mandatory_clients)
    greedy_stage_entries.append(_build_perf_entry("python_greedy_prepare_priorities", prepare_priorities_started_at))
    greedy_stage_entries.append({
        "stage": "python_greedy_priority_static_components",
        "duration_ms": max(0, int(round(priority_static_seconds * 1000))),
    })
    greedy_stage_entries.append({
        "stage": "python_greedy_priority_date_components",
        "duration_ms": max(0, int(round(priority_date_seconds * 1000))),
    })
    greedy_stage_entries.append({
        "stage": "python_greedy_priority_distance_lookup",
        "duration_ms": max(0, int(round(priority_distance_seconds * 1000))),
    })
    greedy_stage_entries.append({
        "stage": "python_greedy_priority_score_assembly",
        "duration_ms": max(0, int(round(priority_score_assembly_seconds * 1000))),
    })
    greedy_stage_entries.append({
        "stage": "python_greedy_priority_sort",
        "duration_ms": max(0, int(round(priority_sort_seconds * 1000))),
    })

    def get_stop_minutes(slot: NormalizedSlot, client: NormalizedClient) -> float:
        cache_key = (slot.slot_id, client.client_id)
        cached = stop_minutes_cache.get(cache_key)
        if cached is not None:
            return cached
        if candidate_planning_context is not None:
            record = candidate_planning_context.candidate_record_by_key.get((client.client_id, slot.slot_id))
            if record is not None:
                value = float(int(record.get("predicted_stop_minutes_centi") or 0)) / 100.0
                stop_minutes_cache[cache_key] = value
                return value
        value = resolve_client_estimated_stop_minutes(slot, client, context=context) or 0.0
        stop_minutes_cache[cache_key] = value
        return value

    def can_fit_client(
        slot: NormalizedSlot,
        client: NormalizedClient,
        *,
        projected_count: int,
        projected_load_units: float,
        projected_time_minutes: float
    ) -> tuple[bool, float]:
        nonlocal capacity_check_seconds
        capacity_started_at = time.perf_counter()
        greedy_metrics["capacity_checks"] = int(greedy_metrics.get("capacity_checks") or 0) + 1
        stop_minutes = get_stop_minutes(slot, client)
        can_fit = True
        if projected_count > slot.max_visits:
            can_fit = False
        elif (
            slot.max_load_units is not None and
            slot.max_load_units > 0 and
            projected_load_units > slot.max_load_units + 1e-9
        ):
            can_fit = False
        elif (
            slot.time_capacity_known and
            slot.max_route_minutes is not None and
            slot.max_route_minutes > 0 and
            projected_time_minutes > slot.max_route_minutes + 1e-9
        ):
            can_fit = False
        if not can_fit:
            greedy_metrics["rejected_by_capacity"] = int(greedy_metrics.get("rejected_by_capacity") or 0) + 1
        capacity_check_seconds += time.perf_counter() - capacity_started_at
        return can_fit, stop_minutes

    def update_commercial_load(commercial_code: str, delta: int) -> None:
        commercial_planned_clients[commercial_code] += delta
        refresh_commercial_ratios()

    def is_collection_target_reached() -> bool:
        return bool(
            target_collection_mode and
            requested_target_collection_decimal is not None and
            assigned_collection_decimal >= requested_target_collection_decimal
        )

    def update_assigned_collection(client: NormalizedClient, delta: int) -> None:
        nonlocal assigned_collection_decimal
        if not target_collection_mode or delta == 0:
            return
        assigned_collection_decimal += (
            _resolve_candidate_recovery_expected_collection_decimal(client) * Decimal(delta)
        )
        assigned_collection_decimal = assigned_collection_decimal.quantize(
            Decimal("0.01"),
            rounding=ROUND_HALF_UP,
        )

    def append_client_to_slot(slot: NormalizedSlot, client: NormalizedClient, stop_minutes: float) -> None:
        assigned_clients_by_slot[slot.slot_id].append(client)
        current_load_by_slot[slot.slot_id] += 1
        slot_load_units[slot.slot_id] += client.predicted_load_units
        slot_time_minutes[slot.slot_id] += stop_minutes
        update_commercial_load(slot.commercial_code, 1)
        update_assigned_collection(client, 1)

    def remove_client_from_slot(slot: NormalizedSlot, client: NormalizedClient, stop_minutes: float) -> None:
        assigned_clients_by_slot[slot.slot_id].remove(client)
        current_load_by_slot[slot.slot_id] -= 1
        slot_load_units[slot.slot_id] -= client.predicted_load_units
        slot_time_minutes[slot.slot_id] -= stop_minutes
        update_commercial_load(slot.commercial_code, -1)
        update_assigned_collection(client, -1)

    def slot_score(client: NormalizedClient, slot: NormalizedSlot) -> tuple[Any, ...]:
        current_load = current_load_by_slot[slot.slot_id]
        next_load = current_load + 1
        target_load = slot_target_by_id[slot.slot_id]
        soft_capacity = slot_soft_capacity_by_id[slot.slot_id]
        score_components = build_score_components(client, slot)
        commercial_code = slot.commercial_code
        current_commercial_load = commercial_planned_clients.get(commercial_code, 0)
        next_commercial_load = current_commercial_load + 1
        commercial_soft_total = commercial_soft_total_by_code.get(commercial_code, 1)
        commercial_target_total = commercial_target_total_by_code.get(commercial_code, 1)
        projected_commercial_ratio = next_commercial_load / commercial_soft_total
        projected_other_ratio = top_ratio_value if top_ratio_code != commercial_code else second_ratio_value
        projected_global_max_ratio = max(projected_commercial_ratio, projected_other_ratio)
        projected_ratio_above_target = max(0.0, projected_commercial_ratio - global_ratio_target)
        projected_ratio_gap = abs(projected_commercial_ratio - global_ratio_target)
        commercial_target_over_ratio = max(0.0, (next_commercial_load - commercial_target_total) / commercial_soft_total)
        user_under_penalty = user_min_target - next_load if user_min_target > 0 and next_load < user_min_target else 0
        user_over_penalty = next_load - user_max_target if user_max_target > 0 and next_load > user_max_target else 0
        soft_overload = max(0, next_load - soft_capacity)
        soft_overload_ratio = round(max(0.0, (next_load / max(1, soft_capacity)) - 1.0), 4)
        target_fill_over_ratio = round(max(0.0, (next_load / max(1, target_load)) - 1.0), 4)
        if sales_mode:
            return (
                0 if client.is_critical else 1,
                int(score_components["coverage_date_penalty"]),
                int(score_components["purchase_score_date_penalty"]),
                int(score_components["purchase_timing_date_penalty"]),
                int(score_components["expected_order_date_penalty"]),
                round(projected_global_max_ratio, 6),
                round(projected_ratio_above_target, 6),
                round(projected_ratio_gap, 6),
                round(commercial_target_over_ratio, 6),
                target_fill_over_ratio,
                soft_overload_ratio,
                soft_overload,
                int(score_components["deadline_gap"]),
                int(score_components["reassignment_penalty"]),
                user_over_penalty,
                user_under_penalty,
                float(score_components["distance_km_rounded4"]),
                slot.date_iso,
                slot.commercial_code,
                current_load
            )
        return (
            int(score_components["recovery_urgency_date_penalty"]),
            int(score_components["recovery_date_penalty"]),
            int(score_components["expected_collection_date_penalty"]),
            0 if client.is_critical else 1,
            int(score_components["coverage_date_penalty"]),
            round(projected_global_max_ratio, 6),
            round(projected_ratio_above_target, 6),
            round(projected_ratio_gap, 6),
            round(commercial_target_over_ratio, 6),
            target_fill_over_ratio,
            soft_overload_ratio,
            soft_overload,
            int(score_components["deadline_gap"]),
            int(score_components["reassignment_penalty"]),
            user_over_penalty,
            user_under_penalty,
            float(score_components["distance_km_rounded4"]),
            slot.date_iso,
            slot.commercial_code,
            current_load
        )

    unassigned_clients: list[str] = []
    mandatory_assignment_started_at = time.perf_counter()
    for client in sorted_mandatory_clients:
        if is_collection_target_reached():
            break
        best_slot: NormalizedSlot | None = None
        best_score: tuple[Any, ...] | None = None
        best_stop_minutes = 0.0
        feasible_slot_ids = feasible_slot_ids_by_client.get(client.client_id, [])
        preferred_slot_ids = [
            slot_id
            for slot_id in feasible_slot_ids
            if current_load_by_slot.get(slot_id, 0) < max(0, _safe_int(resolved_slot_targets.get(slot_id), 0))
        ]
        candidate_slot_ids = preferred_slot_ids or feasible_slot_ids
        if candidate_slot_ids is feasible_slot_ids and candidate_slot_ids:
            greedy_metrics["full_candidate_scans"] = int(greedy_metrics.get("full_candidate_scans") or 0) + 1

        for slot_id in candidate_slot_ids:
            greedy_metrics["assignment_attempts"] = int(greedy_metrics.get("assignment_attempts") or 0) + 1
            slot = slot_by_id.get(slot_id)
            if slot is None:
                greedy_metrics["rejected_by_constraint"] = int(greedy_metrics.get("rejected_by_constraint") or 0) + 1
                continue
            can_fit_slot, estimated_stop_minutes = can_fit_client(
                slot,
                client,
                projected_count=current_load_by_slot[slot_id] + 1,
                projected_load_units=slot_load_units[slot_id] + client.predicted_load_units,
                projected_time_minutes=slot_time_minutes[slot_id] + get_stop_minutes(slot, client)
            )
            if not can_fit_slot:
                continue
            greedy_metrics["candidate_evaluations"] = int(greedy_metrics.get("candidate_evaluations") or 0) + 1
            score = slot_score(client, slot)
            if best_score is None or score < best_score:
                best_score = score
                best_slot = slot
                best_stop_minutes = estimated_stop_minutes

        if best_slot is None:
            assignment_decisions.append(("mandatory", client.client_id, None))
            unassigned_clients.append(client.client_id)
            continue
        append_client_to_slot(best_slot, client, best_stop_minutes)
        assignment_decisions.append(("mandatory", client.client_id, best_slot.slot_id))
    greedy_stage_entries.append(_build_perf_entry("python_greedy_mandatory_assignment", mandatory_assignment_started_at))

    repair_started_at = time.perf_counter()
    if unassigned_clients and not is_collection_target_reached():
        unresolved_clients: list[str] = []
        for client_id in unassigned_clients:
            if is_collection_target_reached():
                break
            client = client_by_id[client_id]
            placed = False
            greedy_metrics["repair_iterations"] = int(greedy_metrics.get("repair_iterations") or 0) + 1

            for slot_id in feasible_slot_ids_by_client.get(client.client_id, []):
                greedy_metrics["assignment_attempts"] = int(greedy_metrics.get("assignment_attempts") or 0) + 1
                slot = slot_by_id.get(slot_id)
                if slot is None:
                    greedy_metrics["rejected_by_constraint"] = int(greedy_metrics.get("rejected_by_constraint") or 0) + 1
                    continue

                current_slot_clients = assigned_clients_by_slot[slot_id]
                slot_can_fit_directly, direct_stop_minutes = can_fit_client(
                    slot,
                    client,
                    projected_count=current_load_by_slot[slot_id] + 1,
                    projected_load_units=slot_load_units[slot_id] + client.predicted_load_units,
                    projected_time_minutes=slot_time_minutes[slot_id] + get_stop_minutes(slot, client)
                )
                if slot_can_fit_directly:
                    append_client_to_slot(slot, client, direct_stop_minutes)
                    assignment_decisions.append(("repair_direct", client.client_id, slot.slot_id))
                    placed = True
                    break

                movable_clients = _sorted_sequence_with_cache(
                    sort_cache,
                    ("greedy_repair_movable_clients", slot_id, tuple(existing.client_id for existing in current_slot_clients)),
                    current_slot_clients,
                    lambda existing: client_repair_sort_keys.get(existing.client_id),
                    greedy_metrics
                )
                for existing_client in movable_clients:
                    for alt_slot_id in feasible_slot_ids_by_client.get(existing_client.client_id, []):
                        if alt_slot_id == slot_id:
                            continue
                        greedy_metrics["assignment_attempts"] = int(greedy_metrics.get("assignment_attempts") or 0) + 1
                        alt_slot = slot_by_id.get(alt_slot_id)
                        if alt_slot is None:
                            greedy_metrics["rejected_by_constraint"] = int(greedy_metrics.get("rejected_by_constraint") or 0) + 1
                            continue
                        can_fit_alt_slot, existing_alt_stop_minutes = can_fit_client(
                            alt_slot,
                            existing_client,
                            projected_count=current_load_by_slot[alt_slot_id] + 1,
                            projected_load_units=slot_load_units[alt_slot_id] + existing_client.predicted_load_units,
                            projected_time_minutes=slot_time_minutes[alt_slot_id] + get_stop_minutes(alt_slot, existing_client)
                        )
                        if not can_fit_alt_slot:
                            continue

                        existing_source_stop_minutes = get_stop_minutes(slot, existing_client)
                        remaining_source_load = slot_load_units[slot_id] - existing_client.predicted_load_units
                        remaining_source_time = slot_time_minutes[slot_id] - existing_source_stop_minutes
                        can_fit_repaired_client, repaired_stop_minutes = can_fit_client(
                            slot,
                            client,
                            projected_count=current_load_by_slot[slot_id],
                            projected_load_units=remaining_source_load + client.predicted_load_units,
                            projected_time_minutes=remaining_source_time + get_stop_minutes(slot, client)
                        )
                        if not can_fit_repaired_client:
                            continue

                        remove_client_from_slot(slot, existing_client, existing_source_stop_minutes)
                        append_client_to_slot(alt_slot, existing_client, existing_alt_stop_minutes)
                        append_client_to_slot(slot, client, repaired_stop_minutes)
                        assignment_decisions.append(("repair_swap", client.client_id, slot.slot_id, existing_client.client_id, alt_slot.slot_id))
                        placed = True
                        break
                    if placed:
                        break
                if placed:
                    break

            if not placed:
                assignment_decisions.append(("repair_unassigned", client.client_id, None))
                unresolved_clients.append(client.client_id)

        unassigned_clients = unresolved_clients
    greedy_stage_entries.append(_build_perf_entry("python_greedy_repair", repair_started_at))

    assignments_before_postprocess_hash = _hash_assignment_state(assigned_clients_by_slot)

    rebalancing_started_at = time.perf_counter()
    rebalance_assignments_to_slot_targets(
        slots=slots,
        assigned_clients_by_slot=assigned_clients_by_slot,
        feasible_slots_by_client=feasible_slots_by_client,
        slot_targets=resolved_slot_targets,
        slot_load_units=slot_load_units,
        slot_time_minutes=slot_time_minutes,
        context=context,
        greedy_metrics=greedy_metrics,
        feasible_slot_sets_by_client=feasible_slot_sets_by_client,
        client_rebalance_sort_keys=client_rebalance_sort_keys,
        sort_cache=sort_cache,
        stop_minutes_cache=stop_minutes_cache,
        decisions_sink=assignment_decisions
    )
    for slot in slots:
        current_load_by_slot[slot.slot_id] = len(assigned_clients_by_slot.get(slot.slot_id, []))
    greedy_stage_entries.append(_build_perf_entry("python_greedy_rebalancing", rebalancing_started_at))

    extract_started_at = time.perf_counter()
    greedy_metrics["assigned_clients_count"] = sum(len(assigned_clients_by_slot.get(slot.slot_id, [])) for slot in slots)
    greedy_metrics["unassigned_clients_count"] = len(unassigned_clients)
    greedy_metrics["repeated_sorts_count"] = int(greedy_metrics.get("sort_cache_hits") or 0)
    greedy_stage_entries.append({
        "stage": "python_greedy_capacity_checks",
        "duration_ms": max(0, int(round(capacity_check_seconds * 1000))),
    })
    greedy_stage_entries.append({
        "stage": "python_greedy_distance_calculations",
        "duration_ms": max(0, int(round(distance_calc_seconds * 1000))),
    })
    greedy_stage_entries.append(_build_perf_entry("python_greedy_extract_solution", extract_started_at))
    greedy_stage_entries.append(_build_perf_entry("python_greedy_total", total_started_at))

    if performance_entries is not None:
        performance_entries.extend(greedy_stage_entries)
    if greedy_meta_sink is not None:
        greedy_meta_sink.clear()
        greedy_meta_sink.update(greedy_metrics)
    if greedy_trace_sink is not None:
        _increment_context_counter(context, "debug_trace_hash_calls")
        debug_greedy_trace_started_at = time.perf_counter()
        greedy_trace_sink.clear()
        greedy_trace_sink.update({
            "greedy_candidate_order_hash": compute_stable_debug_hash([
                (
                    str(assignment.get("client_id") or ""),
                    str(assignment.get("slot_id") or "")
                )
                for assignment in candidate_records_for_priority
            ]),
            "candidate_pairs_count": len(candidate_records_for_priority),
            "client_priority_order_hash": compute_stable_debug_hash([client.client_id for client in sorted_mandatory_clients]),
            "client_priority_count": len(sorted_mandatory_clients),
            "candidate_order_by_client_hash": compute_stable_debug_hash([
                {
                    "client_id": client.client_id,
                    "candidate_slot_ids": list(feasible_slot_ids_by_client.get(client.client_id, []))
                }
                for client in sorted_mandatory_clients
            ]),
            "initial_capacities_hash": compute_stable_debug_hash([
                {
                    "slot_id": slot.slot_id,
                    "slot_target": slot_target_by_id[slot.slot_id],
                    "slot_soft_capacity": slot_soft_capacity_by_id[slot.slot_id],
                    "max_visits": slot.max_visits,
                    "max_load_units": slot.max_load_units,
                    "max_route_minutes": slot.max_route_minutes,
                }
                for slot in slots
            ]),
            "assignment_decisions_hash": compute_stable_debug_hash(list(assignment_decisions)),
            "assignment_decisions_count": len(assignment_decisions),
            "assignments_before_postprocess_hash": assignments_before_postprocess_hash,
            "assignments_after_postprocess_hash": _hash_assignment_state(assigned_clients_by_slot),
            "canonical_functional_result_hash": None,
        })
        if performance_entries is not None and is_perf_debug_enabled():
            performance_entries.append(_build_perf_entry("python_debug_greedy_trace_hashes", debug_greedy_trace_started_at))

    return assigned_clients_by_slot, unassigned_clients


def build_coverage_cp_sat_model_artifacts(
    raw_payload: dict[str, Any],
    payload: dict[str, Any],
    slots: list[NormalizedSlot],
    mandatory_clients: list[NormalizedClient],
    assignments: list[dict[str, Any]],
    slot_targets: dict[str, Any],
    slot_soft_capacities: dict[str, Any],
    commercial_soft_capacity_totals: dict[str, Any],
    commercial_target_totals: dict[str, Any],
    global_ratio_target_scaled: int,
    *,
    include_fingerprint_payload: bool = False,
    candidate_planning_context: CandidatePlanningContext | None = None,
) -> tuple[CoverageCpSatArtifacts, list[dict[str, Any]]]:
    stage_entries: list[dict[str, Any]] = []

    prepare_started_at = time.perf_counter()
    indexed_candidates = build_solver_candidate_indices(
        assignments,
        mandatory_clients,
        slots,
        candidate_planning_context=candidate_planning_context
    )
    unique_assignments = indexed_candidates["assignments"]
    candidate_by_client_slot = indexed_candidates["candidate_by_client_slot"]
    candidate_indexes_by_client = indexed_candidates["candidate_indexes_by_client"]
    candidate_indexes_by_slot = indexed_candidates["candidate_indexes_by_slot"]
    candidate_keys = indexed_candidates["candidate_keys"]
    client_by_id = {client.client_id: client for client in mandatory_clients}
    slot_by_id = {slot.slot_id: slot for slot in slots}
    stage_entries.append(_build_perf_entry("python_solver_prepare_indices", prepare_started_at))

    model = cp_model.CpModel()
    builder = CoverageModelBuilder(model=model)

    user_min_target = max(0, _safe_int(payload.get("user_min_visits_per_slot"), 0))
    user_max_target = max(0, _safe_int(payload.get("user_max_visits_per_slot"), 0))
    collection_target_context = resolve_collection_target_context(payload)
    requested_target_collection_decimal = (
        _to_stable_money_decimal(collection_target_context.get("requested_target_collection_amount"))
        if isinstance(collection_target_context, dict) and collection_target_context.get("mode") == "target_collection"
        else None
    )
    target_collection_mode = bool(
        not is_sales_coverage_mode(payload) and
        requested_target_collection_decimal is not None and
        requested_target_collection_decimal > Decimal("0.00")
    )
    requested_target_collection_cents = (
        int(requested_target_collection_decimal * 100)
        if requested_target_collection_decimal is not None
        else 0
    )
    planning_start = parse_iso_date(payload.get("planning_start_date"))
    recovery_client_order = sorted(
        mandatory_clients,
        key=lambda client: (
            -resolve_client_recovery_urgency_value(client),
            -resolve_client_recovery_priority_value(client),
            -resolve_client_expected_collection_value(client),
            0 if client.is_critical else 1,
            -resolve_client_coverage_urgency_component(client, payload.get("planning_start_date")),
            len(candidate_indexes_by_client.get(client.client_id, [])),
            parse_iso_date(client.next_visit_deadline).toordinal() if parse_iso_date(client.next_visit_deadline) else 999999999,
            0 if client.historical_commercial_code else 1,
            client.client_id,
        ),
    )

    variables_started_at = time.perf_counter()
    x_vars_by_index: list[Any] = []
    x_var_by_key: dict[tuple[str, str], Any] = {}
    for index, assignment in enumerate(unique_assignments):
        key = candidate_keys[index]
        variable = model.NewBoolVar(f"x_{key[0]}_{assignment['slot_index']}")
        x_vars_by_index.append(variable)
        x_var_by_key[key] = variable
        builder.register_bool_var(("x", key[0], key[1]), variable)

    unassigned_vars: dict[str, Any] = {}
    assigned_vars: dict[str, Any] = {}
    client_collection_cents: dict[str, int] = {}
    for client in mandatory_clients:
        variable = model.NewBoolVar(f"unassigned_{client.client_id}")
        unassigned_vars[client.client_id] = variable
        builder.register_bool_var(("unassigned", client.client_id), variable)
        client_collection_cents[client.client_id] = int(
            _resolve_candidate_recovery_expected_collection_decimal(client) * 100
        )
        if target_collection_mode:
            assigned_var = model.NewBoolVar(f"assigned_{client.client_id}")
            assigned_vars[client.client_id] = assigned_var
            builder.register_bool_var(("assigned", client.client_id), assigned_var)

    slot_shortfall_vars: dict[str, Any] = {}
    slot_target_under_vars: dict[str, Any] = {}
    slot_target_over_vars: dict[str, Any] = {}
    slot_overload_vars: dict[str, Any] = {}
    slot_user_under_vars: dict[str, Any] = {}
    slot_user_over_vars: dict[str, Any] = {}
    slot_load_vars: dict[str, Any] = {}
    slot_load_units_vars: dict[str, Any] = {}
    slot_route_minutes_vars: dict[str, Any] = {}
    slot_ca_vars: dict[str, Any] = {}
    target_collection_effective_var = None
    target_collection_assigned_var = None
    target_collection_gap_vars: dict[tuple[str, str], Any] = {}

    if target_collection_mode:
        available_collection_cents = sum(
            max(0, int(client_collection_cents.get(client.client_id) or 0))
            for client in mandatory_clients
        )
        target_collection_assigned_var = model.NewIntVar(
            0,
            max(0, available_collection_cents),
            "assigned_collection_cents",
        )
        builder.register_int_var(
            ("assigned_collection", "all"),
            0,
            max(0, available_collection_cents),
            target_collection_assigned_var,
        )
        target_collection_effective_var = model.NewIntVar(
            0,
            max(0, min(requested_target_collection_cents, available_collection_cents)),
            "effective_collection_cents",
        )
        builder.register_int_var(
            ("effective_collection", "all"),
            0,
            max(0, min(requested_target_collection_cents, available_collection_cents)),
            target_collection_effective_var,
        )
        for previous_client, next_client in zip(recovery_client_order, recovery_client_order[1:]):
            gap_key = (previous_client.client_id, next_client.client_id)
            gap_var = model.NewBoolVar(f"target_gap_{previous_client.client_id}_{next_client.client_id}")
            target_collection_gap_vars[gap_key] = gap_var
            builder.register_bool_var(("target_gap", previous_client.client_id, next_client.client_id), gap_var)

    for slot in slots:
        slot_min_visits = resolve_slot_min_visits(slot, payload)
        load_var = model.NewIntVar(slot_min_visits, slot.max_visits, f"load_{slot.slot_id}")
        slot_load_vars[slot.slot_id] = load_var
        builder.register_int_var(("load", slot.slot_id), slot_min_visits, slot.max_visits, load_var)

        slot_target = max(0, _safe_int(slot_targets.get(slot.slot_id), 0))
        target_under_var = model.NewIntVar(0, max(slot_target, 0), f"target_under_{slot.slot_id}")
        target_over_var = model.NewIntVar(0, max(slot.max_visits, slot_target), f"target_over_{slot.slot_id}")
        slot_target_under_vars[slot.slot_id] = target_under_var
        slot_target_over_vars[slot.slot_id] = target_over_var
        builder.register_int_var(("target_under", slot.slot_id), 0, max(slot_target, 0), target_under_var)
        builder.register_int_var(("target_over", slot.slot_id), 0, max(slot.max_visits, slot_target), target_over_var)

        slot_soft_capacity = max(1, _safe_int(slot_soft_capacities.get(slot.slot_id), 0) or resolve_slot_soft_capacity(slot))
        overload_var = model.NewIntVar(0, max(0, slot.max_visits - slot_soft_capacity), f"overload_{slot.slot_id}")
        slot_overload_vars[slot.slot_id] = overload_var
        builder.register_int_var(("overload", slot.slot_id), 0, max(0, slot.max_visits - slot_soft_capacity), overload_var)

        if user_min_target > 0:
            user_under_var = model.NewIntVar(0, max(user_min_target, 0), f"user_under_{slot.slot_id}")
            slot_user_under_vars[slot.slot_id] = user_under_var
            builder.register_int_var(("user_under", slot.slot_id), 0, max(user_min_target, 0), user_under_var)

        if user_max_target > 0:
            user_over_var = model.NewIntVar(0, max(user_max_target, slot.max_visits), f"user_over_{slot.slot_id}")
            slot_user_over_vars[slot.slot_id] = user_over_var
            builder.register_int_var(("user_over", slot.slot_id), 0, max(user_max_target, slot.max_visits), user_over_var)

        if slot.max_load_units is not None and slot.max_load_units > 0:
            load_units_limit = int(round(slot.max_load_units * 100))
            load_units_var = model.NewIntVar(0, max(0, load_units_limit), f"load_units_{slot.slot_id}")
            slot_load_units_vars[slot.slot_id] = load_units_var
            builder.register_int_var(("load_units", slot.slot_id), 0, max(0, load_units_limit), load_units_var)

        if slot.time_capacity_known and slot.max_route_minutes is not None and slot.max_route_minutes > 0:
            route_minutes_limit = int(round(slot.max_route_minutes * 100))
            route_minutes_var = model.NewIntVar(0, max(0, route_minutes_limit), f"route_minutes_{slot.slot_id}")
            slot_route_minutes_vars[slot.slot_id] = route_minutes_var
            builder.register_int_var(("route_minutes", slot.slot_id), 0, max(0, route_minutes_limit), route_minutes_var)

        max_ca_limit = max(
            0,
            sum(int(unique_assignments[candidate_index]["predicted_ca_cents"] or 0) for candidate_index in candidate_indexes_by_slot.get(slot.slot_id, []))
        )
        ca_var = model.NewIntVar(0, max(0, max_ca_limit), f"ca_{slot.slot_id}")
        slot_ca_vars[slot.slot_id] = ca_var
        builder.register_int_var(("ca", slot.slot_id), 0, max(0, max_ca_limit), ca_var)

        min_ca_cents = int(round(slot.min_ca * 100))
        if payload["strict_ca"]:
            slot_shortfall_vars[slot.slot_id] = None
        else:
            shortfall_var = model.NewIntVar(0, max(min_ca_cents, 0), f"ca_shortfall_{slot.slot_id}")
            slot_shortfall_vars[slot.slot_id] = shortfall_var
            builder.register_int_var(("ca_shortfall", slot.slot_id), 0, max(min_ca_cents, 0), shortfall_var)

    commercial_load_vars: dict[str, Any] = {}
    commercial_ratio_scaled_vars: dict[str, Any] = {}
    commercial_ratio_gap_vars: dict[str, Any] = {}
    commercial_target_over_scaled_vars: dict[str, Any] = {}
    commercial_soft_over_scaled_vars: dict[str, Any] = {}
    max_commercial_ratio_scaled_bound = 0

    slot_ids_by_commercial: dict[str, list[str]] = defaultdict(list)
    for slot in slots:
        slot_ids_by_commercial[slot.commercial_code].append(slot.slot_id)

    for commercial_code, commercial_slot_ids in slot_ids_by_commercial.items():
        commercial_max_load = sum(max(0, _safe_int(slot_by_id[slot_id].max_visits, 0)) for slot_id in commercial_slot_ids)
        commercial_load_var = model.NewIntVar(0, max(0, commercial_max_load), f"commercial_load_{commercial_code}")
        commercial_load_vars[commercial_code] = commercial_load_var
        builder.register_int_var(("commercial_load", commercial_code), 0, max(0, commercial_max_load), commercial_load_var)

        soft_total = max(1, _safe_int(commercial_soft_capacity_totals.get(commercial_code), 0))
        target_total = max(0, _safe_int(commercial_target_totals.get(commercial_code), 0))
        ratio_bound = max(0, math.ceil((commercial_max_load * RATIO_SCALE) / max(1, soft_total)))
        max_commercial_ratio_scaled_bound = max(max_commercial_ratio_scaled_bound, ratio_bound)

        ratio_var = model.NewIntVar(0, max(0, ratio_bound), f"commercial_ratio_{commercial_code}")
        commercial_ratio_scaled_vars[commercial_code] = ratio_var
        builder.register_int_var(("commercial_ratio", commercial_code), 0, max(0, ratio_bound), ratio_var)

        ratio_gap_var = model.NewIntVar(0, max(0, ratio_bound + global_ratio_target_scaled), f"commercial_ratio_gap_{commercial_code}")
        commercial_ratio_gap_vars[commercial_code] = ratio_gap_var
        builder.register_int_var(("commercial_ratio_gap", commercial_code), 0, max(0, ratio_bound + global_ratio_target_scaled), ratio_gap_var)

        target_over_scaled_var = model.NewIntVar(0, max(0, ratio_bound), f"commercial_target_over_{commercial_code}")
        commercial_target_over_scaled_vars[commercial_code] = target_over_scaled_var
        builder.register_int_var(("commercial_target_over", commercial_code), 0, max(0, ratio_bound), target_over_scaled_var)

        soft_over_scaled_var = model.NewIntVar(0, max(0, ratio_bound), f"commercial_soft_over_{commercial_code}")
        commercial_soft_over_scaled_vars[commercial_code] = soft_over_scaled_var
        builder.register_int_var(("commercial_soft_over", commercial_code), 0, max(0, ratio_bound), soft_over_scaled_var)

    max_commercial_ratio_var = model.NewIntVar(0, max(0, max_commercial_ratio_scaled_bound), "max_commercial_ratio_scaled")
    builder.register_int_var(("max_commercial_ratio", "all"), 0, max(0, max_commercial_ratio_scaled_bound), max_commercial_ratio_var)
    stage_entries.append(_build_perf_entry("python_solver_build_variables", variables_started_at))

    constraints_started_at = time.perf_counter()
    for client in mandatory_clients:
        candidate_indexes = candidate_indexes_by_client.get(client.client_id, [])
        assignment_terms = [
            (("x", unique_assignments[candidate_index]["client_id"], unique_assignments[candidate_index]["slot_id"]), x_vars_by_index[candidate_index], 1)
            for candidate_index in candidate_indexes
        ]
        assignment_terms.append((("unassigned", client.client_id), unassigned_vars[client.client_id], 1))
        builder.add_linear_constraint(assignment_terms, "==", 1, "client_exactly_one")
        if target_collection_mode:
            builder.add_linear_constraint(
                [(("assigned", client.client_id), assigned_vars[client.client_id], 1)] + [
                    (("x", unique_assignments[candidate_index]["client_id"], unique_assignments[candidate_index]["slot_id"]), x_vars_by_index[candidate_index], -1)
                    for candidate_index in candidate_indexes
                ],
                "==",
                0,
                "client_assigned_balance",
            )

    for slot in slots:
        slot_candidate_indexes = candidate_indexes_by_slot.get(slot.slot_id, [])
        slot_candidate_terms = [
            (("x", unique_assignments[candidate_index]["client_id"], unique_assignments[candidate_index]["slot_id"]), x_vars_by_index[candidate_index], -1)
            for candidate_index in slot_candidate_indexes
        ]

        load_var = slot_load_vars[slot.slot_id]
        builder.add_linear_constraint(
            [(("load", slot.slot_id), load_var, 1), *slot_candidate_terms],
            "==",
            0,
            "slot_load_balance"
        )
        builder.add_linear_constraint(
            [(("load", slot.slot_id), load_var, 1)],
            "<=",
            int(slot.max_visits),
            "slot_load_capacity"
        )

        if slot.slot_id in slot_load_units_vars:
            load_units_limit = int(round((slot.max_load_units or 0.0) * 100))
            load_units_var = slot_load_units_vars[slot.slot_id]
            builder.add_linear_constraint(
                [(("load_units", slot.slot_id), load_units_var, 1)] + [
                    (("x", unique_assignments[candidate_index]["client_id"], unique_assignments[candidate_index]["slot_id"]), x_vars_by_index[candidate_index], -int(unique_assignments[candidate_index]["predicted_load_units_centi"] or 0))
                    for candidate_index in slot_candidate_indexes
                ],
                "==",
                0,
                "slot_load_units_balance"
            )
            builder.add_linear_constraint(
                [(("load_units", slot.slot_id), load_units_var, 1)],
                "<=",
                load_units_limit,
                "slot_load_units_capacity"
            )

        if slot.slot_id in slot_route_minutes_vars:
            route_minutes_limit = int(round((slot.max_route_minutes or 0.0) * 100))
            route_minutes_var = slot_route_minutes_vars[slot.slot_id]
            builder.add_linear_constraint(
                [(("route_minutes", slot.slot_id), route_minutes_var, 1)] + [
                    (("x", unique_assignments[candidate_index]["client_id"], unique_assignments[candidate_index]["slot_id"]), x_vars_by_index[candidate_index], -int(unique_assignments[candidate_index]["predicted_stop_minutes_centi"] or 0))
                    for candidate_index in slot_candidate_indexes
                ],
                "==",
                0,
                "slot_route_minutes_balance"
            )
            builder.add_linear_constraint(
                [(("route_minutes", slot.slot_id), route_minutes_var, 1)],
                "<=",
                route_minutes_limit,
                "slot_route_minutes_capacity"
            )

        ca_var = slot_ca_vars[slot.slot_id]
        builder.add_linear_constraint(
            [(("ca", slot.slot_id), ca_var, 1)] + [
                (("x", unique_assignments[candidate_index]["client_id"], unique_assignments[candidate_index]["slot_id"]), x_vars_by_index[candidate_index], -int(unique_assignments[candidate_index]["predicted_ca_cents"] or 0))
                for candidate_index in slot_candidate_indexes
            ],
            "==",
            0,
            "slot_ca_balance"
        )

        min_ca_cents = int(round(slot.min_ca * 100))
        if payload["strict_ca"]:
            builder.add_linear_constraint(
                [(("ca", slot.slot_id), ca_var, 1)],
                ">=",
                min_ca_cents,
                "slot_ca_minimum"
            )
        else:
            shortfall_var = slot_shortfall_vars[slot.slot_id]
            builder.add_linear_constraint(
                [(("ca_shortfall", slot.slot_id), shortfall_var, 1), (("ca", slot.slot_id), ca_var, 1)],
                ">=",
                min_ca_cents,
                "slot_ca_shortfall_floor"
            )
            builder.add_linear_constraint(
                [(("ca_shortfall", slot.slot_id), shortfall_var, 1)],
                ">=",
                0,
                "slot_ca_shortfall_non_negative"
            )

        slot_target = max(0, _safe_int(slot_targets.get(slot.slot_id), 0))
        slot_soft_capacity = max(1, _safe_int(slot_soft_capacities.get(slot.slot_id), 0) or resolve_slot_soft_capacity(slot))
        builder.add_linear_constraint(
            [(("target_under", slot.slot_id), slot_target_under_vars[slot.slot_id], 1), (("load", slot.slot_id), load_var, 1)],
            ">=",
            slot_target,
            "slot_target_under"
        )
        builder.add_linear_constraint(
            [(("target_over", slot.slot_id), slot_target_over_vars[slot.slot_id], 1), (("load", slot.slot_id), load_var, -1)],
            ">=",
            -slot_target,
            "slot_target_over"
        )
        builder.add_linear_constraint(
            [(("overload", slot.slot_id), slot_overload_vars[slot.slot_id], 1), (("load", slot.slot_id), load_var, -1)],
            ">=",
            -slot_soft_capacity,
            "slot_soft_overload"
        )

        if slot.slot_id in slot_user_under_vars:
            builder.add_linear_constraint(
                [(("user_under", slot.slot_id), slot_user_under_vars[slot.slot_id], 1), (("load", slot.slot_id), load_var, 1)],
                ">=",
                user_min_target,
                "slot_user_under"
            )
        if slot.slot_id in slot_user_over_vars:
            builder.add_linear_constraint(
                [(("user_over", slot.slot_id), slot_user_over_vars[slot.slot_id], 1), (("load", slot.slot_id), load_var, -1)],
                ">=",
                -user_max_target,
                "slot_user_over"
            )

    for commercial_code, commercial_load_var in commercial_load_vars.items():
        commercial_slot_ids = slot_ids_by_commercial.get(commercial_code, [])
        soft_total = max(1, _safe_int(commercial_soft_capacity_totals.get(commercial_code), 0))
        target_total = max(0, _safe_int(commercial_target_totals.get(commercial_code), 0))
        ratio_var = commercial_ratio_scaled_vars[commercial_code]
        ratio_gap_var = commercial_ratio_gap_vars[commercial_code]
        target_over_scaled_var = commercial_target_over_scaled_vars[commercial_code]
        soft_over_scaled_var = commercial_soft_over_scaled_vars[commercial_code]

        builder.add_linear_constraint(
            [(("commercial_load", commercial_code), commercial_load_var, 1)] + [
                (("load", slot_id), slot_load_vars[slot_id], -1)
                for slot_id in commercial_slot_ids
            ],
            "==",
            0,
            "commercial_load_balance"
        )
        builder.add_linear_constraint(
            [(("commercial_ratio", commercial_code), ratio_var, soft_total), (("commercial_load", commercial_code), commercial_load_var, -RATIO_SCALE)],
            ">=",
            0,
            "commercial_ratio_floor"
        )
        builder.add_linear_constraint(
            [(("commercial_ratio_gap", commercial_code), ratio_gap_var, 1), (("commercial_ratio", commercial_code), ratio_var, -1)],
            ">=",
            -global_ratio_target_scaled,
            "commercial_ratio_gap_upper"
        )
        builder.add_linear_constraint(
            [(("commercial_ratio_gap", commercial_code), ratio_gap_var, 1), (("commercial_ratio", commercial_code), ratio_var, 1)],
            ">=",
            global_ratio_target_scaled,
            "commercial_ratio_gap_lower"
        )
        builder.add_linear_constraint(
            [(("commercial_target_over", commercial_code), target_over_scaled_var, soft_total), (("commercial_load", commercial_code), commercial_load_var, -RATIO_SCALE)],
            ">=",
            -(target_total * RATIO_SCALE),
            "commercial_target_over"
        )
        builder.add_linear_constraint(
            [(("commercial_soft_over", commercial_code), soft_over_scaled_var, soft_total), (("commercial_load", commercial_code), commercial_load_var, -RATIO_SCALE)],
            ">=",
            -(soft_total * RATIO_SCALE),
            "commercial_soft_over"
        )

    builder.add_max_equality(
        ("max_commercial_ratio", "all"),
        max_commercial_ratio_var,
        [
            (("commercial_ratio", commercial_code), commercial_ratio_scaled_vars[commercial_code])
            for commercial_code in sorted(commercial_ratio_scaled_vars.keys())
        ],
        "max_commercial_ratio"
    )
    if target_collection_mode and target_collection_assigned_var is not None and target_collection_effective_var is not None:
        builder.add_linear_constraint(
            [(("assigned_collection", "all"), target_collection_assigned_var, 1)] + [
                (("assigned", client.client_id), assigned_vars[client.client_id], -int(client_collection_cents.get(client.client_id) or 0))
                for client in mandatory_clients
                if int(client_collection_cents.get(client.client_id) or 0) > 0
            ],
            "==",
            0,
            "target_collection_assigned_balance",
        )
        builder.add_linear_constraint(
            [
                (("effective_collection", "all"), target_collection_effective_var, 1),
                (("assigned_collection", "all"), target_collection_assigned_var, -1),
            ],
            "<=",
            0,
            "target_collection_effective_cap",
        )
        for previous_client, next_client in zip(recovery_client_order, recovery_client_order[1:]):
            builder.add_linear_constraint(
                [
                    (("target_gap", previous_client.client_id, next_client.client_id), target_collection_gap_vars[(previous_client.client_id, next_client.client_id)], 1),
                    (("assigned", next_client.client_id), assigned_vars[next_client.client_id], -1),
                    (("unassigned", previous_client.client_id), unassigned_vars[previous_client.client_id], -1),
                ],
                ">=",
                -1,
                "target_collection_priority_gap",
            )
    stage_entries.append(_build_perf_entry("python_solver_build_constraints", constraints_started_at))

    objective_started_at = time.perf_counter()
    coverage_weight = 1_000_000_000_000
    max_ratio_weight = 1_000_000
    commercial_ratio_gap_weight = 100_000
    commercial_soft_over_weight = 75_000
    commercial_target_over_weight = 25_000
    recovery_mode = not is_sales_coverage_mode(payload)
    coverage_timing_weight = 1 if recovery_mode else 100
    recovery_urgency_timing_weight = 100 if recovery_mode else 0
    recovery_timing_weight = 10 if recovery_mode else 0
    expected_collection_timing_weight = 1 if recovery_mode else 0
    purchase_score_timing_weight = 1 if not recovery_mode else 0
    purchase_timing_urgency_weight = 1 if not recovery_mode else 0
    expected_order_timing_weight = 1 if not recovery_mode else 0
    reassignment_weight = 10_000
    geography_weight = 10
    overload_weight = 500
    target_weight = 100
    user_target_weight = 50
    shortfall_weight = 10

    for client in mandatory_clients:
        priority_multiplier = 2 if client.is_critical else 1
        coverage_urgency_weight = int(round(resolve_client_coverage_urgency_component(client, payload.get("planning_start_date")) * 100))
        recovery_urgency_weight = 0 if not recovery_mode else int(round(resolve_client_recovery_urgency_value(client) * 100))
        recovery_priority_weight = 0 if not recovery_mode else int(round(resolve_client_recovery_priority_value(client) * 100))
        expected_collection_weight = 0 if not recovery_mode else int(round(min(resolve_client_expected_collection_value(client), 1_000_000.0) * 10))
        purchase_prediction_weight = int(round(resolve_client_purchase_prediction_score_value(client) * 100)) if not recovery_mode else 0
        expected_order_weight = int(round(min(resolve_client_expected_order_value(client), 1_000_000.0) * 10)) if not recovery_mode else 0
        predicted_ca_weight = int(round(resolve_client_predicted_ca_value(client) * 100)) if not recovery_mode else 0
        if recovery_mode:
            total_coefficient = (
                (coverage_weight * priority_multiplier) +
                (recovery_urgency_weight * 1_000_000) +
                (recovery_priority_weight * 10_000) +
                (expected_collection_weight * 10) +
                coverage_urgency_weight
            )
        else:
            total_coefficient = (
                (coverage_weight * priority_multiplier) +
                (coverage_urgency_weight * 1_000_000) +
                (purchase_prediction_weight * 1_000) +
                expected_order_weight +
                predicted_ca_weight
            )
        if not target_collection_mode:
            builder.add_objective_term(("unassigned", client.client_id), unassigned_vars[client.client_id], total_coefficient)
        elif client.client_id in assigned_vars:
            builder.add_objective_term(("assigned", client.client_id), assigned_vars[client.client_id], 1)

    if not target_collection_mode:
        builder.add_objective_term(("max_commercial_ratio", "all"), max_commercial_ratio_var, max_ratio_weight)
        for commercial_code in commercial_ratio_gap_vars:
            builder.add_objective_term(("commercial_ratio_gap", commercial_code), commercial_ratio_gap_vars[commercial_code], commercial_ratio_gap_weight)
            builder.add_objective_term(("commercial_soft_over", commercial_code), commercial_soft_over_scaled_vars[commercial_code], commercial_soft_over_weight)
            builder.add_objective_term(("commercial_target_over", commercial_code), commercial_target_over_scaled_vars[commercial_code], commercial_target_over_weight)

        for slot in slots:
            if slot_shortfall_vars[slot.slot_id] is not None:
                builder.add_objective_term(("ca_shortfall", slot.slot_id), slot_shortfall_vars[slot.slot_id], shortfall_weight)
            builder.add_objective_term(("overload", slot.slot_id), slot_overload_vars[slot.slot_id], overload_weight)
            builder.add_objective_term(("target_under", slot.slot_id), slot_target_under_vars[slot.slot_id], target_weight)
            builder.add_objective_term(("target_over", slot.slot_id), slot_target_over_vars[slot.slot_id], target_weight)
            if slot.slot_id in slot_user_under_vars:
                builder.add_objective_term(("user_under", slot.slot_id), slot_user_under_vars[slot.slot_id], user_target_weight)
            if slot.slot_id in slot_user_over_vars:
                builder.add_objective_term(("user_over", slot.slot_id), slot_user_over_vars[slot.slot_id], user_target_weight)
    else:
        for previous_client, next_client in zip(recovery_client_order, recovery_client_order[1:]):
            builder.add_objective_term(
                ("target_gap", previous_client.client_id, next_client.client_id),
                target_collection_gap_vars[(previous_client.client_id, next_client.client_id)],
                10,
            )

    for index, assignment in enumerate(unique_assignments):
        key = candidate_keys[index]
        variable = x_vars_by_index[index]
        if target_collection_mode:
            continue
        total_coefficient = 0
        if int(assignment.get("recovery_urgency_date_penalty") or 0) > 0:
            total_coefficient += int(assignment["recovery_urgency_date_penalty"]) * recovery_urgency_timing_weight
        if int(assignment.get("coverage_date_penalty") or 0) > 0:
            total_coefficient += int(assignment["coverage_date_penalty"]) * coverage_timing_weight
        if int(assignment.get("recovery_date_penalty") or 0) > 0:
            total_coefficient += int(assignment["recovery_date_penalty"]) * recovery_timing_weight
        if int(assignment.get("expected_collection_date_penalty") or 0) > 0:
            total_coefficient += int(assignment["expected_collection_date_penalty"]) * expected_collection_timing_weight
        if int(assignment.get("purchase_score_date_penalty") or 0) > 0:
            total_coefficient += int(assignment["purchase_score_date_penalty"]) * purchase_score_timing_weight
        if int(assignment.get("purchase_timing_date_penalty") or 0) > 0:
            total_coefficient += int(assignment["purchase_timing_date_penalty"]) * purchase_timing_urgency_weight
        if int(assignment.get("expected_order_date_penalty") or 0) > 0:
            total_coefficient += int(assignment["expected_order_date_penalty"]) * expected_order_timing_weight
        if int(assignment.get("reassignment_penalty") or 0) > 0:
            total_coefficient += int(assignment["reassignment_penalty"]) * reassignment_weight
        if int(assignment.get("distance_penalty") or 0) > 0:
            total_coefficient += int(assignment["distance_penalty"]) * geography_weight
        builder.add_objective_term(("x", key[0], key[1]), variable, total_coefficient)

    objective_terms = builder.build_objective_terms()
    if not target_collection_mode:
        model.Minimize(sum(objective_terms))
    stage_entries.append(_build_perf_entry("python_solver_build_objective", objective_started_at))

    solver_parameters = {
        "max_time_in_seconds": max(5.0, min(90.0, _safe_float(raw_payload.get("max_solver_seconds"), 30.0))),
        "num_search_workers": max(1, min(8, 4)),
        "random_seed": None,
        "relative_gap_limit": None,
        "absolute_gap_limit": None,
        "search_branching": None,
        "cp_model_presolve": None,
        "linearization_level": None,
        "log_search_progress": False,
    }

    proto = model.Proto()
    constraint_categories = {
        str(key): int(value)
        for key, value in sorted(builder.constraint_category_counts.items(), key=lambda item: str(item[0]))
    }
    logical_model_payload = {
        "clients": sorted(client.client_id for client in mandatory_clients),
        "slots": sorted(slot.slot_id for slot in slots),
        "candidate_pairs": sorted(
            (
                {
                    "client_id": assignment["client_id"],
                    "slot_id": assignment["slot_id"],
                    "slot_index": int(assignment["slot_index"] or 0),
                    "predicted_ca_cents": int(assignment["predicted_ca_cents"] or 0),
                    "predicted_load_units_centi": int(assignment["predicted_load_units_centi"] or 0),
                    "predicted_stop_minutes_centi": int(assignment["predicted_stop_minutes_centi"] or 0),
                    "distance_penalty": int(assignment["distance_penalty"] or 0),
                    "coverage_date_penalty": int(assignment["coverage_date_penalty"] or 0),
                    "recovery_date_penalty": int(assignment["recovery_date_penalty"] or 0),
                    "expected_collection_date_penalty": int(assignment["expected_collection_date_penalty"] or 0),
                    "purchase_score_date_penalty": int(assignment["purchase_score_date_penalty"] or 0),
                    "purchase_timing_date_penalty": int(assignment["purchase_timing_date_penalty"] or 0),
                    "expected_order_date_penalty": int(assignment["expected_order_date_penalty"] or 0),
                    "reassignment_penalty": int(assignment["reassignment_penalty"] or 0),
                }
                for assignment in unique_assignments
            ),
            key=lambda item: (item["client_id"], item["slot_id"])
        ),
        "variables": [
            {
                "key": list(key),
                "kind": value["kind"],
                "domain": value["domain"],
            }
            for key, value in sorted(builder.variable_specs.items(), key=lambda item: tuple(str(part) for part in item[0]))
        ],
        "constraints": sorted(
            [
                _to_stable_json_value(signature)
                for signature in builder.constraint_signatures
            ],
            key=lambda item: json.dumps(item, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
        ),
        "objective": [
            {
                "key": list(key),
                "coefficient": int(value[1])
            }
            for key, value in sorted(builder.objective_coefficients.items(), key=lambda item: tuple(str(part) for part in item[0]))
            if int(value[1] or 0) != 0
        ]
    }
    model_fingerprint = compute_coverage_model_fingerprint(logical_model_payload)

    model_stats = {
        "clients_count": len(mandatory_clients),
        "slots_count": len(slots),
        "candidate_pairs_count": len(unique_assignments),
        "removed_duplicate_candidate_pairs": int(indexed_candidates["removed_duplicate_candidate_pairs"] or 0),
        "bool_var_count": int(builder.bool_var_count),
        "int_var_count": int(builder.int_var_count),
        "constraints_count": int(sum(constraint_categories.values())),
        "constraints_by_category": constraint_categories,
        "objective_terms_count": len(objective_terms),
        "model_proto_bytes": len(proto.SerializeToString()),
        "model_fingerprint": model_fingerprint,
        "deduplicated_constraint_count": int(builder.deduplicated_constraint_count),
        "index_counts": {
            "candidate_indexes_by_client": len(candidate_indexes_by_client),
            "candidate_indexes_by_slot": len(candidate_indexes_by_slot),
            "candidate_by_client_slot": len(candidate_by_client_slot)
        }
    }
    if include_fingerprint_payload:
        model_stats["model_fingerprint_payload"] = logical_model_payload

    return CoverageCpSatArtifacts(
        model=model,
        assignments=unique_assignments,
        candidate_keys=candidate_keys,
        candidate_indexes_by_client=candidate_indexes_by_client,
        candidate_indexes_by_slot=candidate_indexes_by_slot,
        candidate_by_client_slot=candidate_by_client_slot,
        x_vars_by_index=x_vars_by_index,
        x_var_by_key=x_var_by_key,
        unassigned_vars=unassigned_vars,
        slot_shortfall_vars=slot_shortfall_vars,
        slot_load_vars=slot_load_vars,
        model_stats=model_stats,
        solver_parameters=solver_parameters,
        secondary_objective_terms=objective_terms,
        target_collection_effective_var=target_collection_effective_var,
    ), stage_entries


def solve_coverage_plan(raw_payload: dict[str, Any]) -> dict[str, Any]:
    total_started_at = time.perf_counter()
    performance_entries: list[dict[str, Any]] = []
    context: CoverageOptimizationContext | None = None
    python_total_recorded = False
    debug_path = {
        "solver_function": "not_started",
        "cp_sat_solve_reached": False,
        "cp_sat_candidate_threshold_reached": False,
    }
    solver_selection = {
        "selected_solver": "not_selected",
        "selection_reason": "not_reached",
        "clients_count": 0,
        "slots_count": 0,
        "candidate_pairs_count": 0,
        "planning_mode": resolve_payload_planning_mode(raw_payload),
        "sales_coverage_mode": is_sales_coverage_mode(raw_payload),
        "ortools_available": cp_model is not None,
        "simple_balanced_solver_eligible": False,
        "cp_sat_solve_reached": False,
        "cp_sat_status": None,
        "thresholds": {
            "cp_sat_candidate_pairs_max": GREEDY_CP_SAT_CANDIDATE_THRESHOLD,
            "payload_max_solver_seconds": max(5.0, min(90.0, _safe_float((raw_payload or {}).get("max_solver_seconds"), 30.0))),
        },
    }
    greedy_meta: dict[str, Any] | None = None
    greedy_trace: dict[str, Any] | None = None
    input_fingerprints: dict[str, Any] | None = None
    candidate_context: CandidatePlanningContext | None = None

    def append_python_total_once() -> None:
        nonlocal python_total_recorded
        if python_total_recorded:
            return
        performance_entries.append(_build_perf_entry("python_total", total_started_at))
        python_total_recorded = True

    if cp_model is None:
        solver_selection["selected_solver"] = "unavailable"
        solver_selection["selection_reason"] = "ortools_unavailable"
        append_python_total_once()
        return finalize_coverage_debug_result(
            {
                "status": "error",
                "message": "OR-Tools indisponible dans l'environnement Python."
            },
            performance_entries=performance_entries,
            debug_path=debug_path,
            solver_selection=solver_selection,
            perf_context=context,
        )

    normalization_started_at = time.perf_counter()
    payload = normalize_payload(raw_payload)
    performance_entries.append(_build_perf_entry("python_normalization", normalization_started_at))
    candidates_started_at = time.perf_counter()
    context = build_coverage_optimization_context(payload, payload_already_normalized=True)
    feasibility = compute_feasibility_from_context(context)
    slots: list[NormalizedSlot] = context.slots
    mandatory_clients: list[NormalizedClient] = context.mandatory_clients
    effective_constraints = context.effective_constraints
    feasible_slots_by_client = context.feasible_slots_by_client
    solver_selection["clients_count"] = len(mandatory_clients)
    solver_selection["slots_count"] = len(slots)
    solver_selection["planning_mode"] = resolve_payload_planning_mode(payload)
    solver_selection["sales_coverage_mode"] = is_sales_coverage_mode(payload)
    performance_entries.append(_build_perf_entry("python_candidates", candidates_started_at))
    analysis_started_at = time.perf_counter()
    analysis_summary = build_coverage_analysis_summary_from_context(context)
    performance_entries.append(_build_perf_entry("python_analysis_summary", analysis_started_at))
    functional_metadata = build_functional_metadata(
        collection_target_context=context.collection_target_context,
    )
    allow_partial_plan = bool(payload["allow_partial_plan"])
    target_collection_mode = bool(
        not is_sales_coverage_mode(payload) and
        isinstance(context.collection_target_context, dict) and
        context.collection_target_context.get("mode") == "target_collection"
    )
    user_min_target = max(0, _safe_int(payload.get("user_min_visits_per_slot"), 0))
    user_max_target = max(0, _safe_int(payload.get("user_max_visits_per_slot"), 0))
    solver_min_target = max(0, _safe_int(payload.get("effective_min_visits_per_slot"), 0))
    solver_max_target = max(0, _safe_int(payload.get("effective_max_visits_per_slot"), 0))
    slot_targets = context.slot_targets
    slot_soft_capacities = context.slot_soft_capacities
    distribution_context = build_capacity_distribution_context(slots, slot_targets, len(mandatory_clients))
    commercial_soft_capacity_totals = distribution_context["commercial_soft_capacity_totals"]
    commercial_target_totals = distribution_context["commercial_target_totals"]
    global_ratio_target_scaled = max(
        0,
        int(round(float(distribution_context.get("global_ratio_target", 1.0) or 1.0) * RATIO_SCALE))
    )

    if feasibility.get("status") != "feasible" and not allow_partial_plan and not target_collection_mode:
        serialize_started_at = time.perf_counter()
        result = {
            "status": "infeasible",
            "reason": feasibility.get("reason") or "coverage_infeasible",
            "commercial": feasibility.get("commercial"),
            "clients_required": feasibility.get("clients_required"),
            "capacity": feasibility.get("capacity"),
            "missing_capacity": feasibility.get("missing_capacity", len(mandatory_clients)),
            "summary": {
                "planning_start_date": payload["planning_start_date"],
                "planning_end_date": payload["planning_end_date"],
                "planning_horizon_days": int(payload["planning_horizon_days"]),
                "coverage_window_days": int(payload["coverage_window_days"]),
                "daily_max_mode": str(payload["daily_max_mode"]),
                "clients_to_cover": len(mandatory_clients),
                "unique_clients_covered": 0,
                "missing_clients_count": len(mandatory_clients),
                "duplicate_clients_count": 0,
                "total_visits": 0,
                "total_slots": len(slots),
                "used_slots": 0,
                "unused_slots": len(slots),
                "total_capacity": sum(slot.max_visits for slot in slots),
                "required_average_per_slot": feasibility["required_average_per_slot"],
                "required_minimum_max_per_slot": feasibility["required_minimum_max_per_slot"],
                "total_predicted_ca": 0.0,
                "predicted_ca_known_count": 0,
                "predicted_ca_unknown_count": 0,
                "predicted_ca_is_complete": True,
                "total_ca_shortfall": 0.0,
                "solver_status": "INFEASIBLE",
                "coverage_rate": 0.0,
                "average_clients_per_route": 0.0,
                "routes_count": 0,
                "active_clients": len(mandatory_clients),
                "unique_clients_planned": 0,
                "missing_clients": len(mandatory_clients),
                "duplicate_clients": 0,
                "predicted_ca": 0.0,
                "total_estimated_km": 0.0,
                "coverage_guarantee_status": "single_visit_only"
            },
            "blocks": [],
            "analysis": analysis_summary,
            "recovery_summary": build_recovery_summary(mandatory_clients, set()),
            "purchase_prediction_summary": build_purchase_prediction_summary(mandatory_clients, set()),
            "diagnostics": {
                "capacity_issues": [],
                "commercial_capacity_issues": [],
                "deadline_issues": feasibility.get("details") if feasibility.get("reason") == "deadline_or_commercial_unreachable" else [],
                "ca_issues": [],
                "truck_capacity_issues": [],
                "reassignment_issues": [],
                "invalid_gps_clients": sorted(
                    client.client_code for client in payload["clients"] if client.invalid_gps
                ),
                "input_duplicate_client_ids": sorted(payload["input_duplicate_client_ids"]),
                "input_duplicate_clients_removed": sorted(payload["input_duplicate_client_codes"])
            },
            "effective_constraints": effective_constraints
        }
        if functional_metadata is not None:
            result["functional_metadata"] = functional_metadata
        performance_entries.append(_build_perf_entry("python_serialize_response", serialize_started_at))
        append_python_total_once()
        return finalize_coverage_debug_result(
            result,
            performance_entries=performance_entries,
            debug_path=debug_path,
            solver_selection=solver_selection,
            perf_context=context,
        )

    if not slots:
        serialize_started_at = time.perf_counter()
        result = {
            "status": "partial_success" if allow_partial_plan else "infeasible",
            "reason": feasibility.get("reason") or "no_available_slots",
            "user_message": (
                "La couverture complete est impossible avec les capacites physiques disponibles. La meilleure repartition possible a ete generee."
                if allow_partial_plan
                else "Aucun slot disponible sur la periode demandee."
            ),
            "summary": {
                "planning_start_date": payload["planning_start_date"],
                "planning_end_date": payload["planning_end_date"],
                "planning_horizon_days": int(payload["planning_horizon_days"]),
                "coverage_window_days": int(payload["coverage_window_days"]),
                "daily_max_mode": str(payload["daily_max_mode"]),
                "clients_to_cover": len(mandatory_clients),
                "unique_clients_covered": 0,
                "missing_clients_count": len(mandatory_clients),
                "duplicate_clients_count": 0,
                "total_visits": 0,
                "total_slots": 0,
                "used_slots": 0,
                "unused_slots": 0,
                "total_capacity": 0,
                "required_average_per_slot": feasibility["required_average_per_slot"],
                "required_minimum_max_per_slot": feasibility["required_minimum_max_per_slot"],
                "total_predicted_ca": 0.0,
                "predicted_ca_known_count": 0,
                "predicted_ca_unknown_count": 0,
                "predicted_ca_is_complete": True,
                "total_ca_shortfall": 0.0,
                "solver_status": "INFEASIBLE",
                "coverage_rate": 0.0,
                "average_clients_per_route": 0.0,
                "routes_count": 0,
                "active_clients": len(mandatory_clients),
                "unique_clients_planned": 0,
                "missing_clients": len(mandatory_clients),
                "duplicate_clients": 0,
                "predicted_ca": 0.0,
                "total_estimated_km": 0.0,
                "coverage_guarantee_status": "single_visit_only"
            },
            "blocks": [],
            "analysis": analysis_summary,
            "recovery_summary": build_recovery_summary(mandatory_clients, set()),
            "purchase_prediction_summary": build_purchase_prediction_summary(mandatory_clients, set()),
            "diagnostics": {
                "capacity_issues": [],
                "commercial_capacity_issues": [],
                "deadline_issues": feasibility.get("details") if feasibility.get("reason") == "deadline_or_commercial_unreachable" else [],
                "ca_issues": [],
                "truck_capacity_issues": [],
                "reassignment_issues": [],
                "invalid_gps_clients": sorted(
                    client.client_code for client in payload["clients"] if client.invalid_gps
                ),
                "input_duplicate_client_ids": sorted(payload["input_duplicate_client_ids"]),
                "input_duplicate_clients_removed": sorted(payload["input_duplicate_client_codes"])
            },
            "effective_constraints": effective_constraints
        }
        if functional_metadata is not None:
            result["functional_metadata"] = functional_metadata
        performance_entries.append(_build_perf_entry("python_serialize_response", serialize_started_at))
        append_python_total_once()
        return finalize_coverage_debug_result(
            result,
            performance_entries=performance_entries,
            debug_path=debug_path,
            solver_selection=solver_selection,
            perf_context=context,
        )

    for slot in slots:
        if slot.hard_capacity is not None:
            slot.max_visits = min(slot.max_visits, max(1, _safe_int(slot.hard_capacity, slot.max_visits)))

    blocks = []
    solver = None
    cp_sat_stats = None
    solver_started_at = time.perf_counter()
    solver_direct_entries: list[dict[str, Any]] = []

    def append_solver_direct_stage(stage: str, started_at: float) -> None:
        entry = _build_perf_entry(stage, started_at)
        solver_direct_entries.append(entry)
        performance_entries.append(entry)

    def append_solver_direct_stage_duration(stage: str, duration_ms: int) -> None:
        entry = {
            "stage": stage,
            "duration_ms": max(0, int(duration_ms))
        }
        solver_direct_entries.append(entry)
        performance_entries.append(entry)

    prepare_dispatch_started_at = time.perf_counter()
    if is_perf_debug_enabled():
        _increment_context_counter(context, "build_coverage_input_fingerprints_calls")
        _increment_context_counter(context, "debug_fingerprint_calls")
        debug_input_fingerprints_started_at = time.perf_counter()
        input_fingerprints = build_coverage_input_fingerprints(
            payload,
            slots,
            mandatory_clients,
            effective_constraints,
            assignments=None
        )
        performance_entries.append(_build_perf_entry("python_debug_input_fingerprints", debug_input_fingerprints_started_at))
    simple_balanced_eligible = can_use_simple_balanced_solver(payload, slots, mandatory_clients)
    solver_selection["simple_balanced_solver_eligible"] = bool(simple_balanced_eligible)
    append_solver_direct_stage("python_solver_prepare_dispatch", prepare_dispatch_started_at)
    if simple_balanced_eligible:
        debug_path["solver_function"] = "solve_simple_balanced_plan"
        solver_selection["selected_solver"] = "solve_simple_balanced_plan"
        solver_selection["selection_reason"] = "simple_balanced_solver_eligible"
        select_strategy_started_at = time.perf_counter()
        append_solver_direct_stage("python_solver_select_strategy", select_strategy_started_at)
        greedy_call_started_at = time.perf_counter()
        slot_assignments_by_code = solve_simple_balanced_plan(payload, slots, mandatory_clients)
        append_solver_direct_stage("python_solver_greedy_call", greedy_call_started_at)
        status = cp_model.OPTIMAL
        slot_shortfall_vars = {slot.slot_id: None for slot in slots}
        unassigned_clients = []
    else:
        candidate_context_started_at = time.perf_counter()
        candidate_context = build_candidate_planning_context(
            payload,
            slots,
            mandatory_clients,
            feasible_slots_by_client,
            context=context,
            performance_entries=performance_entries,
        )
        append_solver_direct_stage("python_candidate_context_build", candidate_context_started_at)
        assignment_records_started_at = time.perf_counter()
        assignments, assignment_index_by_key = build_assignment_candidates(
            payload,
            slots,
            mandatory_clients,
            feasible_slots_by_client,
            context=context
        )
        append_solver_direct_stage("python_solver_build_assignment_records", assignment_records_started_at)
        reuse_wrapper_started_at = time.perf_counter()
        append_solver_direct_stage("python_candidate_context_reuse_wrapper", reuse_wrapper_started_at)
        if len(feasible_slots_by_client) != len(mandatory_clients):
            raise RuntimeError("shared_context_client_slot_mismatch")
        solver_selection["candidate_pairs_count"] = len(assignments)
        if is_perf_debug_enabled():
            _increment_context_counter(context, "build_coverage_input_fingerprints_calls")
            _increment_context_counter(context, "debug_fingerprint_calls")
            debug_input_fingerprints_started_at = time.perf_counter()
            input_fingerprints = build_coverage_input_fingerprints(
                payload,
                slots,
                mandatory_clients,
                effective_constraints,
                assignments=assignments,
                candidate_context=candidate_context
            )
            performance_entries.append(_build_perf_entry("python_debug_input_fingerprints", debug_input_fingerprints_started_at))
        candidate_indexes_started_at = time.perf_counter()
        append_solver_direct_stage("python_solver_build_candidate_indexes", candidate_indexes_started_at)
        select_strategy_started_at = time.perf_counter()
        if len(assignments) > GREEDY_CP_SAT_CANDIDATE_THRESHOLD:
            debug_path["solver_function"] = "solve_greedy_capacity_plan"
            debug_path["cp_sat_candidate_threshold_reached"] = True
            solver_selection["selected_solver"] = "solve_greedy_capacity_plan"
            solver_selection["selection_reason"] = "candidate_pairs_threshold_exceeded"
            greedy_meta = {}
            greedy_trace = {}
            append_solver_direct_stage("python_solver_select_strategy", select_strategy_started_at)
            greedy_call_started_at = time.perf_counter()
            slot_assignments_by_code, unassigned_clients = solve_greedy_capacity_plan(
                payload,
                slots,
                mandatory_clients,
                feasible_slots_by_client,
                slot_targets=slot_targets,
                context=context,
                assignment_candidates=assignments,
                assignment_index_by_key=assignment_index_by_key,
                candidate_planning_context=candidate_context,
                performance_entries=performance_entries,
                greedy_meta_sink=greedy_meta,
                greedy_trace_sink=greedy_trace
            )
            append_solver_direct_stage("python_solver_greedy_call", greedy_call_started_at)
            status = cp_model.FEASIBLE
            slot_shortfall_vars = {slot.slot_id: None for slot in slots}
        else:
            debug_path["solver_function"] = "CpSolver.Solve"
            solver_selection["selected_solver"] = "CpSolver.Solve"
            solver_selection["selection_reason"] = "candidate_pairs_within_cp_sat_threshold"
            append_solver_direct_stage("python_solver_select_strategy", select_strategy_started_at)
            cp_sat_artifacts, solver_build_entries = build_coverage_cp_sat_model_artifacts(
                raw_payload=raw_payload,
                payload=payload,
                slots=slots,
                mandatory_clients=mandatory_clients,
                assignments=assignments,
                slot_targets=slot_targets,
                slot_soft_capacities=slot_soft_capacities,
                commercial_soft_capacity_totals=commercial_soft_capacity_totals,
                commercial_target_totals=commercial_target_totals,
                global_ratio_target_scaled=global_ratio_target_scaled,
                include_fingerprint_payload=False,
                candidate_planning_context=candidate_context
            )
            performance_entries.extend(solver_build_entries)
            slot_shortfall_vars = cp_sat_artifacts.slot_shortfall_vars

            solver = cp_model.CpSolver()
            solver.parameters.max_time_in_seconds = cp_sat_artifacts.solver_parameters["max_time_in_seconds"]
            solver.parameters.num_search_workers = cp_sat_artifacts.solver_parameters["num_search_workers"]
            solver.parameters.log_search_progress = cp_sat_artifacts.solver_parameters["log_search_progress"]

            solve_started_at = time.perf_counter()
            debug_path["cp_sat_solve_reached"] = True
            solver_selection["cp_sat_solve_reached"] = True
            if (
                target_collection_mode and
                cp_sat_artifacts.target_collection_effective_var is not None
            ):
                cp_sat_artifacts.model.Maximize(cp_sat_artifacts.target_collection_effective_var)
                first_phase_status = solver.Solve(cp_sat_artifacts.model)
                if first_phase_status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
                    cp_sat_artifacts.model.Add(
                        cp_sat_artifacts.target_collection_effective_var ==
                        solver.Value(cp_sat_artifacts.target_collection_effective_var)
                    )
                    cp_sat_artifacts.model.Minimize(sum(cp_sat_artifacts.secondary_objective_terms or []))
                    status = solver.Solve(cp_sat_artifacts.model)
                else:
                    status = first_phase_status
            else:
                cp_sat_artifacts.model.Minimize(sum(cp_sat_artifacts.secondary_objective_terms or []))
                status = solver.Solve(cp_sat_artifacts.model)
            solver_selection["cp_sat_status"] = _status_name(status)
            performance_entries.append(_build_perf_entry("python_solver_cp_sat_solve", solve_started_at))

            repair_started_at = time.perf_counter()
            if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
                greedy_meta = {}
                greedy_trace = {}
                greedy_call_started_at = time.perf_counter()
                slot_assignments_by_code, unassigned_clients = solve_greedy_capacity_plan(
                    payload,
                    slots,
                    mandatory_clients,
                    feasible_slots_by_client,
                    slot_targets=slot_targets,
                    context=context,
                    assignment_candidates=assignments,
                    assignment_index_by_key=assignment_index_by_key,
                    candidate_planning_context=candidate_context,
                    performance_entries=performance_entries,
                    greedy_meta_sink=greedy_meta,
                    greedy_trace_sink=greedy_trace
                )
                append_solver_direct_stage("python_solver_greedy_call", greedy_call_started_at)
                solver_selection["selected_solver"] = "solve_greedy_capacity_plan"
                solver_selection["selection_reason"] = f"cp_sat_status_{_status_name(status).lower()}_fallback"
                status = cp_model.FEASIBLE
                slot_shortfall_vars = {slot.slot_id: None for slot in slots}
                performance_entries.append({
                    "stage": "python_solver_extract_solution",
                    "duration_ms": 0
                })
                performance_entries.append(_build_perf_entry("python_solver_repair", repair_started_at))
            else:
                performance_entries.append(_build_perf_entry("python_solver_repair", repair_started_at))
                extract_started_at = time.perf_counter()
                slot_assignments_by_code = defaultdict(list)
                unassigned_clients = []
                client_by_id = {client.client_id: client for client in mandatory_clients}

                for candidate_index, assignment in enumerate(cp_sat_artifacts.assignments):
                    if solver.Value(cp_sat_artifacts.x_vars_by_index[candidate_index]) != 1:
                        continue
                    slot_assignments_by_code[assignment["slot_id"]].append(client_by_id[assignment["client_id"]])

                for client in mandatory_clients:
                    if solver.Value(cp_sat_artifacts.unassigned_vars[client.client_id]) == 1:
                        unassigned_clients.append(client.client_id)
                performance_entries.append(_build_perf_entry("python_solver_extract_solution", extract_started_at))

            solver_response = solver.ResponseProto() if solver is not None else None
            cp_sat_stats = {
                **cp_sat_artifacts.model_stats,
                "status": _status_name(status),
                "wall_time": float(getattr(solver, "WallTime", lambda: 0.0)() or 0.0),
                "branches": int(getattr(solver, "NumBranches", lambda: 0)() or 0),
                "conflicts": int(getattr(solver, "NumConflicts", lambda: 0)() or 0),
                "objective_value": float(getattr(solver, "ObjectiveValue", lambda: 0.0)() or 0.0),
                "best_objective_bound": float(getattr(solver, "BestObjectiveBound", lambda: 0.0)() or 0.0),
                "gap": (
                    None
                    if float(getattr(solver, "ObjectiveValue", lambda: 0.0)() or 0.0) == 0.0
                    else abs(
                        float(getattr(solver, "ObjectiveValue", lambda: 0.0)() or 0.0) -
                        float(getattr(solver, "BestObjectiveBound", lambda: 0.0)() or 0.0)
                    ) / max(1.0, abs(float(getattr(solver, "ObjectiveValue", lambda: 0.0)() or 0.0)))
                ),
                "deterministic_time": (
                    float(getattr(solver_response, "deterministic_time", 0.0) or 0.0)
                    if solver_response is not None
                    else None
                ),
                "parameters": cp_sat_artifacts.solver_parameters
            }
            if is_perf_debug_enabled():
                print(
                    "[COVERAGE_CP_SAT] "
                    f"clients={cp_sat_stats['clients_count']} "
                    f"slots={cp_sat_stats['slots_count']} "
                    f"candidate_pairs={cp_sat_stats['candidate_pairs_count']} "
                    f"bool_vars={cp_sat_stats['bool_var_count']} "
                    f"int_vars={cp_sat_stats['int_var_count']} "
                    f"constraints={cp_sat_stats['constraints_count']} "
                    f"objective_terms={cp_sat_stats['objective_terms_count']} "
                    f"model_proto_bytes={cp_sat_stats['model_proto_bytes']} "
                    f"status={cp_sat_stats['status']} "
                    f"wall_time={round(cp_sat_stats['wall_time'], 6)} "
                    f"branches={cp_sat_stats['branches']} "
                    f"conflicts={cp_sat_stats['conflicts']} "
                    f"objective_value={round(cp_sat_stats['objective_value'], 6)} "
                    f"best_objective_bound={round(cp_sat_stats['best_objective_bound'], 6)} "
                    f"gap={None if cp_sat_stats['gap'] is None else round(cp_sat_stats['gap'], 8)} "
                    f"deterministic_time={cp_sat_stats['deterministic_time']}",
                    flush=True
                )
                print(
                    "[COVERAGE_CP_SAT_CONSTRAINTS] "
                    + " ".join(
                        f"{key}={value}"
                        for key, value in cp_sat_stats["constraints_by_category"].items()
                    ),
                    flush=True
                )
    total_predicted_ca_value = 0.0
    total_predicted_ca_known_count = 0
    total_predicted_ca_unknown_count = 0
    total_ca_shortfall_value = 0.0
    total_ca_shortfall_is_complete = True
    total_estimated_km = 0.0
    planned_client_ids: set[str] = set()
    postprocess_assignments_seconds = 0.0
    build_visit_order_seconds = 0.0
    for slot in slots:
        slot_postprocess_started_at = time.perf_counter()
        assigned_clients = slot_assignments_by_code.get(slot.slot_id, [])
        load = len(assigned_clients)
        historical_soft_capacity = max(1, _safe_int(slot_soft_capacities.get(slot.slot_id), 0) or resolve_slot_soft_capacity(slot))
        sales_activity_proxy_per_day = max(1, resolve_slot_sales_activity_proxy(slot))
        required_target_capacity = max(0, _safe_int(slot_targets.get(slot.slot_id), 0))
        proxy_gap_clients = max(0, load - sales_activity_proxy_per_day)
        planned_to_sales_proxy_ratio = round(load / max(1, sales_activity_proxy_per_day), 2) if load > 0 else 0.0
        predicted_ca_aggregate = summarize_predicted_ca_clients(assigned_clients)
        recovery_aggregate = summarize_recovery_clients(assigned_clients)
        purchase_prediction_aggregate = summarize_purchase_prediction_clients(assigned_clients)
        predicted_ca = predicted_ca_aggregate["predicted_ca"]
        total_predicted_ca_known_count += predicted_ca_aggregate["predicted_ca_known_count"]
        total_predicted_ca_unknown_count += predicted_ca_aggregate["predicted_ca_unknown_count"]
        if predicted_ca is not None:
            total_predicted_ca_value += predicted_ca

        ca_shortfall = 0.0
        if slot.min_ca > 0 and not predicted_ca_aggregate["predicted_ca_is_complete"]:
            ca_shortfall = None
            total_ca_shortfall_is_complete = False
        elif slot_shortfall_vars[slot.slot_id] is not None and solver is not None:
            ca_shortfall = round(solver.Value(slot_shortfall_vars[slot.slot_id]) / 100.0, 2)
        elif not payload["strict_ca"] and slot.min_ca > 0:
            ca_shortfall = round(max(0.0, slot.min_ca - (predicted_ca or 0.0)), 2)

        if ca_shortfall is not None:
            total_ca_shortfall_value += ca_shortfall
        postprocess_assignments_seconds += time.perf_counter() - slot_postprocess_started_at

        build_visit_order_started_at = time.perf_counter()
        route_order, estimated_distance_km, estimated_duration_minutes = build_route_for_slot(
            payload,
            slot,
            assigned_clients,
            context=context
        )
        time_usage = build_slot_time_usage(payload, slot, assigned_clients)
        total_estimated_km += estimated_distance_km
        planned_load_units = round(sum(client.predicted_load_units for client in assigned_clients), 2)
        client_rows = []
        for visit_order, client in enumerate(route_order, start=1):
            priority_breakdown, priority_reasons = build_client_priority_breakdown(payload, slot, client, context=context)
            planned_client_ids.add(client.client_id)
            client_rows.append({
                "visit_order": visit_order,
                "client_id": client.client_id,
                "client_code": client.client_code,
                "client_name": client.client_name,
                "address": client.address,
                "commercial_zone": client.commercial_zone,
                "zone_comm": client.commercial_zone,
                "routing_code": client.route_code,
                "region": client.region,
                "predicted_ca": round(client.predicted_ca, 2) if is_known_predicted_ca(client.predicted_ca) else None,
                "predicted_ca_known": client.predicted_ca_known,
                "predicted_ca_source": client.predicted_ca_source,
                "purchase_prediction_score": round(client.purchase_prediction_score, 2) if is_known_purchase_number(client.purchase_prediction_score) else None,
                "predicted_purchase_date": client.predicted_purchase_date,
                "purchase_days_until_prediction": client.purchase_days_until_prediction,
                "recommended_quantity": round(client.recommended_quantity, 2) if is_known_purchase_number(client.recommended_quantity) else None,
                "expected_order_value": round(client.expected_order_value, 2) if is_known_purchase_number(client.expected_order_value) else None,
                "predicted_products": client.predicted_products,
                "purchase_prediction_known": client.purchase_prediction_known,
                "purchase_prediction_source": client.purchase_prediction_source,
                "recovery_total_balance": round(client.recovery_total_balance, 2) if is_known_recovery_number(client.recovery_total_balance) else None,
                "recovery_due_amount": round(client.recovery_due_amount, 2) if is_known_recovery_number(client.recovery_due_amount) else None,
                "recovery_days_past_due": client.recovery_days_past_due,
                "recovery_expected_next_payment_date": client.recovery_expected_next_payment_date,
                "recovery_days_since_expected_payment": client.recovery_days_since_expected_payment,
                "recovery_payment_behavior_score": round(client.recovery_payment_behavior_score, 2) if is_known_recovery_number(client.recovery_payment_behavior_score) else None,
                "recovery_expected_collection_amount": round(client.recovery_expected_collection_amount, 2) if is_known_recovery_number(client.recovery_expected_collection_amount) else None,
                "recovery_priority_score": round(client.recovery_priority_score, 2) if is_known_recovery_number(client.recovery_priority_score) else None,
                "recovery_data_known": client.recovery_data_known,
                "recovery_source": client.recovery_source,
                "priority_breakdown": priority_breakdown,
                "priority_reasons": priority_reasons,
                "predicted_load_units": round(client.predicted_load_units, 2),
                "service_minutes": round(client.service_minutes, 2) if client.service_minutes_known and client.service_minutes is not None else None,
                "service_minutes_known": client.service_minutes_known,
                "next_visit_deadline": client.next_visit_deadline,
                "historical_commercial_code": client.historical_commercial_code,
                "allowed_commercial_codes": client.allowed_commercial_codes,
                "reassignment_reason": (
                    "coverage_balance_capacity"
                    if client.historical_commercial_code and client.historical_commercial_code != slot.commercial_code
                    else None
                ),
                "latitude": client.latitude,
                "longitude": client.longitude
            })
        blocks.append({
            "slot_id": slot.slot_id,
            "date": slot.date_iso,
            "commercial_code": slot.commercial_code,
            "commercial_label": slot.commercial_label,
            "clients_count": load,
            "unique_clients_count": len({client.client_id for client in assigned_clients}),
            "predicted_ca": predicted_ca,
            "predicted_ca_known_total": predicted_ca,
            "predicted_ca_known_count": predicted_ca_aggregate["predicted_ca_known_count"],
            "predicted_ca_unknown_count": predicted_ca_aggregate["predicted_ca_unknown_count"],
            "predicted_ca_is_complete": predicted_ca_aggregate["predicted_ca_is_complete"],
            "predicted_ca_completeness": (
                "complete"
                if predicted_ca_aggregate["predicted_ca_is_complete"]
                else "partial" if predicted_ca_aggregate["predicted_ca_known_count"] > 0
                else "unknown"
            ),
            "recovery_clients_count": recovery_aggregate["recovery_clients_count"],
            "recovery_data_known_count": recovery_aggregate["recovery_data_known_count"],
            "recovery_data_unknown_count": recovery_aggregate["recovery_data_unknown_count"],
            "expected_collection_total": recovery_aggregate["expected_collection_total"],
            "overdue_balance_total": recovery_aggregate["overdue_balance_total"],
            "high_recovery_priority_count": recovery_aggregate["high_recovery_priority_count"],
            "recovery_completeness": recovery_aggregate["recovery_completeness"],
            "purchase_prediction_known_count": purchase_prediction_aggregate["purchase_prediction_known_count"],
            "purchase_prediction_unknown_count": purchase_prediction_aggregate["purchase_prediction_unknown_count"],
            "predicted_order_value_total": purchase_prediction_aggregate["predicted_order_value_total"],
            "recommended_quantity_total": purchase_prediction_aggregate["recommended_quantity_total"],
            "high_purchase_priority_count": purchase_prediction_aggregate["high_purchase_priority_count"],
            "purchase_prediction_completeness": purchase_prediction_aggregate["purchase_prediction_completeness"],
            "ca_target": round(slot.min_ca, 2),
            "min_daily_ca_target": round(slot.min_ca, 2),
            "ca_shortfall": ca_shortfall,
            "min_daily_ca_status": (
                "unknown"
                if round(slot.min_ca, 2) <= 0 or predicted_ca_aggregate["predicted_ca_known_count"] == 0
                else "partial"
                if not predicted_ca_aggregate["predicted_ca_is_complete"]
                else "reached"
                if predicted_ca is not None and predicted_ca >= round(slot.min_ca, 2)
                else "not_reached"
            ),
            "estimated_distance_km": round(estimated_distance_km, 2),
            "estimated_duration_minutes": round(estimated_duration_minutes, 2),
            "distance_source": "haversine_fallback",
            "time": {
                "service_minutes_total": time_usage["service_minutes_total"],
                "service_minutes_known_count": time_usage["service_minutes_known_count"],
                "estimated_stop_minutes_total": time_usage["estimated_stop_minutes_total"],
                "known_travel_minutes": time_usage["known_travel_minutes"],
                "route_minutes_without_break": time_usage["route_minutes_without_break"],
                "route_minutes_with_break": time_usage["route_minutes_with_break"],
                "max_route_minutes": time_usage["max_route_minutes"],
                "break_minutes": round(slot.break_minutes, 2),
                "time_capacity_known": time_usage["time_capacity_known"],
                "time_constraint_source": slot.time_constraint_source,
                "shift_start_time": slot.shift_start_time,
                "shift_end_time": slot.shift_end_time,
                "depot_id": slot.depot_id
            },
            "capacity": {
                "user_preferred_min": slot.user_preferred_min or None,
                "user_preferred_max": slot.user_preferred_max or None,
                "recommended_min": slot.recommended_min or None,
                "recommended_max": slot.recommended_max or None,
                "effective_target_min": slot.effective_target_min or None,
                "effective_target_max": slot.effective_target_max or None,
                "hard_capacity_known": bool(slot.hard_capacity_known),
                "adjustment_reason": str(slot.adjustment_reason or payload.get("adjustment_reason") or "user_range_accepted"),
                "user_min_clients": user_min_target or None,
                "user_max_clients": user_max_target or None,
                "effective_min_clients": solver_min_target or None,
                "effective_max_clients": solver_max_target or None,
                "sales_activity_proxy_per_day": sales_activity_proxy_per_day,
                "sales_proxy_source": str(slot.sales_proxy_source or "global_sales_history_fallback").strip() or "global_sales_history_fallback",
                "sales_proxy_confidence": str(slot.sales_proxy_confidence or "low").strip().lower() or "low",
                "historical_soft_capacity": historical_soft_capacity,
                "recommended_capacity": max(1, _safe_int(slot.recommended_capacity, historical_soft_capacity)),
                "weighted_target_capacity": required_target_capacity,
                "required_target_capacity": required_target_capacity,
                "hard_capacity": _safe_int(slot.hard_capacity, 0) or None,
                "emergency_solver_ceiling": slot.max_visits,
                "max_visits": slot.max_visits,
                "planned_clients": load,
                "planned_clients_per_day": load,
                "planned_visits": load,
                "planned_to_sales_proxy_ratio": planned_to_sales_proxy_ratio,
                "proxy_gap_clients": proxy_gap_clients,
                "overload_clients": proxy_gap_clients,
                "overload_ratio": planned_to_sales_proxy_ratio,
                "capacity_source": slot.capacity_source,
                "planned_load_units": planned_load_units,
                "max_load_units": round(slot.max_load_units, 2) if slot.max_load_units is not None else None,
                "planned_route_minutes": time_usage["route_minutes_without_break"],
                "max_route_minutes": round(slot.max_route_minutes, 2) if slot.max_route_minutes is not None else None,
                "time_capacity_known": time_usage["time_capacity_known"]
            },
            "route_order": route_order,
            "clients": client_rows
        })
        build_visit_order_seconds += time.perf_counter() - build_visit_order_started_at

    append_solver_direct_stage_duration(
        "python_solver_postprocess_assignments",
        int(round(postprocess_assignments_seconds * 1000))
    )
    append_solver_direct_stage_duration(
        "python_solver_build_visit_order",
        int(round(build_visit_order_seconds * 1000))
    )

    statistics_started_at = time.perf_counter()
    total_predicted_ca = round(total_predicted_ca_value, 2) if total_predicted_ca_known_count > 0 else (None if total_predicted_ca_unknown_count > 0 else 0.0)
    total_predicted_ca_is_complete = total_predicted_ca_unknown_count == 0
    total_ca_shortfall = round(total_ca_shortfall_value, 2) if total_ca_shortfall_is_complete else None
    finalized_collection_target_context = finalize_collection_target_context_from_assigned_clients(
        context.collection_target_context,
        [
            client
            for assigned_clients in slot_assignments_by_code.values()
            for client in assigned_clients
        ],
    )
    if finalized_collection_target_context is not None:
        if (
            finalized_collection_target_context.get("mode") == "target_collection" and
            finalized_collection_target_context.get("collection_target_stop_reason") == "target_unreachable"
        ):
            unreachable_context = dict(context.collection_target_context or {})
            unreachable_context.update({
                "selected_estimated_collection_amount": finalized_collection_target_context.get("selected_estimated_collection_amount"),
                "estimated_remaining_amount": finalized_collection_target_context.get("estimated_remaining_amount"),
                "is_target_reached": finalized_collection_target_context.get("is_target_reached"),
                "stop_reason": finalized_collection_target_context.get("stop_reason"),
            })
            analysis_summary["collection_target_context"] = unreachable_context
            functional_metadata = build_functional_metadata(
                collection_target_context=unreachable_context,
            )
        for container in (analysis_summary, functional_metadata):
            if isinstance(container, dict):
                container["requested_target_collection_amount"] = finalized_collection_target_context.get("requested_target_collection_amount")
                container["estimated_assigned_collection_amount"] = finalized_collection_target_context.get("estimated_assigned_collection_amount")
                container["estimated_remaining_collection_amount"] = finalized_collection_target_context.get("estimated_remaining_collection_amount")
                container["is_target_collection_reached"] = finalized_collection_target_context.get("is_target_collection_reached")
                container["collection_target_stop_reason"] = finalized_collection_target_context.get("collection_target_stop_reason")
    recovery_summary = build_recovery_summary(mandatory_clients, planned_client_ids)
    purchase_prediction_summary = build_purchase_prediction_summary(mandatory_clients, planned_client_ids)

    commercial_summaries = build_commercial_plan_summaries(slots, blocks, slot_targets=slot_targets)
    total_historical_capacity = sum(resolve_slot_soft_capacity(slot) for slot in slots)
    total_sales_activity_proxy = sum(resolve_slot_sales_activity_proxy(slot) for slot in slots)
    total_planned_overload_clients = max(
        0,
        sum(block["clients_count"] for block in blocks) - total_historical_capacity
    )
    max_planned_overload_ratio = max(
        (
            float(block.get("capacity", {}).get("planned_to_sales_proxy_ratio", 0.0) or 0.0)
            for block in blocks
        ),
        default=0.0
    )
    operational_metrics = {
        **(feasibility.get("operational") or {}),
        "total_historical_capacity": total_historical_capacity,
        "sales_activity_proxy_total": total_sales_activity_proxy,
        "total_required_clients": len(mandatory_clients),
        "operational_capacity_gap": max(0, len(mandatory_clients) - total_historical_capacity),
        "required_capacity_multiplier": round(
            (len(mandatory_clients) / max(1, total_historical_capacity)) if mandatory_clients else 1.0,
            2
        ),
        "planned_overload_clients": total_planned_overload_clients,
        "max_planned_overload_ratio": round(max_planned_overload_ratio, 2),
        "commercial_summaries": commercial_summaries
    }
    operational_metrics = finalize_operational_metrics(
        payload=payload,
        slots=slots,
        operational_metrics=operational_metrics,
        planned_clients_total=sum(block["clients_count"] for block in blocks),
        max_overload_ratio=max_planned_overload_ratio,
        physically_impossible=False
    )

    validation_started_at = time.perf_counter()
    validation = validate_solution(
        clients=mandatory_clients,
        slots=slots,
        blocks=blocks,
        strict_ca=payload["strict_ca"],
        payload=payload
    )
    performance_entries.append(_build_perf_entry("python_validation", validation_started_at))
    append_solver_direct_stage("python_solver_build_statistics", statistics_started_at)

    def finalize_solver_wrapper_stages() -> None:
        stage_names = {
            str(entry.get("stage") or "")
            for entry in performance_entries
            if entry and entry.get("stage")
        }
        if debug_path["cp_sat_solve_reached"] and "python_solver_cp_sat_solve" not in stage_names:
            raise RuntimeError(
                "coverage perf debug inconsistency: python_solver_total exists but python_solver_cp_sat_solve is missing in the CP-SAT execution path."
            )
        total_entry = _build_perf_entry("python_solver_total", solver_started_at)
        child_total_ms = sum(max(0, int(entry.get("duration_ms") or 0)) for entry in solver_direct_entries)
        unaccounted_ms = max(0, int(total_entry["duration_ms"] or 0) - child_total_ms)
        solver_unaccounted_entry = {
            "stage": "python_solver_unaccounted",
            "duration_ms": unaccounted_ms
        }
        performance_entries.append(solver_unaccounted_entry)
        performance_entries.append(_build_perf_entry("python_solver", solver_started_at))
        performance_entries.append(total_entry)
        if greedy_meta is not None:
            greedy_meta["solver_unaccounted_ms"] = unaccounted_ms
        if is_perf_debug_enabled() and unaccounted_ms > 100:
            print(f"[COVERAGE_PERF_WARNING] solver_unaccounted_ms={unaccounted_ms}", flush=True)
    if not validation["is_valid"]:
        build_response_started_at = time.perf_counter()
        result = {
            "status": "invalid",
            "user_message": "Certains parametres ont ete ajustes afin d assurer la meilleure couverture possible.",
            "summary": {
                "planning_start_date": payload["planning_start_date"],
                "planning_end_date": payload["planning_end_date"],
                "planning_horizon_days": int(payload["planning_horizon_days"]),
                "coverage_window_days": int(payload["coverage_window_days"]),
                "daily_max_mode": str(payload["daily_max_mode"]),
                "clients_to_cover": len(mandatory_clients),
                "unique_clients_covered": validation["unique_clients_covered"],
                "missing_clients_count": len(validation["missing_clients"]),
                "duplicate_clients_count": len(validation["duplicate_clients"]),
                "total_visits": validation["total_visits"],
                "total_slots": len(slots),
                "used_slots": sum(1 for block in blocks if block["clients_count"] > 0),
                "unused_slots": sum(1 for block in blocks if block["clients_count"] == 0),
                "total_capacity": sum(slot.max_visits for slot in slots),
                "required_average_per_slot": feasibility["required_average_per_slot"],
                "required_minimum_max_per_slot": feasibility["required_minimum_max_per_slot"],
                "total_predicted_ca": total_predicted_ca,
                "predicted_ca_known_count": total_predicted_ca_known_count,
                "predicted_ca_unknown_count": total_predicted_ca_unknown_count,
                "predicted_ca_is_complete": total_predicted_ca_is_complete,
                "total_ca_shortfall": total_ca_shortfall,
                "solver_status": "INVALID",
                "coverage_rate": round((validation["unique_clients_covered"] / max(1, len(mandatory_clients))) * 100, 2),
                "average_clients_per_route": round((validation["total_visits"] / max(1, sum(1 for block in blocks if block["clients_count"] > 0))), 2) if blocks else 0.0,
                "routes_count": sum(1 for block in blocks if block["clients_count"] > 0),
                "active_clients": len(mandatory_clients),
                "unique_clients_planned": validation["unique_clients_covered"],
                "missing_clients": len(validation["missing_clients"]),
                "duplicate_clients": len(validation["duplicate_clients"]),
                "predicted_ca": total_predicted_ca,
                "total_estimated_km": round(total_estimated_km, 2),
                "capacity_mode": operational_metrics["capacity_mode"],
                "time_capacity_known": operational_metrics["time_capacity_known"],
                "operational_capacity_known": operational_metrics["operational_capacity_known"],
                "sales_activity_proxy_total": operational_metrics["sales_activity_proxy_total"],
                "planned_to_sales_proxy_ratio": operational_metrics["planned_to_sales_proxy_ratio"],
                "total_historical_capacity": total_historical_capacity,
                "operational_capacity_gap": operational_metrics["operational_capacity_gap"],
                "required_capacity_multiplier": operational_metrics["required_capacity_multiplier"],
                "estimated_extra_commercial_days": operational_metrics.get("estimated_extra_commercial_days"),
                "estimated_extra_commercial_days_needed": operational_metrics.get("estimated_extra_commercial_days"),
                "operational_status": operational_metrics["status"],
                "operational_status_label": operational_metrics["status_label"],
                "coverage_guarantee_status": "single_visit_only"
            },
            "blocks": blocks,
            "recovery_summary": recovery_summary,
            "purchase_prediction_summary": purchase_prediction_summary,
            "effective_constraints": effective_constraints,
            "operational": operational_metrics,
            "diagnostics": {
                "capacity_issues": validation["capacity_violations"],
                "commercial_capacity_issues": validation["commercial_violations"],
                "deadline_issues": validation["deadline_violations"],
                "ca_issues": validation["ca_violations"],
                "truck_capacity_issues": validation["truck_capacity_violations"],
                "time_capacity_issues": validation["time_capacity_violations"],
                "reassignment_issues": validation["reassignment_violations"],
                "invalid_gps_clients": validation["invalid_gps_clients"],
                "duplicate_clients": validation["duplicate_clients"],
                "missing_clients": validation["missing_clients"],
                "input_duplicate_client_ids": sorted(payload["input_duplicate_client_ids"]),
                "input_duplicate_clients_removed": sorted(payload["input_duplicate_client_codes"])
            }
        }
        append_solver_direct_stage("python_solver_build_response", build_response_started_at)
        finalize_solver_wrapper_stages()
        serialize_started_at = time.perf_counter()
        performance_entries.append(_build_perf_entry("python_serialize_response", serialize_started_at))
        append_python_total_once()
        return finalize_coverage_debug_result(
            result,
            performance_entries=performance_entries,
            debug_path=debug_path,
            solver_selection=solver_selection,
            greedy_meta=greedy_meta,
            input_fingerprints=input_fingerprints,
            greedy_trace=greedy_trace,
            candidate_context=candidate_context,
            candidate_context_meta=build_candidate_context_meta(
                context,
                candidate_context,
                reused_by_wrapper=candidate_context is not None,
                reused_by_greedy=greedy_trace is not None,
                reused_by_fingerprints=input_fingerprints is not None and candidate_context is not None,
            ),
            perf_context=context,
        )

    solver_status = "OPTIMAL" if status == cp_model.OPTIMAL else "FEASIBLE"
    used_slots = sum(1 for block in blocks if block["clients_count"] > 0)
    missing_clients_count = len(validation["missing_clients"])
    duplicate_clients_count = len(validation["duplicate_clients"])
    coverage_rate = round((validation["unique_clients_covered"] / max(1, len(mandatory_clients))) * 100, 2) if mandatory_clients else 100.0
    adjusted_inputs = (
        str(payload.get("adjustment_reason") or "") not in {"", "no_adjustment_required", "user_range_respected", "user_range_accepted"}
    )
    partial_due_to_capacity = (
        False
        if target_collection_mode
        else missing_clients_count > 0 or feasibility["status"] != "feasible"
    )
    user_message = (
        "La couverture complete est impossible avec les capacites physiques disponibles. La meilleure repartition possible a ete generee."
        if partial_due_to_capacity and allow_partial_plan
        else "Le plan couvre les clients et repartit la charge selon l activite de vente historique. La faisabilite terrain reste a confirmer, car les visites reelles, les durees et les temps de trajet ne sont pas encore mesures."
        if not operational_metrics["operational_capacity_known"]
        else "La couverture complete necessite une charge superieure aux capacites historiques. Consultez les commerciaux surcharges ou augmentez la periode / les ressources."
        if operational_metrics["status"] in {"under_tension", "critical_overload"}
        else "Certains parametres ont ete ajustes afin d assurer la meilleure couverture possible."
        if adjusted_inputs
        else "Plan de couverture genere avec succes."
    )

    build_response_started_at = time.perf_counter()
    result = {
        "status": "partial_success" if partial_due_to_capacity and allow_partial_plan else "success",
        "reason": feasibility.get("reason") if partial_due_to_capacity else None,
        "user_message": user_message,
        "summary": {
            "planning_start_date": payload["planning_start_date"],
            "planning_end_date": payload["planning_end_date"],
            "planning_horizon_days": int(payload["planning_horizon_days"]),
            "coverage_window_days": int(payload["coverage_window_days"]),
            "daily_max_mode": str(payload["daily_max_mode"]),
            "clients_to_cover": len(mandatory_clients),
            "unique_clients_covered": validation["unique_clients_covered"],
            "missing_clients_count": missing_clients_count,
            "duplicate_clients_count": duplicate_clients_count,
            "total_visits": validation["total_visits"],
            "total_slots": len(slots),
            "used_slots": used_slots,
            "unused_slots": len(slots) - used_slots,
            "total_capacity": sum(slot.max_visits for slot in slots),
            "required_average_per_slot": feasibility["required_average_per_slot"],
            "required_minimum_max_per_slot": feasibility["required_minimum_max_per_slot"],
            "total_predicted_ca": total_predicted_ca,
            "predicted_ca_known_count": total_predicted_ca_known_count,
            "predicted_ca_unknown_count": total_predicted_ca_unknown_count,
            "predicted_ca_is_complete": total_predicted_ca_is_complete,
            "total_ca_shortfall": total_ca_shortfall,
            "solver_status": solver_status,
            "coverage_rate": coverage_rate,
            "average_clients_per_route": round((validation["total_visits"] / max(1, used_slots)), 2) if used_slots else 0.0,
            "routes_count": used_slots,
            "active_clients": len(mandatory_clients),
            "unique_clients_planned": validation["unique_clients_covered"],
            "missing_clients": missing_clients_count,
            "duplicate_clients": duplicate_clients_count,
            "predicted_ca": total_predicted_ca,
            "total_estimated_km": round(total_estimated_km, 2),
            "capacity_mode": operational_metrics["capacity_mode"],
            "time_capacity_known": operational_metrics["time_capacity_known"],
            "operational_capacity_known": operational_metrics["operational_capacity_known"],
            "sales_activity_proxy_total": operational_metrics["sales_activity_proxy_total"],
            "planned_to_sales_proxy_ratio": operational_metrics["planned_to_sales_proxy_ratio"],
            "total_historical_capacity": total_historical_capacity,
            "operational_capacity_gap": operational_metrics["operational_capacity_gap"],
            "required_capacity_multiplier": operational_metrics["required_capacity_multiplier"],
            "estimated_extra_commercial_days": operational_metrics.get("estimated_extra_commercial_days"),
            "estimated_extra_commercial_days_needed": operational_metrics.get("estimated_extra_commercial_days"),
            "operational_status": operational_metrics["status"],
            "operational_status_label": operational_metrics["status_label"],
            "coverage_guarantee_status": "single_visit_only"
        },
        "blocks": blocks,
        "analysis": analysis_summary,
        "recovery_summary": recovery_summary,
        "purchase_prediction_summary": purchase_prediction_summary,
        "effective_constraints": effective_constraints,
        "operational": operational_metrics,
        "diagnostics": {
            "capacity_issues": validation["capacity_violations"],
            "commercial_capacity_issues": validation["commercial_violations"],
            "deadline_issues": validation["deadline_violations"],
            "ca_issues": validation["ca_violations"],
            "truck_capacity_issues": validation["truck_capacity_violations"],
            "time_capacity_issues": validation["time_capacity_violations"],
            "reassignment_issues": validation["reassignment_violations"],
            "invalid_gps_clients": validation["invalid_gps_clients"],
            "missing_clients": validation["missing_clients"],
            "input_duplicate_client_ids": sorted(payload["input_duplicate_client_ids"]),
            "input_duplicate_clients_removed": sorted(payload["input_duplicate_client_codes"])
        }
    }
    if functional_metadata is not None:
        result["functional_metadata"] = functional_metadata
    if is_perf_debug_enabled() and cp_sat_stats is not None:
        result["meta"] = {
            "cp_sat": cp_sat_stats
        }
    append_solver_direct_stage("python_solver_build_response", build_response_started_at)
    finalize_solver_wrapper_stages()
    serialize_started_at = time.perf_counter()
    performance_entries.append(_build_perf_entry("python_serialize_response", serialize_started_at))
    append_python_total_once()
    return finalize_coverage_debug_result(
        result,
        performance_entries=performance_entries,
        debug_path=debug_path,
        solver_selection=solver_selection,
        greedy_meta=greedy_meta,
        input_fingerprints=input_fingerprints,
        greedy_trace=greedy_trace,
        candidate_context=candidate_context,
        candidate_context_meta=build_candidate_context_meta(
            context,
            candidate_context,
            reused_by_wrapper=candidate_context is not None,
            reused_by_greedy=greedy_trace is not None,
            reused_by_fingerprints=input_fingerprints is not None and candidate_context is not None,
        ),
        perf_context=context,
    )


def build_route_for_slot(
    payload: dict[str, Any],
    slot: NormalizedSlot,
    clients: list[NormalizedClient],
    context: CoverageOptimizationContext | None = None
) -> tuple[list[NormalizedClient], float, float]:
    sales_mode = is_sales_coverage_mode(payload)
    remaining = clients[:]
    ordered: list[NormalizedClient] = []
    depot_lat, depot_lon = resolve_slot_depot_coordinates(payload, slot)
    current_lat = depot_lat
    current_lon = depot_lon
    total_distance = 0.0
    total_duration = 0.0

    while remaining:
        with_gps = [client for client in remaining if not client.invalid_gps]
        if not with_gps:
            ordered.extend(remaining)
            total_duration += sum(
                (client.service_minutes if client.service_minutes_known and client.service_minutes is not None else DEFAULT_SERVICE_MINUTES) +
                DEFAULT_STOP_HANDLING_MINUTES
                for client in remaining
            )
            break

        scored = []
        for client in with_gps:
            distance = _get_context_distance_km(context, current_lat, current_lon, client.latitude, client.longitude)
            distance = distance if distance is not None else 0.0
            if sales_mode:
                scored.append((
                    distance,
                    -resolve_client_purchase_prediction_score_value(client),
                    -resolve_client_purchase_timing_urgency(client),
                    -resolve_client_expected_order_value(client),
                    -resolve_client_predicted_ca_value(client),
                    client
                ))
            else:
                scored.append((
                    -resolve_client_recovery_urgency_value(client),
                    -resolve_client_recovery_priority_value(client),
                    -resolve_client_expected_collection_value(client),
                    distance,
                    client
                ))
        if sales_mode:
            scored.sort(key=lambda item: (item[0], item[1], item[2], item[3], item[4], item[5].client_id))
            next_client = scored[0][5]
        else:
            scored.sort(key=lambda item: (item[0], item[1], item[2], item[3], item[4].client_id))
            next_client = scored[0][4]
        remaining.remove(next_client)
        ordered.append(next_client)
        leg_distance = _get_context_distance_km(context, current_lat, current_lon, next_client.latitude, next_client.longitude) or 0.0
        total_distance += leg_distance
        service_minutes = next_client.service_minutes if next_client.service_minutes_known and next_client.service_minutes is not None else DEFAULT_SERVICE_MINUTES
        total_duration += ((leg_distance / DEFAULT_DRIVE_SPEED_KMH) * 60.0) + service_minutes + DEFAULT_STOP_HANDLING_MINUTES
        current_lat = next_client.latitude
        current_lon = next_client.longitude

    if ordered and depot_lat is not None and depot_lon is not None and current_lat is not None and current_lon is not None:
        return_distance = _get_context_distance_km(context, current_lat, current_lon, depot_lat, depot_lon) or 0.0
        total_distance += return_distance
        total_duration += (return_distance / DEFAULT_DRIVE_SPEED_KMH) * 60.0

    total_duration += max(0.0, slot.break_minutes)

    return ordered, total_distance, total_duration


def validate_solution(
    clients: list[NormalizedClient],
    slots: list[NormalizedSlot],
    blocks: list[dict[str, Any]],
    strict_ca: bool,
    payload: dict[str, Any]
) -> dict[str, Any]:
    client_id_counter = Counter()
    missing_clients = []
    duplicate_clients = []
    capacity_violations = []
    truck_capacity_violations = []
    time_capacity_violations = []
    commercial_violations = []
    reassignment_violations = []
    deadline_violations = []
    ca_violations = []
    invalid_gps_clients = sorted(client.client_code for client in clients if client.invalid_gps)
    collection_target_context = resolve_collection_target_context(payload)
    target_collection_mode = bool(
        not is_sales_coverage_mode(payload) and
        isinstance(collection_target_context, dict) and
        collection_target_context.get("mode") == "target_collection"
    )

    client_by_id = {client.client_id: client for client in clients}
    slot_by_id = {slot.slot_id: slot for slot in slots}
    total_visits = 0

    for block in blocks:
        slot = slot_by_id.get(block["slot_id"])
        assigned_client_ids = [item["client_id"] for item in block.get("clients", []) if item.get("client_id")]
        total_visits += len(assigned_client_ids)
        if slot:
            slot_min_visits = resolve_slot_min_visits(slot, payload)
            if slot_min_visits > 0 and len(assigned_client_ids) < slot_min_visits:
                capacity_violations.append({
                    "slot_id": slot.slot_id,
                    "planned_visits": len(assigned_client_ids),
                    "min_visits": slot_min_visits
                })
        if slot and len(assigned_client_ids) > slot.max_visits:
            capacity_violations.append({
                "slot_id": slot.slot_id,
                "planned_visits": len(assigned_client_ids),
                "max_visits": slot.max_visits
            })
        planned_load_units = round(sum(
            float(item.get("predicted_load_units", 0.0) or 0.0)
            for item in block.get("clients", [])
        ), 2)
        if slot and slot.max_load_units is not None and slot.max_load_units > 0 and planned_load_units > round(slot.max_load_units, 2) + 1e-9:
            truck_capacity_violations.append({
                "slot_id": slot.slot_id,
                "planned_load_units": planned_load_units,
                "max_load_units": round(slot.max_load_units, 2)
            })
        block_time = block.get("time") if isinstance(block.get("time"), dict) else {}
        route_minutes_without_break = _safe_optional_float(block_time.get("route_minutes_without_break"))
        if (
            slot and
            slot.time_capacity_known and
            slot.max_route_minutes is not None and
            slot.max_route_minutes > 0 and
            route_minutes_without_break is not None and
            route_minutes_without_break > round(slot.max_route_minutes, 2) + 1e-9
        ):
            time_capacity_violations.append({
                "slot_id": slot.slot_id,
                "route_minutes_without_break": round(route_minutes_without_break, 2),
                "max_route_minutes": round(slot.max_route_minutes, 2)
            })
        block_predicted_ca = _safe_optional_float(block.get("predicted_ca"))
        if slot and strict_ca and block_predicted_ca is not None and round(block_predicted_ca, 2) + 1e-9 < round(slot.min_ca, 2):
            ca_violations.append({
                "slot_id": slot.slot_id,
                "predicted_ca": round(block_predicted_ca, 2),
                "ca_target": round(slot.min_ca, 2)
            })

        for client_id in assigned_client_ids:
            client_id_counter[client_id] += 1
            client = client_by_id.get(client_id)
            if client and slot and slot.commercial_code not in client.allowed_commercial_codes:
                commercial_violations.append({
                    "client_id": client_id,
                    "client_code": client.client_code,
                    "slot_id": slot.slot_id,
                    "commercial_code": slot.commercial_code,
                    "allowed_commercial_codes": client.allowed_commercial_codes
                })
            if client and slot and client.historical_commercial_code and slot.commercial_code != client.historical_commercial_code:
                reassignment_violations.append({
                    "client_id": client_id,
                    "client_code": client.client_code,
                    "historical_commercial_code": client.historical_commercial_code,
                    "assigned_commercial_code": slot.commercial_code,
                    "slot_id": slot.slot_id
                })
            if client and slot:
                deadline = parse_iso_date(client.next_visit_deadline)
                slot_date = parse_iso_date(slot.date_iso)
                if deadline and slot_date and slot_date > deadline:
                    deadline_violations.append({
                        "client_id": client_id,
                        "client_code": client.client_code,
                        "slot_id": slot.slot_id,
                        "slot_date": slot.date_iso,
                        "deadline": client.next_visit_deadline
                    })

    for client in clients:
        count = client_id_counter.get(client.client_id, 0)
        if client.is_mandatory and count == 0 and not target_collection_mode:
            missing_clients.append(client.client_id)
        if count > 1:
            duplicate_clients.append(client.client_id)

    allow_partial_plan = _safe_bool(payload.get("allow_partial_plan"), False)

    return {
        "is_valid": (
            (allow_partial_plan or len(missing_clients) == 0) and
            len(duplicate_clients) == 0 and
            len(capacity_violations) == 0 and
            len(truck_capacity_violations) == 0 and
            len(time_capacity_violations) == 0 and
            len(commercial_violations) == 0 and
            len(deadline_violations) == 0 and
            (len(ca_violations) == 0 if strict_ca else True)
        ),
        "missing_clients": missing_clients,
        "duplicate_clients": duplicate_clients,
        "capacity_violations": capacity_violations,
        "truck_capacity_violations": truck_capacity_violations,
        "time_capacity_violations": time_capacity_violations,
        "commercial_violations": commercial_violations,
        "reassignment_violations": reassignment_violations,
        "deadline_violations": deadline_violations,
        "ca_violations": ca_violations,
        "invalid_gps_clients": invalid_gps_clients,
        "unique_clients_covered": sum(1 for _, count in client_id_counter.items() if count >= 1),
        "total_visits": total_visits
    }
