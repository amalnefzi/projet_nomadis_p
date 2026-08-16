import argparse
import json
import math
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import log_loss, mean_absolute_error, roc_auc_score
from sqlalchemy import create_engine
from xgboost import XGBClassifier, XGBRegressor

import api_ia
from nomadis_feature_store import (
    ensure_feature_store_tables,
    load_active_feature_store_frame,
    read_feature_store_state,
)


FEATURE_COLUMNS_BASE = list(api_ia.FEATURE_COLUMNS_BASE)
MAIN_CATEGORICAL_COLUMNS = list(api_ia.MAIN_CATEGORICAL_COLUMNS)
PURCHASE_TARGET = "achat_target"
CA_TARGET = "ca_jour"
QTY_TARGET = "qte_jour"
MIN_TARGET_ROWS = 5

PURCHASE_PARAMS = {
    "n_estimators": 300,
    "learning_rate": 0.05,
    "max_depth": 5,
    "subsample": 0.85,
    "colsample_bytree": 0.85,
    "min_child_weight": 2,
    "objective": "binary:logistic",
    "eval_metric": "logloss",
    "random_state": 42,
    "verbosity": 0,
}

REGRESSION_PARAMS = {
    "n_estimators": 350,
    "learning_rate": 0.05,
    "max_depth": 5,
    "subsample": 0.85,
    "colsample_bytree": 0.85,
    "min_child_weight": 2,
    "objective": "reg:squarederror",
    "random_state": 42,
    "verbosity": 0,
}


def parse_args():
    parser = argparse.ArgumentParser(description="Train a Sales V2 candidate model from feedback.")
    parser.add_argument("--input", required=True, help="Input JSON payload path.")
    parser.add_argument("--output", required=True, help="Output JSON result path.")
    parser.add_argument("--artifacts-dir", default=None, help="Optional candidate artifacts directory.")
    return parser.parse_args()


def normalize_code(value):
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def normalize_date(value):
    if value is None:
        return None
    parsed = pd.to_datetime(value, errors="coerce")
    if pd.isna(parsed):
        return None
    return pd.Timestamp(parsed).normalize()


def normalize_number(value):
    if value is None or value == "":
        return None
    try:
        parsed = float(value)
    except Exception:
        return None
    if not np.isfinite(parsed):
        return None
    return float(parsed)


def build_recency_weights(dates):
    date_series = pd.to_datetime(pd.Series(dates), errors="coerce")
    if date_series.empty:
        return np.array([])
    min_date = date_series.min()
    max_date = date_series.max()
    span_days = max((max_date - min_date).days, 1)
    normalized = (date_series - min_date).dt.days / span_days
    return (0.4 + 0.6 * normalized).to_numpy()


def load_historical_training_frame(base_dir):
    engine = api_ia.feature_store_engine
    if engine is None:
        engine = create_engine(api_ia.get_mysql_url(), pool_pre_ping=True)
    ensure_feature_store_tables(engine)
    state = read_feature_store_state(engine)
    df, _loaded_state = load_active_feature_store_frame(engine)
    if df.empty:
        raise RuntimeError("Canonical feature store snapshot missing for candidate training.")
    if state.get("status") != "ready":
        raise RuntimeError(f"Canonical feature store is not ready (status={state.get('status') or 'unknown'}).")
    source_max_date = normalize_date(state.get("active_source_max_date"))
    if source_max_date is None:
        raise RuntimeError("Canonical feature store state is missing active_source_max_date.")
    df["client_code"] = df["client_code"].astype(str).str.strip()
    if "date_doc" in df.columns:
        df["date_doc"] = pd.to_datetime(df["date_doc"], errors="coerce").dt.normalize()
    elif "history_date" in df.columns:
        df["date_doc"] = pd.to_datetime(df["history_date"], errors="coerce").dt.normalize()
    elif "date" in df.columns:
        df["date_doc"] = pd.to_datetime(df["date"], errors="coerce").dt.normalize()
    else:
        raise RuntimeError("Canonical feature store frame does not expose a usable historical date column.")
    df = df.dropna(subset=["date_doc"]).copy()
    df = df[df["date_doc"] <= source_max_date].copy()
    df[FEATURE_COLUMNS_BASE] = df[FEATURE_COLUMNS_BASE].apply(pd.to_numeric, errors="coerce").fillna(0)
    for column in MAIN_CATEGORICAL_COLUMNS:
        df[column] = df[column].fillna("Inconnu").astype(str).str.strip()
    df[PURCHASE_TARGET] = pd.to_numeric(df[PURCHASE_TARGET], errors="coerce").fillna(0).astype(int)
    df[CA_TARGET] = pd.to_numeric(df[CA_TARGET], errors="coerce").fillna(0.0)
    df[QTY_TARGET] = pd.to_numeric(df[QTY_TARGET], errors="coerce").fillna(0.0)
    df["date"] = df["date_doc"]
    return df


def build_candidate_lookup(feedback_rows, historical_df):
    lookup = {}
    if historical_df is None or historical_df.empty:
        return lookup

    working = historical_df.copy()
    working["client_code"] = working["client_code"].astype(str).str.strip()
    working["date"] = pd.to_datetime(working["date"], errors="coerce").dt.normalize()
    working["jour_semaine"] = pd.to_numeric(working["jour_semaine"], errors="coerce").fillna(-1).astype(int)

    unique_slots = sorted({
        (normalize_date(row.get("planned_date")), int(pd.Timestamp(normalize_date(row.get("planned_date"))).weekday() + 1) % 7)
        for row in feedback_rows
        if normalize_date(row.get("planned_date")) is not None
    }, key=lambda item: item[0])

    for planned_date, jour_semaine in unique_slots:
        candidates = working[
            (working["date"] == planned_date) &
            (working["jour_semaine"] == int(jour_semaine))
        ].copy()
        if candidates.empty:
            lookup[(planned_date.strftime("%Y-%m-%d"), jour_semaine)] = {}
            continue

        by_code = {}
        for _, candidate_row in candidates.iterrows():
            client_code = normalize_code(candidate_row.get("client_code"))
            if not client_code:
                continue
            by_code[client_code] = candidate_row.to_dict()
        lookup[(planned_date.strftime("%Y-%m-%d"), jour_semaine)] = by_code

    return lookup


def build_feedback_training_rows(feedback_rows, historical_df):
    lookup = build_candidate_lookup(feedback_rows, historical_df)
    built_rows = []
    excluded = []

    for row in feedback_rows:
        planned_date = normalize_date(row.get("planned_date"))
        client_code = normalize_code(row.get("client_code"))
        execution_status = normalize_code(row.get("execution_status"))
        purchase_made = row.get("purchase_made")
        actual_ca = normalize_number(row.get("actual_ca"))
        actual_quantity = normalize_number(row.get("actual_quantity"))

        if planned_date is None or not client_code:
            excluded.append({
                "planned_visit_id": normalize_code(row.get("planned_visit_id")),
                "reason": "missing_identity_or_date",
            })
            continue

        jour_semaine = int((planned_date.weekday() + 1) % 7)
        candidate_row = lookup.get((planned_date.strftime("%Y-%m-%d"), jour_semaine), {}).get(client_code)
        if candidate_row is None:
            excluded.append({
                "planned_visit_id": normalize_code(row.get("planned_visit_id")),
                "client_code": client_code,
                "planned_date": planned_date.strftime("%Y-%m-%d"),
                "reason": "missing_feature_snapshot",
            })
            continue

        training_row = {
            "planned_visit_id": normalize_code(row.get("planned_visit_id")),
            "client_code": client_code,
            "planned_date": planned_date.strftime("%Y-%m-%d"),
            "date": planned_date,
            PURCHASE_TARGET: None,
            CA_TARGET: np.nan,
            QTY_TARGET: np.nan,
        }

        for column in FEATURE_COLUMNS_BASE:
            training_row[column] = pd.to_numeric(candidate_row.get(column), errors="coerce")
        for column in MAIN_CATEGORICAL_COLUMNS:
            training_row[column] = normalize_code(candidate_row.get(column)) or "Inconnu"

        if execution_status == "visited" and purchase_made is not None:
            training_row[PURCHASE_TARGET] = 1 if bool(purchase_made) else 0
            if bool(purchase_made) and actual_ca is not None:
                training_row[CA_TARGET] = actual_ca
            if bool(purchase_made) and actual_quantity is not None:
                training_row[QTY_TARGET] = actual_quantity

        built_rows.append(training_row)

    return pd.DataFrame(built_rows), excluded


def prepare_training_splits(historical_df, train_feedback_df, holdout_feedback_df, training_cutoff):
    train_cutoff = normalize_date(training_cutoff)
    historical_train = historical_df.copy()
    if train_cutoff is not None:
      historical_train = historical_train[historical_train["date"] <= train_cutoff].copy()
    historical_train = historical_train.sort_values(["date", "client_code"]).reset_index(drop=True)

    feedback_train = train_feedback_df.copy().sort_values(["date", "client_code"]).reset_index(drop=True)
    feedback_holdout = holdout_feedback_df.copy().sort_values(["date", "client_code"]).reset_index(drop=True)
    return historical_train, feedback_train, feedback_holdout


def build_purchase_dataset(historical_train, feedback_train):
    historical_part = historical_train[[
        "client_code",
        "date",
        PURCHASE_TARGET,
        *FEATURE_COLUMNS_BASE,
        *MAIN_CATEGORICAL_COLUMNS,
    ]].copy()
    feedback_part = feedback_train[feedback_train[PURCHASE_TARGET].notna()][[
        "client_code",
        "date",
        PURCHASE_TARGET,
        *FEATURE_COLUMNS_BASE,
        *MAIN_CATEGORICAL_COLUMNS,
    ]].copy()
    if feedback_part.empty:
        return historical_part
    feedback_part[PURCHASE_TARGET] = feedback_part[PURCHASE_TARGET].astype(int)
    return pd.concat([historical_part, feedback_part], ignore_index=True)


def build_regression_dataset(historical_train, feedback_train, target_name):
    historical_positive = historical_train[historical_train[PURCHASE_TARGET] == 1][[
        "client_code",
        "date",
        target_name,
        *FEATURE_COLUMNS_BASE,
        *MAIN_CATEGORICAL_COLUMNS,
    ]].copy()
    feedback_positive = feedback_train[feedback_train[target_name].notna()][[
        "client_code",
        "date",
        target_name,
        *FEATURE_COLUMNS_BASE,
        *MAIN_CATEGORICAL_COLUMNS,
    ]].copy()
    if feedback_positive.empty:
        return historical_positive
    return pd.concat([historical_positive, feedback_positive], ignore_index=True)


def compute_regression_metrics(actual_values, predicted_values):
    actual = np.asarray(actual_values, dtype=float)
    predicted = np.asarray(predicted_values, dtype=float)
    if actual.size == 0:
        return {
            "comparable_count": 0,
            "mae": None,
            "rmse": None,
            "bias": None,
            "mape_valid_count": 0,
            "mape": None,
        }

    errors = predicted - actual
    valid_mape_mask = actual > 0
    return {
        "comparable_count": int(actual.size),
        "mae": round(float(mean_absolute_error(actual, predicted)), 6),
        "rmse": round(float(math.sqrt(np.mean(np.square(errors)))), 6),
        "bias": round(float(np.mean(errors)), 6),
        "mape_valid_count": int(valid_mape_mask.sum()),
        "mape": round(float(np.mean(np.abs(errors[valid_mape_mask] / actual[valid_mape_mask])) * 100), 6)
        if valid_mape_mask.any()
        else None,
    }


def compute_classifier_metrics(actual_values, probability_values):
    actual = np.asarray(actual_values, dtype=int)
    probabilities = np.clip(np.asarray(probability_values, dtype=float), 1e-6, 1 - 1e-6)
    if actual.size == 0:
        return {
            "comparable_count": 0,
            "positive_count": 0,
            "negative_count": 0,
            "auc": None,
            "logloss": None,
            "bias": None,
        }

    positive_count = int(actual.sum())
    negative_count = int(actual.size - positive_count)
    auc = None
    if len(np.unique(actual)) >= 2:
        auc = round(float(roc_auc_score(actual, probabilities)), 6)

    return {
        "comparable_count": int(actual.size),
        "positive_count": positive_count,
        "negative_count": negative_count,
        "auc": auc,
        "logloss": round(float(log_loss(actual, probabilities, labels=[0, 1])), 6),
        "bias": round(float(np.mean(probabilities - actual)), 6),
    }


def evaluate_current_models(holdout_df):
    results = {}

    purchase_holdout = holdout_df[holdout_df[PURCHASE_TARGET].notna()].copy()
    if not purchase_holdout.empty:
        purchase_features = api_ia.build_features(purchase_holdout)
        purchase_prob = api_ia.model_achat.predict_proba(purchase_features)[:, 1]
        results["purchase_probability"] = compute_classifier_metrics(
            purchase_holdout[PURCHASE_TARGET].astype(int).to_numpy(),
            purchase_prob,
        )
    else:
        results["purchase_probability"] = compute_classifier_metrics([], [])

    ca_holdout = holdout_df[holdout_df[CA_TARGET].notna()].copy()
    if not ca_holdout.empty:
        ca_features = api_ia.build_features(ca_holdout)
        ca_predictions = np.maximum(1.0, np.expm1(api_ia.model_ca.predict(ca_features)))
        results["ca_if_buy"] = compute_regression_metrics(
            ca_holdout[CA_TARGET].to_numpy(),
            ca_predictions,
        )
    else:
        results["ca_if_buy"] = compute_regression_metrics([], [])

    qty_holdout = holdout_df[holdout_df[QTY_TARGET].notna()].copy()
    if not qty_holdout.empty:
        qty_features = api_ia.build_features(qty_holdout)
        qty_predictions = np.maximum(1.0, np.expm1(api_ia.model_qte.predict(qty_features)))
        results["quantity_if_buy"] = compute_regression_metrics(
            qty_holdout[QTY_TARGET].to_numpy(),
            qty_predictions,
        )
    else:
        results["quantity_if_buy"] = compute_regression_metrics([], [])

    return results


def train_candidate_models(historical_train, feedback_train, feedback_holdout):
    targets_retrained = []
    candidate_models = {}
    candidate_metrics = {}

    purchase_dataset = build_purchase_dataset(historical_train, feedback_train).sort_values(["date", "client_code"])
    purchase_holdout = feedback_holdout[feedback_holdout[PURCHASE_TARGET].notna()].copy()

    if len(purchase_dataset) >= MIN_TARGET_ROWS and not purchase_holdout.empty:
        purchase_features_train = api_ia.build_features(purchase_dataset)
        purchase_features_holdout = api_ia.build_features(purchase_holdout)
        purchase_model = XGBClassifier(**PURCHASE_PARAMS)
        purchase_model.fit(
            purchase_features_train,
            purchase_dataset[PURCHASE_TARGET].astype(int),
            sample_weight=build_recency_weights(purchase_dataset["date"]),
        )
        purchase_prob = purchase_model.predict_proba(purchase_features_holdout)[:, 1]
        candidate_models["purchase_probability"] = purchase_model
        candidate_metrics["purchase_probability"] = compute_classifier_metrics(
            purchase_holdout[PURCHASE_TARGET].astype(int).to_numpy(),
            purchase_prob,
        )
        targets_retrained.append("purchase_probability")
    else:
        candidate_metrics["purchase_probability"] = compute_classifier_metrics([], [])

    ca_dataset = build_regression_dataset(historical_train, feedback_train, CA_TARGET).sort_values(["date", "client_code"])
    ca_holdout = feedback_holdout[feedback_holdout[CA_TARGET].notna()].copy()
    if len(ca_dataset) >= MIN_TARGET_ROWS and not ca_holdout.empty:
        ca_features_train = api_ia.build_features(ca_dataset)
        ca_features_holdout = api_ia.build_features(ca_holdout)
        ca_model = XGBRegressor(**REGRESSION_PARAMS)
        ca_model.fit(
            ca_features_train,
            np.log1p(ca_dataset[CA_TARGET].astype(float)),
            sample_weight=build_recency_weights(ca_dataset["date"]),
        )
        ca_predictions = np.maximum(1.0, np.expm1(ca_model.predict(ca_features_holdout)))
        candidate_models["ca_if_buy"] = ca_model
        candidate_metrics["ca_if_buy"] = compute_regression_metrics(
            ca_holdout[CA_TARGET].to_numpy(),
            ca_predictions,
        )
        targets_retrained.append("ca_if_buy")
    else:
        candidate_metrics["ca_if_buy"] = compute_regression_metrics([], [])

    qty_dataset = build_regression_dataset(historical_train, feedback_train, QTY_TARGET).sort_values(["date", "client_code"])
    qty_holdout = feedback_holdout[feedback_holdout[QTY_TARGET].notna()].copy()
    if len(qty_dataset) >= MIN_TARGET_ROWS and not qty_holdout.empty:
        qty_features_train = api_ia.build_features(qty_dataset)
        qty_features_holdout = api_ia.build_features(qty_holdout)
        qty_model = XGBRegressor(**REGRESSION_PARAMS)
        qty_model.fit(
            qty_features_train,
            np.log1p(qty_dataset[QTY_TARGET].astype(float)),
            sample_weight=build_recency_weights(qty_dataset["date"]),
        )
        qty_predictions = np.maximum(1.0, np.expm1(qty_model.predict(qty_features_holdout)))
        candidate_models["quantity_if_buy"] = qty_model
        candidate_metrics["quantity_if_buy"] = compute_regression_metrics(
            qty_holdout[QTY_TARGET].to_numpy(),
            qty_predictions,
        )
        targets_retrained.append("quantity_if_buy")
    else:
        candidate_metrics["quantity_if_buy"] = compute_regression_metrics([], [])

    return targets_retrained, candidate_models, candidate_metrics


def build_delta(current_metrics, candidate_metrics):
    delta = {
        "purchase_probability": {},
        "ca_if_buy": {},
        "quantity_if_buy": {},
    }

    current_purchase = current_metrics.get("purchase_probability", {})
    candidate_purchase = candidate_metrics.get("purchase_probability", {})
    if current_purchase.get("auc") is not None and candidate_purchase.get("auc") is not None:
        delta["purchase_probability"]["auc"] = round(candidate_purchase["auc"] - current_purchase["auc"], 6)
    if current_purchase.get("logloss") is not None and candidate_purchase.get("logloss") is not None:
        delta["purchase_probability"]["logloss"] = round(candidate_purchase["logloss"] - current_purchase["logloss"], 6)
    if current_purchase.get("bias") is not None and candidate_purchase.get("bias") is not None:
        delta["purchase_probability"]["bias"] = round(candidate_purchase["bias"] - current_purchase["bias"], 6)

    for target_name in ("ca_if_buy", "quantity_if_buy"):
        current_target = current_metrics.get(target_name, {})
        candidate_target = candidate_metrics.get(target_name, {})
        for metric_name in ("mae", "rmse", "bias", "mape"):
            if current_target.get(metric_name) is not None and candidate_target.get(metric_name) is not None:
                delta[target_name][metric_name] = round(candidate_target[metric_name] - current_target[metric_name], 6)

    return delta


def build_recommendation(current_metrics, candidate_metrics):
    comparisons = []

    current_purchase = current_metrics.get("purchase_probability", {})
    candidate_purchase = candidate_metrics.get("purchase_probability", {})
    if current_purchase.get("auc") is not None and candidate_purchase.get("auc") is not None:
        comparisons.append(candidate_purchase["auc"] > current_purchase["auc"])
    if current_purchase.get("logloss") is not None and candidate_purchase.get("logloss") is not None:
        comparisons.append(candidate_purchase["logloss"] < current_purchase["logloss"])

    for target_name in ("ca_if_buy", "quantity_if_buy"):
        current_target = current_metrics.get(target_name, {})
        candidate_target = candidate_metrics.get(target_name, {})
        if current_target.get("mae") is not None and candidate_target.get("mae") is not None:
            comparisons.append(candidate_target["mae"] < current_target["mae"])

    if not comparisons:
        return "insufficient_data"
    if all(comparisons) and any(comparisons):
        return "candidate_better"
    return "current_better"


def save_candidate_artifacts(artifacts_dir, candidate_models, payload, current_metrics, candidate_metrics, delta, recommendation):
    artifact_dir = Path(artifacts_dir)
    artifact_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "artifacts_dir": str(artifact_dir),
        "files": {}
    }

    file_map = {
        "purchase_probability": "modele_nomadis_achat_candidate.pkl",
        "ca_if_buy": "modele_nomadis_ca_candidate.pkl",
        "quantity_if_buy": "modele_nomadis_qte_candidate.pkl",
    }

    for target_name, model in candidate_models.items():
        filename = file_map[target_name]
        target_path = artifact_dir / filename
        joblib.dump(model, target_path)
        manifest["files"][target_name] = str(target_path)

    metadata_path = artifact_dir / "candidate_metadata.json"
    metadata = {
        "candidate_version": payload.get("candidate_version"),
        "trained_at": pd.Timestamp.utcnow().isoformat(),
        "training_data_cutoff": payload.get("train_rows", [])[-1]["planned_date"] if payload.get("train_rows") else None,
        "feedback_rows_used": len(payload.get("train_rows", [])),
        "feedback_rows_holdout": len(payload.get("holdout_rows", [])),
        "current_model": current_metrics,
        "candidate_model": candidate_metrics,
        "delta": delta,
        "recommendation": recommendation,
        "targets_retrained": sorted(candidate_models.keys()),
    }
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf8")
    manifest["files"]["metadata"] = str(metadata_path)
    return manifest


def run_candidate_training(payload, artifacts_dir):
    historical_df = load_historical_training_frame(Path(api_ia.BASE_DIR))
    train_feedback_df, train_excluded = build_feedback_training_rows(
        payload.get("train_rows", []),
        historical_df,
    )
    holdout_feedback_df, holdout_excluded = build_feedback_training_rows(
        payload.get("holdout_rows", []),
        historical_df,
    )

    training_cutoff = payload.get("train_rows", [])[-1].get("planned_date") if payload.get("train_rows") else None
    historical_train, feedback_train, feedback_holdout = prepare_training_splits(
        historical_df,
        train_feedback_df,
        holdout_feedback_df,
        training_cutoff,
    )

    current_metrics = evaluate_current_models(feedback_holdout)
    targets_retrained, candidate_models, candidate_metrics = train_candidate_models(
        historical_train,
        feedback_train,
        feedback_holdout,
    )
    delta = build_delta(current_metrics, candidate_metrics)
    recommendation = build_recommendation(current_metrics, candidate_metrics)

    artifact_manifest = None
    if artifacts_dir:
        artifact_manifest = save_candidate_artifacts(
            artifacts_dir,
            candidate_models,
            payload,
            current_metrics,
            candidate_metrics,
            delta,
            recommendation,
        )

    holdout_dates = [normalize_date(row.get("planned_date")) for row in payload.get("holdout_rows", [])]
    holdout_dates = [date for date in holdout_dates if date is not None]

    return {
        "status": "success",
        "candidate_version": payload.get("candidate_version"),
        "trained_at": pd.Timestamp.utcnow().isoformat(),
        "training_data_cutoff": training_cutoff,
        "feedback_rows_used": len(payload.get("train_rows", [])),
        "feedback_rows_holdout": len(payload.get("holdout_rows", [])),
        "holdout_window": {
            "start_date": holdout_dates[0].strftime("%Y-%m-%d") if holdout_dates else None,
            "end_date": holdout_dates[-1].strftime("%Y-%m-%d") if holdout_dates else None,
        },
        "targets_retrained": targets_retrained,
        "current_model": current_metrics,
        "candidate_model": candidate_metrics,
        "delta": delta,
        "recommendation": recommendation,
        "artifact_manifest": artifact_manifest,
        "metrics": {
            "excluded_feedback_rows": {
                "train": train_excluded,
                "holdout": holdout_excluded,
            },
            "historical_train_rows": int(len(historical_train)),
            "feedback_train_rows_with_features": int(len(feedback_train)),
            "feedback_holdout_rows_with_features": int(len(feedback_holdout)),
        },
        "error": None,
    }


def main():
    args = parse_args()
    input_path = Path(args.input)
    output_path = Path(args.output)

    with input_path.open("r", encoding="utf8") as handle:
        payload = json.load(handle)

    try:
        result = run_candidate_training(payload, args.artifacts_dir)
    except Exception as error:
        result = {
            "status": "failed",
            "candidate_version": payload.get("candidate_version"),
            "trained_at": pd.Timestamp.utcnow().isoformat(),
            "training_data_cutoff": payload.get("train_rows", [])[-1].get("planned_date") if payload.get("train_rows") else None,
            "feedback_rows_used": len(payload.get("train_rows", [])),
            "feedback_rows_holdout": len(payload.get("holdout_rows", [])),
            "holdout_window": None,
            "targets_retrained": [],
            "current_model": None,
            "candidate_model": None,
            "delta": {},
            "recommendation": "current_better",
            "artifact_manifest": None,
            "metrics": None,
            "error": str(error),
        }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf8")


if __name__ == "__main__":
    main()
