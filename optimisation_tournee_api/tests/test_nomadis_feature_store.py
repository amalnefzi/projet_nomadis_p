import sys
import unittest
from pathlib import Path
from unittest import mock
from datetime import date

import pandas as pd
from sqlalchemy import create_engine


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import api_ia  # noqa: E402
from nomadis_feature_store import (  # noqa: E402
    FEATURE_SCHEMA_VERSION,
    build_feature_store_source_summary,
    compute_effective_history_cutoff,
    feature_store_covers_target_date,
    persist_feature_store_snapshot,
    feature_store_is_current,
)


class NomadisFeatureStoreServingTest(unittest.TestCase):
    def setUp(self):
        self.original_df_master = api_ia.df_master
        self.original_df_daily_demand = api_ia.df_daily_demand
        self.original_df_prefs = api_ia.df_prefs
        self.original_prediction_history_source = api_ia.prediction_history_source
        self.original_feature_store_state = api_ia.feature_store_state
        self.original_feature_store_refresh_thread = api_ia.feature_store_refresh_thread
        self.original_feature_store_refresh_last_result = api_ia.feature_store_refresh_last_result

    def tearDown(self):
        api_ia.df_master = self.original_df_master
        api_ia.df_daily_demand = self.original_df_daily_demand
        api_ia.df_prefs = self.original_df_prefs
        api_ia.prediction_history_source = self.original_prediction_history_source
        api_ia.feature_store_state = self.original_feature_store_state
        api_ia.feature_store_refresh_thread = self.original_feature_store_refresh_thread
        api_ia.feature_store_refresh_last_result = self.original_feature_store_refresh_last_result

    def test_feature_store_current_depends_on_active_snapshot_and_watermark(self):
        source_summary = {"watermark": "sha1:abc"}
        state = {
            "status": "failed",
            "active_feature_schema_version": FEATURE_SCHEMA_VERSION,
            "active_feature_state_version": "sha1:state",
            "active_source_data_watermark": "sha1:abc",
        }
        self.assertTrue(feature_store_is_current(state, source_summary))

        mismatched = dict(state, active_source_data_watermark="sha1:def")
        self.assertFalse(feature_store_is_current(mismatched, source_summary))

    def test_effective_cutoff_uses_prediction_date_minus_one_day_and_source_max(self):
        state = {"active_source_max_date": "2026-08-11"}
        cutoff = compute_effective_history_cutoff("2026-08-12", state)
        self.assertEqual(cutoff.date().isoformat(), "2026-08-11")

        future_source_state = {"active_source_max_date": "2035-02-15"}
        no_leak_cutoff = compute_effective_history_cutoff("2026-08-12", future_source_state)
        self.assertEqual(no_leak_cutoff.date().isoformat(), "2026-08-11")

        limited_state = {"active_source_max_date": "2026-07-15"}
        bounded_cutoff = compute_effective_history_cutoff("2026-08-12", limited_state)
        self.assertEqual(bounded_cutoff.date().isoformat(), "2026-07-15")

    def test_load_feature_store_runtime_builds_daily_history_from_store_not_csv(self):
        store_history = pd.DataFrame([
            {
                "client_code": "00158",
                "history_date": pd.Timestamp("2026-08-11"),
                "date_doc": pd.Timestamp("2026-08-11"),
                "ca_jour": 120.0,
                "qte_jour": 8.0,
                "achat_target": 1,
                "jour_semaine": 2,
                "region": "GT",
                "delegation": "Ariana",
                "routing_code": "1",
                "home_commercial": "1",
            }
        ])
        loaded_state = {
            "active_source_max_date": "2026-08-11",
            "active_source_data_watermark": "sha1:abc",
            "active_feature_state_version": "sha1:state",
        }
        observed = {}

        def fake_load_daily_demand_history(history, prefer_csv=True):
            observed["prefer_csv"] = prefer_csv
            observed["history_rows"] = len(history)
            return pd.DataFrame([{
                "date_doc": pd.Timestamp("2026-08-11"),
                "jour_semaine": 2,
                "total_ca": 120.0,
                "total_qte": 8.0,
                "buyers": 1,
                "active_clients": 1,
            }])

        with mock.patch.object(api_ia, "load_active_feature_store_frame", return_value=(store_history, loaded_state)), \
             mock.patch.object(api_ia, "build_preferences_frame", return_value=pd.DataFrame(columns=["client_code", "produit_nom", "produit_code", "qte_moyenne"])), \
             mock.patch.object(api_ia, "load_daily_demand_history", side_effect=fake_load_daily_demand_history):
            ready = api_ia.load_feature_store_runtime(engine=object())

        self.assertTrue(ready)
        self.assertEqual(api_ia.prediction_history_source, "canonical_feature_store")
        self.assertFalse(observed["prefer_csv"])
        self.assertEqual(observed["history_rows"], 1)

    def test_build_daily_demand_history_accepts_canonical_runtime_column_names(self):
        history = pd.DataFrame([
            {
                "client_code": "00158",
                "date": pd.Timestamp("2026-08-11"),
                "history_date": pd.Timestamp("2026-08-11"),
                "vente_nette": 120.0,
                "qte_totale": 8.0,
                "achat_target": 1,
            },
            {
                "client_code": "00159",
                "date": pd.Timestamp("2026-08-11"),
                "history_date": pd.Timestamp("2026-08-11"),
                "vente_nette": 30.0,
                "qte_totale": 2.0,
                "achat_target": 1,
            },
        ])

        daily = api_ia.build_daily_demand_history(history)

        self.assertEqual(len(daily), 1)
        self.assertEqual(daily.iloc[0]["date_doc"].date().isoformat(), "2026-08-11")
        self.assertEqual(float(daily.iloc[0]["total_ca"]), 150.0)
        self.assertEqual(float(daily.iloc[0]["total_qte"]), 10.0)
        self.assertEqual(int(daily.iloc[0]["buyers"]), 2)
        self.assertEqual(int(daily.iloc[0]["active_clients"]), 2)

    def test_select_prediction_candidates_uses_canonical_store_cutoff(self):
        api_ia.df_master = pd.DataFrame([
            {
                "client_code": "00158",
                "history_date": pd.Timestamp("2026-08-12"),
                "date": pd.Timestamp("2026-08-12"),
                "jour_semaine": 3,
                "vente_last": 233.013,
                "region": "GT",
                "delegation": "Ariana",
                "routing_code": "1",
                "home_commercial": "1",
            },
            {
                "client_code": "00158",
                "history_date": pd.Timestamp("2026-08-19"),
                "date": pd.Timestamp("2026-08-19"),
                "jour_semaine": 3,
                "vente_last": 777.0,
                "region": "GT",
                "delegation": "Ariana",
                "routing_code": "1",
                "home_commercial": "1",
            },
        ])
        api_ia.prediction_history_source = "canonical_feature_store"

        with mock.patch.object(api_ia, "ensure_feature_store_ready_for_target_date", return_value={
            "status": "ready",
            "effective_cutoff": "2026-08-11",
        }), mock.patch.object(api_ia, "build_feature_store_source_data_version", return_value="sha1:abc"):
            candidates, history_meta = api_ia.select_prediction_candidates("2026-08-12", 3)

        self.assertEqual(history_meta["history_source"], "canonical_feature_store")
        self.assertEqual(history_meta["history_cutoff_date"], "2026-08-11")
        self.assertEqual(history_meta["history_trusted_max_date"], "2026-08-11")
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates.iloc[0]["client_code"], "00158")
        self.assertEqual(pd.Timestamp(candidates.iloc[0]["date"]).date().isoformat(), "2026-08-12")
        self.assertEqual(float(candidates.iloc[0]["vente_last"]), 233.013)

    def test_feature_store_target_coverage_uses_serving_horizon(self):
        state = {
            "active_source_summary": {
                "serving_horizon_end_date": "2026-12-10"
            }
        }
        self.assertTrue(feature_store_covers_target_date(state, "2026-09-01"))
        self.assertFalse(feature_store_covers_target_date(state, "2027-01-05"))

    def test_build_feature_store_source_summary_keeps_real_query_counts(self):
        fake_row = {
            "source_max_date": date(2026, 8, 11),
            "txn_count": 11168,
            "client_count": 850,
            "txn_day_count": 541,
            "total_net_amount": 2258440.853,
            "max_doc_code": "FAC24700106",
        }

        class FakeResult:
            def mappings(self):
                return self

            def first(self):
                return fake_row

        class FakeConnection:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc_val, exc_tb):
                return False

            def execute(self, *args, **kwargs):
                return FakeResult()

        class FakeEngine:
            def connect(self):
                return FakeConnection()

        summary = build_feature_store_source_summary(
            FakeEngine(),
            reference_now="2026-08-12",
            target_date="2026-08-12",
        )

        self.assertEqual(summary["source_upper_bound_date"], "2026-08-11")
        self.assertEqual(summary["source_max_date"], "2026-08-11")
        self.assertEqual(summary["txn_count"], 11168)
        self.assertEqual(summary["client_count"], 850)
        self.assertEqual(summary["txn_day_count"], 541)
        self.assertAlmostEqual(summary["total_net_amount"], 2258440.853, places=3)
        self.assertEqual(summary["max_doc_code"], "FAC24700106")

    def test_schedule_feature_store_refresh_skips_when_source_is_current(self):
        source_summary = {"watermark": "sha1:abc"}
        state = {
            "status": "ready",
            "active_feature_schema_version": FEATURE_SCHEMA_VERSION,
            "active_feature_state_version": "sha1:state",
            "active_source_data_watermark": "sha1:abc",
        }
        with mock.patch.object(api_ia, "get_feature_store_engine", return_value=object()), \
             mock.patch.object(api_ia, "build_feature_store_source_summary", return_value=source_summary), \
             mock.patch.object(api_ia, "read_feature_store_state", return_value=state), \
             mock.patch.object(api_ia, "refresh_feature_store_singleflight") as refresh_mock:
            result = api_ia.schedule_feature_store_refresh_if_needed(reason="startup")

        self.assertEqual(result["status"], "ready")
        self.assertTrue(result["skipped"])
        self.assertEqual(result["reason"], "already_current")
        refresh_mock.assert_not_called()

    def test_schedule_feature_store_refresh_recovers_expired_building_state(self):
        source_summary = {"watermark": "sha1:new"}
        stale_state = {
            "status": "building",
            "rebuild_started_at": "2026-08-01T00:00:00",
            "active_feature_schema_version": FEATURE_SCHEMA_VERSION,
            "active_feature_state_version": "sha1:old",
            "active_source_data_watermark": "sha1:old",
        }
        with mock.patch.object(api_ia, "get_feature_store_engine", return_value=object()), \
             mock.patch.object(api_ia, "build_feature_store_source_summary", return_value=source_summary), \
             mock.patch.object(api_ia, "read_feature_store_state", return_value=stale_state), \
             mock.patch.object(api_ia, "feature_store_build_expired", return_value=True), \
             mock.patch.object(api_ia, "refresh_feature_store_singleflight", return_value={"status": "building", "reason": "startup"}) as refresh_mock:
            result = api_ia.schedule_feature_store_refresh_if_needed(reason="startup")

        self.assertEqual(result["status"], "building")
        refresh_mock.assert_called_once()

    def test_refresh_feature_store_singleflight_wait_reuses_inflight_thread(self):
        active_thread = mock.Mock()
        active_thread.is_alive.side_effect = [True, True, False]
        api_ia.feature_store_refresh_thread = active_thread
        api_ia.feature_store_refresh_last_result = {"status": "ready", "reason": "background"}

        with mock.patch.object(api_ia, "_feature_store_refresh_worker") as worker_mock:
            result = api_ia.refresh_feature_store_singleflight(reason="prediction_request", wait=True)

        active_thread.join.assert_called_once_with(timeout=api_ia.FEATURE_STORE_BUILD_TIMEOUT_SECONDS)
        worker_mock.assert_not_called()
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["reason"], "background")

    def test_predict_route_uses_preferences_for_request_cutoff(self):
        scored_candidates = pd.DataFrame([
            {
                "client_code": "00158",
                "Prob_achat": 12.5,
                "Prob_modele": 14.0,
                "Habit_score": 40.0,
                "Recency_score": 42.0,
                "Pred_ca_if_buy": 44.7,
                "Pred_qte_if_buy": 9.6,
                "Prix_pred": 7.0,
                "Vn_predit": 5.59,
                "Qte_predite": 0.8,
                "Confidence": 65.0,
                "Cadence_score": 55.0,
                "Basket_fit_score": 60.0,
                "Score": 41.0,
                "VIP": 40,
            }
        ])
        scoring_result = {
            "date_str": "2026-08-12",
            "clients_du_jour": scored_candidates,
            "history_meta": {
                "history_source": "canonical_feature_store",
                "history_cutoff_date": "2026-08-11",
            },
            "filtered_clients": scored_candidates,
            "selected_limit": 1,
            "selected_commercials": ["1"],
            "budget_meta": {},
        }
        expected_preferences = pd.DataFrame([
            {"client_code": "00158", "produit_nom": "LBEN 430 GR", "produit_code": "BR010124", "qte_moyenne": 2.0}
        ])
        captured = {}

        def fake_dashboard_output(filtered_clients, selected_limit, selected_commercials, preferences_frame=None):
            captured["preferences_frame"] = preferences_frame.copy() if preferences_frame is not None else None
            return {
                "filtered_head": filtered_clients.head(selected_limit).copy(),
                "predictions": {
                    "00158": {
                        "score": 41.0,
                        "confidence": 65.0,
                        "vip": 40,
                        "qte": 1,
                        "chiffre": 5.59,
                        "ca_if_buy": 44.7,
                        "qte_if_buy": 9.6,
                        "details": {"LBEN 430 GR": 1},
                        "prix_moyen": 5.59,
                        "prob_achat": 12.5,
                        "prob_modele": 14.0,
                        "habit_score": 40.0,
                        "recency_score": 42.0,
                        "cadence_score": 55.0,
                        "basket_fit_score": 60.0,
                        "commercial_scores": {"1": 100.0},
                        "best_commercial": "1",
                    }
                }
            }

        with api_ia.app.test_request_context(
            "/api/predict",
            method="POST",
            json={"date": "2026-08-12", "commercials": ["1"]},
        ), mock.patch.object(api_ia, "build_scored_prediction_candidates", return_value=scoring_result), \
             mock.patch.object(api_ia, "get_preferences_frame_for_cutoff", return_value=expected_preferences) as prefs_mock, \
             mock.patch.object(api_ia, "build_dashboard_prediction_output", side_effect=fake_dashboard_output), \
             mock.patch.object(api_ia, "finalize_prediction_response", side_effect=lambda _data, payload, status_code=200: (payload, status_code)):
            payload, status_code = api_ia.predict_tournee()

        self.assertEqual(status_code, 200)
        prefs_mock.assert_called_once_with("2026-08-11", engine=api_ia.feature_store_engine)
        self.assertIsNotNone(captured.get("preferences_frame"))
        pd.testing.assert_frame_equal(
            captured["preferences_frame"].reset_index(drop=True),
            expected_preferences.reset_index(drop=True),
        )
        self.assertEqual(payload["status"], "success")
        self.assertEqual(payload["meta"]["history_cutoff_date"], "2026-08-11")

    def test_persist_feature_store_snapshot_handles_duplicate_columns(self):
        engine = create_engine("sqlite:///:memory:")
        with engine.begin() as connection:
            connection.exec_driver_sql("""
                CREATE TABLE nomadis_client_feature_store (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    feature_state_version TEXT NOT NULL,
                    feature_schema_version TEXT NOT NULL,
                    source_data_watermark TEXT NOT NULL,
                    source_max_date TEXT,
                    computed_at TEXT,
                    client_code TEXT NOT NULL,
                    date_doc TEXT NOT NULL,
                    region TEXT,
                    delegation TEXT,
                    routing_code TEXT,
                    home_commercial TEXT,
                    potentiel REAL,
                    ca_jour REAL,
                    qte_jour REAL,
                    docs_jour REAL,
                    line_items_jour REAL,
                    product_refs_jour REAL,
                    achat_target INTEGER,
                    jour_semaine INTEGER,
                    day_of_month INTEGER,
                    week_of_month INTEGER,
                    days_to_month_end INTEGER,
                    is_month_start INTEGER,
                    is_month_end INTEGER,
                    nbr_visites_hist REAL,
                    nbr_visites_jour REAL,
                    days_since_last_order REAL,
                    vente_last REAL,
                    qte_last REAL,
                    docs_last REAL,
                    line_items_last REAL,
                    product_refs_last REAL,
                    vente_avg_3 REAL,
                    qte_avg_3 REAL,
                    docs_avg_3 REAL,
                    line_items_avg_3 REAL,
                    product_refs_avg_3 REAL,
                    ca_last_7d REAL,
                    ca_last_30d REAL,
                    ca_last_60d REAL,
                    ca_last_90d REAL,
                    qte_last_7d REAL,
                    qte_last_30d REAL,
                    qte_last_60d REAL,
                    qte_last_90d REAL,
                    docs_last_30d REAL,
                    docs_last_90d REAL,
                    line_items_last_30d REAL,
                    line_items_last_90d REAL,
                    product_refs_last_30d REAL,
                    product_refs_last_90d REAL,
                    orders_last_7d REAL,
                    orders_last_30d REAL,
                    orders_last_60d REAL,
                    orders_last_90d REAL,
                    avg_ca_per_order_90d REAL,
                    avg_qte_per_order_90d REAL,
                    avg_docs_per_order_90d REAL,
                    avg_line_items_per_order_90d REAL,
                    avg_product_refs_per_order_90d REAL,
                    weekday_purchase_rate REAL,
                    days_since_last_same_weekday_order REAL,
                    days_between_last_orders REAL,
                    avg_days_between_orders_5 REAL,
                    order_gap_ratio REAL,
                    recent_ca_trend REAL,
                    recent_qte_trend REAL,
                    avg_price_hist REAL,
                    month INTEGER,
                    created_at TEXT,
                    updated_at TEXT
                )
            """)
            connection.exec_driver_sql("""
                CREATE TABLE nomadis_feature_store_state (
                    state_key TEXT PRIMARY KEY,
                    active_feature_schema_version TEXT,
                    active_feature_state_version TEXT,
                    active_source_data_watermark TEXT,
                    active_source_max_date TEXT,
                    active_row_count INTEGER,
                    active_client_count INTEGER,
                    active_computed_at TEXT,
                    active_source_summary_json TEXT,
                    status TEXT NOT NULL DEFAULT 'missing',
                    rebuild_reason TEXT,
                    rebuild_started_at TEXT,
                    last_completed_at TEXT,
                    error_message TEXT
                )
            """)
            connection.exec_driver_sql("""
                INSERT INTO nomadis_feature_store_state (state_key, status)
                VALUES ('active', 'missing')
            """)
        features = pd.DataFrame([
            {
                "client_code": "00158",
                "date": pd.Timestamp("2026-08-11"),
                "region": "GT",
                "delegation": "Ariana",
                "routing_code": "1",
                "home_commercial": "1",
                "potentiel": 12.0,
                "vente_nette": 44.7,
                "qte_totale": 9.6,
                "achat_target": 1,
                "jour_semaine": 2,
                "day_of_month": 11,
                "week_of_month": 2,
                "days_to_month_end": 20,
                "is_month_start": 0,
                "is_month_end": 0,
                "nbr_visites_hist": 8,
                "nbr_visites_jour": 4,
                "days_since_last_order": 1,
                "vente_last": 233.013,
                "qte_last": 24,
                "docs_last": 1,
                "line_items_last": 2,
                "product_refs_last": 2,
                "vente_avg_3": 163.0,
                "qte_avg_3": 12.0,
                "docs_avg_3": 1.0,
                "line_items_avg_3": 2.0,
                "product_refs_avg_3": 2.0,
                "ca_last_7d": 233.013,
                "ca_last_30d": 233.013,
                "ca_last_60d": 233.013,
                "ca_last_90d": 233.013,
                "qte_last_7d": 24.0,
                "qte_last_30d": 24.0,
                "qte_last_60d": 24.0,
                "qte_last_90d": 24.0,
                "docs_last_30d": 1.0,
                "docs_last_90d": 1.0,
                "line_items_last_30d": 2.0,
                "line_items_last_90d": 2.0,
                "product_refs_last_30d": 2.0,
                "product_refs_last_90d": 2.0,
                "orders_last_7d": 1.0,
                "orders_last_30d": 1.0,
                "orders_last_60d": 1.0,
                "orders_last_90d": 1.0,
                "avg_ca_per_order_90d": 233.013,
                "avg_qte_per_order_90d": 24.0,
                "avg_docs_per_order_90d": 1.0,
                "avg_line_items_per_order_90d": 2.0,
                "avg_product_refs_per_order_90d": 2.0,
                "weekday_purchase_rate": 0.5,
                "days_since_last_same_weekday_order": 7.0,
                "days_between_last_orders": 7.0,
                "avg_days_between_orders_5": 7.0,
                "order_gap_ratio": 1.0,
                "recent_ca_trend": 0.1,
                "recent_qte_trend": 0.1,
                "avg_price_hist": 7.35,
                "month": 8,
            }
        ])
        features["potentiel_duplicate"] = features["potentiel"]
        features = features.rename(columns={"potentiel_duplicate": "potentiel"})
        source_summary = {
            "watermark": "sha1:abc",
            "source_max_date": "2026-08-11",
        }

        with mock.patch("nomadis_feature_store.ensure_feature_store_tables", autospec=True):
            persisted = persist_feature_store_snapshot(
                engine,
                {"features": features},
                source_summary,
                reason="unit_test",
            )
        state = pd.read_sql("SELECT * FROM nomadis_feature_store_state WHERE state_key = 'active'", engine)
        loaded_rows = pd.read_sql("SELECT * FROM nomadis_client_feature_store", engine)

        self.assertEqual(persisted["row_count"], 1)
        self.assertEqual(state.iloc[0]["status"], "ready")
        self.assertEqual(len(loaded_rows), 1)
        self.assertEqual(str(loaded_rows.iloc[0]["client_code"]).zfill(5), "00158")


if __name__ == "__main__":
    unittest.main()
