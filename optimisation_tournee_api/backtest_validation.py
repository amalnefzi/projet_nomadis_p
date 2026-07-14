import argparse
from pathlib import Path

import joblib
import numpy as np
import pandas as pd


BASE_DIR = Path(__file__).resolve().parent
DATASET_PATH = BASE_DIR / "dataset_features_clients_jour.csv"
FEATURE_COLUMNS_PATH = BASE_DIR / "colonnes_ia.pkl"
MODEL_ACHAT_PATH = BASE_DIR / "modele_nomadis_achat.pkl"
MODEL_CA_PATH = BASE_DIR / "modele_nomadis_ca.pkl"
MODEL_QTE_PATH = BASE_DIR / "modele_nomadis_qte.pkl"
MODEL_PRICE_PATH = BASE_DIR / "modele_nomadis_price.pkl"

FEATURE_COLUMNS_BASE = [
    "jour_semaine",
    "potentiel",
    "nbr_visites_hist",
    "nbr_visites_jour",
    "days_since_last_order",
    "vente_last",
    "qte_last",
    "vente_avg_3",
    "qte_avg_3",
    "ca_last_30d",
    "ca_last_60d",
    "ca_last_90d",
    "qte_last_30d",
    "qte_last_60d",
    "qte_last_90d",
    "orders_last_30d",
    "orders_last_60d",
    "orders_last_90d",
    "avg_ca_per_order_90d",
    "avg_qte_per_order_90d",
    "weekday_purchase_rate",
    "days_since_last_same_weekday_order",
    "recent_ca_trend",
    "recent_qte_trend",
    "avg_price_hist",
    "month",
]


def build_features(df, feature_columns):
    features = df[FEATURE_COLUMNS_BASE + ["region"]].copy()
    features["region"] = features["region"].fillna("Inconnu").astype(str).str.strip()
    for col in FEATURE_COLUMNS_BASE:
        features[col] = pd.to_numeric(features[col], errors="coerce").fillna(0)
    features = pd.get_dummies(features, columns=["region"], dummy_na=False)
    return features.reindex(columns=feature_columns, fill_value=0)


def overlap_count(pred_codes, actual_codes, top_k):
    pred_top = set(pred_codes[:top_k])
    actual_top = set(actual_codes[:top_k])
    return len(pred_top & actual_top)


def clamp(value, min_value, max_value):
    return min(max_value, max(min_value, value))


def compute_priority_score(chiffre_predit, max_chiffre, prob_achat, habit_score, recency_score):
    vente_norm = chiffre_predit / max_chiffre if max_chiffre > 0 else 0
    purchase_signal = clamp(
        ((prob_achat * 0.75) + (habit_score * 0.15) + (recency_score * 0.10)) / 100,
        0,
        1,
    )
    score_norm = (0.6 * vente_norm) + (0.35 * purchase_signal)
    return round(clamp(score_norm * 100, 0, 100), 1)


def blend_expected_quantity(prob_buy, ca_if_buy, qte_if_buy, price_if_buy, avg_price_hist):
    prob_buy = max(0.0, min(1.0, float(prob_buy)))
    ca_if_buy = max(1.0, float(ca_if_buy))
    qte_if_buy = max(1.0, float(qte_if_buy))
    price_if_buy = max(0.5, float(price_if_buy))
    avg_price_hist = float(avg_price_hist) if pd.notna(avg_price_hist) else np.nan

    expected_ca = ca_if_buy * prob_buy
    qte_from_model = qte_if_buy * prob_buy
    qte_from_price = expected_ca / price_if_buy
    hist_price = avg_price_hist if np.isfinite(avg_price_hist) and avg_price_hist > 0.5 else price_if_buy
    qte_from_hist = expected_ca / max(0.5, hist_price)
    return max(0.0, (0.50 * qte_from_price) + (0.35 * qte_from_model) + (0.15 * qte_from_hist))


def pick_test_dates(df, n_dates):
    actual_dates = (
        df[df["achat_target"] == 1]
        .groupby("date_doc")
        .agg(nb_buyers=("client_code", "nunique"))
        .reset_index()
    )
    actual_dates = actual_dates[actual_dates["nb_buyers"] >= 5].sort_values("date_doc")
    return actual_dates["date_doc"].tail(n_dates).tolist()


def evaluate_date(df_day, feature_columns, model_achat, model_ca, model_qte, model_price, top_k):
    X = build_features(df_day, feature_columns)
    achat_prob = np.clip(model_achat.predict_proba(X)[:, 1], 0, 1)
    pred_ca_if_buy = np.maximum(1, np.expm1(model_ca.predict(X)))
    pred_qte_if_buy = np.maximum(1, np.expm1(model_qte.predict(X)))
    pred_price_if_buy = np.maximum(0.5, np.expm1(model_price.predict(X)))

    scored = df_day.copy()
    scored["prob_achat_pred"] = achat_prob
    scored["ca_pred"] = pred_ca_if_buy * achat_prob
    scored["qte_pred"] = [
        blend_expected_quantity(prob, ca_buy, qte_buy, price_buy, hist_price)
        for prob, ca_buy, qte_buy, price_buy, hist_price in zip(
            achat_prob,
            pred_ca_if_buy,
            pred_qte_if_buy,
            pred_price_if_buy,
            scored["avg_price_hist"].to_numpy(),
        )
    ]
    scored["habit_score_pred"] = (
        (pd.to_numeric(scored["weekday_purchase_rate"], errors="coerce").fillna(0).clip(0, 1) * 0.7) +
        (
            (
                pd.to_numeric(scored["recent_ca_trend"], errors="coerce").fillna(0).clip(0, 1.2) +
                pd.to_numeric(scored["recent_qte_trend"], errors="coerce").fillna(0).clip(0, 1.2)
            ) / 2 / 1.2
        ) * 0.3
    ) * 100
    scored["recency_score_pred"] = (
        (
            1 - pd.to_numeric(scored["days_since_last_order"], errors="coerce").fillna(999).clip(0, 60) / 60
        ).clip(0, 1) * 0.6 +
        (
            1 - pd.to_numeric(scored["days_since_last_same_weekday_order"], errors="coerce").fillna(999).clip(0, 90) / 90
        ).clip(0, 1) * 0.4
    ) * 100

    max_pred_ca = float(scored["ca_pred"].max())
    scored["priority_score_pred"] = scored.apply(
        lambda row: compute_priority_score(
            float(row["ca_pred"]),
            max_pred_ca,
            float(row["prob_achat_pred"] * 100),
            float(row["habit_score_pred"]),
            float(row["recency_score_pred"]),
        ),
        axis=1,
    )

    actual_total_ca = float(scored["ca_jour"].sum())
    actual_total_qte = float(scored["qte_jour"].sum())
    pred_total_ca = float(scored["ca_pred"].sum())
    pred_total_qte = float(scored["qte_pred"].sum())

    ca_error_pct = abs(pred_total_ca - actual_total_ca) / max(actual_total_ca, 1) * 100
    qte_error_pct = abs(pred_total_qte - actual_total_qte) / max(actual_total_qte, 1) * 100

    pred_rank = (
        scored.sort_values(["priority_score_pred", "ca_pred", "prob_achat_pred"], ascending=False)["client_code"]
        .astype(str)
        .tolist()
    )
    actual_rank = (
        scored[scored["achat_target"] == 1]
        .sort_values(["ca_jour", "qte_jour"], ascending=False)["client_code"]
        .astype(str)
        .tolist()
    )

    return {
        "date": pd.to_datetime(df_day["date_doc"].iloc[0]).date().isoformat(),
        "actual_total_ca": actual_total_ca,
        "pred_total_ca": pred_total_ca,
        "ca_error_pct": ca_error_pct,
        "actual_total_qte": actual_total_qte,
        "pred_total_qte": pred_total_qte,
        "qte_error_pct": qte_error_pct,
        "top5_overlap": overlap_count(pred_rank, actual_rank, min(5, top_k)),
        "top10_overlap": overlap_count(pred_rank, actual_rank, min(10, top_k)),
        "actual_buyers": len(actual_rank),
    }


def main():
    parser = argparse.ArgumentParser(description="Mini validation temporelle des modeles IA.")
    parser.add_argument("--dates", type=int, default=5, help="Nombre de dates recentes a tester")
    parser.add_argument("--top-k", type=int, default=10, help="K max pour overlap top clients")
    args = parser.parse_args()

    df = pd.read_csv(DATASET_PATH, dtype={"client_code": str}, low_memory=False)
    df["date_doc"] = pd.to_datetime(df["date_doc"], errors="coerce")
    df = df.dropna(subset=["date_doc"]).copy()
    df["client_code"] = df["client_code"].astype(str).str.strip()
    df["achat_target"] = pd.to_numeric(df["achat_target"], errors="coerce").fillna(0).astype(int)
    df["ca_jour"] = pd.to_numeric(df["ca_jour"], errors="coerce").fillna(0)
    df["qte_jour"] = pd.to_numeric(df["qte_jour"], errors="coerce").fillna(0)

    feature_columns = joblib.load(FEATURE_COLUMNS_PATH)
    model_achat = joblib.load(MODEL_ACHAT_PATH)
    model_ca = joblib.load(MODEL_CA_PATH)
    model_qte = joblib.load(MODEL_QTE_PATH)
    model_price = joblib.load(MODEL_PRICE_PATH)

    test_dates = pick_test_dates(df, args.dates)
    if not test_dates:
        raise RuntimeError("Aucune date exploitable trouvee pour le backtest.")

    print(f"Mini validation sur {len(test_dates)} dates recentes:")
    print()

    rows = []
    for test_date in test_dates:
        df_day = df[df["date_doc"] == test_date].copy()
        row = evaluate_date(df_day, feature_columns, model_achat, model_ca, model_qte, model_price, args.top_k)
        rows.append(row)
        print(
            f"{row['date']} | CA reel {row['actual_total_ca']:.1f} | CA predit {row['pred_total_ca']:.1f} "
            f"| err {row['ca_error_pct']:.1f}% | QTE reel {row['actual_total_qte']:.0f} "
            f"| QTE predite {row['pred_total_qte']:.0f} | err {row['qte_error_pct']:.1f}% "
            f"| top5 {row['top5_overlap']}/5 | top10 {row['top10_overlap']}/10"
        )

    results = pd.DataFrame(rows)
    print()
    print("Moyennes:")
    print(
        f"CA error moyen: {results['ca_error_pct'].mean():.1f}% | "
        f"QTE error moyen: {results['qte_error_pct'].mean():.1f}% | "
        f"Top5 overlap moyen: {results['top5_overlap'].mean():.2f}/5 | "
        f"Top10 overlap moyen: {results['top10_overlap'].mean():.2f}/10"
    )


if __name__ == "__main__":
    main()
