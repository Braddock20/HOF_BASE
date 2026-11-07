"""Output writers: CSV, JSONL and SQLite, all streaming row by row.

Streaming matters for a school project: you can stop the run at any point and
still have a usable dataset on disk.
"""

from __future__ import annotations

import csv
import json
import os
import sqlite3
from typing import Any, Iterable, Iterator

from .models import FIELDS, PROFILE_FIELDS, ProfileRecord, VideoRecord

CSV_SUFFIX = ".csv"
JSONL_SUFFIX = ".jsonl"
SQLITE_SUFFIX = ".sqlite3"


class RecordWriter:
    """Base writer interface. Subclasses persist :class:`VideoRecord` rows."""

    def __init__(self, path: str) -> None:
        self.path = path
        self.count = 0

    def write(self, record: VideoRecord) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    def close(self) -> None:
        pass

    def __enter__(self) -> "RecordWriter":
        return self

    def __exit__(self, *exc_info) -> None:
        self.close()


class CsvWriter(RecordWriter):
    """Writes UTF-8 CSV with a fixed header derived from :data:`FIELDS`."""

    def __init__(self, path: str) -> None:
        super().__init__(path)
        os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
        new_file = not os.path.exists(path) or os.path.getsize(path) == 0
        self._file = open(path, "a", newline="", encoding="utf-8")
        self._writer = csv.writer(self._file)
        if new_file:
            self._writer.writerow(FIELDS)

    def write(self, record: VideoRecord) -> None:
        self._writer.writerow(record.to_row())
        self.count += 1

    def close(self) -> None:
        try:
            self._file.flush()
            self._file.close()
        except Exception:
            pass


class JsonlWriter(RecordWriter):
    """Writes one JSON object per line."""

    def __init__(self, path: str) -> None:
        super().__init__(path)
        os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
        self._file = open(path, "a", encoding="utf-8")

    def write(self, record: VideoRecord) -> None:
        self._file.write(json.dumps(record.to_dict(), ensure_ascii=False) + "\n")
        self.count += 1

    def close(self) -> None:
        try:
            self._file.flush()
            self._file.close()
        except Exception:
            pass


class SqliteWriter(RecordWriter):
    """Writes rows into a SQLite database (one table, ``videos``).

    Numeric fields are stored as INTEGER so that SQL like
    ``SELECT AVG(likes) FROM videos`` behaves the way you expect.
    """

    NUMERIC_FIELDS = {
        "author_followers",
        "author_heart_count",
        "hashtag_count",
        "sound_duration",
        "likes",
        "comments",
        "shares",
        "saves",
        "plays",
        "reposts",
        "create_hour",
        "duration_seconds",
        "width",
        "height",
    }

    def __init__(self, path: str) -> None:
        super().__init__(path)
        os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
        self._conn = sqlite3.connect(path)
        columns = ", ".join(
            f'"{field}" {"INTEGER" if field in self.NUMERIC_FIELDS else "TEXT"}'
            for field in FIELDS
        )
        self._conn.execute(f"CREATE TABLE IF NOT EXISTS videos ({columns})")
        self._conn.commit()

    def write(self, record: VideoRecord) -> None:
        row = record.to_dict()
        placeholders = ", ".join("?" for _ in FIELDS)
        columns = ", ".join(f'"{field}"' for field in FIELDS)
        values: list[Any] = []
        for field in FIELDS:
            value = row[field]
            if value == "" or value is None:
                values.append(None)
            elif field in self.NUMERIC_FIELDS:
                try:
                    values.append(int(float(str(value))))
                except (TypeError, ValueError):
                    values.append(None)
            else:
                values.append(str(value))
        self._conn.execute(
            f"INSERT INTO videos ({columns}) VALUES ({placeholders})", values
        )
        self.count += 1

    def close(self) -> None:
        try:
            self._conn.commit()
            self._conn.close()
        except Exception:
            pass


def build_writer(out_dir: str, stem: str, fmt: str) -> RecordWriter:
    """Create the writer matching ``fmt`` inside ``out_dir``."""
    os.makedirs(out_dir, exist_ok=True)
    if fmt == "csv":
        return CsvWriter(os.path.join(out_dir, f"{stem}{CSV_SUFFIX}"))
    if fmt == "jsonl":
        return JsonlWriter(os.path.join(out_dir, f"{stem}{JSONL_SUFFIX}"))
    if fmt == "sqlite":
        return SqliteWriter(os.path.join(out_dir, f"{stem}{SQLITE_SUFFIX}"))
    raise ValueError(f"unknown format: {fmt!r} (use csv, jsonl or sqlite)")


class ProfileCsvWriter(RecordWriter):
    """Writes creator profiles to CSV."""

    def __init__(self, path: str) -> None:
        super().__init__(path)
        os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
        new_file = not os.path.exists(path) or os.path.getsize(path) == 0
        self._file = open(path, "a", newline="", encoding="utf-8")
        self._writer = csv.writer(self._file)
        if new_file:
            self._writer.writerow(PROFILE_FIELDS)

    def write(self, record: ProfileRecord) -> None:
        self._writer.writerow(record.to_row())
        self.count += 1

    def close(self) -> None:
        try:
            self._file.flush()
            self._file.close()
        except Exception:
            pass


class ProfileJsonlWriter(RecordWriter):
    """Writes creator profiles as JSON lines."""

    def __init__(self, path: str) -> None:
        super().__init__(path)
        os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
        self._file = open(path, "a", encoding="utf-8")

    def write(self, record: ProfileRecord) -> None:
        self._file.write(json.dumps(record.to_dict(), ensure_ascii=False) + "\n")
        self.count += 1

    def close(self) -> None:
        try:
            self._file.flush()
            self._file.close()
        except Exception:
            pass


class ProfileSqliteWriter(RecordWriter):
    """Writes creator profiles into a SQLite database (table ``profiles``)."""

    NUMERIC_FIELDS = {
        "follower_count",
        "following_count",
        "video_count",
        "total_likes",
        "friend_count",
    }

    def __init__(self, path: str) -> None:
        super().__init__(path)
        os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
        self._conn = sqlite3.connect(path)
        columns = ", ".join(
            f'"{field}" {"INTEGER" if field in self.NUMERIC_FIELDS else "TEXT"}'
            for field in PROFILE_FIELDS
        )
        self._conn.execute(f"CREATE TABLE IF NOT EXISTS profiles ({columns})")
        self._conn.commit()

    def write(self, record: ProfileRecord) -> None:
        row = record.to_dict()
        columns = ", ".join(f'"{field}"' for field in PROFILE_FIELDS)
        placeholders = ", ".join("?" for _ in PROFILE_FIELDS)
        values: list[Any] = []
        for field in PROFILE_FIELDS:
            value = row[field]
            if value == "" or value is None:
                values.append(None)
            elif field in self.NUMERIC_FIELDS:
                try:
                    values.append(int(float(str(value))))
                except (TypeError, ValueError):
                    values.append(None)
            else:
                values.append(str(value))
        self._conn.execute(
            f"INSERT INTO profiles ({columns}) VALUES ({placeholders})", values
        )
        self.count += 1

    def close(self) -> None:
        try:
            self._conn.commit()
            self._conn.close()
        except Exception:
            pass


def build_profile_writer(out_dir: str, stem: str, fmt: str) -> RecordWriter:
    """Create the profile writer matching ``fmt`` inside ``out_dir``."""
    os.makedirs(out_dir, exist_ok=True)
    suffix = {"csv": CSV_SUFFIX, "jsonl": JSONL_SUFFIX, "sqlite": SQLITE_SUFFIX}[fmt]
    name = f"{stem}_profiles{suffix}"
    if fmt == "csv":
        return ProfileCsvWriter(os.path.join(out_dir, name))
    if fmt == "jsonl":
        return ProfileJsonlWriter(os.path.join(out_dir, name))
    return ProfileSqliteWriter(os.path.join(out_dir, name))


def write_all(writers: Iterable[RecordWriter], record: VideoRecord) -> None:
    """Write one record to every writer."""
    for writer in writers:
        writer.write(record)


def existing_ids(csv_path: str, column: str = "video_id") -> set[str]:
    """Read already-collected IDs from a CSV so a run can resume."""
    if not os.path.exists(csv_path):
        return set()
    ids: set[str] = set()
    try:
        with open(csv_path, newline="", encoding="utf-8") as handle:
            for row in csv.DictReader(handle):
                value = (row.get(column) or "").strip()
                if value:
                    ids.add(value)
    except OSError:
        return set()
    return ids


def read_csv(path: str) -> Iterator[dict[str, str]]:
    """Stream a CSV file as dicts (used by the analysis script)."""
    with open(path, newline="", encoding="utf-8") as handle:
        yield from csv.DictReader(handle)


def csv_columns(path: str) -> list[str]:
    """Header of a CSV file."""
    with open(path, newline="", encoding="utf-8") as handle:
        reader = csv.reader(handle)
        for row in reader:
            return row
    return []


def to_int(value: Any) -> int:
    """Best-effort int conversion for CSV cells."""
    if value is None or value == "":
        return 0
    try:
        return int(float(str(value).replace(",", "")))
    except (TypeError, ValueError):
        return 0
