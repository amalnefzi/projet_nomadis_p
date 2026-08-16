import importlib
import sys
import types
import unittest
from pathlib import Path

import numpy as np
import pandas as pd


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def install_fake_api_ia():
    fake_api = types.ModuleType("api_ia")
    fake_api.FEATURE_COLUMNS_BASE = [
        "jour_semaine",
        "vente_last",
        "qte_last",
        "ca_last_30d",
        "orders_last_30d",
    ]
    fake_api.MAIN_CATEGORICAL_COLUMNS = [
        "region",
        "delegation",
        "routing_code",
        "home_commercial",
    ]
    fake_api.feature_store_engine = None
    fake_api.get_mysql_url = lambda: "sqlite://"
    fake_api.build_features = lambda frame: frame[fake_api.FEATURE_COLUMNS_BASE + fake_api.MAIN_CATEGORICAL_COLUMNS].copy()
    sys.modules["api_ia"] = fake_api
    return fake_api


class TrainCandidateFeedbackCanonicalLookupTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original_api = sys.modules.get("api_ia")
        install_fake_api_ia()
        cls.module = importlib.import_module("train_candidate_feedback")

    @classmethod
    def tearDownClass(cls):
        if cls.original_api is not None:
            sys.modules["api_ia"] = cls.original_api
        else:
            sys.modules.pop("api_ia", None)

    def test_build_feedback_training_rows_uses_canonical_feature_store_frame(self):
        feedback_rows = [{
            "planned_visit_id": "pv-00158",
            "client_code": "00158",
            "planned_date": "2026-08-12",
            "execution_status": "visited",
            "purchase_made": True,
            "actual_ca": 120.5,
            "actual_quantity": 7,
        }]

        historical_df = pd.DataFrame([
            {
                "client_code": "00158",
                "date": pd.Timestamp("2026-08-12"),
                "jour_semaine": 3,
                "vente_last": 243.241,
                "qte_last": 27,
                "ca_last_30d": 3075.826,
                "orders_last_30d": 4,
                "region": "GT",
                "delegation": "Ariana_Ville",
                "routing_code": "1",
                "home_commercial": "1",
            },
            {
                "client_code": "00158",
                "date": pd.Timestamp("2026-08-19"),
                "jour_semaine": 3,
                "vente_last": 999.0,
                "qte_last": 99,
                "ca_last_30d": 9999.0,
                "orders_last_30d": 99,
                "region": "GT",
                "delegation": "Ariana_Ville",
                "routing_code": "1",
                "home_commercial": "1",
            },
        ])

        built_rows, excluded = self.module.build_feedback_training_rows(feedback_rows, historical_df)

        self.assertEqual(excluded, [])
        self.assertEqual(len(built_rows), 1)
        row = built_rows.iloc[0]
        self.assertEqual(row["client_code"], "00158")
        self.assertEqual(pd.Timestamp(row["date"]).date().isoformat(), "2026-08-12")
        self.assertAlmostEqual(float(row["vente_last"]), 243.241, places=6)
        self.assertAlmostEqual(float(row["qte_last"]), 27.0, places=6)
        self.assertAlmostEqual(float(row["ca_last_30d"]), 3075.826, places=6)
        self.assertAlmostEqual(float(row["orders_last_30d"]), 4.0, places=6)
        self.assertEqual(int(row[self.module.PURCHASE_TARGET]), 1)
        self.assertAlmostEqual(float(row[self.module.CA_TARGET]), 120.5, places=6)
        self.assertAlmostEqual(float(row[self.module.QTY_TARGET]), 7.0, places=6)

    def test_build_feedback_training_rows_accepts_client_absent_from_legacy_csv_if_present_in_store(self):
        feedback_rows = [{
            "planned_visit_id": "pv-clt999",
            "client_code": "CLT999",
            "planned_date": "2026-08-12",
            "execution_status": "visited",
            "purchase_made": False,
            "actual_ca": None,
            "actual_quantity": None,
        }]

        historical_df = pd.DataFrame([
            {
                "client_code": "CLT999",
                "date": pd.Timestamp("2026-08-12"),
                "jour_semaine": 3,
                "vente_last": 12.0,
                "qte_last": 2,
                "ca_last_30d": 18.0,
                "orders_last_30d": 1,
                "region": "GT",
                "delegation": "Ariana_Ville",
                "routing_code": "1",
                "home_commercial": "1",
            }
        ])

        built_rows, excluded = self.module.build_feedback_training_rows(feedback_rows, historical_df)

        self.assertEqual(excluded, [])
        self.assertEqual(len(built_rows), 1)
        row = built_rows.iloc[0]
        self.assertEqual(row["client_code"], "CLT999")
        self.assertEqual(int(row[self.module.PURCHASE_TARGET]), 0)
        self.assertTrue(np.isnan(row[self.module.CA_TARGET]))
        self.assertTrue(np.isnan(row[self.module.QTY_TARGET]))


if __name__ == "__main__":
    unittest.main()
