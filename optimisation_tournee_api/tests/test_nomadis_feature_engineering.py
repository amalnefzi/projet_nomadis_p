import math
import sys
import unittest
from numbers import Number
from pathlib import Path

import pandas as pd
from sqlalchemy import create_engine


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from nomadis_feature_engineering import (  # noqa: E402
    FEATURE_SCHEMA_VERSION,
    build_canonical_feature_bundle,
    get_mysql_url,
)


CSV_PATH = API_DIR / "dataset_features_clients_jour.csv"
REFERENCE_CASES = [
    ("00002", "2025-01-01"),
    ("00002", "2025-10-03"),
    ("00002", "2026-07-15"),
]


def _load_reference_cases():
    reference = pd.read_csv(CSV_PATH, parse_dates=["date_doc"], low_memory=False)
    reference["client_code"] = reference["client_code"].astype(str).str.zfill(5)
    reference["date_doc"] = pd.to_datetime(reference["date_doc"]).dt.normalize()
    rows = []
    for client_code, date_iso in REFERENCE_CASES:
        matched = reference[
            (reference["client_code"] == client_code)
            & (reference["date_doc"] == pd.Timestamp(date_iso))
        ]
        if matched.empty:
            raise AssertionError(f"Missing historical CSV reference row for {client_code} / {date_iso}")
        rows.append(matched.iloc[[0]])
    return pd.concat(rows, ignore_index=True)


class NomadisFeatureEngineeringParityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.reference_sample = _load_reference_cases()
        if cls.reference_sample.empty:
            raise unittest.SkipTest("dataset_features_clients_jour.csv does not contain usable sample rows")

        cls.cutoff_date = cls.reference_sample["date_doc"].max()
        cls.client_codes = sorted(cls.reference_sample["client_code"].unique())

        engine = create_engine(get_mysql_url())
        try:
            bundle = build_canonical_feature_bundle(
                engine,
                cutoff_date=cls.cutoff_date,
                client_codes=cls.client_codes,
            )
        finally:
            engine.dispose()

        generated = bundle["features"].copy()
        generated["client_code"] = generated["client_code"].astype(str).str.zfill(5)
        generated["date"] = pd.to_datetime(generated["date"]).dt.normalize()
        generated = generated.rename(
            columns={
                "date": "date_doc",
                "vente_nette": "ca_jour",
                "qte_totale": "qte_jour",
            }
        )
        cls.generated = generated

        shared_columns = [
            column
            for column in cls.reference_sample.columns
            if column in cls.generated.columns
        ]
        cls.shared_columns = shared_columns
        cls.generated_lookup = cls.generated.set_index(["client_code", "date_doc"])
        cls.reference_lookup = cls.reference_sample.set_index(["client_code", "date_doc"])

    def test_feature_schema_version_is_defined(self):
        self.assertIsInstance(FEATURE_SCHEMA_VERSION, str)
        self.assertTrue(FEATURE_SCHEMA_VERSION.startswith("sha1:"))

    def test_client_codes_preserve_leading_zeroes(self):
        for code in self.generated["client_code"].dropna().astype(str):
            self.assertEqual(code, code.zfill(5))

    def test_canonical_builder_matches_historical_csv_sample(self):
        numeric_mismatches = []
        exact_mismatches = []

        for key, reference_row in self.reference_lookup.iterrows():
            self.assertIn(key, self.generated_lookup.index, f"Missing generated feature row for {key}")
            generated_row = self.generated_lookup.loc[key]

            for column in self.shared_columns:
                if column in {"client_code", "date_doc"}:
                    continue
                left = generated_row[column]
                right = reference_row[column]

                if pd.isna(left) and pd.isna(right):
                    continue

                if isinstance(left, Number) or isinstance(right, Number):
                    left_value = float(left)
                    right_value = float(right)
                    if not math.isclose(left_value, right_value, rel_tol=1e-5, abs_tol=1e-4):
                        numeric_mismatches.append((key, column, left_value, right_value))
                    continue

                if str(left) != str(right):
                    exact_mismatches.append((key, column, left, right))

        self.assertFalse(
            numeric_mismatches,
            f"Numeric feature mismatches found: {numeric_mismatches[:5]}",
        )
        self.assertFalse(
            exact_mismatches,
            f"Categorical feature mismatches found: {exact_mismatches[:5]}",
        )

    def test_normalize_base_dataset_collapses_duplicate_client_day_rows(self):
        sample = pd.DataFrame([
            {
                "client_code": "CLT00",
                "date_doc": pd.Timestamp("2026-02-11"),
                "region": "GT",
                "delegation": "Ariana",
                "routing_code": "1",
                "home_commercial": "1",
                "potentiel": 10.0,
                "ca_jour": 278.760,
                "qte_jour": 26.0,
                "docs_jour": 1.0,
                "line_items_jour": 2.0,
                "product_refs_jour": 2.0,
            },
            {
                "client_code": "CLT00",
                "date_doc": pd.Timestamp("2026-02-11"),
                "region": "GT",
                "delegation": "Ariana",
                "routing_code": "1",
                "home_commercial": "1",
                "potentiel": 10.0,
                "ca_jour": 92.845,
                "qte_jour": 2.0,
                "docs_jour": 1.0,
                "line_items_jour": 1.0,
                "product_refs_jour": 1.0,
            },
        ])

        from nomadis_feature_engineering import normalize_base_dataset

        normalized = normalize_base_dataset(sample)
        self.assertEqual(len(normalized), 1)
        row = normalized.iloc[0]
        self.assertEqual(row["client_code"], "CLT00")
        self.assertEqual(pd.Timestamp(row["date_doc"]).date().isoformat(), "2026-02-11")
        self.assertAlmostEqual(float(row["ca_jour"]), 371.605, places=6)
        self.assertAlmostEqual(float(row["qte_jour"]), 28.0, places=6)
        self.assertAlmostEqual(float(row["docs_jour"]), 2.0, places=6)
        self.assertAlmostEqual(float(row["line_items_jour"]), 3.0, places=6)
        self.assertAlmostEqual(float(row["product_refs_jour"]), 3.0, places=6)


if __name__ == "__main__":
    unittest.main()
