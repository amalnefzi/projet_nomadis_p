import json
from pathlib import Path

import numpy as np
from sklearn.metrics import accuracy_score, mean_absolute_error, mean_absolute_percentage_error, r2_score, roc_auc_score


MODEL_STRATEGY_FILENAME = "model_strategy.json"
STRATEGY_VERSION = 1
SELECTION_METRIC = "mae"


def _as_float_array(values):
    return np.asarray(values, dtype=float)


def _safe_round(value, digits=4):
    if value is None:
        return None
    if not np.isfinite(value):
        return None
    return round(float(value), digits)


def compute_regression_metrics(y_true, y_pred):
    y_true = _as_float_array(y_true)
    y_pred = _as_float_array(y_pred)
    finite_mask = np.isfinite(y_true) & np.isfinite(y_pred)
    if not finite_mask.any():
        return {"r2": None, "mae": None, "mape": None}

    y_true = y_true[finite_mask]
    y_pred = y_pred[finite_mask]

    mae = mean_absolute_error(y_true, y_pred)

    if len(y_true) >= 2 and np.unique(y_true).size >= 2:
        r2 = r2_score(y_true, y_pred)
    else:
        r2 = None

    positive_mask = np.abs(y_true) > 1e-9
    if positive_mask.any():
        mape = mean_absolute_percentage_error(y_true[positive_mask], y_pred[positive_mask]) * 100.0
    else:
        mape = None

    return {
        "r2": _safe_round(r2, 4),
        "mae": _safe_round(mae, 4),
        "mape": _safe_round(mape, 1),
    }


def compute_classifier_metrics(y_true, y_prob):
    y_true = np.asarray(y_true, dtype=int)
    y_prob = np.clip(_as_float_array(y_prob), 0.0, 1.0)
    if len(np.unique(y_true)) < 2:
        return {"auc": None, "accuracy": None}

    auc = roc_auc_score(y_true, y_prob)
    accuracy = accuracy_score(y_true, (y_prob >= 0.5).astype(int))
    return {
        "auc": _safe_round(auc, 4),
        "accuracy": _safe_round(accuracy * 100.0, 1),
    }


def _first_positive_feature(frame, columns, default=0.0):
    result = np.full(len(frame), float(default), dtype=float)
    locked = np.zeros(len(frame), dtype=bool)
    for column in columns:
        if column not in frame.columns:
            continue
        values = pd_to_numeric(frame[column])
        eligible = (~locked) & np.isfinite(values) & (values > 0)
        result[eligible] = values[eligible]
        locked[eligible] = True
    return result


def pd_to_numeric(values):
    return np.asarray(values, dtype=float)


def build_historical_baselines(frame):
    baseline_ca = _first_positive_feature(
        frame,
        ["avg_ca_per_order_90d", "vente_avg_3", "vente_last"],
        default=0.0,
    )
    baseline_qte = _first_positive_feature(
        frame,
        ["avg_qte_per_order_90d", "qte_avg_3", "qte_last"],
        default=0.0,
    )

    baseline_price = _first_positive_feature(frame, ["avg_price_hist"], default=0.0)
    missing_price = ~(np.isfinite(baseline_price) & (baseline_price > 0))
    ratio_mask = missing_price & (baseline_qte > 0)
    baseline_price[ratio_mask] = baseline_ca[ratio_mask] / baseline_qte[ratio_mask]
    baseline_price[~np.isfinite(baseline_price)] = 0.0

    return {
        "ca_if_buy": np.maximum(0.0, baseline_ca),
        "qte_if_buy": np.maximum(0.0, baseline_qte),
        "price_if_buy": np.maximum(0.0, baseline_price),
    }


def choose_strategy(model_metrics, baseline_metrics, metric_name=SELECTION_METRIC):
    model_value = model_metrics.get(metric_name)
    baseline_value = baseline_metrics.get(metric_name)

    if model_value is None and baseline_value is None:
        return {
            "selected": "model",
            "selection_metric": metric_name,
            "reason": "baseline_and_model_unavailable",
        }
    if model_value is None:
        return {
            "selected": "baseline_history",
            "selection_metric": metric_name,
            "reason": "model_metric_unavailable",
        }
    if baseline_value is None:
        return {
            "selected": "model",
            "selection_metric": metric_name,
            "reason": "baseline_metric_unavailable",
        }
    if model_value <= baseline_value:
        return {
            "selected": "model",
            "selection_metric": metric_name,
            "reason": "model_beats_or_matches_baseline",
        }
    return {
        "selected": "baseline_history",
        "selection_metric": metric_name,
        "reason": "baseline_beats_model",
    }


def default_strategy():
    return {
        "strategy_version": STRATEGY_VERSION,
        "selection_metric": SELECTION_METRIC,
        "targets": {
            "ca_if_buy": {"selected": "model"},
            "qte_if_buy": {"selected": "model"},
            "price_if_buy": {"selected": "model"},
        },
    }


def resolve_target_choice(strategy, target_name):
    targets = strategy.get("targets") if isinstance(strategy, dict) else {}
    target_entry = targets.get(target_name) if isinstance(targets, dict) else {}
    selected = target_entry.get("selected") if isinstance(target_entry, dict) else None
    return selected if selected in {"model", "baseline_history"} else "model"


def save_strategy(base_dir, strategy_payload):
    strategy_path = Path(base_dir) / MODEL_STRATEGY_FILENAME
    strategy_path.write_text(
        json.dumps(strategy_payload, ensure_ascii=True, indent=2),
        encoding="utf8",
    )
    return strategy_path


def load_strategy(base_dir):
    strategy_path = Path(base_dir) / MODEL_STRATEGY_FILENAME
    if not strategy_path.exists():
        return default_strategy()

    try:
        payload = json.loads(strategy_path.read_text(encoding="utf8"))
    except Exception:
        return default_strategy()

    strategy = default_strategy()
    if isinstance(payload, dict):
        strategy.update({
            "strategy_version": payload.get("strategy_version", strategy["strategy_version"]),
            "selection_metric": payload.get("selection_metric", strategy["selection_metric"]),
        })
        payload_targets = payload.get("targets")
        if isinstance(payload_targets, dict):
            for target_name in strategy["targets"]:
                target_payload = payload_targets.get(target_name)
                if isinstance(target_payload, dict):
                    strategy["targets"][target_name] = {
                        **strategy["targets"][target_name],
                        **target_payload,
                    }
    return strategy


def extract_precision_score(strategy):
    if not isinstance(strategy, dict):
        return None
    purchase = strategy.get("purchase")
    if not isinstance(purchase, dict):
        return None
    metrics = purchase.get("metrics")
    if not isinstance(metrics, dict):
        return None
    auc = metrics.get("auc")
    if auc is None or not np.isfinite(float(auc)):
        return None
    return round(float(auc) * 100.0, 1)
