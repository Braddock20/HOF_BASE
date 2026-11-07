#!/usr/bin/env python3
"""Turn a scraped TikTok metadata CSV into charts and summary statistics.

This is the "what do I do with the data?" half of the project: it produces
the figures and tables you would normally put in a school report.

    python analyze.py data/tiktok_metadata.csv --out analysis/

Outputs (in the chosen folder):
    summary_stats.csv      one row per numeric metric
    top_hashtags.csv       hashtag frequency + engagement
    engagement_hist.png    distribution of likes
    top_hashtags.png      most used hashtags
    posting_heatmap.png    when videos are published
    top_creators.png       creators ranked by engagement
    duration_vs_likes.png  length vs popularity
"""

from __future__ import annotations

import argparse
import os
import sys
import unicodedata

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

NUMERIC = ["likes", "comments", "shares", "saves", "plays", "duration_seconds"]
DAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def safe_label(text: str) -> str:
    """ASCII-fold a label for plotting.

    Hashtags are not always Latin (CJK, Cyrillic, emoji...). The chart font
    may not carry those glyphs; the CSV keeps the original spelling.
    """
    folded = unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode()
    return folded or str(text)


def load(path: str) -> pd.DataFrame:
    frame = pd.read_csv(path, dtype=str, keep_default_na=False)
    for column in NUMERIC:
        if column in frame.columns:
            frame[column] = pd.to_numeric(frame[column], errors="coerce").fillna(0)
    if "create_hour" in frame.columns:
        frame["create_hour"] = pd.to_numeric(frame["create_hour"], errors="coerce").fillna(-1)
    if "status" in frame.columns:
        frame = frame[frame["status"] == "ok"]
    return frame


def engagement_rate(frame: pd.DataFrame) -> pd.Series:
    """Shares per 1,000 views (falls back to shares per 1,000 likes)."""
    plays = frame.get("plays", pd.Series(dtype=float)).replace(0, np.nan)
    shares = frame.get("shares", pd.Series(dtype=float)).fillna(0)
    rate = shares / plays * 1000
    return rate.replace([np.inf, -np.inf], np.nan).fillna(0)


def explode_hashtags(frame: pd.DataFrame) -> pd.DataFrame:
    """One row per (video, hashtag)."""
    rows = []
    for _, row in frame.iterrows():
        raw = str(row.get("hashtags", "") or "")
        tags = [tag.strip() for tag in raw.split(",") if tag.strip()]
        for tag in tags:
            rows.append(
                {
                    "hashtag": tag.lower(),
                    "likes": row.get("likes", 0),
                    "comments": row.get("comments", 0),
                    "shares": row.get("shares", 0),
                    "plays": row.get("plays", 0),
                    "saves": row.get("saves", 0),
                }
            )
    return pd.DataFrame(rows)


def save(fig, out_dir: str, name: str) -> str:
    path = os.path.join(out_dir, name)
    fig.savefig(path, dpi=150, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    print(f"  wrote {path}")
    return path


def chart_engagement(frame: pd.DataFrame, out_dir: str) -> None:
    likes = frame["likes"].clip(lower=0)
    if likes.empty or likes.sum() == 0:
        print("  (no likes data, skipping engagement histogram)")
        return
    fig, ax = plt.subplots(figsize=(8, 4.5))
    ax.hist(likes, bins=min(30, max(8, len(likes))), color="#4c6ef5", edgecolor="white")
    ax.set_yscale("log")
    ax.set_xlabel("Likes")
    ax.set_ylabel("Number of videos (log scale)")
    ax.set_title("Distribution of likes across the sample")
    ax.grid(axis="y", alpha=0.25)
    save(fig, out_dir, "engagement_hist.png")


def chart_hashtags(frame: pd.DataFrame, out_dir: str, top: int = 15) -> pd.DataFrame:
    tags = explode_hashtags(frame)
    if tags.empty:
        print("  (no hashtags, skipping hashtag chart)")
        return tags
    grouped = (
        tags.groupby("hashtag")
        .agg(videos=("likes", "size"), total_likes=("likes", "sum"), total_shares=("shares", "sum"))
        .sort_values("total_likes", ascending=False)
        .head(top)
        .sort_values("total_likes")
    )
    grouped.to_csv(os.path.join(out_dir, "top_hashtags.csv"))
    fig, ax = plt.subplots(figsize=(9, 6))
    ax.barh([safe_label(i) for i in grouped.index], grouped["total_likes"], color="#12b886")
    ax.set_xlabel("Total likes")
    ax.set_title(f"Top {top} hashtags by total likes")
    ax.grid(axis="x", alpha=0.25)
    save(fig, out_dir, "top_hashtags.png")
    return grouped


def chart_heatmap(frame: pd.DataFrame, out_dir: str) -> None:
    if "create_hour" not in frame.columns or "create_weekday" not in frame.columns:
        print("  (no timestamp data, skipping heatmap)")
        return
    subset = frame[(frame["create_hour"] >= 0) & (frame["create_weekday"] != "")]
    if subset.empty:
        print("  (no timestamp data, skipping heatmap)")
        return
    pivot = subset.pivot_table(
        index="create_weekday", columns="create_hour", values="video_id", aggfunc="count", fill_value=0
    )
    pivot = pivot.reindex([day for day in DAY_ORDER if day in pivot.index])
    # Always show a full 24-hour axis so empty hours read as "no data".
    pivot = pivot.reindex(columns=range(24), fill_value=0)
    fig, ax = plt.subplots(figsize=(12, 4.8))
    image = ax.imshow(pivot.values, aspect="auto", cmap="YlOrRd")
    ax.set_yticks(range(len(pivot.index)), pivot.index)
    ax.set_xticks(range(0, 24, 2), [str(h) for h in range(0, 24, 2)])
    ax.set_xlabel("Hour of day (UTC)")
    ax.set_ylabel("Day of week")
    ax.set_title("When videos in the sample were published")
    fig.colorbar(image, ax=ax, label="Number of videos")
    save(fig, out_dir, "posting_heatmap.png")


def chart_creators(frame: pd.DataFrame, out_dir: str, top: int = 12) -> None:
    if "author_handle" not in frame.columns:
        return
    grouped = (
        frame.groupby("author_handle")
        .agg(videos=("likes", "size"), likes=("likes", "sum"), plays=("plays", "sum"))
        .sort_values("likes", ascending=False)
        .head(top)
        .sort_values("likes")
    )
    if grouped.empty:
        return
    fig, ax = plt.subplots(figsize=(9, 5.5))
    ax.barh([safe_label(i) for i in grouped.index], grouped["likes"], color="#f59f00")
    ax.set_xlabel("Total likes")
    ax.set_title(f"Top {top} creators in the sample by likes")
    ax.grid(axis="x", alpha=0.25)
    save(fig, out_dir, "top_creators.png")


def chart_duration(frame: pd.DataFrame, out_dir: str) -> None:
    if frame.empty:
        return
    fig, ax = plt.subplots(figsize=(8, 4.8))
    ax.scatter(frame["duration_seconds"], frame["likes"], alpha=0.55, color="#e8590c", edgecolor="none")
    ax.set_xlabel("Video length (seconds)")
    ax.set_ylabel("Likes")
    ax.set_yscale("log")
    ax.set_title("Video length vs likes (log scale)")
    ax.grid(alpha=0.25)
    save(fig, out_dir, "duration_vs_likes.png")


def print_summary(frame: pd.DataFrame, hashtag_table: pd.DataFrame) -> None:
    n = len(frame)
    print("\n" + "=" * 60)
    print(f"  SAMPLE SUMMARY  ({n} videos)")
    print("=" * 60)
    if n:
        if "create_date" in frame.columns and len(frame):
            print(f"  date range        : {frame['create_date'].min()} -> {frame['create_date'].max()}")
        else:
            print("  date range        : n/a")
        print(f"  unique creators   : {frame['author_handle'].nunique()}")
        for metric in NUMERIC:
            if metric in frame.columns:
                series = frame[metric]
                print(
                    f"  {metric:<17}: total {series.sum():>12,.0f} | "
                    f"mean {series.mean():>10,.1f} | median {series.median():>10,.1f} | "
                    f"max {series.max():>12,.0f}"
                )
        rate = engagement_rate(frame)
        if rate.sum() > 0:
            print(f"  shares per 1k views: mean {rate.mean():.2f} | median {rate.median():.2f}")
    if not hashtag_table.empty:
        print("-" * 60)
        print("  top hashtags by total likes:")
        for tag, row in hashtag_table.sort_values("total_likes", ascending=False).head(10).iterrows():
            print(f"    #{tag:<22} {int(row['videos']):>3} videos   {int(row['total_likes']):>10,} likes")
    print("=" * 60 + "\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Analyse a scraped TikTok metadata CSV.")
    parser.add_argument("csv", help="path to the scraped CSV file")
    parser.add_argument("--out", default="analysis", help="output folder (default: analysis)")
    parser.add_argument("--top", type=int, default=15, help="how many hashtags/creators to show")
    args = parser.parse_args(argv)

    if not os.path.exists(args.csv):
        print(f"CSV not found: {args.csv}", file=sys.stderr)
        return 1

    os.makedirs(args.out, exist_ok=True)
    frame = load(args.csv)
    if frame.empty:
        print("No usable rows in the CSV (all records failed?).", file=sys.stderr)
        return 1

    print(f"Analysing {len(frame)} videos from {args.csv}")
    hashtag_table = chart_hashtags(frame, args.out, top=args.top)
    chart_engagement(frame, args.out)
    chart_heatmap(frame, args.out)
    chart_creators(frame, args.out, top=args.top)
    chart_duration(frame, args.out)

    stats = (
        frame[NUMERIC]
        .describe()
        .T[["count", "mean", "50%", "max"]]
        .rename(columns={"50%": "median"})
    )
    stats.to_csv(os.path.join(args.out, "summary_stats.csv"))
    print(f"  wrote {os.path.join(args.out, 'summary_stats.csv')}")

    print_summary(frame, hashtag_table)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
