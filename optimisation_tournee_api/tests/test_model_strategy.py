import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import pandas as pd


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import api_ia  # noqa: E402
from nomadis_feature_engineering import blend_expected_quantity  # noqa: E402
from nomadis_model_strategy import (  # noqa: E402
    build_historical_baselines,
    choose_strategy,
    compute_regression_metrics,
    load_strategy,
)


class _StaticClassifier:
    def __init__(self, probability):
        self.probability = float(probability)

    def predict_proba(self, frame):
        return np.tile([1.0 - self.probability, self.probability], (len(frame), 1))


class _StaticRegressor:
    def __init__(self, prediction):
        self.prediction = float(prediction)

    def predict(self, frame):
        return np.full(len(frame), np.log1p(self.prediction), dtype=float)


class ModelStrategyTest(unittest.TestCase):
    def test_regression_metrics_report_explicit_fields_only(self):
        metrics = compute_regression_metrics([0.0, 10.0, 20.0], [0.0, 8.0, 25.0])

        self.assertEqual(set(metrics.keys()), {"r2", "mae", "mape"})
        self.assertAlmostEqual(metrics["mae"], 2.3333, places=4)
        self.assertAlmostEqual(metrics["mape"], 22.5, places=1)

    def test_strategy_selection_prefers_baseline_when_mae_is_lower(self):
        selection = choose_strategy(
            {"r2": -0.32, "mae": 14.0, "mape": 79.3},
            {"r2": 0.05, "mae": 8.5, "mape": 40.0},
        )

        self.assertEqual(selection["selected"], "baseline_history")
        self.assertEqual(selection["selection_metric"], "mae")

    def test_load_strategy_reads_persisted_target_choices(self):
        payload = {
            "strategy_version": 1,
            "selection_metric": "mae",
            "targets": {
                "ca_if_buy": {"selected": "baseline_history"},
                "qte_if_buy": {"selected": "model"},
                "price_if_buy": {"selected": "baseline_history"},
            },
        }

        with tempfile.TemporaryDirectory() as tmp_dir:
            strategy_path = Path(tmp_dir) / "model_strategy.json"
            strategy_path.write_text(json.dumps(payload), encoding="utf8")
            loaded = load_strategy(tmp_dir)

        self.assertEqual(loaded["targets"]["ca_if_buy"]["selected"], "baseline_history")
        self.assertEqual(loaded["targets"]["qte_if_buy"]["selected"], "model")
        self.assertEqual(loaded["targets"]["price_if_buy"]["selected"], "baseline_history")

    def test_api_scoring_uses_persisted_baseline_strategy(self):
        candidate_row = {column: 0.0 for column in api_ia.FEATURE_COLUMNS_BASE}
        candidate_row.update({
            "client_code": "00158",
            "region": "GT",
            "delegation": "Ariana",
            "routing_code": "1",
            "home_commercial": "C01",
            "avg_ca_per_order_90d": 50.0,
            "avg_qte_per_order_90d": 7.0,
            "avg_price_hist": 10.0,
            "nbr_visites_hist": 8.0,
            "nbr_visites_jour": 4.0,
            "weekday_purchase_rate": 0.5,
            "days_since_last_order": 7.0,
            "days_since_last_same_weekday_order": 7.0,
            "recent_ca_trend": 0.1,
            "recent_qte_trend": 0.1,
            "avg_days_between_orders_5": 7.0,
            "order_gap_ratio": 1.0,
            "jour_semaine": 0,
        })
        candidates = pd.DataFrame([candidate_row])

        original_strategy = api_ia.model_strategy
        original_model_achat = api_ia.model_achat
        original_model_ca = api_ia.model_ca
        original_model_qte = api_ia.model_qte
        original_model_price = api_ia.model_price
        original_feature_columns = api_ia.feature_columns
        original_df_master = api_ia.df_master

        api_ia.model_strategy = {
            "targets": {
                "ca_if_buy": {"selected": "baseline_history"},
                "qte_if_buy": {"selected": "baseline_history"},
                "price_if_buy": {"selected": "baseline_history"},
            }
        }
        api_ia.model_achat = _StaticClassifier(0.8)
        api_ia.model_ca = _StaticRegressor(5.0)
        api_ia.model_qte = _StaticRegressor(0.2)
        api_ia.model_price = _StaticRegressor(1.5)
        api_ia.feature_columns = list(api_ia.build_features(candidates).columns)
        api_ia.df_master = candidates.copy()

        try:
            with mock.patch.object(api_ia, "select_prediction_candidates", return_value=(candidates.copy(), {
                "history_source": "canonical_feature_store",
                "history_cutoff_date": "2026-08-22",
                "history_candidates_count": 1,
            })), mock.patch.object(api_ia, "estimate_daily_budget", return_value={
                "expected_buyers_estimate": 1,
                "expected_total_ca": 40.0,
                "expected_total_qte": 8.0,
            }), mock.patch.object(api_ia, "apply_daily_budget_controls", side_effect=lambda frame, meta: (frame, meta)):
                result = api_ia.build_scored_prediction_candidates({"date": "2026-08-23"})
        finally:
            api_ia.model_strategy = original_strategy
            api_ia.model_achat = original_model_achat
            api_ia.model_ca = original_model_ca
            api_ia.model_qte = original_model_qte
            api_ia.model_price = original_model_price
            api_ia.feature_columns = original_feature_columns
            api_ia.df_master = original_df_master

        scored = result["clients_du_jour"].iloc[0]
        self.assertEqual(result["strategy_meta"]["ca_if_buy"], "baseline_history")
        self.assertEqual(result["strategy_meta"]["qte_if_buy"], "baseline_history")
        self.assertEqual(result["strategy_meta"]["price_if_buy"], "baseline_history")
        self.assertAlmostEqual(float(scored["Pred_ca_if_buy"]), 50.0, places=4)
        self.assertAlmostEqual(float(scored["Pred_qte_if_buy"]), 7.0, places=4)
        self.assertAlmostEqual(float(scored["Prix_pred"]), 10.0, places=4)

    def test_blend_expected_quantity_does_not_force_minimum_quantity(self):
        blended = blend_expected_quantity(
            np.array([0.0]),
            np.array([0.0]),
            np.array([0.2]),
            np.array([1.0]),
            np.array([10.0]),
        )

        self.assertEqual(float(blended[0]), 0.0)

    def test_historical_feature_store_queries_keep_text_and_standard_str_to_date(self):
        train_auto_source = (API_DIR / "train_auto.py").read_text(encoding="utf8")
        feature_source = (API_DIR / "nomadis_feature_engineering.py").read_text(encoding="utf8")

        self.assertIn("pd.read_sql(text(get_base_dataset_query()), engine)", train_auto_source)
        self.assertIn("pd.read_sql(text(get_assignment_dataset_query()), engine)", train_auto_source)
        self.assertIn("pd.read_sql(text(query_prefs), engine)", train_auto_source)
        self.assertIn("STR_TO_DATE(e.date, '%Y-%m-%d %H:%i:%s')", feature_source)
        self.assertNotIn("%%Y", feature_source)


if __name__ == "__main__":
    unittest.main()
