import argparse
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

import backtest_validation as bv


BASE_DIR = Path(__file__).resolve().parent
DATASET_PATH = BASE_DIR / "dataset_features_clients_jour.csv"
FEATURE_COLUMNS_PATH = BASE_DIR / "colonnes_ia.pkl"
MODEL_ACHAT_PATH = BASE_DIR / "modele_nomadis_achat.pkl"
MODEL_CA_PATH = BASE_DIR / "modele_nomadis_ca.pkl"
MODEL_QTE_PATH = BASE_DIR / "modele_nomadis_qte.pkl"
MODEL_PRICE_PATH = BASE_DIR / "modele_nomadis_price.pkl"


def load_dataset():
    df = pd.read_csv(DATASET_PATH, dtype={"client_code": str}, low_memory=False)
    df["date_doc"] = pd.to_datetime(df["date_doc"], errors="coerce")
    df = df.dropna(subset=["date_doc"]).copy()
    df["client_code"] = df["client_code"].astype(str).str.strip()
    df["achat_target"] = pd.to_numeric(df["achat_target"], errors="coerce").fillna(0).astype(int)
    df["ca_jour"] = pd.to_numeric(df["ca_jour"], errors="coerce").fillna(0)
    df["qte_jour"] = pd.to_numeric(df["qte_jour"], errors="coerce").fillna(0)
    return df


def train_test_cutoff(df):
    sorted_df = df.sort_values("date_doc").reset_index(drop=True)
    split_index = max(1, int(len(sorted_df) * 0.8))
    return pd.Timestamp(sorted_df.loc[split_index, "date_doc"])


def pick_test_dates(df, cutoff_date, max_dates, min_buyers):
    date_stats = (
        df[df["achat_target"] == 1]
        .groupby("date_doc")
        .agg(nb_buyers=("client_code", "nunique"))
        .reset_index()
        .sort_values("date_doc")
    )
    filtered = date_stats[(date_stats["date_doc"] >= cutoff_date) & (date_stats["nb_buyers"] >= min_buyers)]
    if max_dates > 0:
        filtered = filtered.tail(max_dates)
    return filtered["date_doc"].tolist()


def build_daily_actual_totals(df):
    daily = (
        df.groupby("date_doc")
        .agg(actual_total_ca=("ca_jour", "sum"), actual_total_qte=("qte_jour", "sum"))
        .sort_index()
    )
    daily["actual_total_ca"] = pd.to_numeric(daily["actual_total_ca"], errors="coerce").fillna(0.0)
    daily["actual_total_qte"] = pd.to_numeric(daily["actual_total_qte"], errors="coerce").fillna(0.0)
    return daily


def rolling_baseline_value(series, date_index, window_days):
    start_date = date_index - pd.Timedelta(days=window_days)
    hist = series.loc[(series.index < date_index) & (series.index >= start_date)]
    if hist.empty:
        hist = series.loc[series.index < date_index].tail(window_days)
    if hist.empty:
        return 0.0
    return float(hist.mean())


def add_baseline_errors(results, daily_totals, window_days):
    baseline_ca = []
    baseline_qte = []
    baseline_ca_err = []
    baseline_qte_err = []
    for _, row in results.iterrows():
        date_idx = pd.Timestamp(row["date"])
        actual_ca = float(row["actual_total_ca"])
        actual_qte = float(row["actual_total_qte"])

        pred_ca = rolling_baseline_value(daily_totals["actual_total_ca"], date_idx, window_days)
        pred_qte = rolling_baseline_value(daily_totals["actual_total_qte"], date_idx, window_days)

        baseline_ca.append(pred_ca)
        baseline_qte.append(pred_qte)
        baseline_ca_err.append(abs(pred_ca - actual_ca) / max(actual_ca, 1.0) * 100.0)
        baseline_qte_err.append(abs(pred_qte - actual_qte) / max(actual_qte, 1.0) * 100.0)

    out = results.copy()
    out["baseline_ca_pred"] = baseline_ca
    out["baseline_qte_pred"] = baseline_qte
    out["baseline_ca_error_pct"] = baseline_ca_err
    out["baseline_qte_error_pct"] = baseline_qte_err
    return out


def pct_days_under_threshold(series, threshold):
    if len(series) == 0:
        return 0.0
    return float((series <= threshold).mean() * 100.0)


def wape(actual, predicted):
    actual = np.asarray(actual, dtype=float)
    predicted = np.asarray(predicted, dtype=float)
    denom = np.abs(actual).sum()
    if denom <= 0:
        return 0.0
    return float(np.abs(actual - predicted).sum() / denom * 100.0)


def print_summary(results, cutoff_date, window_days):
    ca_mape = float(results["ca_error_pct"].mean())
    qte_mape = float(results["qte_error_pct"].mean())
    ca_wape = wape(results["actual_total_ca"], results["pred_total_ca"])
    qte_wape = wape(results["actual_total_qte"], results["pred_total_qte"])

    baseline_ca_mape = float(results["baseline_ca_error_pct"].mean())
    baseline_qte_mape = float(results["baseline_qte_error_pct"].mean())
    baseline_ca_wape = wape(results["actual_total_ca"], results["baseline_ca_pred"])
    baseline_qte_wape = wape(results["actual_total_qte"], results["baseline_qte_pred"])

    top5_ratio_pct = float((results["top5_overlap"] / 5.0).mean() * 100.0)
    top10_ratio_pct = float((results["top10_overlap"] / 10.0).mean() * 100.0)

    print("=== Strong Backtest Summary ===")
    print(f"Cutoff train/test: {cutoff_date.date().isoformat()}")
    print(f"Nb jours testes: {len(results)}")
    print(f"Baseline fenetre: {window_days} jours")
    print()
    print("Model (IA):")
    print(
        f"- CA  -> MAPE: {ca_mape:.1f}% | WAPE: {ca_wape:.1f}% | median APE: {results['ca_error_pct'].median():.1f}%"
    )
    print(
        f"- QTE -> MAPE: {qte_mape:.1f}% | WAPE: {qte_wape:.1f}% | median APE: {results['qte_error_pct'].median():.1f}%"
    )
    print(f"- Top5 overlap moyen: {results['top5_overlap'].mean():.2f}/5 ({top5_ratio_pct:.1f}%)")
    print(f"- Top10 overlap moyen: {results['top10_overlap'].mean():.2f}/10 ({top10_ratio_pct:.1f}%)")
    print()
    print("Baseline (moyenne glissante des ventes reelles):")
    print(
        f"- CA  -> MAPE: {baseline_ca_mape:.1f}% | WAPE: {baseline_ca_wape:.1f}% | median APE: {results['baseline_ca_error_pct'].median():.1f}%"
    )
    print(
        f"- QTE -> MAPE: {baseline_qte_mape:.1f}% | WAPE: {baseline_qte_wape:.1f}% | median APE: {results['baseline_qte_error_pct'].median():.1f}%"
    )
    print()
    print("Stabilite journaliere IA:")
    print(f"- CA error <= 20%: {pct_days_under_threshold(results['ca_error_pct'], 20):.1f}% des jours")
    print(f"- CA error <= 30%: {pct_days_under_threshold(results['ca_error_pct'], 30):.1f}% des jours")
    print(f"- CA error <= 50%: {pct_days_under_threshold(results['ca_error_pct'], 50):.1f}% des jours")
    print(f"- QTE error <= 20%: {pct_days_under_threshold(results['qte_error_pct'], 20):.1f}% des jours")
    print(f"- QTE error <= 30%: {pct_days_under_threshold(results['qte_error_pct'], 30):.1f}% des jours")
    print(f"- QTE error <= 50%: {pct_days_under_threshold(results['qte_error_pct'], 50):.1f}% des jours")
    print()
    print("Comparaison IA vs Baseline (MAPE):")
    print(f"- Gain CA: {baseline_ca_mape - ca_mape:+.1f} points")
    print(f"- Gain QTE: {baseline_qte_mape - qte_mape:+.1f} points")


def main():
    parser = argparse.ArgumentParser(description="Evaluation forte du systeme de prediction Nomadis.")
    parser.add_argument("--dates", type=int, default=120, help="Nombre max de dates testees (0 = toutes)")
    parser.add_argument("--top-k", type=int, default=10, help="Top-k pour overlap")
    parser.add_argument("--min-buyers", type=int, default=5, help="Nb minimum d'acheteurs reels sur la date")
    parser.add_argument("--baseline-window", type=int, default=28, help="Fenetre en jours pour baseline")
    args = parser.parse_args()

    df = load_dataset()
    cutoff = train_test_cutoff(df)
    test_dates = pick_test_dates(df, cutoff, args.dates, args.min_buyers)
    if not test_dates:
        raise RuntimeError("Aucune date test valide trouvee.")

    feature_columns = joblib.load(FEATURE_COLUMNS_PATH)
    model_achat = joblib.load(MODEL_ACHAT_PATH)
    model_ca = joblib.load(MODEL_CA_PATH)
    model_qte = joblib.load(MODEL_QTE_PATH)
    model_price = joblib.load(MODEL_PRICE_PATH)

    rows = []
    for test_date in test_dates:
        df_day = df[df["date_doc"] == test_date].copy()
        row = bv.evaluate_date(df_day, feature_columns, model_achat, model_ca, model_qte, model_price, args.top_k)
        rows.append(row)

    results = pd.DataFrame(rows)
    daily_totals = build_daily_actual_totals(df)
    results = add_baseline_errors(results, daily_totals, args.baseline_window)
    print_summary(results, cutoff, args.baseline_window)


if __name__ == "__main__":
    main()
