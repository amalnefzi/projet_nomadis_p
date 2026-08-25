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
    build_feature_panel_from_base,
    build_valid_sales_document_filters,
    enrich_panel_features,
    get_assignment_dataset_query,
    get_base_dataset_query,
    get_preferences_query,
    get_mysql_url,
)


CSV_PATH = API_DIR / "dataset_features_clients_jour.csv"


def _load_reference_cases():
    reference = pd.read_csv(
        CSV_PATH,
        parse_dates=["date_doc"],
        low_memory=False,
        dtype={"client_code": "string"},
    )
    reference["client_code"] = reference["client_code"].astype(str).str.strip()
    reference["date_doc"] = pd.to_datetime(reference["date_doc"]).dt.normalize()
    if reference.empty:
        raise unittest.SkipTest("dataset_features_clients_jour.csv is empty")

    client_counts = (
        reference.groupby("client_code", sort=True)
        .size()
        .reset_index(name="row_count")
        .sort_values(["row_count", "client_code"], ascending=[False, True], kind="mergesort")
    )
    selected_client_code = client_counts.iloc[0]["client_code"]
    client_rows = reference[reference["client_code"] == selected_client_code].reset_index(drop=True)

    sample_positions = [0, len(client_rows) // 2, len(client_rows) - 1]
    sampled_rows = [client_rows.iloc[[position]] for position in sample_positions]
    return pd.concat(sampled_rows, ignore_index=True)


class NomadisFeatureEngineeringUtilityTest(unittest.TestCase):
    def test_feature_schema_version_is_defined(self):
        self.assertIsInstance(FEATURE_SCHEMA_VERSION, str)
        self.assertTrue(FEATURE_SCHEMA_VERSION.startswith("sha1:"))

    def test_normalize_client_codes_keeps_exact_identities(self):
        from nomadis_feature_engineering import _normalize_client_codes

        self.assertEqual(
            _normalize_client_codes(["00152", "152", "00152", " 152 "]),
            ["00152", "152"],
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

    def test_normalize_base_dataset_keeps_00152_and_152_distinct(self):
        sample = pd.DataFrame([
            {
                "client_code": "00152",
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
                "client_code": "152",
                "date_doc": pd.Timestamp("2026-02-11"),
                "region": "GT",
                "delegation": "Ariana",
                "routing_code": "1",
                "home_commercial": "1",
                "potentiel": 20.0,
                "ca_jour": 92.845,
                "qte_jour": 2.0,
                "docs_jour": 1.0,
                "line_items_jour": 1.0,
                "product_refs_jour": 1.0,
            },
        ])

        from nomadis_feature_engineering import normalize_base_dataset

        normalized = normalize_base_dataset(sample)
        self.assertEqual(len(normalized), 2)
        self.assertEqual(set(normalized["client_code"].astype(str)), {"00152", "152"})


class NomadisFeatureEngineeringTemporalStabilityTest(unittest.TestCase):
    def test_feature_values_do_not_change_when_future_sales_are_added(self):
        calendar_dates = list(pd.date_range("2026-01-01", "2026-02-03", freq="D"))
        base_columns = [
            "client_code",
            "date_doc",
            "region",
            "delegation",
            "routing_code",
            "home_commercial",
            "potentiel",
            "ca_jour",
            "qte_jour",
            "docs_jour",
            "line_items_jour",
            "product_refs_jour",
        ]
        base_without_future = pd.DataFrame(
            [
                {
                    "client_code": "00152",
                    "date_doc": pd.Timestamp("2026-01-03"),
                    "region": "GT",
                    "delegation": "Ariana",
                    "routing_code": "1",
                    "home_commercial": "1",
                    "potentiel": 10.0,
                    "ca_jour": 120.0,
                    "qte_jour": 6.0,
                    "docs_jour": 1.0,
                    "line_items_jour": 2.0,
                    "product_refs_jour": 2.0,
                }
            ],
            columns=base_columns,
        )
        base_with_future = pd.concat(
            [
                base_without_future,
                pd.DataFrame(
                    [
                        {
                            "client_code": "00152",
                            "date_doc": pd.Timestamp("2026-02-01"),
                            "region": "GT",
                            "delegation": "Ariana",
                            "routing_code": "1",
                            "home_commercial": "1",
                            "potentiel": 10.0,
                            "ca_jour": 500.0,
                            "qte_jour": 25.0,
                            "docs_jour": 1.0,
                            "line_items_jour": 3.0,
                            "product_refs_jour": 3.0,
                        }
                    ],
                    columns=base_columns,
                ),
            ],
            ignore_index=True,
        )

        features_without_future = build_feature_panel_from_base(
            base_without_future,
            calendar_dates=calendar_dates,
        )
        features_with_future = build_feature_panel_from_base(
            base_with_future,
            calendar_dates=calendar_dates,
        )

        cutoff = pd.Timestamp("2026-01-03")
        stable_without_future = (
            features_without_future[features_without_future["date"] <= cutoff]
            .sort_values(["client_code", "date"])
            .reset_index(drop=True)
        )
        stable_with_future = (
            features_with_future[features_with_future["date"] <= cutoff]
            .sort_values(["client_code", "date"])
            .reset_index(drop=True)
        )

        self.assertEqual(set(stable_without_future["client_code"].astype(str)), {"00152"})
        self.assertEqual(set(stable_with_future["client_code"].astype(str)), {"00152"})
        pd.testing.assert_frame_equal(stable_without_future, stable_with_future)

    @staticmethod
    def _build_same_weekday_group(include_future_orders=False):
        dates = pd.date_range("2026-01-05", "2026-02-15", freq="D")
        order_dates = {
            pd.Timestamp("2026-01-05"),
            pd.Timestamp("2026-01-07"),
            pd.Timestamp("2026-01-19"),
            pd.Timestamp("2026-01-28"),
        }
        if include_future_orders:
            order_dates.update(
                {
                    pd.Timestamp("2026-02-02"),
                    pd.Timestamp("2026-02-11"),
                }
            )

        group = pd.DataFrame({"date": dates})
        group["client_code"] = "CLT_SAME_WEEKDAY"
        group["jour_semaine"] = ((group["date"].dt.weekday + 1) % 7).astype(int)
        group["achat_target"] = group["date"].isin(order_dates).astype(int)
        group["vente_nette"] = group["achat_target"] * 100.0
        group["qte_totale"] = group["achat_target"] * 5.0
        group["docs_jour"] = group["achat_target"] * 1.0
        group["line_items_jour"] = group["achat_target"] * 2.0
        group["product_refs_jour"] = group["achat_target"] * 2.0
        return group

    def test_same_weekday_gap_uses_only_past_orders_from_the_same_weekday(self):
        features = enrich_panel_features(self._build_same_weekday_group()).set_index("date")

        self.assertTrue(pd.isna(features.loc[pd.Timestamp("2026-01-05"), "days_since_last_same_weekday_order"]))
        self.assertTrue(pd.isna(features.loc[pd.Timestamp("2026-01-07"), "days_since_last_same_weekday_order"]))
        self.assertEqual(features.loc[pd.Timestamp("2026-01-12"), "days_since_last_same_weekday_order"], 7.0)
        self.assertEqual(features.loc[pd.Timestamp("2026-01-19"), "days_since_last_same_weekday_order"], 14.0)
        self.assertEqual(features.loc[pd.Timestamp("2026-01-21"), "days_since_last_same_weekday_order"], 14.0)
        self.assertEqual(features.loc[pd.Timestamp("2026-01-28"), "days_since_last_same_weekday_order"], 21.0)

        valid_gaps = features["days_since_last_same_weekday_order"].dropna()
        self.assertTrue(((valid_gaps % 7) == 0).all())

    def test_same_weekday_gap_is_stable_when_future_orders_are_added(self):
        without_future = enrich_panel_features(self._build_same_weekday_group(include_future_orders=False))
        with_future = enrich_panel_features(self._build_same_weekday_group(include_future_orders=True))

        cutoff = pd.Timestamp("2026-02-01")
        feature_name = "days_since_last_same_weekday_order"
        past_without_future = (
            without_future.loc[without_future["date"] <= cutoff, ["date", feature_name]]
            .set_index("date")[feature_name]
        )
        past_with_future = (
            with_future.loc[with_future["date"] <= cutoff, ["date", feature_name]]
            .set_index("date")[feature_name]
        )

        pd.testing.assert_series_equal(past_without_future, past_with_future)


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
        generated["client_code"] = generated["client_code"].astype(str).str.strip()
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


class FeatureStoreQueryFilterPolicyTest(unittest.TestCase):
    def test_base_query_uses_shared_sales_document_policy(self):
        query = get_base_dataset_query()
        expected_policy = build_valid_sales_document_filters("e", "c")

        self.assertIn(expected_policy, query)
        self.assertIn("JOIN clients c ON e.client_code = c.code", query)

    def test_assignment_query_uses_shared_sales_document_policy(self):
        query = get_assignment_dataset_query()
        expected_policy = build_valid_sales_document_filters("e", "c")

        self.assertIn(expected_policy, query)
        self.assertIn("JOIN clients c ON e.client_code = c.code", query)

    def test_preferences_query_uses_shared_sales_document_policy(self):
        query = get_preferences_query("2026-08-22")
        expected_policy = build_valid_sales_document_filters("e", "c")

        self.assertIn(expected_policy, query)
        self.assertIn("JOIN clients c ON e.client_code = c.code", query)


if __name__ == "__main__":
    unittest.main()
