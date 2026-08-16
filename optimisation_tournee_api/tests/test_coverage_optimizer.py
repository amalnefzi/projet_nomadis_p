import sys
from collections import Counter
from datetime import datetime, timedelta
import hashlib
import importlib
import json
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import coverage_optimizer as optimizer_module  # noqa: E402

from coverage_optimizer import (  # noqa: E402
    CoverageModelBuilder,
    apply_effective_visit_bounds_to_slots,
    build_assignment_candidates,
    build_capacity_distribution_context,
    build_client_priority_breakdown,
    build_coverage_analysis_summary_from_context,
    build_coverage_cp_sat_model_artifacts,
    build_coverage_optimization_context,
    build_feasible_slot_ids_by_client,
    build_solver_candidate_indices,
    build_slots,
    compute_coverage_model_fingerprint,
    compute_feasibility_from_context,
    compute_feasibility,
    compute_weighted_slot_targets,
    deduplicate_assignment_candidates,
    normalize_payload,
    resolve_last_real_visit_date,
    solve_greedy_capacity_plan,
    solve_coverage_plan,
)


START_DATE = "2026-08-03"


def build_commercials(
    count=6,
    days=14,
    max_visits=69,
    min_ca=0,
    absent=None,
    commercial_codes=None,
    historical_soft_capacities=None,
    hard_capacities=None,
    user_preferred_min=None,
    user_preferred_max=None,
    effective_target_min=None,
    effective_target_max=None
):
    absent = absent or set()
    historical_soft_capacities = historical_soft_capacities or {}
    hard_capacities = hard_capacities or {}
    codes = commercial_codes or [f"C{commercial_index + 1:03d}" for commercial_index in range(count)]
    start_date = datetime.strptime(START_DATE, "%Y-%m-%d").date()
    commercials = []
    for commercial_index, code in enumerate(codes):
        available_dates = []
        max_visits_by_date = {}
        min_ca_by_date = {}
        user_preferred_min_by_date = {}
        user_preferred_max_by_date = {}
        recommended_min_by_date = {}
        recommended_max_by_date = {}
        effective_target_min_by_date = {}
        effective_target_max_by_date = {}
        hard_capacity_known_by_date = {}
        adjustment_reason_by_date = {}
        historical_soft_capacity_by_date = {}
        sales_activity_proxy_by_date = {}
        recommended_capacity_by_date = {}
        hard_capacity_by_date = {}
        capacity_source_by_date = {}
        sales_proxy_source_by_date = {}
        sales_proxy_confidence_by_date = {}
        for offset in range(days):
            date_iso = (start_date + timedelta(days=offset)).strftime("%Y-%m-%d")
            if (code, date_iso) in absent:
                continue
            available_dates.append(date_iso)
            max_visits_by_date[date_iso] = max_visits
            min_ca_by_date[date_iso] = min_ca
            if user_preferred_min is not None:
                user_preferred_min_by_date[date_iso] = user_preferred_min
            if user_preferred_max is not None:
                user_preferred_max_by_date[date_iso] = user_preferred_max
            historical_capacity = historical_soft_capacities.get((code, date_iso), historical_soft_capacities.get(code))
            if historical_capacity is not None:
                historical_soft_capacity_by_date[date_iso] = historical_capacity
                sales_activity_proxy_by_date[date_iso] = historical_capacity
                recommended_capacity_by_date[date_iso] = historical_capacity
                recommended_min_by_date[date_iso] = historical_capacity
                recommended_max_by_date[date_iso] = historical_capacity
                capacity_source_by_date[date_iso] = "commercial_weekday_history"
                sales_proxy_source_by_date[date_iso] = "commercial_weekday_sales_history"
                sales_proxy_confidence_by_date[date_iso] = "medium"
            if effective_target_min is not None:
                effective_target_min_by_date[date_iso] = effective_target_min
            if effective_target_max is not None:
                effective_target_max_by_date[date_iso] = effective_target_max
            hard_capacity = hard_capacities.get((code, date_iso), hard_capacities.get(code))
            if hard_capacity is not None:
                hard_capacity_by_date[date_iso] = hard_capacity
                hard_capacity_known_by_date[date_iso] = True
                adjustment_reason_by_date[date_iso] = "insufficient_physical_capacity" if hard_capacity < max_visits else "user_range_accepted"
        commercials.append({
            "code": code,
            "label": f"Commercial {commercial_index + 1}",
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
            "historical_soft_capacity_by_date": historical_soft_capacity_by_date,
            "sales_activity_proxy_by_date": sales_activity_proxy_by_date,
            "sales_proxy_source_by_date": sales_proxy_source_by_date,
            "sales_proxy_confidence_by_date": sales_proxy_confidence_by_date,
            "recommended_capacity_by_date": recommended_capacity_by_date,
            "hard_capacity_by_date": hard_capacity_by_date,
            "capacity_source_by_date": capacity_source_by_date
        })
    return commercials


def build_clients(total, allowed_codes=None, predicted_ca=100.0, deadline=None, code_prefix=""):
    allowed_codes = allowed_codes or []
    clients = []
    for index in range(total):
        code = f"{code_prefix}{index + 1:05d}" if code_prefix else f"{index + 1:05d}"
        client_id = f"{code_prefix or 'client_'}{index + 1}"
        clients.append({
            "client_id": client_id,
            "client_code": code,
            "client_name": f"Client {code}",
            "latitude": 36.80 + ((index % 20) * 0.001),
            "longitude": 10.18 + ((index % 20) * 0.001),
            "historical_commercial_code": allowed_codes[0] if len(allowed_codes) == 1 else "C001",
            "allowed_commercial_codes": allowed_codes,
            "predicted_ca": predicted_ca,
            "last_real_visit_date": None,
            "next_visit_deadline": deadline,
            "visit_frequency_days": 14,
            "is_mandatory": True
        })
    return clients


def base_payload(
    clients,
    commercials,
    strict_ca=False,
    min_daily_ca_per_commercial=0,
    planning_days=14,
    capacity_mode="sales_activity_proxy",
    operational_capacity_known=False,
    planning_mode="recovery_coverage"
):
    return {
        "planning_mode": planning_mode,
        "planning_start_date": START_DATE,
        "planning_days": planning_days,
        "visit_frequency_days": 14,
        "strict_ca": strict_ca,
        "default_max_visits_per_slot": 69,
        "min_daily_ca_per_commercial": min_daily_ca_per_commercial,
        "depot": {
            "latitude": 36.8065,
            "longitude": 10.1815
        },
        "working_days": [0, 1, 2, 3, 4, 5, 6],
        "allow_commercial_reassignment": True,
        "capacity_mode": capacity_mode,
        "operational_capacity_known": operational_capacity_known,
        "commercials": commercials,
        "clients": clients
    }


def block_sizes(result):
    return Counter(block["clients_count"] for block in result["blocks"])


def planned_clients_by_commercial(result):
    totals = Counter()
    for block in result["blocks"]:
        totals[block["commercial_code"]] += block["clients_count"]
    return totals


def commercial_summary_by_code(result):
    return {
        item["commercial_code"]: item
        for item in result.get("operational", {}).get("commercial_summaries", [])
    }


def overload_ratios_from_totals(totals, capacities):
    return {
        commercial_code: totals[commercial_code] / max(1, capacities[commercial_code])
        for commercial_code in capacities
    }


def normalize_result_without_meta(result):
    return {
        key: value
        for key, value in result.items()
        if key != "meta"
    }


def compute_functional_result_hash(result):
    return optimizer_module.compute_coverage_functional_result_hash(result)


def find_first_difference_path(left, right, path="root"):
    if type(left) is not type(right):
        return path
    if isinstance(left, dict):
        left_keys = sorted(left.keys(), key=str)
        right_keys = sorted(right.keys(), key=str)
        if left_keys != right_keys:
            return path
        for key in left_keys:
            child_path = find_first_difference_path(left[key], right[key], f"{path}.{key}")
            if child_path is not None:
                return child_path
        return None
    if isinstance(left, list):
        if len(left) != len(right):
            return path
        for index, (left_item, right_item) in enumerate(zip(left, right)):
            child_path = find_first_difference_path(left_item, right_item, f"{path}[{index}]")
            if child_path is not None:
                return child_path
        return None
    return None if left == right else path


def performance_stage_map(result):
    return {
        entry["stage"]: int(entry["duration_ms"])
        for entry in result["meta"]["performance"]["stages"]
    }


def build_perf4b_sales_greedy_payload():
    clients = build_clients(3, allowed_codes=["C001"], predicted_ca=50.0)
    clients[0]["client_id"] = "same-00152"
    clients[0]["client_code"] = "00152"
    clients[0]["purchase_prediction_score"] = 90
    clients[0]["purchase_prediction_known"] = True
    clients[0]["recovery_priority_score"] = 5
    clients[1]["client_id"] = "same-152"
    clients[1]["client_code"] = "152"
    clients[1]["purchase_prediction_score"] = 20
    clients[1]["purchase_prediction_known"] = True
    clients[1]["recovery_priority_score"] = 99
    clients[2]["client_id"] = "same-null"
    clients[2]["client_code"] = "NULL"
    clients[2]["predicted_ca"] = None
    clients[2]["predicted_ca_known"] = False
    clients[2]["purchase_prediction_score"] = None
    clients[2]["purchase_prediction_known"] = False
    clients[2]["expected_order_value"] = None

    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=1,
            days=3,
            max_visits=2,
            commercial_codes=["C001"],
            hard_capacities={"C001": 1}
        ),
        planning_days=3,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True,
        planning_mode="sales_coverage"
    )
    payload["request_id"] = "perf4b-initial"
    payload["cache_status"] = "miss"
    return payload


def build_canonical_hash_fixture_result():
    return {
        "status": "success",
        "reason": None,
        "summary": {
            "planning_start_date": "2026-08-03",
            "planning_end_date": "2026-08-04",
            "clients_to_cover": 3,
            "unique_clients_covered": 2,
            "missing_clients_count": 1,
            "duplicate_clients_count": 0,
            "total_visits": 2,
            "total_slots": 2,
            "used_slots": 2,
            "unused_slots": 0,
            "total_capacity": 2,
            "required_average_per_slot": 1,
            "required_minimum_max_per_slot": 1,
            "total_predicted_ca": 420.0,
            "predicted_ca_known_count": 1,
            "predicted_ca_unknown_count": 1,
            "predicted_ca_is_complete": False,
            "total_ca_shortfall": 0.0,
            "solver_status": "FEASIBLE",
            "coverage_rate": 66.67,
            "average_clients_per_route": 1.0,
            "routes_count": 2,
            "active_clients": 3,
            "unique_clients_planned": 2,
            "missing_clients": 1,
            "duplicate_clients": 0,
            "predicted_ca": 420.0,
            "total_estimated_km": 12.5,
        },
        "blocks": [
            {
                "slot_id": "2026-08-04::C002",
                "date": "2026-08-04",
                "commercial_code": "C002",
                "clients": [
                    {
                        "visit_order": 1,
                        "client_id": "same-null",
                        "client_code": "152",
                        "predicted_ca": None,
                        "recommended_quantity": None,
                        "purchase_prediction_score": None,
                        "recovery_priority_score": None,
                    }
                ]
            },
            {
                "slot_id": "2026-08-03::C001",
                "date": "2026-08-03",
                "commercial_code": "C001",
                "clients": [
                    {
                        "visit_order": 2,
                        "client_id": "same-00152",
                        "client_code": "00152",
                        "predicted_ca": 420.0,
                        "recommended_quantity": 6.0,
                        "purchase_prediction_score": 85.0,
                        "recovery_priority_score": None,
                    }
                ]
            }
        ],
        "diagnostics": {
            "missing_clients": ["same-missing"],
            "duplicate_clients": []
        },
        "request_id": "technical-request-id",
        "cache_status": "miss",
        "generated_at": "2026-08-02T10:00:00Z",
        "meta": {
            "performance": {
                "stages": [
                    {"stage": "python_solver_total", "duration_ms": 1}
                ]
            }
        }
    }


def legacy_solve_greedy_capacity_plan_reference(
    payload,
    slots,
    mandatory_clients,
    feasible_slots_by_client,
    slot_targets=None,
    context=None,
    assignment_candidates=None,
    assignment_index_by_key=None,
    candidate_planning_context=None,
    performance_entries=None,
    greedy_meta_sink=None,
    greedy_trace_sink=None
):
    _ = assignment_index_by_key
    _ = candidate_planning_context
    _ = performance_entries
    _ = greedy_meta_sink
    sales_mode = optimizer_module.is_sales_coverage_mode(payload)
    assigned_clients_by_slot = {slot.slot_id: [] for slot in slots}
    slot_by_id = {slot.slot_id: slot for slot in slots}
    slot_load_units = {slot.slot_id: 0.0 for slot in slots}
    slot_time_minutes = {slot.slot_id: 0.0 for slot in slots}
    user_min_target = max(0, optimizer_module._safe_int(payload.get("user_min_visits_per_slot"), 0))
    user_max_target = max(0, optimizer_module._safe_int(payload.get("user_max_visits_per_slot"), 0))
    distribution_context = optimizer_module.build_capacity_distribution_context(slots, slot_targets, len(mandatory_clients))
    resolved_slot_targets = distribution_context["slot_targets"]
    resolved_slot_soft_capacities = distribution_context["slot_soft_capacities"]
    commercial_soft_capacity_totals = distribution_context["commercial_soft_capacity_totals"]
    commercial_target_totals = distribution_context["commercial_target_totals"]
    global_ratio_target = float(distribution_context["global_ratio_target"] or 1.0)
    commercial_planned_clients = Counter()
    assignment_decisions = []
    assignment_candidates = assignment_candidates or []

    def client_sort_key(client):
        deadline = optimizer_module.parse_iso_date(client.next_visit_deadline)
        deadline_ordinal = deadline.toordinal() if deadline else 999999999
        return (
            0 if client.is_critical else 1,
            -optimizer_module.resolve_client_coverage_urgency_component(client, payload.get("planning_start_date")),
            len(feasible_slots_by_client.get(client.client_id, [])),
            deadline_ordinal,
            0.0 if sales_mode else -optimizer_module.resolve_client_recovery_priority_value(client),
            0.0 if sales_mode else -optimizer_module.resolve_client_expected_collection_value(client),
            -optimizer_module.resolve_client_purchase_prediction_score_value(client),
            -optimizer_module.resolve_client_purchase_timing_urgency(client),
            -optimizer_module.resolve_client_expected_order_value(client),
            0 if client.historical_commercial_code else 1,
            -optimizer_module.resolve_client_predicted_ca_value(client),
            client.client_id
        )

    def slot_score(client, slot):
        current_load = len(assigned_clients_by_slot[slot.slot_id])
        next_load = current_load + 1
        target_load = max(1, optimizer_module._safe_int(resolved_slot_targets.get(slot.slot_id), 0) or optimizer_module.resolve_slot_soft_capacity(slot))
        soft_capacity = max(1, optimizer_module._safe_int(resolved_slot_soft_capacities.get(slot.slot_id), 0) or optimizer_module.resolve_slot_soft_capacity(slot))
        deadline = optimizer_module.parse_iso_date(client.next_visit_deadline)
        slot_date = optimizer_module.parse_iso_date(slot.date_iso)
        deadline_gap = 0
        if deadline and slot_date:
            deadline_gap = max(0, (deadline - slot_date).days)
        planning_start = optimizer_module.parse_iso_date(payload.get("planning_start_date"))
        day_offset = max(0, (slot_date - planning_start).days) if slot_date and planning_start else 0

        reassignment_penalty = 0
        if client.historical_commercial_code and slot.commercial_code != client.historical_commercial_code:
            reassignment_penalty = 1

        commercial_code = slot.commercial_code
        current_commercial_load = commercial_planned_clients.get(commercial_code, 0)
        next_commercial_load = current_commercial_load + 1
        commercial_soft_total = max(1, optimizer_module._safe_int(commercial_soft_capacity_totals.get(commercial_code), 0))
        commercial_target_total = max(1, optimizer_module._safe_int(commercial_target_totals.get(commercial_code), 0))
        projected_commercial_ratio = next_commercial_load / commercial_soft_total
        projected_global_max_ratio = projected_commercial_ratio
        for other_code, other_soft_total in commercial_soft_capacity_totals.items():
            other_ratio = (
                next_commercial_load / commercial_soft_total
                if other_code == commercial_code
                else commercial_planned_clients.get(other_code, 0) / max(1, optimizer_module._safe_int(other_soft_total, 0))
            )
            projected_global_max_ratio = max(projected_global_max_ratio, other_ratio)
        projected_ratio_above_target = max(0.0, projected_commercial_ratio - global_ratio_target)
        projected_ratio_gap = abs(projected_commercial_ratio - global_ratio_target)
        commercial_target_over_ratio = max(0.0, (next_commercial_load - commercial_target_total) / commercial_soft_total)

        user_under_penalty = 0
        if user_min_target > 0 and next_load < user_min_target:
            user_under_penalty = user_min_target - next_load

        user_over_penalty = 0
        if user_max_target > 0 and next_load > user_max_target:
            user_over_penalty = next_load - user_max_target

        distance_km = optimizer_module._get_context_distance_km(
            context,
            payload["depot"].get("latitude"),
            payload["depot"].get("longitude"),
            client.latitude,
            client.longitude
        ) or 0.0
        coverage_date_penalty = int(round(optimizer_module.resolve_client_coverage_urgency_component(client, payload.get("planning_start_date")) * day_offset * 100))
        recovery_date_penalty = 0 if sales_mode else int(round(optimizer_module.resolve_client_recovery_priority_value(client) * day_offset * 100))
        expected_collection_date_penalty = 0 if sales_mode else int(round(min(optimizer_module.resolve_client_expected_collection_value(client), 1_000_000.0) * day_offset * 10))
        purchase_score_date_penalty = int(round(optimizer_module.resolve_client_purchase_prediction_score_value(client) * day_offset * 100))
        purchase_timing_date_penalty = int(round(optimizer_module.resolve_client_purchase_timing_urgency(client) * day_offset * 100))
        expected_order_date_penalty = int(round(min(optimizer_module.resolve_client_expected_order_value(client), 1_000_000.0) * day_offset * 10))
        soft_overload = max(0, next_load - soft_capacity)
        soft_overload_ratio = round(max(0.0, (next_load / max(1, soft_capacity)) - 1.0), 4)
        target_fill_over_ratio = round(max(0.0, (next_load / max(1, target_load)) - 1.0), 4)

        return (
            0 if client.is_critical else 1,
            coverage_date_penalty,
            recovery_date_penalty,
            expected_collection_date_penalty,
            purchase_score_date_penalty,
            purchase_timing_date_penalty,
            expected_order_date_penalty,
            round(projected_global_max_ratio, 6),
            round(projected_ratio_above_target, 6),
            round(projected_ratio_gap, 6),
            round(commercial_target_over_ratio, 6),
            target_fill_over_ratio,
            soft_overload_ratio,
            soft_overload,
            deadline_gap,
            reassignment_penalty,
            user_over_penalty,
            user_under_penalty,
            round(distance_km, 4),
            slot.date_iso,
            slot.commercial_code,
            current_load
        )

    sorted_mandatory_clients = sorted(mandatory_clients, key=client_sort_key)
    unassigned_clients = []
    for client in sorted_mandatory_clients:
        best_slot = None
        best_score = None
        feasible_slot_ids = feasible_slots_by_client.get(client.client_id, [])
        preferred_slot_ids = [
            slot_id
            for slot_id in feasible_slot_ids
            if len(assigned_clients_by_slot.get(slot_id, [])) < max(0, optimizer_module._safe_int(resolved_slot_targets.get(slot_id), 0))
        ]
        candidate_slot_ids = preferred_slot_ids or feasible_slot_ids

        for slot_id in candidate_slot_ids:
            slot = slot_by_id.get(slot_id)
            if slot is None:
                continue
            if len(assigned_clients_by_slot[slot_id]) >= slot.max_visits:
                continue
            if (
                slot.max_load_units is not None and
                slot.max_load_units > 0 and
                slot_load_units[slot_id] + client.predicted_load_units > slot.max_load_units + 1e-9
            ):
                continue
            estimated_stop_minutes = optimizer_module.resolve_client_estimated_stop_minutes(slot, client, context=context) or 0.0
            if (
                slot.time_capacity_known and
                slot.max_route_minutes is not None and
                slot.max_route_minutes > 0 and
                slot_time_minutes[slot_id] + estimated_stop_minutes > slot.max_route_minutes + 1e-9
            ):
                continue

            score = slot_score(client, slot)
            if best_score is None or score < best_score:
                best_score = score
                best_slot = slot

        if best_slot is None:
            assignment_decisions.append(("mandatory", client.client_id, None))
            unassigned_clients.append(client.client_id)
            continue

        assigned_clients_by_slot[best_slot.slot_id].append(client)
        slot_load_units[best_slot.slot_id] += client.predicted_load_units
        slot_time_minutes[best_slot.slot_id] += optimizer_module.resolve_client_estimated_stop_minutes(best_slot, client, context=context) or 0.0
        commercial_planned_clients[best_slot.commercial_code] += 1
        assignment_decisions.append(("mandatory", client.client_id, best_slot.slot_id))

    if unassigned_clients:
        unresolved_clients = []
        client_by_id = {client.client_id: client for client in mandatory_clients}
        for client_id in unassigned_clients:
            client = client_by_id[client_id]
            placed = False

            for slot_id in feasible_slots_by_client.get(client.client_id, []):
                slot = slot_by_id.get(slot_id)
                if slot is None:
                    continue

                current_slot_clients = assigned_clients_by_slot[slot_id]
                current_slot_load = slot_load_units[slot_id]
                slot_can_fit_directly = (
                    len(current_slot_clients) < slot.max_visits and
                    (
                        slot.max_load_units is None or
                        slot.max_load_units <= 0 or
                        current_slot_load + client.predicted_load_units <= slot.max_load_units + 1e-9
                    )
                    and
                    (
                        not slot.time_capacity_known or
                        slot.max_route_minutes is None or
                        slot.max_route_minutes <= 0 or
                        slot_time_minutes[slot_id] + (optimizer_module.resolve_client_estimated_stop_minutes(slot, client, context=context) or 0.0) <= slot.max_route_minutes + 1e-9
                    )
                )
                if slot_can_fit_directly:
                    current_slot_clients.append(client)
                    slot_load_units[slot_id] += client.predicted_load_units
                    slot_time_minutes[slot_id] += optimizer_module.resolve_client_estimated_stop_minutes(slot, client, context=context) or 0.0
                    commercial_planned_clients[slot.commercial_code] += 1
                    assignment_decisions.append(("repair_direct", client.client_id, slot.slot_id))
                    placed = True
                    break

                movable_clients = sorted(
                    current_slot_clients,
                    key=lambda existing: (
                        0 if not existing.is_critical else 1,
                        -len(feasible_slots_by_client.get(existing.client_id, [])),
                        optimizer_module.resolve_client_recovery_priority_value(existing),
                        optimizer_module.resolve_client_expected_collection_value(existing),
                        optimizer_module.resolve_client_purchase_prediction_score_value(existing),
                        optimizer_module.resolve_client_purchase_timing_urgency(existing),
                        optimizer_module.resolve_client_expected_order_value(existing),
                        optimizer_module.resolve_client_predicted_ca_value(existing),
                        existing.client_id
                    )
                )
                for existing_client in movable_clients:
                    for alt_slot_id in feasible_slots_by_client.get(existing_client.client_id, []):
                        if alt_slot_id == slot_id:
                            continue
                        alt_slot = slot_by_id.get(alt_slot_id)
                        if alt_slot is None:
                            continue
                        if len(assigned_clients_by_slot[alt_slot_id]) >= alt_slot.max_visits:
                            continue
                        if (
                            alt_slot.max_load_units is not None and
                            alt_slot.max_load_units > 0 and
                            slot_load_units[alt_slot_id] + existing_client.predicted_load_units > alt_slot.max_load_units + 1e-9
                        ):
                            continue
                        if (
                            alt_slot.time_capacity_known and
                            alt_slot.max_route_minutes is not None and
                            alt_slot.max_route_minutes > 0 and
                            slot_time_minutes[alt_slot_id] + (optimizer_module.resolve_client_estimated_stop_minutes(alt_slot, existing_client, context=context) or 0.0) > alt_slot.max_route_minutes + 1e-9
                        ):
                            continue

                        remaining_source_load = current_slot_load - existing_client.predicted_load_units
                        remaining_source_time = slot_time_minutes[slot_id] - (optimizer_module.resolve_client_estimated_stop_minutes(slot, existing_client, context=context) or 0.0)
                        if (
                            slot.max_load_units is not None and
                            slot.max_load_units > 0 and
                            remaining_source_load + client.predicted_load_units > slot.max_load_units + 1e-9
                        ):
                            continue
                        if (
                            slot.time_capacity_known and
                            slot.max_route_minutes is not None and
                            slot.max_route_minutes > 0 and
                            remaining_source_time + (optimizer_module.resolve_client_estimated_stop_minutes(slot, client, context=context) or 0.0) > slot.max_route_minutes + 1e-9
                        ):
                            continue

                        current_slot_clients.remove(existing_client)
                        slot_load_units[slot_id] -= existing_client.predicted_load_units
                        slot_time_minutes[slot_id] -= optimizer_module.resolve_client_estimated_stop_minutes(slot, existing_client, context=context) or 0.0
                        commercial_planned_clients[slot.commercial_code] -= 1
                        assigned_clients_by_slot[alt_slot_id].append(existing_client)
                        slot_load_units[alt_slot_id] += existing_client.predicted_load_units
                        slot_time_minutes[alt_slot_id] += optimizer_module.resolve_client_estimated_stop_minutes(alt_slot, existing_client, context=context) or 0.0
                        commercial_planned_clients[alt_slot.commercial_code] += 1
                        current_slot_clients.append(client)
                        slot_load_units[slot_id] += client.predicted_load_units
                        slot_time_minutes[slot_id] += optimizer_module.resolve_client_estimated_stop_minutes(slot, client, context=context) or 0.0
                        commercial_planned_clients[slot.commercial_code] += 1
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

    assignments_before_postprocess_hash = optimizer_module._hash_assignment_state(assigned_clients_by_slot)
    optimizer_module.rebalance_assignments_to_slot_targets(
        slots=slots,
        assigned_clients_by_slot=assigned_clients_by_slot,
        feasible_slots_by_client=feasible_slots_by_client,
        slot_targets=resolved_slot_targets,
        slot_load_units=slot_load_units,
        slot_time_minutes=slot_time_minutes,
        context=context,
        decisions_sink=assignment_decisions
    )
    if greedy_trace_sink is not None:
        greedy_trace_sink.clear()
        greedy_trace_sink.update({
            "greedy_candidate_order_hash": optimizer_module.compute_stable_debug_hash([
                (
                    str(assignment.get("client_id") or ""),
                    str(assignment.get("slot_id") or "")
                )
                for assignment in assignment_candidates
            ]),
            "candidate_pairs_count": len(assignment_candidates),
            "client_priority_order_hash": optimizer_module.compute_stable_debug_hash([client.client_id for client in sorted_mandatory_clients]),
            "client_priority_count": len(sorted_mandatory_clients),
            "candidate_order_by_client_hash": optimizer_module.compute_stable_debug_hash([
                {
                    "client_id": client.client_id,
                    "candidate_slot_ids": list(feasible_slots_by_client.get(client.client_id, []))
                }
                for client in sorted_mandatory_clients
            ]),
            "initial_capacities_hash": optimizer_module.compute_stable_debug_hash([
                {
                    "slot_id": slot.slot_id,
                    "slot_target": resolved_slot_targets.get(slot.slot_id),
                    "slot_soft_capacity": resolved_slot_soft_capacities.get(slot.slot_id),
                    "max_visits": slot.max_visits,
                    "max_load_units": slot.max_load_units,
                    "max_route_minutes": slot.max_route_minutes,
                }
                for slot in slots
            ]),
            "assignment_decisions_hash": optimizer_module.compute_stable_debug_hash(list(assignment_decisions)),
            "assignment_decisions_count": len(assignment_decisions),
            "assignments_before_postprocess_hash": assignments_before_postprocess_hash,
            "assignments_after_postprocess_hash": optimizer_module._hash_assignment_state(assigned_clients_by_slot),
            "canonical_functional_result_hash": None,
        })

    return assigned_clients_by_slot, unassigned_clients


def test_a_historical_capacities_create_a_weighted_distribution():
    payload = base_payload(
        clients=build_clients(24),
        commercials=build_commercials(
            count=3,
            days=1,
            max_visits=30,
            commercial_codes=["A", "B", "C"],
            historical_soft_capacities={
                "A": 15,
                "B": 7,
                "C": 2
            }
        ),
        planning_days=1
    )

    result = solve_coverage_plan(payload)
    planned_by_commercial = planned_clients_by_commercial(result)

    assert result["status"] == "success"
    assert result["summary"]["unique_clients_covered"] == 24
    assert result["summary"]["missing_clients_count"] == 0
    assert result["summary"]["duplicate_clients_count"] == 0
    assert planned_by_commercial["A"] > planned_by_commercial["B"]
    assert planned_by_commercial["B"] > planned_by_commercial["C"]
    assert planned_by_commercial["A"] == 15
    assert planned_by_commercial["B"] == 7
    assert planned_by_commercial["C"] == 2


def test_b_total_assigned_clients_match_the_unique_clients_covered():
    payload = base_payload(
        clients=build_clients(24),
        commercials=build_commercials(
            count=3,
            days=1,
            max_visits=30,
            commercial_codes=["A", "B", "C"],
            historical_soft_capacities={
                "A": 15,
                "B": 7,
                "C": 2
            }
        ),
        planning_days=1
    )
    result = solve_coverage_plan(payload)

    assert result["status"] == "success"
    assert result["summary"]["total_visits"] == result["summary"]["unique_clients_covered"]
    assert result["summary"]["missing_clients_count"] == 0
    assert result["summary"]["duplicate_clients_count"] == 0

    planned_client_ids = [
        client["client_id"]
        for block in result["blocks"]
        for client in block["clients"]
    ]
    assert len(planned_client_ids) == result["summary"]["unique_clients_covered"]
    assert len(set(planned_client_ids)) == result["summary"]["unique_clients_covered"]


def test_c_no_client_id_is_assigned_more_than_once():
    payload = base_payload(
        clients=build_clients(24),
        commercials=build_commercials(
            count=3,
            days=1,
            max_visits=30,
            commercial_codes=["A", "B", "C"],
            historical_soft_capacities={
                "A": 15,
                "B": 7,
                "C": 2
            }
        ),
        planning_days=1
    )
    result = solve_coverage_plan(payload)

    planned_client_ids = [
        client["client_id"]
        for block in result["blocks"]
        for client in block["clients"]
    ]

    assert result["status"] == "success"
    assert len(planned_client_ids) == len(set(planned_client_ids))
    assert result["summary"]["duplicate_clients_count"] == 0


def test_d_base_without_validated_visits_keeps_operational_status_unknown():
    payload = base_payload(
        clients=build_clients(40),
        commercials=build_commercials(
            count=2,
            days=1,
            max_visits=30,
            commercial_codes=["A", "B"],
            historical_soft_capacities={
                "A": 10,
                "B": 10
            }
        ),
        planning_days=1
    )

    result = solve_coverage_plan(payload)

    assert result["status"] == "success"
    assert result["summary"]["unique_clients_covered"] == 40
    assert result["summary"]["missing_clients_count"] == 0
    assert result["summary"]["duplicate_clients_count"] == 0
    assert result["summary"]["capacity_mode"] == "sales_activity_proxy"
    assert result["summary"]["operational_capacity_known"] is False
    assert result["summary"]["estimated_extra_commercial_days"] is None
    assert result["summary"]["estimated_extra_commercial_days_needed"] is None
    assert result["summary"]["operational_status"] == "unknown"
    assert result["summary"]["operational_status_label"] == "Capacite terrain non mesuree"
    assert result["operational"]["planned_overload_clients"] == 20
    assert result["operational"]["planned_to_sales_proxy_ratio"] == 2.0
    assert "activite de vente historique" in result["user_message"]


def test_e_validated_visit_capacity_reenables_operational_metrics():
    payload = base_payload(
        clients=build_clients(40),
        commercials=build_commercials(
            count=2,
            days=1,
            max_visits=30,
            commercial_codes=["A", "B"],
            historical_soft_capacities={
                "A": 10,
                "B": 10
            }
        ),
        planning_days=1,
        capacity_mode="validated_visit_capacity",
        operational_capacity_known=True
    )

    result = solve_coverage_plan(payload)

    assert result["status"] == "success"
    assert result["summary"]["capacity_mode"] == "validated_visit_capacity"
    assert result["summary"]["operational_capacity_known"] is True
    assert result["summary"]["estimated_extra_commercial_days"] == 2
    assert result["summary"]["estimated_extra_commercial_days_needed"] == 2
    assert result["summary"]["operational_status"] == "critical_overload"
    assert result["summary"]["operational_status_label"] == "Surcharge critique"


def test_f_true_hard_capacity_is_never_exceeded():
    payload = base_payload(
        clients=build_clients(31),
        commercials=build_commercials(
            count=3,
            days=1,
            max_visits=30,
            commercial_codes=["A", "B", "C"],
            historical_soft_capacities={
                "A": 15,
                "B": 7,
                "C": 2
            },
            hard_capacities={
                "A": 20,
                "B": 10,
                "C": 1
            }
        ),
        planning_days=1
    )

    result = solve_coverage_plan(payload)
    planned_by_commercial = planned_clients_by_commercial(result)

    assert result["status"] == "success"
    assert result["summary"]["unique_clients_covered"] == 31
    assert result["summary"]["missing_clients_count"] == 0
    assert planned_by_commercial["A"] <= 20
    assert planned_by_commercial["B"] <= 10
    assert planned_by_commercial["C"] <= 1
    assert not result["diagnostics"]["capacity_issues"]


def test_f_impossible_fixed_commercial_capacity():
    payload = base_payload(
        clients=build_clients(1050, allowed_codes=["C001"]),
        commercials=build_commercials(count=1, days=14, max_visits=69),
        planning_days=14
    )
    payload["allow_commercial_reassignment"] = False

    result = solve_coverage_plan(payload)

    assert result["status"] == "infeasible"
    assert result["reason"] == "insufficient_commercial_capacity"
    assert result["commercial"] == "C001"
    assert result["clients_required"] == 1050
    assert result["capacity"] == 966
    assert result["missing_capacity"] == 84


def test_g_impossible_global_capacity():
    payload = {
        **base_payload(
            clients=build_clients(5768),
            commercials=build_commercials(count=6, days=14, max_visits=30),
            planning_days=14
        ),
        "default_max_visits_per_slot": 30
    }

    result = solve_coverage_plan(payload)

    assert result["status"] == "infeasible"
    assert result["reason"] == "insufficient_visit_capacity"
    assert result["summary"]["total_capacity"] == 2520
    assert result["summary"]["required_minimum_max_per_slot"] == 69
    assert result["summary"]["clients_to_cover"] == 5768
    assert result["summary"]["missing_clients_count"] == 5768


def test_h_variable_availability_recomputes_slots():
    absent = {("C001", "2026-08-05")}
    payload = base_payload(
        clients=build_clients(1000),
        commercials=build_commercials(count=6, days=14, max_visits=69, absent=absent),
        planning_days=14
    )
    normalized = normalize_payload(payload)
    feasibility = compute_feasibility(normalized)

    assert feasibility["status"] == "feasible"
    assert feasibility["total_slots"] == 83
    assert feasibility["configured_total_capacity"] == 83 * 69
    assert feasibility["required_minimum_max_per_slot"] == 13


def test_i_adjusted_target_capacity_replaces_historical_soft_caps_for_full_coverage():
    payload = {
        **base_payload(
            clients=build_clients(5757),
            commercials=build_commercials(count=6, days=14, max_visits=69),
            planning_days=14
        ),
        "default_max_visits_per_slot": 69,
        "user_min_visits_per_slot": 20,
        "user_max_visits_per_slot": 40
    }

    normalized = normalize_payload(payload)
    feasibility = compute_feasibility(normalized)
    result = solve_coverage_plan(payload)

    assert normalized["user_min_visits_per_slot"] == 20
    assert normalized["user_max_visits_per_slot"] == 40
    assert feasibility["required_minimum_max_per_slot"] == 69
    assert feasibility["configured_total_capacity"] == 5796
    assert feasibility["status"] == "feasible"

    assert result["status"] == "success"
    assert result["reason"] is None
    assert result["summary"]["total_capacity"] == 5796
    assert result["summary"]["required_minimum_max_per_slot"] == 69
    assert result["summary"]["unique_clients_covered"] == 5757
    assert result["summary"]["missing_clients_count"] == 0
    assert result["summary"]["duplicate_clients_count"] == 0
    assert result["summary"]["used_slots"] == 84
    assert "activite de vente historique" in result["user_message"]

    planned_client_codes = [
        client["client_code"]
        for block in result["blocks"]
        for client in block["clients"]
    ]
    assert len(planned_client_codes) == 5757
    assert len(set(planned_client_codes)) == 5757


def test_j_critical_client_is_planned_before_deadline():
    clients = build_clients(30)
    clients[0]["client_id"] = "CRIT-1"
    clients[0]["client_code"] = "CRIT001"
    clients[0]["next_visit_deadline"] = "2026-08-05"
    payload = base_payload(
        clients=clients,
        commercials=build_commercials(count=2, days=14, max_visits=20),
        planning_days=14
    )

    result = solve_coverage_plan(payload)

    assert result["status"] == "success"
    critical_block = next(
        block for block in result["blocks"]
        if any(row["client_code"] == "CRIT001" for row in block["clients"])
    )
    assert critical_block["date"] <= "2026-08-05"


def test_k_strict_daily_ca():
    commercials = build_commercials(count=2, days=1, max_visits=2, min_ca=200)
    clients = [
        {
            "client_id": "A1-ID",
            "client_code": "A1",
            "client_name": "A1",
            "latitude": 36.81,
            "longitude": 10.18,
            "historical_commercial_code": "C001",
            "allowed_commercial_codes": ["C001"],
            "predicted_ca": 100,
            "is_mandatory": True
        },
        {
            "client_id": "A2-ID",
            "client_code": "A2",
            "client_name": "A2",
            "latitude": 36.82,
            "longitude": 10.19,
            "historical_commercial_code": "C001",
            "allowed_commercial_codes": ["C001"],
            "predicted_ca": 100,
            "is_mandatory": True
        },
        {
            "client_id": "B1-ID",
            "client_code": "B1",
            "client_name": "B1",
            "latitude": 36.83,
            "longitude": 10.20,
            "historical_commercial_code": "C002",
            "allowed_commercial_codes": ["C002"],
            "predicted_ca": 120,
            "is_mandatory": True
        },
        {
            "client_id": "B2-ID",
            "client_code": "B2",
            "client_name": "B2",
            "latitude": 36.84,
            "longitude": 10.21,
            "historical_commercial_code": "C002",
            "allowed_commercial_codes": ["C002"],
            "predicted_ca": 110,
            "is_mandatory": True
        }
    ]
    payload = base_payload(
        clients=clients,
        commercials=commercials,
        strict_ca=True,
        min_daily_ca_per_commercial=200,
        planning_days=1
    )
    payload["allow_commercial_reassignment"] = False

    result = solve_coverage_plan(payload)

    assert result["status"] == "success"
    assert all(block["predicted_ca"] >= block["ca_target"] for block in result["blocks"])


def test_l_soft_daily_ca_reports_shortfall():
    commercials = build_commercials(count=2, days=1, max_visits=2, min_ca=500)
    clients = build_clients(4, predicted_ca=100)
    payload = base_payload(
        clients=clients,
        commercials=commercials,
        strict_ca=False,
        min_daily_ca_per_commercial=500,
        planning_days=1
    )

    result = solve_coverage_plan(payload)

    assert result["status"] == "success"
    assert result["summary"]["missing_clients_count"] == 0
    assert result["summary"]["duplicate_clients_count"] == 0
    assert result["summary"]["total_ca_shortfall"] > 0
    assert any(block["ca_shortfall"] > 0 for block in result["blocks"])


def test_m_no_duplicate_for_ca():
    commercials = build_commercials(count=1, days=1, max_visits=10, min_ca=10000)
    clients = build_clients(5, allowed_codes=["C001"], predicted_ca=100)
    payload = base_payload(
        clients=clients,
        commercials=commercials,
        strict_ca=False,
        min_daily_ca_per_commercial=10000,
        planning_days=1
    )
    payload["allow_commercial_reassignment"] = False

    result = solve_coverage_plan(payload)

    assert result["status"] == "success"
    assert result["summary"]["total_visits"] == 5
    assert result["summary"]["duplicate_clients_count"] == 0
    assert result["summary"]["unique_clients_covered"] == 5


def test_n_validated_visit_without_sale_updates_last_real_visit():
    visits = [
        {
            "validation_status": "validated",
            "check_in_at": "2026-07-20 09:10:00",
            "sale_amount": 0
        }
    ]
    assert resolve_last_real_visit_date(visits) == "2026-07-20"


def test_o_invoice_without_validated_visit_does_not_replace_last_real_visit():
    visits = [
        {
            "validation_status": "pending",
            "check_in_at": "2026-07-27 09:10:00",
            "sale_amount": 900
        }
    ]
    assert resolve_last_real_visit_date(visits) is None


def test_p_invalid_gps_clients_are_reported_without_being_dropped():
    commercials = build_commercials(count=1, days=2, max_visits=5)
    clients = [
        {
            "client_id": "GPS001-ID",
            "client_code": "GPS001",
            "client_name": "GPS001",
            "latitude": None,
            "longitude": None,
            "historical_commercial_code": "C001",
            "allowed_commercial_codes": ["C001"],
            "predicted_ca": 100,
            "is_mandatory": True
        },
        {
            "client_id": "GPS002-ID",
            "client_code": "GPS002",
            "client_name": "GPS002",
            "latitude": 36.82,
            "longitude": 10.19,
            "historical_commercial_code": "C001",
            "allowed_commercial_codes": ["C001"],
            "predicted_ca": 100,
            "is_mandatory": True
        }
    ]
    payload = base_payload(clients=clients, commercials=commercials, planning_days=2)
    payload["allow_commercial_reassignment"] = False

    result = solve_coverage_plan(payload)

    assert result["status"] == "success"
    assert result["summary"]["unique_clients_covered"] == 2
    assert result["diagnostics"]["invalid_gps_clients"] == ["GPS001"]


def test_q_client_ids_prevent_false_duplicates_when_codes_share_the_same_normalized_value():
    commercials = build_commercials(count=1, days=1, max_visits=2)
    payload = base_payload(
        clients=[
            {
                "client_id": "1",
                "client_code": "00152",
                "client_name": "Client 00152",
                "latitude": 36.81,
                "longitude": 10.18,
                "historical_commercial_code": "C001",
                "allowed_commercial_codes": ["C001"],
                "predicted_ca": 100,
                "is_mandatory": True
            },
            {
                "client_id": "2",
                "client_code": "152",
                "client_name": "Client 152",
                "latitude": 36.82,
                "longitude": 10.19,
                "historical_commercial_code": "C001",
                "allowed_commercial_codes": ["C001"],
                "predicted_ca": 100,
                "is_mandatory": True
            }
        ],
        commercials=commercials,
        planning_days=1
    )
    payload["allow_commercial_reassignment"] = False

    result = solve_coverage_plan(payload)

    assert result["status"] == "success"
    assert result["summary"]["clients_to_cover"] == 2
    assert result["summary"]["unique_clients_covered"] == 2
    assert result["summary"]["duplicate_clients_count"] == 0

    planned_client_ids = [
        client["client_id"]
        for block in result["blocks"]
        for client in block["clients"]
    ]
    assert sorted(planned_client_ids) == ["1", "2"]
    assert len(planned_client_ids) == 2
    assert len(set(planned_client_ids)) == 2


def test_r_variable_client_counts_remain_dynamic_and_match_solver_summary():
    for total_clients in [1, 17, 257]:
        payload = base_payload(
            clients=build_clients(total_clients),
            commercials=build_commercials(count=3, days=7, max_visits=50),
            planning_days=7
        )

        result = solve_coverage_plan(payload)

        assert result["status"] == "success"
        assert result["summary"]["clients_to_cover"] == total_clients
        assert result["summary"]["unique_clients_covered"] == total_clients
        assert result["summary"]["missing_clients_count"] == 0
        assert result["summary"]["duplicate_clients_count"] == 0


def test_s_proportionality_keeps_overload_ratios_close():
    capacities = {"A": 10, "B": 5, "C": 1}
    payload = base_payload(
        clients=build_clients(48),
        commercials=build_commercials(
            count=3,
            days=1,
            max_visits=60,
            commercial_codes=["A", "B", "C"],
            historical_soft_capacities=capacities
        ),
        planning_days=1
    )

    result = solve_coverage_plan(payload)
    planned_by_commercial = planned_clients_by_commercial(result)
    overload_ratios = overload_ratios_from_totals(planned_by_commercial, capacities)
    tolerance = 0.2

    assert result["status"] == "success"
    assert planned_by_commercial["A"] > planned_by_commercial["B"] > planned_by_commercial["C"]
    assert max(overload_ratios.values()) - min(overload_ratios.values()) <= tolerance
    assert result["summary"]["unique_clients_covered"] == 48
    assert result["summary"]["duplicate_clients_count"] == 0


def test_t_habitual_preference_does_not_force_extreme_overload_on_a_weak_commercial():
    capacities = {"A": 10, "C": 1}
    clients = build_clients(33)
    for client in clients:
        client["historical_commercial_code"] = "C"
        client["allowed_commercial_codes"] = ["A", "C"]

    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=2,
            days=1,
            max_visits=40,
            commercial_codes=["A", "C"],
            historical_soft_capacities=capacities
        ),
        planning_days=1
    )

    result = solve_coverage_plan(payload)
    planned_by_commercial = planned_clients_by_commercial(result)
    overload_ratios = overload_ratios_from_totals(planned_by_commercial, capacities)
    summaries = commercial_summary_by_code(result)

    assert result["status"] == "success"
    assert planned_by_commercial["A"] > planned_by_commercial["C"]
    assert planned_by_commercial["C"] <= 6
    assert abs(overload_ratios["A"] - overload_ratios["C"]) <= 0.5
    assert summaries["A"]["reassigned_clients_total"] > 0
    assert result["summary"]["unique_clients_covered"] == 33
    assert result["summary"]["duplicate_clients_count"] == 0


def test_u_greedy_solver_keeps_capacity_hierarchy_and_ratio_proportionality():
    capacities = {"A": 10, "B": 5, "C": 1}
    payload = normalize_payload(base_payload(
        clients=build_clients(960),
        commercials=build_commercials(
            count=3,
            days=20,
            max_visits=100,
            commercial_codes=["A", "B", "C"],
            historical_soft_capacities=capacities
        ),
        planning_days=20
    ))
    slots = build_slots(payload)
    mandatory_clients = [client for client in payload["clients"] if client.is_mandatory]
    feasibility = compute_feasibility(payload)
    assigned_by_slot, unassigned = solve_greedy_capacity_plan(
        payload=payload,
        slots=slots,
        mandatory_clients=mandatory_clients,
        feasible_slots_by_client=build_feasible_slot_ids_by_client(mandatory_clients, slots),
        slot_targets=feasibility["slot_targets"]
    )

    planned_by_commercial = Counter()
    for slot in slots:
        planned_by_commercial[slot.commercial_code] += len(assigned_by_slot.get(slot.slot_id, []))

    overload_ratios = overload_ratios_from_totals(planned_by_commercial, {
        "A": capacities["A"] * 20,
        "B": capacities["B"] * 20,
        "C": capacities["C"] * 20
    })

    assert not unassigned
    assert planned_by_commercial["A"] > planned_by_commercial["B"] > planned_by_commercial["C"]
    assert max(overload_ratios.values()) - min(overload_ratios.values()) <= 0.25


def test_v_realistic_5768_clients_distribution_keeps_user_range_when_math_is_feasible():
    payload = normalize_payload({
        **base_payload(
            clients=build_clients(5768),
            commercials=build_commercials(count=6, days=40, max_visits=30),
            planning_days=40
        ),
        "default_max_visits_per_slot": 30,
        "user_min_visits_per_slot": 20,
        "user_max_visits_per_slot": 30
    })
    slots = build_slots(payload)
    bounds = apply_effective_visit_bounds_to_slots(payload, slots, len(payload["clients"]))
    slot_targets, _, _ = compute_weighted_slot_targets(
        slots,
        len(payload["clients"]),
        effective_min_visits_per_slot=bounds["effective_min_visits_per_slot"]
    )

    assert len(slots) == 240
    assert bounds["user_range_mathematically_realisable"] is True
    assert bounds["effective_min_visits_per_slot"] == 20
    assert bounds["effective_max_visits_per_slot"] == 30
    assert bounds["adjustment_reason"] == "user_range_respected"
    assert sum(slot_targets.values()) == 5768
    assert min(slot_targets.values()) >= 20
    assert max(slot_targets.values()) <= 30


def test_w_greedy_solver_keeps_weighted_loads_inside_a_feasible_user_range():
    payload = normalize_payload({
        **base_payload(
            clients=build_clients(60),
            commercials=build_commercials(
                count=3,
                days=4,
                max_visits=30,
                commercial_codes=["A", "B", "C"],
                historical_soft_capacities={"A": 9, "B": 6, "C": 3}
            ),
            planning_days=4
        ),
        "user_min_visits_per_slot": 4,
        "user_max_visits_per_slot": 6
    })
    feasibility = compute_feasibility(payload)
    slots = build_slots(payload)
    mandatory_clients = [client for client in payload["clients"] if client.is_mandatory]
    apply_effective_visit_bounds_to_slots(payload, slots, len(mandatory_clients))
    assigned_by_slot, unassigned = solve_greedy_capacity_plan(
        payload=payload,
        slots=slots,
        mandatory_clients=mandatory_clients,
        feasible_slots_by_client=build_feasible_slot_ids_by_client(mandatory_clients, slots),
        slot_targets=feasibility["slot_targets"]
    )
    loads = [len(assigned_by_slot.get(slot.slot_id, [])) for slot in slots]

    assert feasibility["effective_constraints"]["user_range_mathematically_realisable"] is True
    assert not unassigned
    assert sum(loads) == 60
    assert min(loads) >= 4
    assert max(loads) <= 6


def test_x_cp_sat_adjusts_user_range_only_when_it_is_impossible():
    payload = {
        **base_payload(
            clients=build_clients(80),
            commercials=build_commercials(
                count=3,
                days=4,
                max_visits=30,
                commercial_codes=["A", "B", "C"],
                historical_soft_capacities={"A": 9, "B": 6, "C": 3}
            ),
            planning_days=4
        ),
        "user_min_visits_per_slot": 4,
        "user_max_visits_per_slot": 6
    }
    result = solve_coverage_plan(payload)
    loads = [block["clients_count"] for block in result["blocks"]]

    assert result["status"] == "success"
    assert result["effective_constraints"]["user_min_clients"] == 4
    assert result["effective_constraints"]["user_max_clients"] == 6
    assert result["effective_constraints"]["effective_min_clients"] == 4
    assert result["effective_constraints"]["effective_max_clients"] == 7
    assert result["effective_constraints"]["adjustment_reason"] == "raised_max_for_full_coverage"
    assert sum(loads) == 80
    assert min(loads) >= 4
    assert max(loads) <= 7
    assert result["summary"]["missing_clients_count"] == 0
    assert result["summary"]["duplicate_clients_count"] == 0


def test_y_normalize_payload_preserves_known_zero_and_unknown_predicted_ca_states():
    payload = base_payload(
        clients=[
            {
                "client_id": "KNOWN-ZERO",
                "client_code": "00001",
                "client_name": "Zero",
                "latitude": 36.81,
                "longitude": 10.18,
                "historical_commercial_code": "C001",
                "allowed_commercial_codes": ["C001"],
                "predicted_ca": 0,
                "predicted_ca_known": True,
                "predicted_ca_source": "sales_history",
                "is_mandatory": True
            },
            {
                "client_id": "UNKNOWN-CA",
                "client_code": "00002",
                "client_name": "Unknown",
                "latitude": 36.82,
                "longitude": 10.19,
                "historical_commercial_code": "C001",
                "allowed_commercial_codes": ["C001"],
                "predicted_ca": None,
                "predicted_ca_known": False,
                "predicted_ca_source": "unavailable",
                "is_mandatory": True
            }
        ],
        commercials=build_commercials(count=1, days=1, max_visits=5),
        planning_days=1
    )

    normalized = normalize_payload(payload)
    known_zero_client = normalized["clients"][0]
    unknown_client = normalized["clients"][1]

    assert known_zero_client.predicted_ca == 0.0
    assert known_zero_client.predicted_ca_known is True
    assert known_zero_client.predicted_ca_source == "sales_history"
    assert unknown_client.predicted_ca is None
    assert unknown_client.predicted_ca_known is False
    assert unknown_client.predicted_ca_source == "unavailable"


def test_z_partial_predicted_ca_aggregation_marks_blocks_and_summary_as_incomplete():
    commercials = build_commercials(count=1, days=1, max_visits=3)
    clients = [
        {
            "client_id": "A-ID",
            "client_code": "A",
            "client_name": "A",
            "latitude": 36.81,
            "longitude": 10.18,
            "historical_commercial_code": "C001",
            "allowed_commercial_codes": ["C001"],
            "predicted_ca": 100,
            "predicted_ca_known": True,
            "predicted_ca_source": "sales_history",
            "is_mandatory": True
        },
        {
            "client_id": "B-ID",
            "client_code": "B",
            "client_name": "B",
            "latitude": 36.82,
            "longitude": 10.19,
            "historical_commercial_code": "C001",
            "allowed_commercial_codes": ["C001"],
            "predicted_ca": None,
            "predicted_ca_known": False,
            "predicted_ca_source": "unavailable",
            "is_mandatory": True
        },
        {
            "client_id": "C-ID",
            "client_code": "C",
            "client_name": "C",
            "latitude": 36.83,
            "longitude": 10.20,
            "historical_commercial_code": "C001",
            "allowed_commercial_codes": ["C001"],
            "predicted_ca": 50,
            "predicted_ca_known": True,
            "predicted_ca_source": "sales_history",
            "is_mandatory": True
        }
    ]
    payload = base_payload(clients=clients, commercials=commercials, planning_days=1)
    payload["allow_commercial_reassignment"] = False

    result = solve_coverage_plan(payload)
    block = result["blocks"][0]

    assert result["status"] == "success"
    assert block["predicted_ca"] == 150.0
    assert block["predicted_ca_known_count"] == 2
    assert block["predicted_ca_unknown_count"] == 1
    assert block["predicted_ca_is_complete"] is False
    assert result["summary"]["total_predicted_ca"] == 150.0
    assert result["summary"]["predicted_ca_known_count"] == 2
    assert result["summary"]["predicted_ca_unknown_count"] == 1
    assert result["summary"]["predicted_ca_is_complete"] is False


def test_aa_user_range_above_known_hard_capacity_stays_below_the_physical_limit():
    payload = base_payload(
        clients=build_clients(35),
        commercials=build_commercials(
            count=1,
            days=1,
            max_visits=60,
            hard_capacities={"C001": 30},
            user_preferred_min=50,
            user_preferred_max=60,
            effective_target_min=50,
            effective_target_max=60
        ),
        planning_days=1,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True
    )
    payload["user_min_visits_per_slot"] = 50
    payload["user_max_visits_per_slot"] = 60
    payload["allow_partial_plan"] = True

    result = solve_coverage_plan(payload)

    assert result["status"] == "partial_success"
    assert result["summary"]["missing_clients_count"] == 5
    assert result["effective_constraints"]["adjustment_reason"] == "insufficient_physical_capacity"
    assert result["blocks"][0]["clients_count"] == 30
    assert result["blocks"][0]["clients_count"] <= 30
    assert result["blocks"][0]["capacity"]["hard_capacity"] == 30
    assert result["blocks"][0]["capacity"]["hard_capacity_known"] is True


def test_ab_user_range_can_be_exceeded_when_coverage_requires_more_but_never_beyond_hard_capacity():
    payload = base_payload(
        clients=build_clients(225),
        commercials=build_commercials(
            count=1,
            days=1,
            max_visits=225,
            hard_capacities={"C001": 250},
            historical_soft_capacities={"C001": 40},
            user_preferred_min=50,
            user_preferred_max=60,
            effective_target_min=50,
            effective_target_max=225
        ),
        planning_days=1,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True
    )
    payload["user_min_visits_per_slot"] = 50
    payload["user_max_visits_per_slot"] = 60

    result = solve_coverage_plan(payload)

    assert result["status"] == "success"
    assert result["summary"]["unique_clients_covered"] == 225
    assert result["effective_constraints"]["adjustment_reason"] == "user_range_below_required_load"
    assert result["blocks"][0]["clients_count"] == 225
    assert result["blocks"][0]["clients_count"] <= 250
    assert result["blocks"][0]["capacity"]["user_preferred_max"] == 60
    assert result["blocks"][0]["capacity"]["effective_target_max"] == 225


def test_ac_sales_proxy_only_keeps_capacity_unknown_and_uses_a_soft_estimate():
    payload = base_payload(
        clients=build_clients(55),
        commercials=build_commercials(
            count=1,
            days=1,
            max_visits=60,
            historical_soft_capacities={"C001": 55},
            user_preferred_min=50,
            user_preferred_max=60,
            effective_target_min=50,
            effective_target_max=60
        ),
        planning_days=1,
        capacity_mode="sales_activity_proxy",
        operational_capacity_known=False
    )
    payload["user_min_visits_per_slot"] = 50
    payload["user_max_visits_per_slot"] = 60

    result = solve_coverage_plan(payload)

    assert result["status"] == "success"
    assert result["summary"]["unique_clients_covered"] == 55
    assert result["summary"]["operational_capacity_known"] is False
    assert result["summary"]["operational_status"] == "unknown"
    assert result["effective_constraints"]["hard_capacity_known"] is False
    assert result["effective_constraints"]["adjustment_reason"] == "terrain_capacity_unknown"
    assert result["blocks"][0]["capacity"]["hard_capacity"] is None
    assert result["blocks"][0]["capacity"]["hard_capacity_known"] is False


def test_ad_reasonable_user_range_is_kept_when_it_matches_coverage_and_capacity():
    payload = base_payload(
        clients=build_clients(25),
        commercials=build_commercials(
            count=1,
            days=1,
            max_visits=25,
            historical_soft_capacities={"C001": 25},
            user_preferred_min=20,
            user_preferred_max=30,
            effective_target_min=20,
            effective_target_max=30
        ),
        planning_days=1,
        capacity_mode="validated_visit_capacity",
        operational_capacity_known=True
    )
    payload["user_min_visits_per_slot"] = 20
    payload["user_max_visits_per_slot"] = 30

    result = solve_coverage_plan(payload)

    assert result["status"] == "success"
    assert result["summary"]["unique_clients_covered"] == 25
    assert result["effective_constraints"]["adjustment_reason"] == "user_range_accepted"
    assert result["blocks"][0]["clients_count"] == 25
    assert 20 <= result["blocks"][0]["clients_count"] <= 30


def test_ae_max_load_units_limit_is_respected_when_partial_planning_is_allowed():
    payload = base_payload(
        clients=build_clients(3, allowed_codes=["C001"]),
        commercials=build_commercials(
            count=1,
            days=1,
            max_visits=10,
            commercial_codes=["C001"]
        ),
        planning_days=1,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True
    )
    payload["allow_partial_plan"] = True
    payload["commercials"][0]["max_load_units_by_date"] = {
        START_DATE: 5.0
    }
    payload["clients"][0]["predicted_load_units"] = 2.5
    payload["clients"][1]["predicted_load_units"] = 2.5
    payload["clients"][2]["predicted_load_units"] = 2.0

    result = solve_coverage_plan(payload)

    assert result["status"] in {"partial_success", "success"}
    assert result["blocks"][0]["capacity"]["planned_load_units"] <= 5.0 + 1e-9
    assert result["diagnostics"]["truck_capacity_issues"] == []


def test_af_allowed_commercial_codes_are_never_violated():
    clients = [
        {
            **build_clients(1, allowed_codes=["C001"])[0],
            "client_id": "client_locked_a",
            "client_code": "00001",
            "allowed_commercial_codes": ["C001"],
            "historical_commercial_code": "C001"
        },
        {
            **build_clients(1, allowed_codes=["C002"])[0],
            "client_id": "client_locked_b",
            "client_code": "00002",
            "allowed_commercial_codes": ["C002"],
            "historical_commercial_code": "C002"
        }
    ]
    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=2,
            days=1,
            max_visits=2,
            commercial_codes=["C001", "C002"]
        ),
        planning_days=1,
        capacity_mode="validated_visit_capacity",
        operational_capacity_known=True
    )

    result = solve_coverage_plan(payload)
    assigned_by_client_id = {
        client["client_id"]: block["commercial_code"]
        for block in result["blocks"]
        for client in block["clients"]
    }

    assert result["status"] == "success"
    assert assigned_by_client_id["client_locked_a"] == "C001"
    assert assigned_by_client_id["client_locked_b"] == "C002"
    assert result["diagnostics"]["commercial_capacity_issues"] == []


def test_ag_known_additive_route_minutes_are_respected_at_the_limit():
    clients = build_clients(20, allowed_codes=["C001"], predicted_ca=50.0)
    for client in clients:
        client["service_minutes"] = 20
        client["service_minutes_known"] = True
        client["estimated_stop_minutes_by_commercial_date"] = {
            f"{START_DATE}::C001": 23
        }

    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=1,
            days=1,
            max_visits=30,
            commercial_codes=["C001"]
        ),
        planning_days=1,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True
    )
    payload["time_capacity_known"] = True
    payload["commercials"][0]["max_route_minutes_by_date"] = {START_DATE: 480}
    payload["commercials"][0]["break_minutes_by_date"] = {START_DATE: 20}

    result = solve_coverage_plan(payload)

    assert result["status"] == "success"
    assert result["blocks"][0]["clients_count"] == 20
    assert result["blocks"][0]["time"]["route_minutes_without_break"] == 460.0
    assert result["blocks"][0]["time"]["route_minutes_with_break"] == 480.0
    assert result["blocks"][0]["capacity"]["max_route_minutes"] == 480.0
    assert result["diagnostics"]["time_capacity_issues"] == []


def test_ah_excess_route_minutes_leave_clients_unplanned_without_invalid_route():
    clients = build_clients(25, allowed_codes=["C001"], predicted_ca=50.0)
    for client in clients:
        client["service_minutes"] = 20
        client["service_minutes_known"] = True
        client["estimated_stop_minutes_by_commercial_date"] = {
            f"{START_DATE}::C001": 23
        }

    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=1,
            days=1,
            max_visits=30,
            commercial_codes=["C001"]
        ),
        planning_days=1,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True
    )
    payload["allow_partial_plan"] = True
    payload["time_capacity_known"] = True
    payload["commercials"][0]["max_route_minutes_by_date"] = {START_DATE: 480}

    result = solve_coverage_plan(payload)

    assert result["status"] == "partial_success"
    assert result["summary"]["unique_clients_covered"] == 20
    assert result["summary"]["missing_clients_count"] == 5
    assert result["blocks"][0]["time"]["route_minutes_without_break"] == 460.0
    assert result["diagnostics"]["time_capacity_issues"] == []


def test_ai_shift_hours_minus_break_compute_route_minutes_budget():
    payload = base_payload(
        clients=build_clients(1, allowed_codes=["C001"]),
        commercials=build_commercials(
            count=1,
            days=1,
            max_visits=5,
            commercial_codes=["C001"]
        ),
        planning_days=1,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=False
    )
    payload["time_capacity_known"] = False
    payload["commercials"][0]["shift_start_time_by_date"] = {START_DATE: "08:00"}
    payload["commercials"][0]["shift_end_time_by_date"] = {START_DATE: "17:00"}
    payload["commercials"][0]["break_minutes_by_date"] = {START_DATE: 60}
    payload["commercials"][0]["max_route_minutes_by_date"] = {START_DATE: 480}

    normalized = normalize_payload(payload)
    slots = build_slots(normalized)

    assert slots[0].shift_start_time == "08:00:00"
    assert slots[0].shift_end_time == "17:00:00"
    assert slots[0].break_minutes == 60.0
    assert slots[0].max_route_minutes == 480.0


def test_aj_missing_time_inputs_keep_time_capacity_unknown_and_do_not_invent_a_hard_limit():
    clients = build_clients(30, allowed_codes=["C001"])
    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=1,
            days=1,
            max_visits=30,
            commercial_codes=["C001"]
        ),
        planning_days=1,
        capacity_mode="sales_activity_proxy",
        operational_capacity_known=False
    )
    payload["time_capacity_known"] = False
    payload["commercials"][0]["max_route_minutes_by_date"] = {START_DATE: 120}

    result = solve_coverage_plan(payload)

    assert result["status"] == "success"
    assert result["summary"]["time_capacity_known"] is False
    assert result["summary"]["operational_capacity_known"] is False
    assert result["blocks"][0]["capacity"]["time_capacity_known"] is False
    assert result["diagnostics"]["time_capacity_issues"] == []


def test_ak_route_time_and_truck_capacity_are_both_enforced():
    clients = build_clients(5, allowed_codes=["C001"])
    for client in clients:
        client["service_minutes"] = 15
        client["service_minutes_known"] = True
        client["predicted_load_units"] = 2.6
        client["estimated_stop_minutes_by_commercial_date"] = {
            f"{START_DATE}::C001": 15
        }

    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=1,
            days=1,
            max_visits=10,
            commercial_codes=["C001"]
        ),
        planning_days=1,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True
    )
    payload["allow_partial_plan"] = True
    payload["time_capacity_known"] = True
    payload["commercials"][0]["max_route_minutes_by_date"] = {START_DATE: 40}
    payload["commercials"][0]["max_load_units_by_date"] = {START_DATE: 5.0}

    result = solve_coverage_plan(payload)

    assert result["status"] == "partial_success"
    assert result["blocks"][0]["capacity"]["planned_load_units"] <= 5.0 + 1e-9
    assert result["blocks"][0]["time"]["route_minutes_without_break"] <= 40.0 + 1e-9
    assert result["diagnostics"]["truck_capacity_issues"] == []
    assert result["diagnostics"]["time_capacity_issues"] == []


def test_al_recovery_priority_places_the_higher_score_client_earlier():
    clients = build_clients(2, allowed_codes=["C001"], predicted_ca=50.0)
    clients[0]["client_id"] = "recovery-high"
    clients[0]["client_code"] = "R001"
    clients[0]["recovery_priority_score"] = 90
    clients[0]["recovery_expected_collection_amount"] = 200
    clients[0]["recovery_data_known"] = True
    clients[1]["client_id"] = "recovery-low"
    clients[1]["client_code"] = "R002"
    clients[1]["recovery_priority_score"] = 20
    clients[1]["recovery_expected_collection_amount"] = 200
    clients[1]["recovery_data_known"] = True

    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=1,
            days=2,
            max_visits=2,
            commercial_codes=["C001"],
            hard_capacities={"C001": 1}
        ),
        planning_days=2,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True
    )
    payload["allow_commercial_reassignment"] = False

    result = solve_coverage_plan(payload)
    client_dates = {
        client["client_id"]: block["date"]
        for block in result["blocks"]
        for client in block["clients"]
    }

    assert result["status"] == "success"
    assert client_dates["recovery-high"] < client_dates["recovery-low"]


def test_am_expected_collection_breaks_ties_between_equal_recovery_scores():
    clients = build_clients(2, allowed_codes=["C001"], predicted_ca=50.0)
    clients[0]["client_id"] = "collect-high"
    clients[0]["client_code"] = "C001A"
    clients[0]["recovery_priority_score"] = 50
    clients[0]["recovery_expected_collection_amount"] = 1000
    clients[0]["recovery_data_known"] = True
    clients[1]["client_id"] = "collect-low"
    clients[1]["client_code"] = "C001B"
    clients[1]["recovery_priority_score"] = 50
    clients[1]["recovery_expected_collection_amount"] = 100
    clients[1]["recovery_data_known"] = True

    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=1,
            days=2,
            max_visits=2,
            commercial_codes=["C001"],
            hard_capacities={"C001": 1}
        ),
        planning_days=2,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True
    )
    payload["allow_commercial_reassignment"] = False

    result = solve_coverage_plan(payload)
    client_dates = {
        client["client_id"]: block["date"]
        for block in result["blocks"]
        for client in block["clients"]
    }

    assert result["status"] == "success"
    assert client_dates["collect-high"] < client_dates["collect-low"]


def test_an_partial_capacity_keeps_the_highest_recovery_client_planned():
    clients = build_clients(2, allowed_codes=["C001"], predicted_ca=50.0)
    clients[0]["client_id"] = "planned-first"
    clients[0]["client_code"] = "P001"
    clients[0]["recovery_priority_score"] = 95
    clients[0]["recovery_expected_collection_amount"] = 800
    clients[0]["recovery_data_known"] = True
    clients[1]["client_id"] = "planned-second"
    clients[1]["client_code"] = "P002"
    clients[1]["recovery_priority_score"] = 10
    clients[1]["recovery_expected_collection_amount"] = 50
    clients[1]["recovery_data_known"] = True

    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=1,
            days=1,
            max_visits=2,
            commercial_codes=["C001"],
            hard_capacities={"C001": 1}
        ),
        planning_days=1,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True
    )
    payload["allow_partial_plan"] = True
    payload["allow_commercial_reassignment"] = False

    result = solve_coverage_plan(payload)
    planned_ids = [
        client["client_id"]
        for block in result["blocks"]
        for client in block["clients"]
    ]

    assert result["status"] == "partial_success"
    assert planned_ids == ["planned-first"]
    assert result["summary"]["missing_clients_count"] == 1


def test_ao_coverage_deadline_stays_ahead_of_recovery_priority():
    clients = build_clients(2, allowed_codes=["C001"], predicted_ca=50.0)
    clients[0]["client_id"] = "deadline-first"
    clients[0]["client_code"] = "D001"
    clients[0]["next_visit_deadline"] = START_DATE
    clients[0]["recovery_priority_score"] = 5
    clients[0]["recovery_expected_collection_amount"] = 50
    clients[0]["recovery_data_known"] = True
    clients[1]["client_id"] = "recovery-later"
    clients[1]["client_code"] = "D002"
    clients[1]["recovery_priority_score"] = 95
    clients[1]["recovery_expected_collection_amount"] = 1000
    clients[1]["recovery_data_known"] = True

    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=1,
            days=2,
            max_visits=2,
            commercial_codes=["C001"],
            hard_capacities={"C001": 1}
        ),
        planning_days=2,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True
    )
    payload["allow_commercial_reassignment"] = False

    result = solve_coverage_plan(payload)
    client_dates = {
        client["client_id"]: block["date"]
        for block in result["blocks"]
        for client in block["clients"]
    }

    assert result["status"] == "success"
    assert client_dates["deadline-first"] == START_DATE
    assert client_dates["deadline-first"] < client_dates["recovery-later"]


def test_ap_high_recovery_priority_does_not_bypass_physical_constraints():
    clients = build_clients(2, allowed_codes=["C001"], predicted_ca=50.0)
    clients[0]["client_id"] = "locked-high"
    clients[0]["client_code"] = "LOCKED-HIGH"
    clients[0]["recovery_priority_score"] = 98
    clients[0]["recovery_expected_collection_amount"] = 1200
    clients[0]["recovery_data_known"] = True
    clients[0]["predicted_load_units"] = 10.0
    clients[1]["client_id"] = "flex-low"
    clients[1]["client_code"] = "LOCKED-LOW"
    clients[1]["recovery_priority_score"] = 10
    clients[1]["recovery_expected_collection_amount"] = 100
    clients[1]["recovery_data_known"] = True
    clients[1]["predicted_load_units"] = 1.0
    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=1,
            days=1,
            max_visits=2,
            commercial_codes=["C001"],
            hard_capacities={"C001": 2}
        ),
        planning_days=1,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True
    )
    payload["allow_partial_plan"] = True
    payload["commercials"][0]["max_load_units_by_date"] = {START_DATE: 5.0}

    result = solve_coverage_plan(payload)
    planned_ids = [
        client["client_id"]
        for block in result["blocks"]
        for client in block["clients"]
    ]

    assert result["status"] == "partial_success"
    assert planned_ids == ["flex-low"]
    assert result["diagnostics"]["commercial_capacity_issues"] == []


def test_aq_missing_recovery_data_keeps_client_plannable_and_preserves_nulls():
    clients = build_clients(1, allowed_codes=["C001"], predicted_ca=50.0)
    payload = base_payload(
        clients=clients,
        commercials=build_commercials(count=1, days=1, max_visits=1, commercial_codes=["C001"]),
        planning_days=1
    )
    payload["allow_commercial_reassignment"] = False

    result = solve_coverage_plan(payload)
    planned_client = result["blocks"][0]["clients"][0]

    assert result["status"] == "success"
    assert planned_client["recovery_data_known"] is False
    assert planned_client["recovery_priority_score"] is None
    assert planned_client["recovery_expected_collection_amount"] is None
    assert result["recovery_summary"]["clients_with_recovery_data"] == 0
    assert result["recovery_summary"]["clients_without_recovery_data"] == 1


def test_ar_client_ids_keep_recovery_profiles_distinct_when_codes_share_normalized_value():
    clients = [
        {
            **build_clients(1, allowed_codes=["C001"], predicted_ca=50.0)[0],
            "client_id": "1",
            "client_code": "00152",
            "recovery_priority_score": 90,
            "recovery_expected_collection_amount": 400,
            "recovery_data_known": True
        },
        {
            **build_clients(1, allowed_codes=["C001"], predicted_ca=50.0)[0],
            "client_id": "2",
            "client_code": "152",
            "recovery_priority_score": 20,
            "recovery_expected_collection_amount": 100,
            "recovery_data_known": True
        }
    ]
    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=1,
            days=2,
            max_visits=2,
            commercial_codes=["C001"],
            hard_capacities={"C001": 1}
        ),
        planning_days=2,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True
    )
    payload["allow_commercial_reassignment"] = False

    result = solve_coverage_plan(payload)
    by_client_id = {
        client["client_id"]: (block["date"], client["recovery_priority_score"])
        for block in result["blocks"]
        for client in block["clients"]
    }

    assert result["status"] == "success"
    assert by_client_id["1"][0] < by_client_id["2"][0]
    assert by_client_id["1"][1] == 90
    assert by_client_id["2"][1] == 20


def test_as_complete_coverage_keeps_all_clients_and_orders_dates_by_recovery_priority():
    clients = build_clients(3, allowed_codes=["C001"], predicted_ca=50.0)
    priorities = [90, 60, 10]
    collections = [500, 300, 100]
    for index, client in enumerate(clients):
        client["client_id"] = f"ordered-{index + 1}"
        client["client_code"] = f"ORD{index + 1:03d}"
        client["recovery_priority_score"] = priorities[index]
        client["recovery_expected_collection_amount"] = collections[index]
        client["recovery_data_known"] = True

    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=1,
            days=3,
            max_visits=2,
            commercial_codes=["C001"],
            hard_capacities={"C001": 1}
        ),
        planning_days=3,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True
    )
    payload["allow_commercial_reassignment"] = False

    result = solve_coverage_plan(payload)
    ordered_rows = sorted(
        (
            block["date"],
            block["clients"][0]["client_id"],
            block["clients"][0]["recovery_priority_score"]
        )
        for block in result["blocks"]
        if block["clients"]
    )

    assert result["status"] == "success"
    assert result["summary"]["unique_clients_covered"] == 3
    assert result["summary"]["missing_clients_count"] == 0
    assert [row[2] for row in ordered_rows] == [90, 60, 10]


def test_bc_sales_coverage_ignores_recovery_priority_score():
    clients = build_clients(2, allowed_codes=["C001"], predicted_ca=50.0)
    clients[0]["client_id"] = "sales-first"
    clients[0]["client_code"] = "S001"
    clients[0]["purchase_prediction_score"] = 80
    clients[0]["predicted_purchase_date"] = "2026-08-04"
    clients[0]["purchase_days_until_prediction"] = 1
    clients[0]["expected_order_value"] = 300
    clients[0]["recommended_quantity"] = 4
    clients[0]["purchase_prediction_known"] = True
    clients[0]["recovery_priority_score"] = 5
    clients[0]["recovery_expected_collection_amount"] = 50
    clients[0]["recovery_data_known"] = True
    clients[1]["client_id"] = "recovery-heavy"
    clients[1]["client_code"] = "S002"
    clients[1]["purchase_prediction_score"] = 20
    clients[1]["predicted_purchase_date"] = "2026-08-04"
    clients[1]["purchase_days_until_prediction"] = 1
    clients[1]["expected_order_value"] = 300
    clients[1]["recommended_quantity"] = 4
    clients[1]["purchase_prediction_known"] = True
    clients[1]["recovery_priority_score"] = 99
    clients[1]["recovery_expected_collection_amount"] = 1500
    clients[1]["recovery_data_known"] = True

    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=1,
            days=2,
            max_visits=2,
            commercial_codes=["C001"],
            hard_capacities={"C001": 1}
        ),
        planning_days=2,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True,
        planning_mode="sales_coverage"
    )

    result = solve_coverage_plan(payload)
    planned_dates = {
        client["client_id"]: block["date"]
        for block in result["blocks"]
        for client in block["clients"]
    }

    assert result["status"] == "success"
    assert planned_dates["sales-first"] < planned_dates["recovery-heavy"]


def test_bd_sales_coverage_keeps_critical_deadline_ahead_of_high_debt():
    clients = build_clients(2, allowed_codes=["C001"], predicted_ca=50.0)
    clients[0]["client_id"] = "critical-first"
    clients[0]["client_code"] = "CR001"
    clients[0]["next_visit_deadline"] = START_DATE
    clients[0]["purchase_prediction_score"] = 15
    clients[0]["purchase_prediction_known"] = True
    clients[1]["client_id"] = "debt-later"
    clients[1]["client_code"] = "CR002"
    clients[1]["purchase_prediction_score"] = 85
    clients[1]["purchase_prediction_known"] = True
    clients[1]["recovery_priority_score"] = 100
    clients[1]["recovery_expected_collection_amount"] = 5000
    clients[1]["recovery_data_known"] = True

    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=1,
            days=2,
            max_visits=2,
            commercial_codes=["C001"],
            hard_capacities={"C001": 1}
        ),
        planning_days=2,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True,
        planning_mode="sales_coverage"
    )

    result = solve_coverage_plan(payload)
    planned_dates = {
        client["client_id"]: block["date"]
        for block in result["blocks"]
        for client in block["clients"]
    }

    assert result["status"] == "success"
    assert planned_dates["critical-first"] == START_DATE
    assert planned_dates["critical-first"] < planned_dates["debt-later"]


def test_be_sales_coverage_prefers_vip_85_before_vip_20():
    clients = build_clients(2, allowed_codes=["C001"], predicted_ca=50.0)
    clients[0]["client_id"] = "vip-high"
    clients[0]["client_code"] = "VIP001"
    clients[0]["purchase_prediction_score"] = 85
    clients[0]["predicted_purchase_date"] = "2026-08-05"
    clients[0]["purchase_days_until_prediction"] = 2
    clients[0]["expected_order_value"] = 200
    clients[0]["purchase_prediction_known"] = True
    clients[1]["client_id"] = "vip-low"
    clients[1]["client_code"] = "VIP002"
    clients[1]["purchase_prediction_score"] = 20
    clients[1]["predicted_purchase_date"] = "2026-08-05"
    clients[1]["purchase_days_until_prediction"] = 2
    clients[1]["expected_order_value"] = 200
    clients[1]["purchase_prediction_known"] = True

    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=1,
            days=2,
            max_visits=2,
            commercial_codes=["C001"],
            hard_capacities={"C001": 1}
        ),
        planning_days=2,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True,
        planning_mode="sales_coverage"
    )

    result = solve_coverage_plan(payload)
    planned_dates = {
        client["client_id"]: block["date"]
        for block in result["blocks"]
        for client in block["clients"]
    }

    assert result["status"] == "success"
    assert planned_dates["vip-high"] < planned_dates["vip-low"]


def test_bf_sales_coverage_prefers_near_purchase_date_before_late_purchase_date():
    clients = build_clients(2, allowed_codes=["C001"], predicted_ca=50.0)
    clients[0]["client_id"] = "buy-near"
    clients[0]["client_code"] = "BUY001"
    clients[0]["purchase_prediction_score"] = 60
    clients[0]["predicted_purchase_date"] = "2026-08-04"
    clients[0]["purchase_days_until_prediction"] = 1
    clients[0]["expected_order_value"] = 200
    clients[0]["purchase_prediction_known"] = True
    clients[1]["client_id"] = "buy-late"
    clients[1]["client_code"] = "BUY002"
    clients[1]["purchase_prediction_score"] = 60
    clients[1]["predicted_purchase_date"] = "2026-08-12"
    clients[1]["purchase_days_until_prediction"] = 9
    clients[1]["expected_order_value"] = 200
    clients[1]["purchase_prediction_known"] = True

    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=1,
            days=2,
            max_visits=2,
            commercial_codes=["C001"],
            hard_capacities={"C001": 1}
        ),
        planning_days=2,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True,
        planning_mode="sales_coverage"
    )

    result = solve_coverage_plan(payload)
    planned_dates = {
        client["client_id"]: block["date"]
        for block in result["blocks"]
        for client in block["clients"]
    }

    assert result["status"] == "success"
    assert planned_dates["buy-near"] < planned_dates["buy-late"]


def test_bg_sales_coverage_daily_ca_target_influences_composition_when_realisable():
    clients = build_clients(2, allowed_codes=["C001"], predicted_ca=0.0)
    clients[0]["client_id"] = "ca-high"
    clients[0]["client_code"] = "CA001"
    clients[0]["predicted_ca"] = 650
    clients[0]["purchase_prediction_score"] = 50
    clients[0]["expected_order_value"] = 650
    clients[0]["purchase_prediction_known"] = True
    clients[1]["client_id"] = "ca-low"
    clients[1]["client_code"] = "CA002"
    clients[1]["predicted_ca"] = 120
    clients[1]["purchase_prediction_score"] = 50
    clients[1]["expected_order_value"] = 120
    clients[1]["purchase_prediction_known"] = True

    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=1,
            days=1,
            max_visits=2,
            min_ca=500,
            commercial_codes=["C001"],
            hard_capacities={"C001": 1}
        ),
        planning_days=1,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True,
        planning_mode="sales_coverage"
    )
    payload["allow_partial_plan"] = True

    result = solve_coverage_plan(payload)
    planned_ids = [
        client["client_id"]
        for block in result["blocks"]
        for client in block["clients"]
    ]

    assert result["status"] == "partial_success"
    assert planned_ids == ["ca-high"]
    assert result["blocks"][0]["min_daily_ca_status"] == "reached"


def test_bh_sales_coverage_never_exceeds_hard_constraints():
    clients = build_clients(2, allowed_codes=["C001"], predicted_ca=50.0)
    clients[0]["client_id"] = "hard-big"
    clients[0]["client_code"] = "HC001"
    clients[0]["purchase_prediction_score"] = 95
    clients[0]["predicted_load_units"] = 10.0
    clients[0]["purchase_prediction_known"] = True
    clients[1]["client_id"] = "hard-small"
    clients[1]["client_code"] = "HC002"
    clients[1]["purchase_prediction_score"] = 10
    clients[1]["predicted_load_units"] = 1.0
    clients[1]["purchase_prediction_known"] = True

    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=1,
            days=1,
            max_visits=2,
            commercial_codes=["C001"],
            hard_capacities={"C001": 2}
        ),
        planning_days=1,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True,
        planning_mode="sales_coverage"
    )
    payload["allow_partial_plan"] = True
    payload["commercials"][0]["max_load_units_by_date"] = {START_DATE: 5.0}

    result = solve_coverage_plan(payload)

    assert result["status"] == "partial_success"
    assert result["blocks"][0]["capacity"]["planned_load_units"] <= 5.0 + 1e-9
    assert result["diagnostics"]["truck_capacity_issues"] == []


def test_bi_sales_coverage_keeps_client_without_prediction_plannable():
    clients = build_clients(1, allowed_codes=["C001"], predicted_ca=0.0)
    clients[0]["predicted_ca"] = None
    clients[0]["expected_order_value"] = None
    clients[0]["purchase_prediction_score"] = None
    clients[0]["purchase_prediction_known"] = False

    payload = base_payload(
        clients=clients,
        commercials=build_commercials(count=1, days=1, max_visits=1, commercial_codes=["C001"]),
        planning_days=1,
        planning_mode="sales_coverage"
    )

    result = solve_coverage_plan(payload)
    row = result["blocks"][0]["clients"][0]

    assert result["status"] == "success"
    assert row["purchase_prediction_known"] is False
    assert row["purchase_prediction_score"] is None
    assert row["expected_order_value"] is None


def test_bj_sales_coverage_keeps_00152_and_152_distinct():
    clients = build_clients(2, allowed_codes=["C001"], predicted_ca=50.0)
    clients[0]["client_id"] = "1"
    clients[0]["client_code"] = "00152"
    clients[0]["purchase_prediction_score"] = 90
    clients[0]["purchase_prediction_known"] = True
    clients[1]["client_id"] = "2"
    clients[1]["client_code"] = "152"
    clients[1]["purchase_prediction_score"] = 20
    clients[1]["purchase_prediction_known"] = True

    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=1,
            days=2,
            max_visits=2,
            commercial_codes=["C001"],
            hard_capacities={"C001": 1}
        ),
        planning_days=2,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True,
        planning_mode="sales_coverage"
    )

    result = solve_coverage_plan(payload)
    planned = {
        client["client_id"]: client["client_code"]
        for block in result["blocks"]
        for client in block["clients"]
    }

    assert result["status"] == "success"
    assert planned["1"] == "00152"
    assert planned["2"] == "152"


def test_bk_sales_coverage_never_duplicates_client_ids():
    payload = base_payload(
        clients=build_clients(6, allowed_codes=["C001"], predicted_ca=50.0),
        commercials=build_commercials(
            count=1,
            days=6,
            max_visits=2,
            commercial_codes=["C001"],
            hard_capacities={"C001": 1}
        ),
        planning_days=6,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True,
        planning_mode="sales_coverage"
    )

    result = solve_coverage_plan(payload)
    planned_client_ids = [
        client["client_id"]
        for block in result["blocks"]
        for client in block["clients"]
    ]

    assert result["status"] == "success"
    assert len(planned_client_ids) == len(set(planned_client_ids))
    assert result["summary"]["duplicate_clients_count"] == 0


def test_at_purchase_score_85_is_scheduled_before_purchase_score_20_at_equal_conditions():
    clients = build_clients(2, allowed_codes=["C001"], predicted_ca=50.0)
    scores = [85, 20]
    for index, client in enumerate(clients):
      client["client_id"] = f"purchase-score-{index + 1}"
      client["client_code"] = f"PS{index + 1:03d}"
      client["purchase_prediction_score"] = scores[index]
      client["predicted_purchase_date"] = "2026-08-05"
      client["purchase_days_until_prediction"] = 2
      client["expected_order_value"] = 200
      client["recommended_quantity"] = 5
      client["purchase_prediction_known"] = True

    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=1,
            days=2,
            max_visits=2,
            commercial_codes=["C001"],
            hard_capacities={"C001": 1}
        ),
        planning_days=2,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True
    )
    payload["allow_commercial_reassignment"] = False

    result = solve_coverage_plan(payload)
    dates = {
        client["client_id"]: block["date"]
        for block in result["blocks"]
        for client in block["clients"]
    }

    assert result["status"] == "success"
    assert dates["purchase-score-1"] < dates["purchase-score-2"]


def test_au_purchase_in_2_days_is_scheduled_before_purchase_in_20_days():
    clients = build_clients(2, allowed_codes=["C001"], predicted_ca=50.0)
    days_until = [2, 20]
    dates_predicted = ["2026-08-05", "2026-08-23"]
    for index, client in enumerate(clients):
      client["client_id"] = f"purchase-date-{index + 1}"
      client["client_code"] = f"PD{index + 1:03d}"
      client["purchase_prediction_score"] = 60
      client["predicted_purchase_date"] = dates_predicted[index]
      client["purchase_days_until_prediction"] = days_until[index]
      client["expected_order_value"] = 200
      client["recommended_quantity"] = 5
      client["purchase_prediction_known"] = True

    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=1,
            days=2,
            max_visits=2,
            commercial_codes=["C001"],
            hard_capacities={"C001": 1}
        ),
        planning_days=2,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True
    )

    result = solve_coverage_plan(payload)
    dates = {
        client["client_id"]: block["date"]
        for block in result["blocks"]
        for client in block["clients"]
    }

    assert result["status"] == "success"
    assert dates["purchase-date-1"] < dates["purchase-date-2"]


def test_av_overdue_recovery_stays_ahead_of_high_purchase_score():
    clients = build_clients(2, allowed_codes=["C001"], predicted_ca=50.0)
    clients[0]["client_id"] = "recovery-critical"
    clients[0]["client_code"] = "RC001"
    clients[0]["recovery_priority_score"] = 90
    clients[0]["recovery_expected_collection_amount"] = 600
    clients[0]["recovery_days_past_due"] = 15
    clients[0]["recovery_due_amount"] = 600
    clients[0]["recovery_data_known"] = True
    clients[1]["client_id"] = "purchase-high"
    clients[1]["client_code"] = "PH001"
    clients[1]["purchase_prediction_score"] = 95
    clients[1]["predicted_purchase_date"] = "2026-08-04"
    clients[1]["purchase_days_until_prediction"] = 1
    clients[1]["expected_order_value"] = 900
    clients[1]["recommended_quantity"] = 12
    clients[1]["purchase_prediction_known"] = True

    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=1,
            days=2,
            max_visits=2,
            commercial_codes=["C001"],
            hard_capacities={"C001": 1}
        ),
        planning_days=2,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True
    )

    result = solve_coverage_plan(payload)
    dates = {
        client["client_id"]: block["date"]
        for block in result["blocks"]
        for client in block["clients"]
    }

    assert result["status"] == "success"
    assert dates["recovery-critical"] < dates["purchase-high"]


def test_aw_coverage_deadline_stays_ahead_of_purchase_score():
    clients = build_clients(2, allowed_codes=["C001"], predicted_ca=50.0)
    clients[0]["client_id"] = "deadline-critical"
    clients[0]["client_code"] = "DC001"
    clients[0]["next_visit_deadline"] = START_DATE
    clients[1]["client_id"] = "purchase-opportunity"
    clients[1]["client_code"] = "PO001"
    clients[1]["purchase_prediction_score"] = 95
    clients[1]["predicted_purchase_date"] = "2026-08-04"
    clients[1]["purchase_days_until_prediction"] = 1
    clients[1]["expected_order_value"] = 1000
    clients[1]["recommended_quantity"] = 10
    clients[1]["purchase_prediction_known"] = True

    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=1,
            days=2,
            max_visits=2,
            commercial_codes=["C001"],
            hard_capacities={"C001": 1}
        ),
        planning_days=2,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True
    )

    result = solve_coverage_plan(payload)
    dates = {
        client["client_id"]: block["date"]
        for block in result["blocks"]
        for client in block["clients"]
    }

    assert result["status"] == "success"
    assert dates["deadline-critical"] == START_DATE
    assert dates["deadline-critical"] < dates["purchase-opportunity"]


def test_ax_purchase_score_breaks_partial_capacity_ties_after_urgencies():
    clients = build_clients(2, allowed_codes=["C001"], predicted_ca=50.0)
    clients[0]["client_id"] = "partial-buy-high"
    clients[0]["client_code"] = "PB001"
    clients[0]["purchase_prediction_score"] = 85
    clients[0]["predicted_purchase_date"] = "2026-08-05"
    clients[0]["purchase_days_until_prediction"] = 2
    clients[0]["expected_order_value"] = 500
    clients[0]["recommended_quantity"] = 8
    clients[0]["purchase_prediction_known"] = True
    clients[1]["client_id"] = "partial-buy-low"
    clients[1]["client_code"] = "PB002"
    clients[1]["purchase_prediction_score"] = 20
    clients[1]["predicted_purchase_date"] = "2026-08-05"
    clients[1]["purchase_days_until_prediction"] = 2
    clients[1]["expected_order_value"] = 500
    clients[1]["recommended_quantity"] = 8
    clients[1]["purchase_prediction_known"] = True

    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=1,
            days=1,
            max_visits=2,
            commercial_codes=["C001"],
            hard_capacities={"C001": 1}
        ),
        planning_days=1,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True
    )
    payload["allow_partial_plan"] = True

    result = solve_coverage_plan(payload)
    planned_ids = [
        client["client_id"]
        for block in result["blocks"]
        for client in block["clients"]
    ]

    assert result["status"] == "partial_success"
    assert planned_ids == ["partial-buy-high"]


def test_ay_client_without_purchase_prediction_stays_plannable_with_nulls():
    clients = build_clients(1, allowed_codes=["C001"], predicted_ca=50.0)
    payload = base_payload(
        clients=clients,
        commercials=build_commercials(count=1, days=1, max_visits=1, commercial_codes=["C001"]),
        planning_days=1
    )

    result = solve_coverage_plan(payload)
    row = result["blocks"][0]["clients"][0]

    assert result["status"] == "success"
    assert row["purchase_prediction_known"] is False
    assert row["purchase_prediction_score"] is None
    assert row["expected_order_value"] is None
    assert result["purchase_prediction_summary"]["clients_with_prediction"] == 0
    assert result["purchase_prediction_summary"]["clients_without_prediction"] == 1


def test_az_high_purchase_score_never_breaks_hard_constraints():
    clients = build_clients(2, allowed_codes=["C001"], predicted_ca=50.0)
    clients[0]["client_id"] = "hard-high"
    clients[0]["client_code"] = "HC001"
    clients[0]["purchase_prediction_score"] = 95
    clients[0]["predicted_purchase_date"] = "2026-08-04"
    clients[0]["purchase_days_until_prediction"] = 1
    clients[0]["expected_order_value"] = 800
    clients[0]["recommended_quantity"] = 8
    clients[0]["purchase_prediction_known"] = True
    clients[0]["predicted_load_units"] = 10.0
    clients[1]["client_id"] = "hard-low"
    clients[1]["client_code"] = "HC002"
    clients[1]["purchase_prediction_score"] = 10
    clients[1]["predicted_purchase_date"] = "2026-08-04"
    clients[1]["purchase_days_until_prediction"] = 1
    clients[1]["expected_order_value"] = 100
    clients[1]["recommended_quantity"] = 2
    clients[1]["purchase_prediction_known"] = True
    clients[1]["predicted_load_units"] = 1.0

    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=1,
            days=1,
            max_visits=2,
            commercial_codes=["C001"],
            hard_capacities={"C001": 2}
        ),
        planning_days=1,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True
    )
    payload["allow_partial_plan"] = True
    payload["commercials"][0]["max_load_units_by_date"] = {START_DATE: 5.0}

    result = solve_coverage_plan(payload)

    assert result["status"] == "partial_success"
    assert result["blocks"][0]["capacity"]["planned_load_units"] <= 5.0 + 1e-9
    assert result["diagnostics"]["truck_capacity_issues"] == []


def test_ba_client_ids_keep_purchase_predictions_distinct_for_00152_and_152():
    clients = build_clients(2, allowed_codes=["C001"], predicted_ca=50.0)
    clients[0]["client_id"] = "1"
    clients[0]["client_code"] = "00152"
    clients[0]["purchase_prediction_score"] = 90
    clients[0]["predicted_purchase_date"] = "2026-08-05"
    clients[0]["purchase_days_until_prediction"] = 2
    clients[0]["expected_order_value"] = 600
    clients[0]["recommended_quantity"] = 6
    clients[0]["purchase_prediction_known"] = True
    clients[1]["client_id"] = "2"
    clients[1]["client_code"] = "152"
    clients[1]["purchase_prediction_score"] = 20
    clients[1]["predicted_purchase_date"] = "2026-08-05"
    clients[1]["purchase_days_until_prediction"] = 2
    clients[1]["expected_order_value"] = 100
    clients[1]["recommended_quantity"] = 1
    clients[1]["purchase_prediction_known"] = True

    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=1,
            days=2,
            max_visits=2,
            commercial_codes=["C001"],
            hard_capacities={"C001": 1}
        ),
        planning_days=2,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True
    )

    result = solve_coverage_plan(payload)
    dates = {
        client["client_id"]: (block["date"], client["purchase_prediction_score"])
        for block in result["blocks"]
        for client in block["clients"]
    }

    assert result["status"] == "success"
    assert dates["1"][0] < dates["2"][0]
    assert dates["1"][1] == 90
    assert dates["2"][1] == 20


def test_bb_complete_coverage_keeps_all_clients_and_adjusts_dates_by_purchase_opportunity():
    clients = build_clients(3, allowed_codes=["C001"], predicted_ca=50.0)
    scores = [90, 60, 10]
    values = [700, 400, 100]
    for index, client in enumerate(clients):
      client["client_id"] = f"pc-{index + 1}"
      client["client_code"] = f"PC{index + 1:03d}"
      client["purchase_prediction_score"] = scores[index]
      client["predicted_purchase_date"] = f"2026-08-0{index + 4}"
      client["purchase_days_until_prediction"] = index + 1
      client["expected_order_value"] = values[index]
      client["recommended_quantity"] = index + 1
      client["purchase_prediction_known"] = True

    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=1,
            days=3,
            max_visits=2,
            commercial_codes=["C001"],
            hard_capacities={"C001": 1}
        ),
        planning_days=3,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True
    )

    result = solve_coverage_plan(payload)
    ordered_rows = sorted(
        (
            block["date"],
            block["clients"][0]["client_id"],
            block["clients"][0]["purchase_prediction_score"]
        )
        for block in result["blocks"]
        if block["clients"]
    )

    assert result["status"] == "success"
    assert result["summary"]["unique_clients_covered"] == 3
    assert result["summary"]["missing_clients_count"] == 0
    assert [row[2] for row in ordered_rows] == [90, 60, 10]


def test_bl_unified_context_reuses_candidates_and_distances_once():
    payload = base_payload(
        clients=build_clients(3, allowed_codes=["C001"], predicted_ca=100.0),
        commercials=build_commercials(
            count=1,
            days=2,
            max_visits=3,
            commercial_codes=["C001"],
            hard_capacities={"C001": 2}
        ),
        planning_days=2,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True,
        planning_mode="sales_coverage"
    )

    normalized = normalize_payload(payload)
    context = build_coverage_optimization_context(normalized, payload_already_normalized=True)
    analysis = build_coverage_analysis_summary_from_context(context)
    assignments_first, assignment_index_first = build_assignment_candidates(
        context.payload,
        context.slots,
        context.mandatory_clients,
        context.feasible_slots_by_client,
        context=context
    )
    assignments_second, assignment_index_second = build_assignment_candidates(
        context.payload,
        context.slots,
        context.mandatory_clients,
        context.feasible_slots_by_client,
        context=context
    )

    build_client_priority_breakdown(context.payload, context.slots[0], context.mandatory_clients[0], context=context)
    build_client_priority_breakdown(context.payload, context.slots[0], context.mandatory_clients[0], context=context)

    assert analysis["input_summary"]["mandatory_clients_count"] == len(context.mandatory_clients)
    assert analysis["feasibility"]["total_slots"] == len(context.slots)
    assert len(assignments_first) == sum(len(slot_ids) for slot_ids in context.feasible_slots_by_client.values())
    assert assignments_first is assignments_second
    assert assignment_index_first is assignment_index_second
    assert context.diagnostics["build_feasible_slot_ids_by_client_calls"] == 1
    assert context.diagnostics["build_assignment_candidates_calls"] == 1
    assert context.diagnostics["distance_cache_hits"] >= 1
    assert context.diagnostics["distance_cache_misses"] >= 1


def test_bm_unified_solver_attaches_same_analysis_summary_as_shared_context():
    clients = build_clients(4, allowed_codes=["C001"], predicted_ca=80.0)
    clients[0]["client_id"] = "1"
    clients[0]["client_code"] = "00152"
    clients[0]["purchase_prediction_score"] = 80
    clients[0]["purchase_prediction_known"] = True
    clients[1]["client_id"] = "2"
    clients[1]["client_code"] = "152"
    clients[1]["purchase_prediction_score"] = 40
    clients[1]["purchase_prediction_known"] = True
    clients[2]["purchase_prediction_known"] = False
    clients[2]["predicted_ca"] = None
    clients[2]["expected_order_value"] = None
    clients[3]["purchase_prediction_score"] = 60
    clients[3]["purchase_prediction_known"] = True

    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=1,
            days=4,
            max_visits=2,
            commercial_codes=["C001"],
            hard_capacities={"C001": 1}
        ),
        planning_days=4,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True,
        planning_mode="sales_coverage"
    )

    normalized = normalize_payload(payload)
    shared_context = build_coverage_optimization_context(normalized, payload_already_normalized=True)
    expected_analysis = build_coverage_analysis_summary_from_context(shared_context)
    result = solve_coverage_plan(payload)
    planned_client_ids = [
        client["client_id"]
        for block in result["blocks"]
        for client in block["clients"]
    ]

    assert result["analysis"] == expected_analysis
    assert result["summary"]["duplicate_clients_count"] == 0
    assert len(planned_client_ids) == len(set(planned_client_ids))
    assert "1" in planned_client_ids
    assert "2" in planned_client_ids


def test_bn_candidate_pairs_are_deduplicated_only_when_strictly_identical():
    assignments = [
        {
            "client_id": "1",
            "slot_id": "2026-08-03::C001",
            "slot_index": 0,
            "predicted_ca_cents": 1000,
            "predicted_load_units_centi": 200,
            "predicted_stop_minutes_centi": 300,
            "distance_penalty": 10,
            "coverage_date_penalty": 20,
            "recovery_date_penalty": 0,
            "expected_collection_date_penalty": 0,
            "purchase_score_date_penalty": 30,
            "purchase_timing_date_penalty": 40,
            "expected_order_date_penalty": 50,
            "reassignment_penalty": 0
        },
        {
            "client_id": "1",
            "slot_id": "2026-08-03::C001",
            "slot_index": 0,
            "predicted_ca_cents": 1000,
            "predicted_load_units_centi": 200,
            "predicted_stop_minutes_centi": 300,
            "distance_penalty": 10,
            "coverage_date_penalty": 20,
            "recovery_date_penalty": 0,
            "expected_collection_date_penalty": 0,
            "purchase_score_date_penalty": 30,
            "purchase_timing_date_penalty": 40,
            "expected_order_date_penalty": 50,
            "reassignment_penalty": 0
        },
        {
            "client_id": "2",
            "slot_id": "2026-08-03::C001",
            "slot_index": 0,
            "predicted_ca_cents": 2000,
            "predicted_load_units_centi": 100,
            "predicted_stop_minutes_centi": 200,
            "distance_penalty": 5,
            "coverage_date_penalty": 10,
            "recovery_date_penalty": 0,
            "expected_collection_date_penalty": 0,
            "purchase_score_date_penalty": 15,
            "purchase_timing_date_penalty": 25,
            "expected_order_date_penalty": 35,
            "reassignment_penalty": 1
        }
    ]

    unique_assignments, candidate_by_key, removed_duplicates = deduplicate_assignment_candidates(assignments)
    index_data = build_solver_candidate_indices(
        assignments,
        mandatory_clients=[
            normalize_payload(base_payload(build_clients(2), build_commercials(count=1, days=1)))["clients"][0],
            normalize_payload(base_payload(build_clients(2), build_commercials(count=1, days=1)))["clients"][1]
        ],
        slots=build_slots(normalize_payload(base_payload(build_clients(2), build_commercials(count=1, days=1))))
    )

    assert removed_duplicates == 1
    assert len(unique_assignments) == 2
    assert len(candidate_by_key) == 2
    assert index_data["removed_duplicate_candidate_pairs"] == 1
    assert len(index_data["candidate_by_client_slot"]) == 2
    assert ("1", "2026-08-03::C001") in index_data["candidate_by_client_slot"]
    assert ("2", "2026-08-03::C001") in index_data["candidate_by_client_slot"]


def test_bo_cp_sat_artifacts_prebuild_indices_and_aggregate_objective_exactly():
    payload = base_payload(
        clients=build_clients(3, allowed_codes=["C001"], predicted_ca=90.0),
        commercials=build_commercials(
            count=1,
            days=2,
            max_visits=3,
            commercial_codes=["C001"],
            hard_capacities={"C001": 2}
        ),
        planning_days=2,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True,
        planning_mode="sales_coverage"
    )

    normalized = normalize_payload(payload)
    context = build_coverage_optimization_context(normalized, payload_already_normalized=True)
    feasibility = compute_feasibility_from_context(context)
    assignments, _ = build_assignment_candidates(
        context.payload,
        context.slots,
        context.mandatory_clients,
        context.feasible_slots_by_client,
        context=context
    )
    distribution_context = build_capacity_distribution_context(context.slots, context.slot_targets, len(context.mandatory_clients))
    artifacts, _ = build_coverage_cp_sat_model_artifacts(
        raw_payload=payload,
        payload=context.payload,
        slots=context.slots,
        mandatory_clients=context.mandatory_clients,
        assignments=assignments,
        slot_targets=feasibility["slot_targets"],
        slot_soft_capacities=feasibility["slot_soft_capacities"],
        commercial_soft_capacity_totals=distribution_context["commercial_soft_capacity_totals"],
        commercial_target_totals=distribution_context["commercial_target_totals"],
        global_ratio_target_scaled=max(0, int(round(float(distribution_context.get("global_ratio_target", 1.0) or 1.0) * 100))),
        include_fingerprint_payload=True
    )

    objective_by_key = {
        tuple(item["key"]): item["coefficient"]
        for item in artifacts.model_stats["model_fingerprint_payload"]["objective"]
    }
    expected_assignment_coefficients = {}
    for assignment in artifacts.assignments:
        key = ("x", assignment["client_id"], assignment["slot_id"])
        expected_assignment_coefficients[key] = (
            int(assignment["coverage_date_penalty"] or 0) * 100 +
            int(assignment["recovery_date_penalty"] or 0) * 0 +
            int(assignment["expected_collection_date_penalty"] or 0) * 0 +
            int(assignment["purchase_score_date_penalty"] or 0) +
            int(assignment["purchase_timing_date_penalty"] or 0) +
            int(assignment["expected_order_date_penalty"] or 0) +
            int(assignment["reassignment_penalty"] or 0) * 10_000 +
            int(assignment["distance_penalty"] or 0) * 10
        )

    assert artifacts.model_stats["index_counts"]["candidate_indexes_by_client"] == len(context.mandatory_clients)
    assert artifacts.model_stats["index_counts"]["candidate_indexes_by_slot"] == len(context.slots)
    assert artifacts.model_stats["candidate_pairs_count"] == len(artifacts.assignments)
    assert artifacts.model_stats["removed_duplicate_candidate_pairs"] == 0
    for key, coefficient in expected_assignment_coefficients.items():
        assert objective_by_key[key] == coefficient


def test_bp_constraint_builder_deduplicates_only_exact_identical_constraints():
    builder = CoverageModelBuilder(model=optimizer_module.cp_model.CpModel())
    x_var = builder.model.NewBoolVar("x")
    y_var = builder.model.NewBoolVar("y")
    builder.register_bool_var(("x", "1", "A"), x_var)
    builder.register_bool_var(("x", "2", "A"), y_var)

    builder.add_linear_constraint(
        [(("x", "1", "A"), x_var, 1), (("x", "2", "A"), y_var, 1)],
        "<=",
        1,
        "same_constraint"
    )
    builder.add_linear_constraint(
        [(("x", "2", "A"), y_var, 1), (("x", "1", "A"), x_var, 1)],
        "<=",
        1,
        "same_constraint"
    )
    builder.add_linear_constraint(
        [(("x", "1", "A"), x_var, 1), (("x", "2", "A"), y_var, 1)],
        "<=",
        2,
        "different_bound"
    )

    assert builder.constraint_category_counts["same_constraint"] == 1
    assert builder.constraint_category_counts["different_bound"] == 1
    assert builder.deduplicated_constraint_count == 1


def test_bq_model_fingerprint_is_identical_for_legacy_like_and_optimized_payloads():
    optimized_payload = {
        "clients": ["2", "1"],
        "slots": ["2026-08-04::C001", "2026-08-03::C001"],
        "candidate_pairs": [
            {
                "client_id": "1",
                "slot_id": "2026-08-03::C001",
                "slot_index": 0,
                "predicted_ca_cents": 1000,
                "predicted_load_units_centi": 100,
                "predicted_stop_minutes_centi": 200,
                "distance_penalty": 10,
                "coverage_date_penalty": 20,
                "recovery_date_penalty": 0,
                "expected_collection_date_penalty": 0,
                "purchase_score_date_penalty": 30,
                "purchase_timing_date_penalty": 40,
                "expected_order_date_penalty": 50,
                "reassignment_penalty": 0
            }
        ],
        "variables": [
            {"key": ["x", "1", "2026-08-03::C001"], "kind": "bool", "domain": [0, 1]},
            {"key": ["unassigned", "1"], "kind": "bool", "domain": [0, 1]}
        ],
        "constraints": [
            ["linear", "client_exactly_one", "==", [[["unassigned", "1"], 1], [["x", "1", "2026-08-03::C001"], 1]], 1]
        ],
        "objective": [
            {"key": ["x", "1", "2026-08-03::C001"], "coefficient": 100},
            {"key": ["unassigned", "1"], "coefficient": 500}
        ]
    }
    legacy_like_payload = {
        "clients": ["1", "2", "1"],
        "slots": ["2026-08-03::C001", "2026-08-04::C001", "2026-08-03::C001"],
        "candidate_pairs": optimized_payload["candidate_pairs"] + optimized_payload["candidate_pairs"],
        "variables": list(reversed(optimized_payload["variables"])),
        "constraints": optimized_payload["constraints"] + optimized_payload["constraints"],
        "objective": [
            {"key": ["unassigned", "1"], "coefficient": 300},
            {"key": ["x", "1", "2026-08-03::C001"], "coefficient": 40},
            {"key": ["x", "1", "2026-08-03::C001"], "coefficient": 60},
            {"key": ["unassigned", "1"], "coefficient": 200}
        ]
    }

    assert compute_coverage_model_fingerprint(optimized_payload) == compute_coverage_model_fingerprint(legacy_like_payload)


def test_br_perf_debug_exposes_detailed_meta_without_changing_business_result(monkeypatch):
    clients = build_clients(2, allowed_codes=["C001"], predicted_ca=50.0)
    clients[0]["client_id"] = "debug-00152"
    clients[0]["client_code"] = "00152"
    clients[0]["purchase_prediction_score"] = 80
    clients[0]["predicted_purchase_date"] = "2026-08-04"
    clients[0]["purchase_days_until_prediction"] = 1
    clients[0]["expected_order_value"] = 500
    clients[0]["purchase_prediction_known"] = True
    clients[1]["client_id"] = "debug-152"
    clients[1]["client_code"] = "152"
    clients[1]["purchase_prediction_score"] = 20
    clients[1]["predicted_purchase_date"] = "2026-08-05"
    clients[1]["purchase_days_until_prediction"] = 2
    clients[1]["expected_order_value"] = 100
    clients[1]["purchase_prediction_known"] = True

    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=1,
            days=2,
            max_visits=2,
            commercial_codes=["C001"],
            hard_capacities={"C001": 1}
        ),
        planning_days=2,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True,
        planning_mode="sales_coverage"
    )

    monkeypatch.setenv("COVERAGE_PERF_DEBUG", "true")
    result_with_debug = solve_coverage_plan(payload)

    monkeypatch.setenv("COVERAGE_PERF_DEBUG", "false")
    result_without_debug = solve_coverage_plan(payload)

    debug_meta = result_with_debug.get("meta") or {}
    debug_stage_names = [
        entry["stage"]
        for entry in debug_meta.get("performance", {}).get("stages", [])
        if entry.get("stage")
    ]
    cp_sat_meta = debug_meta.get("cp_sat") or {}

    assert "python_solver_prepare_indices" in debug_stage_names
    assert "python_solver_build_variables" in debug_stage_names
    assert "python_solver_build_constraints" in debug_stage_names
    assert "python_solver_build_objective" in debug_stage_names
    assert "python_solver_cp_sat_solve" in debug_stage_names
    assert "python_solver_extract_solution" in debug_stage_names
    assert "python_solver_repair" in debug_stage_names
    assert "python_solver_total" in debug_stage_names
    assert cp_sat_meta["clients_count"] == 2
    assert cp_sat_meta["slots_count"] == 2
    assert cp_sat_meta["candidate_pairs_count"] >= 2
    assert isinstance(cp_sat_meta["constraints_by_category"], dict)
    assert "meta" not in result_without_debug or (
        "performance" not in (result_without_debug.get("meta") or {}) and
        "cp_sat" not in (result_without_debug.get("meta") or {})
    )

    normalized_debug = {key: value for key, value in result_with_debug.items() if key != "meta"}
    normalized_without_debug = {key: value for key, value in result_without_debug.items() if key != "meta"}
    assert normalized_debug == normalized_without_debug


def test_bs_flask_optimize_endpoint_exposes_and_prints_detailed_cp_sat_debug(monkeypatch, capsys):
    monkeypatch.setenv("COVERAGE_PERF_DEBUG", "true")
    api_module = importlib.import_module("api_ia")
    client = api_module.app.test_client()

    clients = build_clients(2, allowed_codes=["C001"], predicted_ca=50.0)
    clients[0]["client_id"] = "flask-00152"
    clients[0]["client_code"] = "00152"
    clients[0]["purchase_prediction_score"] = 70
    clients[0]["predicted_purchase_date"] = "2026-08-04"
    clients[0]["purchase_days_until_prediction"] = 1
    clients[0]["expected_order_value"] = 400
    clients[0]["purchase_prediction_known"] = True
    clients[1]["client_id"] = "flask-152"
    clients[1]["client_code"] = "152"
    clients[1]["purchase_prediction_score"] = 20
    clients[1]["predicted_purchase_date"] = "2026-08-05"
    clients[1]["purchase_days_until_prediction"] = 2
    clients[1]["expected_order_value"] = 120
    clients[1]["purchase_prediction_known"] = True

    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=1,
            days=2,
            max_visits=2,
            commercial_codes=["C001"],
            hard_capacities={"C001": 1}
        ),
        planning_days=2,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True,
        planning_mode="sales_coverage"
    )

    capsys.readouterr()
    response = client.post("/api/optimize-coverage", json=payload)
    captured = capsys.readouterr()
    data = response.get_json()

    assert response.status_code == 200
    stage_names = [
        entry["stage"]
        for entry in data["meta"]["performance"]["stages"]
    ]
    assert "python_solver_prepare_indices" in stage_names
    assert "python_solver_build_variables" in stage_names
    assert "python_solver_build_constraints" in stage_names
    assert "python_solver_build_objective" in stage_names
    assert "python_solver_cp_sat_solve" in stage_names
    assert "python_solver_extract_solution" in stage_names
    assert "python_solver_repair" in stage_names
    assert "python_solver_total" in stage_names

    cp_sat = data["meta"]["cp_sat"]
    assert cp_sat["status"] in {"OPTIMAL", "FEASIBLE"}
    assert cp_sat["wall_time"] >= 0
    assert cp_sat["candidate_pairs_count"] >= 2
    assert cp_sat["constraints_count"] > 0
    assert cp_sat["model_proto_bytes"] > 0

    assert "[COVERAGE_DEBUG_PATH] optimize_endpoint_entered=true" in captured.out
    assert "[COVERAGE_DEBUG_PATH] solver_function=CpSolver.Solve" in captured.out
    assert "[COVERAGE_DEBUG_PATH] cp_sat_solve_reached=true" in captured.out
    assert "[COVERAGE_CP_SAT]" in captured.out
    assert "[COVERAGE_CP_SAT_CONSTRAINTS]" in captured.out
    assert "python_solver_cp_sat_solve" in captured.out


def test_bt_greedy_solver_selection_reports_exact_threshold_reason(monkeypatch):
    monkeypatch.setenv("COVERAGE_PERF_DEBUG", "true")
    monkeypatch.setattr(optimizer_module, "GREEDY_CP_SAT_CANDIDATE_THRESHOLD", 1)

    payload = base_payload(
        clients=build_clients(2, allowed_codes=["C001"], predicted_ca=50.0),
        commercials=build_commercials(
            count=1,
            days=2,
            max_visits=2,
            commercial_codes=["C001"],
            hard_capacities={"C001": 1}
        ),
        planning_days=2,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True,
        planning_mode="sales_coverage"
    )

    result = solve_coverage_plan(payload)
    meta = result["meta"]
    solver_selection = meta["solver_selection"]
    stage_names = [entry["stage"] for entry in meta["performance"]["stages"]]

    assert solver_selection["selected_solver"] == "solve_greedy_capacity_plan"
    assert solver_selection["selection_reason"] == "candidate_pairs_threshold_exceeded"
    assert solver_selection["clients_count"] == 2
    assert solver_selection["slots_count"] == 2
    assert solver_selection["candidate_pairs_count"] == 4
    assert solver_selection["sales_coverage_mode"] is True
    assert solver_selection["ortools_available"] is True
    assert solver_selection["simple_balanced_solver_eligible"] is False
    assert solver_selection["thresholds"]["cp_sat_candidate_pairs_max"] == 1
    assert "python_greedy_prepare_indices" in stage_names
    assert "python_greedy_mandatory_assignment" in stage_names
    assert "python_greedy_total" in stage_names
    assert "python_solver_cp_sat_solve" not in stage_names


def test_bu_greedy_debug_meta_and_reference_solver_keep_same_hash_and_order(monkeypatch):
    clients = build_clients(3, allowed_codes=["C001"], predicted_ca=50.0)
    clients[0]["client_id"] = "same-00152"
    clients[0]["client_code"] = "00152"
    clients[0]["purchase_prediction_score"] = 90
    clients[0]["purchase_prediction_known"] = True
    clients[0]["recovery_priority_score"] = 5
    clients[1]["client_id"] = "same-152"
    clients[1]["client_code"] = "152"
    clients[1]["purchase_prediction_score"] = 20
    clients[1]["purchase_prediction_known"] = True
    clients[1]["recovery_priority_score"] = 99
    clients[2]["client_id"] = "same-null"
    clients[2]["client_code"] = "NULL"
    clients[2]["predicted_ca"] = None
    clients[2]["predicted_ca_known"] = False
    clients[2]["purchase_prediction_score"] = None
    clients[2]["purchase_prediction_known"] = False
    clients[2]["expected_order_value"] = None

    payload = base_payload(
        clients=clients,
        commercials=build_commercials(
            count=1,
            days=3,
            max_visits=2,
            commercial_codes=["C001"],
            hard_capacities={"C001": 1}
        ),
        planning_days=3,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True,
        planning_mode="sales_coverage"
    )

    monkeypatch.setattr(optimizer_module, "GREEDY_CP_SAT_CANDIDATE_THRESHOLD", 1)
    monkeypatch.setenv("COVERAGE_PERF_DEBUG", "true")
    optimized_result = solve_coverage_plan(payload)

    with monkeypatch.context() as scoped:
        scoped.setattr(optimizer_module, "GREEDY_CP_SAT_CANDIDATE_THRESHOLD", 1)
        scoped.setattr(optimizer_module, "solve_greedy_capacity_plan", legacy_solve_greedy_capacity_plan_reference)
        scoped.setenv("COVERAGE_PERF_DEBUG", "false")
        reference_result = solve_coverage_plan(payload)

    monkeypatch.setenv("COVERAGE_PERF_DEBUG", "false")
    plain_result = solve_coverage_plan(payload)

    optimized_without_meta = normalize_result_without_meta(optimized_result)
    assert optimized_without_meta == reference_result
    assert compute_functional_result_hash(optimized_result) == compute_functional_result_hash(reference_result)
    assert plain_result == reference_result

    greedy_meta = optimized_result["meta"]["greedy"]
    assert greedy_meta["score_cache_hits"] > 0
    assert greedy_meta["distance_cache_hits"] > 0
    assert greedy_meta["repeated_sorts_count"] == 0
    assert greedy_meta["assigned_clients_count"] == 3
    assert greedy_meta["unassigned_clients_count"] == 0
    assert optimized_result["diagnostics"]["truck_capacity_issues"] == []
    assert optimized_result["diagnostics"]["time_capacity_issues"] == []
    assert optimized_result["diagnostics"]["commercial_capacity_issues"] == []

    planned_rows = {
        client["client_id"]: (block["date"], client["visit_order"], client["client_code"], client["predicted_ca"])
        for block in optimized_result["blocks"]
        for client in block["clients"]
    }
    assert planned_rows["same-00152"][2] == "00152"
    assert planned_rows["same-152"][2] == "152"
    assert planned_rows["same-null"][3] is None
    assert planned_rows["same-00152"][0] < planned_rows["same-152"][0]
    assert len(planned_rows) == 3
    assert "greedy" not in (plain_result.get("meta") or {})
    assert "solver_selection" not in (plain_result.get("meta") or {})
    assert "candidate_context" not in (plain_result.get("meta") or {})


def test_bv_flask_optimize_endpoint_exposes_greedy_debug_and_logs(monkeypatch, capsys):
    monkeypatch.setenv("COVERAGE_PERF_DEBUG", "true")
    monkeypatch.setattr(optimizer_module, "GREEDY_CP_SAT_CANDIDATE_THRESHOLD", 1)
    api_module = importlib.import_module("api_ia")
    client = api_module.app.test_client()

    payload = base_payload(
        clients=build_clients(2, allowed_codes=["C001"], predicted_ca=50.0),
        commercials=build_commercials(
            count=1,
            days=2,
            max_visits=2,
            commercial_codes=["C001"],
            hard_capacities={"C001": 1}
        ),
        planning_days=2,
        capacity_mode="configured_hard_capacity",
        operational_capacity_known=True,
        planning_mode="sales_coverage"
    )

    capsys.readouterr()
    response = client.post("/api/optimize-coverage", json=payload)
    captured = capsys.readouterr()
    data = response.get_json()

    assert response.status_code == 200
    stage_names = [entry["stage"] for entry in data["meta"]["performance"]["stages"]]
    assert "python_solver_prepare_dispatch" in stage_names
    assert "python_candidate_context_build" in stage_names
    assert "python_solver_build_assignment_records" in stage_names
    assert "python_candidate_context_reuse_wrapper" in stage_names
    assert "python_solver_build_candidate_indexes" in stage_names
    assert "python_solver_select_strategy" in stage_names
    assert "python_solver_greedy_call" in stage_names
    assert "python_solver_postprocess_assignments" in stage_names
    assert "python_solver_build_visit_order" in stage_names
    assert "python_solver_build_statistics" in stage_names
    assert "python_solver_build_response" in stage_names
    assert "python_solver_unaccounted" in stage_names
    assert "python_greedy_prepare_indices" in stage_names
    assert "python_greedy_prepare_capacities" in stage_names
    assert "python_candidate_context_reuse_greedy" in stage_names
    assert "python_greedy_prepare_priorities" in stage_names
    assert "python_greedy_mandatory_assignment" in stage_names
    assert "python_greedy_capacity_checks" in stage_names
    assert "python_greedy_distance_calculations" in stage_names
    assert "python_greedy_repair" in stage_names
    assert "python_greedy_rebalancing" in stage_names
    assert "python_greedy_extract_solution" in stage_names
    assert "python_greedy_total" in stage_names
    assert "python_debug_input_fingerprints" in stage_names
    assert "python_debug_greedy_trace_hashes" in stage_names
    assert "python_debug_result_hashes" in stage_names
    assert "python_solver_total" in stage_names
    assert data["meta"]["solver_selection"]["selected_solver"] == "solve_greedy_capacity_plan"
    assert data["meta"]["greedy"]["candidate_pairs_count"] == 4
    assert data["meta"]["greedy_trace"]["candidate_pairs_count"] == 4
    assert data["meta"]["greedy_trace"]["canonical_functional_result_hash"]
    assert data["meta"]["input_fingerprints"]["functional_input_hash"]
    assert data["meta"]["input_fingerprints"]["input_candidate_pairs_snapshot_hash"]
    assert data["meta"]["candidate_context"]["candidate_record_build_calls"] == 1
    assert data["meta"]["candidate_context"]["candidate_index_build_calls"] == 1
    assert data["meta"]["candidate_context"]["context_reused_by_wrapper"] is True
    assert data["meta"]["candidate_context"]["context_reused_by_greedy"] is True
    assert data["meta"]["candidate_context"]["context_reused_by_fingerprints"] is True
    assert data["meta"]["result_hashes"]["python_solver_result_hash"]
    assert data["meta"]["result_hashes"]["python_response_before_flask_hash"]
    assert data["meta"]["result_hashes"]["flask_json_response_hash"]
    assert data["meta"]["result_hashes"]["canonical_functional_result_hash"]
    assert "[COVERAGE_SOLVER_SELECTION]" in captured.out
    assert "[COVERAGE_GREEDY]" in captured.out
    assert "[COVERAGE_INPUT]" in captured.out
    assert "[COVERAGE_GREEDY_TRACE]" in captured.out
    assert "[COVERAGE_RESULT]" in captured.out
    assert "python_greedy_total" in captured.out
    assert "selected_solver=solve_greedy_capacity_plan" in captured.out


def test_bw_solver_wrapper_stages_cover_total_and_keep_unaccounted_below_100(monkeypatch):
    monkeypatch.setenv("COVERAGE_PERF_DEBUG", "true")
    monkeypatch.setattr(optimizer_module, "GREEDY_CP_SAT_CANDIDATE_THRESHOLD", 1)

    result = solve_coverage_plan(build_perf4b_sales_greedy_payload())
    stage_map = performance_stage_map(result)
    direct_child_stage_names = [
        "python_solver_prepare_dispatch",
        "python_candidate_context_build",
        "python_solver_build_assignment_records",
        "python_candidate_context_reuse_wrapper",
        "python_solver_build_candidate_indexes",
        "python_solver_select_strategy",
        "python_solver_greedy_call",
        "python_solver_postprocess_assignments",
        "python_solver_build_visit_order",
        "python_solver_build_statistics",
        "python_solver_build_response",
        "python_solver_unaccounted",
    ]

    assert all(stage_name in stage_map for stage_name in direct_child_stage_names)
    assert stage_map["python_solver_total"] == sum(stage_map[stage_name] for stage_name in direct_child_stage_names)
    assert stage_map["python_solver"] == stage_map["python_solver_total"]
    assert result["meta"]["greedy"]["solver_unaccounted_ms"] == stage_map["python_solver_unaccounted"]
    assert stage_map["python_solver_unaccounted"] <= 100


def test_bx_functional_input_hash_is_stable_and_changes_only_for_business_input(monkeypatch):
    monkeypatch.setenv("COVERAGE_PERF_DEBUG", "true")
    monkeypatch.setattr(optimizer_module, "GREEDY_CP_SAT_CANDIDATE_THRESHOLD", 1)

    payload = build_perf4b_sales_greedy_payload()
    stable_result = solve_coverage_plan(payload)

    same_business_payload = build_perf4b_sales_greedy_payload()
    same_business_payload["request_id"] = "perf4b-second"
    same_business_payload["cache_status"] = "hit"
    same_business_result = solve_coverage_plan(same_business_payload)

    changed_business_payload = build_perf4b_sales_greedy_payload()
    changed_business_payload["allow_commercial_reassignment"] = False
    changed_business_result = solve_coverage_plan(changed_business_payload)

    client_code_changed_payload = build_perf4b_sales_greedy_payload()
    client_code_changed_payload["clients"][0]["client_code"] = "152"
    client_code_changed_result = solve_coverage_plan(client_code_changed_payload)

    null_changed_payload = build_perf4b_sales_greedy_payload()
    null_changed_payload["clients"][2]["predicted_ca"] = 0
    null_changed_payload["clients"][2]["predicted_ca_known"] = True
    null_changed_result = solve_coverage_plan(null_changed_payload)

    reordered_payload = {
        key: value
        for key, value in reversed(list(build_perf4b_sales_greedy_payload().items()))
    }
    reordered_payload["commercials"] = [
        {key: value for key, value in reversed(list(commercial.items()))}
        for commercial in build_perf4b_sales_greedy_payload()["commercials"]
    ]
    reordered_payload["clients"] = [
        {key: value for key, value in reversed(list(client.items()))}
        for client in build_perf4b_sales_greedy_payload()["clients"]
    ]
    reordered_result = solve_coverage_plan(reordered_payload)

    stable_hash = stable_result["meta"]["input_fingerprints"]["functional_input_hash"]
    assert stable_hash == same_business_result["meta"]["input_fingerprints"]["functional_input_hash"]
    assert stable_hash != changed_business_result["meta"]["input_fingerprints"]["functional_input_hash"]
    assert stable_hash != client_code_changed_result["meta"]["input_fingerprints"]["functional_input_hash"]
    assert stable_hash != null_changed_result["meta"]["input_fingerprints"]["functional_input_hash"]
    assert stable_hash == reordered_result["meta"]["input_fingerprints"]["functional_input_hash"]
    assert compute_functional_result_hash(stable_result) == compute_functional_result_hash(reordered_result)


def test_by_legacy_and_optimized_greedy_keep_identical_input_trace_and_final_hash(monkeypatch):
    monkeypatch.setenv("COVERAGE_PERF_DEBUG", "true")
    monkeypatch.setattr(optimizer_module, "GREEDY_CP_SAT_CANDIDATE_THRESHOLD", 1)

    payload = build_perf4b_sales_greedy_payload()
    optimized_result = solve_coverage_plan(payload)

    with monkeypatch.context() as scoped:
        scoped.setenv("COVERAGE_PERF_DEBUG", "true")
        scoped.setattr(optimizer_module, "GREEDY_CP_SAT_CANDIDATE_THRESHOLD", 1)
        scoped.setattr(optimizer_module, "solve_greedy_capacity_plan", legacy_solve_greedy_capacity_plan_reference)
        reference_result = solve_coverage_plan(build_perf4b_sales_greedy_payload())

    optimized_trace = optimized_result["meta"]["greedy_trace"]
    reference_trace = reference_result["meta"]["greedy_trace"]
    optimized_without_meta = normalize_result_without_meta(optimized_result)
    reference_without_meta = normalize_result_without_meta(reference_result)

    assert optimized_result["meta"]["input_fingerprints"]["functional_input_hash"] == reference_result["meta"]["input_fingerprints"]["functional_input_hash"]
    assert optimized_result["meta"]["input_fingerprints"]["input_candidate_pairs_snapshot_hash"] == reference_result["meta"]["input_fingerprints"]["input_candidate_pairs_snapshot_hash"]
    assert optimized_trace == reference_trace
    assert optimized_without_meta == reference_without_meta
    assert compute_functional_result_hash(optimized_result) == compute_functional_result_hash(reference_result)
    assert optimized_trace["assignment_decisions_count"] > 0
    assert optimized_trace["assignments_before_postprocess_hash"]
    assert optimized_trace["assignments_after_postprocess_hash"]
    assert optimized_trace["canonical_functional_result_hash"] == compute_functional_result_hash(optimized_result)
    planned_client_ids = [
        client["client_id"]
        for block in optimized_result["blocks"]
        for client in block["clients"]
    ]
    assert len(planned_client_ids) == len(set(planned_client_ids))
    assert optimized_result["diagnostics"]["truck_capacity_issues"] == []
    assert optimized_result["diagnostics"]["time_capacity_issues"] == []
    assert optimized_result["diagnostics"]["commercial_capacity_issues"] == []


def test_bz_candidate_context_is_built_once_and_reused_by_wrapper_greedy_and_fingerprints(monkeypatch):
    monkeypatch.setenv("COVERAGE_PERF_DEBUG", "true")
    monkeypatch.setattr(optimizer_module, "GREEDY_CP_SAT_CANDIDATE_THRESHOLD", 1)

    observed = {
        "build_context_ids": [],
        "greedy_context_ids": [],
        "fingerprint_context_ids": [],
    }
    real_build_candidate_planning_context = optimizer_module.build_candidate_planning_context
    real_build_coverage_input_fingerprints = optimizer_module.build_coverage_input_fingerprints
    real_solve_greedy_capacity_plan = optimizer_module.solve_greedy_capacity_plan

    def instrumented_build_candidate_planning_context(*args, **kwargs):
        candidate_context = real_build_candidate_planning_context(*args, **kwargs)
        observed["build_context_ids"].append(id(candidate_context))
        return candidate_context

    def instrumented_build_coverage_input_fingerprints(*args, **kwargs):
        candidate_context = kwargs.get("candidate_context")
        observed["fingerprint_context_ids"].append(None if candidate_context is None else id(candidate_context))
        return real_build_coverage_input_fingerprints(*args, **kwargs)

    def instrumented_solve_greedy_capacity_plan(*args, **kwargs):
        candidate_context = kwargs.get("candidate_planning_context")
        observed["greedy_context_ids"].append(None if candidate_context is None else id(candidate_context))
        return real_solve_greedy_capacity_plan(*args, **kwargs)

    monkeypatch.setattr(optimizer_module, "build_candidate_planning_context", instrumented_build_candidate_planning_context)
    monkeypatch.setattr(optimizer_module, "build_coverage_input_fingerprints", instrumented_build_coverage_input_fingerprints)
    monkeypatch.setattr(optimizer_module, "solve_greedy_capacity_plan", instrumented_solve_greedy_capacity_plan)

    result = solve_coverage_plan(build_perf4b_sales_greedy_payload())

    candidate_context_meta = result["meta"]["candidate_context"]
    assert candidate_context_meta["candidate_records_count"] == result["meta"]["greedy"]["candidate_pairs_count"]
    assert candidate_context_meta["candidate_record_build_calls"] == 1
    assert candidate_context_meta["candidate_index_build_calls"] == 1
    assert candidate_context_meta["duplicated_candidate_record_copies"] == 0
    assert candidate_context_meta["context_reused_by_wrapper"] is True
    assert candidate_context_meta["context_reused_by_greedy"] is True
    assert candidate_context_meta["context_reused_by_fingerprints"] is True
    assert candidate_context_meta["estimated_candidate_context_bytes"] > 0

    assert len(set(observed["build_context_ids"])) == 1
    shared_context_id = observed["build_context_ids"][0]
    assert shared_context_id in observed["greedy_context_ids"]
    assert shared_context_id in observed["fingerprint_context_ids"]

    stage_names = list(performance_stage_map(result).keys())
    assert "python_candidate_context_build" in stage_names
    assert "python_candidate_context_reuse_wrapper" in stage_names
    assert "python_candidate_context_reuse_greedy" in stage_names


def test_bz_canonical_hash_is_stable_across_technical_metadata_and_detects_business_differences():
    baseline = build_canonical_hash_fixture_result()
    baseline_hash = compute_functional_result_hash(baseline)

    same_business = build_canonical_hash_fixture_result()
    same_business["request_id"] = "another-request-id"
    same_business["cache_status"] = "hit"
    same_business["meta"] = {
        "performance": {
            "stages": [
                {"stage": "python_solver_total", "duration_ms": 99}
            ]
        },
        "debug_path": {
            "solver_function": "solve_greedy_capacity_plan"
        }
    }
    reordered = build_canonical_hash_fixture_result()
    reordered["blocks"] = list(reversed(reordered["blocks"]))

    changed_assignment = build_canonical_hash_fixture_result()
    changed_assignment["blocks"][0]["clients"][0]["client_id"] = "same-other"
    changed_date = build_canonical_hash_fixture_result()
    changed_date["blocks"][1]["date"] = "2026-08-05"
    changed_commercial = build_canonical_hash_fixture_result()
    changed_commercial["blocks"][1]["commercial_code"] = "C009"
    changed_visit_order = build_canonical_hash_fixture_result()
    changed_visit_order["blocks"][1]["clients"][0]["visit_order"] = 3
    changed_null_to_zero = build_canonical_hash_fixture_result()
    changed_null_to_zero["blocks"][0]["clients"][0]["predicted_ca"] = 0
    changed_null_to_empty = build_canonical_hash_fixture_result()
    changed_null_to_empty["blocks"][0]["clients"][0]["predicted_ca"] = ""
    changed_code = build_canonical_hash_fixture_result()
    changed_code["blocks"][1]["clients"][0]["client_code"] = "152"

    assert baseline_hash == compute_functional_result_hash(same_business)
    assert baseline_hash == compute_functional_result_hash(reordered)
    assert baseline_hash != compute_functional_result_hash(changed_assignment)
    assert baseline_hash != compute_functional_result_hash(changed_date)
    assert baseline_hash != compute_functional_result_hash(changed_commercial)
    assert baseline_hash != compute_functional_result_hash(changed_visit_order)
    assert baseline_hash != compute_functional_result_hash(changed_null_to_zero)
    assert baseline_hash != compute_functional_result_hash(changed_null_to_empty)
    assert baseline_hash != compute_functional_result_hash(changed_code)

    baseline_snapshot = optimizer_module.build_canonical_coverage_result_snapshot(baseline)
    changed_snapshot = optimizer_module.build_canonical_coverage_result_snapshot(changed_commercial)
    assert find_first_difference_path(baseline_snapshot, changed_snapshot) == "root.planned_assignments[0].commercial_code"


def test_ca_candidate_pair_hashes_have_distinct_explicit_contracts(monkeypatch):
    monkeypatch.setenv("COVERAGE_PERF_DEBUG", "true")
    monkeypatch.setattr(optimizer_module, "GREEDY_CP_SAT_CANDIDATE_THRESHOLD", 1)

    result = solve_coverage_plan(build_perf4b_sales_greedy_payload())
    input_fingerprints = result["meta"]["input_fingerprints"]
    greedy_trace = result["meta"]["greedy_trace"]

    assert "input_candidate_pairs_snapshot_hash" in input_fingerprints
    assert "candidate_pairs_hash" not in input_fingerprints
    assert "greedy_candidate_order_hash" in greedy_trace
    assert "candidate_pairs_hash" not in greedy_trace
    assert input_fingerprints["input_candidate_pairs_snapshot_hash"] != greedy_trace["greedy_candidate_order_hash"]


def test_cb_debug_false_skips_fingerprints_and_keeps_same_result(monkeypatch):
    monkeypatch.delenv("COVERAGE_PERF_DEBUG", raising=False)
    monkeypatch.delenv("COVERAGE_PERF_TIMINGS", raising=False)
    monkeypatch.setattr(optimizer_module, "GREEDY_CP_SAT_CANDIDATE_THRESHOLD", 1)

    observed = {
        "fingerprint_calls": 0,
        "finalize_calls": 0,
    }
    real_build_coverage_input_fingerprints = optimizer_module.build_coverage_input_fingerprints
    real_finalize_coverage_debug_result = optimizer_module.finalize_coverage_debug_result

    def instrumented_build_coverage_input_fingerprints(*args, **kwargs):
        observed["fingerprint_calls"] += 1
        return real_build_coverage_input_fingerprints(*args, **kwargs)

    def instrumented_finalize_coverage_debug_result(*args, **kwargs):
        observed["finalize_calls"] += 1
        return real_finalize_coverage_debug_result(*args, **kwargs)

    monkeypatch.setattr(optimizer_module, "build_coverage_input_fingerprints", instrumented_build_coverage_input_fingerprints)
    monkeypatch.setattr(optimizer_module, "finalize_coverage_debug_result", instrumented_finalize_coverage_debug_result)

    plain_result = solve_coverage_plan(build_perf4b_sales_greedy_payload())
    assert observed["fingerprint_calls"] == 0
    assert observed["finalize_calls"] == 1

    with monkeypatch.context() as scoped:
        scoped.setenv("COVERAGE_PERF_DEBUG", "true")
        scoped.delenv("COVERAGE_PERF_TIMINGS", raising=False)
        scoped.setattr(optimizer_module, "GREEDY_CP_SAT_CANDIDATE_THRESHOLD", 1)
        debug_result = solve_coverage_plan(build_perf4b_sales_greedy_payload())

    assert "meta" not in plain_result
    assert normalize_result_without_meta(debug_result) == plain_result


def test_cc_timings_mode_is_lightweight_and_reuses_context_once(monkeypatch):
    monkeypatch.delenv("COVERAGE_PERF_DEBUG", raising=False)
    monkeypatch.setenv("COVERAGE_PERF_TIMINGS", "true")
    monkeypatch.setattr(optimizer_module, "GREEDY_CP_SAT_CANDIDATE_THRESHOLD", 1)

    observed = {
        "fingerprint_calls": 0,
        "candidate_context_build_calls": 0,
        "solve_greedy_capacity_plan_calls": 0,
    }
    real_build_coverage_input_fingerprints = optimizer_module.build_coverage_input_fingerprints
    real_build_candidate_planning_context = optimizer_module.build_candidate_planning_context
    real_solve_greedy_capacity_plan = optimizer_module.solve_greedy_capacity_plan

    def instrumented_build_coverage_input_fingerprints(*args, **kwargs):
        observed["fingerprint_calls"] += 1
        return real_build_coverage_input_fingerprints(*args, **kwargs)

    def instrumented_build_candidate_planning_context(*args, **kwargs):
        observed["candidate_context_build_calls"] += 1
        return real_build_candidate_planning_context(*args, **kwargs)

    def instrumented_solve_greedy_capacity_plan(*args, **kwargs):
        observed["solve_greedy_capacity_plan_calls"] += 1
        return real_solve_greedy_capacity_plan(*args, **kwargs)

    monkeypatch.setattr(optimizer_module, "build_coverage_input_fingerprints", instrumented_build_coverage_input_fingerprints)
    monkeypatch.setattr(optimizer_module, "build_candidate_planning_context", instrumented_build_candidate_planning_context)
    monkeypatch.setattr(optimizer_module, "solve_greedy_capacity_plan", instrumented_solve_greedy_capacity_plan)

    timings_result = solve_coverage_plan(build_perf4b_sales_greedy_payload())
    assert observed["fingerprint_calls"] == 0
    assert observed["candidate_context_build_calls"] == 1
    assert observed["solve_greedy_capacity_plan_calls"] == 1

    with monkeypatch.context() as scoped:
        scoped.delenv("COVERAGE_PERF_DEBUG", raising=False)
        scoped.delenv("COVERAGE_PERF_TIMINGS", raising=False)
        scoped.setattr(optimizer_module, "GREEDY_CP_SAT_CANDIDATE_THRESHOLD", 1)
        plain_result = solve_coverage_plan(build_perf4b_sales_greedy_payload())

    stage_names = [entry["stage"] for entry in timings_result["meta"]["performance"]["stages"]]
    allowed_stage_names = {
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

    assert set(stage_names).issubset(allowed_stage_names)
    assert "python_debug_input_fingerprints" not in stage_names
    assert "python_debug_greedy_trace_hashes" not in stage_names
    assert "python_debug_result_hashes" not in stage_names
    assert "solver_selection" not in timings_result["meta"]
    assert "greedy" not in timings_result["meta"]
    assert "greedy_trace" not in timings_result["meta"]
    assert "input_fingerprints" not in timings_result["meta"]
    assert "result_hashes" not in timings_result["meta"]
    assert "candidate_context" not in timings_result["meta"]
    assert normalize_result_without_meta(timings_result) == plain_result


def test_cd_flask_timings_mode_exposes_only_lightweight_performance_meta(monkeypatch):
    monkeypatch.delenv("COVERAGE_PERF_DEBUG", raising=False)
    monkeypatch.setenv("COVERAGE_PERF_TIMINGS", "true")
    monkeypatch.setattr(optimizer_module, "GREEDY_CP_SAT_CANDIDATE_THRESHOLD", 1)
    api_module = importlib.import_module("api_ia")
    client = api_module.app.test_client()

    payload = build_perf4b_sales_greedy_payload()
    response = client.post("/api/optimize-coverage", json=payload)
    data = response.get_json()

    assert response.status_code == 200
    assert "performance" in data["meta"]
    assert "solver_selection" not in data["meta"]
    assert "greedy" not in data["meta"]
    assert "greedy_trace" not in data["meta"]
    assert "input_fingerprints" not in data["meta"]
    assert "result_hashes" not in data["meta"]
    assert "candidate_context" not in data["meta"]
    assert "python_total" in [entry["stage"] for entry in data["meta"]["performance"]["stages"]]


def test_ce_flask_debug_false_returns_no_debug_meta(monkeypatch):
    monkeypatch.delenv("COVERAGE_PERF_DEBUG", raising=False)
    monkeypatch.delenv("COVERAGE_PERF_TIMINGS", raising=False)
    monkeypatch.setattr(optimizer_module, "GREEDY_CP_SAT_CANDIDATE_THRESHOLD", 1)
    api_module = importlib.import_module("api_ia")
    client = api_module.app.test_client()

    response = client.post("/api/optimize-coverage", json=build_perf4b_sales_greedy_payload())
    data = response.get_json()

    assert response.status_code == 200
    assert "meta" not in data


def test_cf_sales_coverage_normalize_payload_keeps_horizon_window_and_mode_distinct():
    payload = base_payload(
        build_clients(2, allowed_codes=["C001"], predicted_ca=50.0),
        build_commercials(count=1, days=30, max_visits=30),
        planning_days=30,
        planning_mode="sales_coverage",
    )
    payload["planning_horizon_days"] = 30
    payload["coverage_window_days"] = 14
    payload["daily_max_mode"] = "strict"
    payload["visit_frequency_days"] = 99
    payload["clients"][0]["last_real_visit_date"] = None

    normalized = normalize_payload(payload)

    assert normalized["planning_days"] == 30
    assert normalized["planning_horizon_days"] == 30
    assert normalized["visit_frequency_days"] == 14
    assert normalized["coverage_window_days"] == 14
    assert normalized["daily_max_mode"] == "strict"
    assert normalized["clients"][0].last_real_visit_date is None


def test_cg_sales_coverage_result_exposes_single_visit_only_without_inventing_history():
    payload = base_payload(
        build_clients(2, allowed_codes=["C001"], predicted_ca=50.0),
        build_commercials(count=1, days=7, max_visits=5),
        planning_days=30,
        planning_mode="sales_coverage",
    )
    payload["planning_horizon_days"] = 30
    payload["coverage_window_days"] = 14
    payload["daily_max_mode"] = "flexible"
    payload["clients"][0]["last_real_visit_date"] = None
    payload["clients"][0]["next_visit_deadline"] = None

    result = solve_coverage_plan(payload)

    assert result["summary"]["planning_horizon_days"] == 30
    assert result["summary"]["coverage_window_days"] == 14
    assert result["summary"]["daily_max_mode"] == "flexible"
    assert result["summary"]["coverage_guarantee_status"] == "single_visit_only"

    normalized = normalize_payload(payload)
    assert normalized["clients"][0].last_real_visit_date is None
    assert normalized["clients"][0].next_visit_deadline == normalized["planning_end_date"]
