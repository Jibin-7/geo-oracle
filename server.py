#!/usr/bin/env python3
"""Serve the GeoOracle local dashboard and build a small SQLite observation index."""

from __future__ import annotations

import argparse
import csv
import hashlib
import gzip
import json
import lzma
import os
import sqlite3
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit


APP_DIR = Path(__file__).resolve().parent
SNAPSHOT = APP_DIR / "data" / "analytics.json"
CACHE_DIR = APP_DIR / ".cache"
DATABASE = CACHE_DIR / "observations.sqlite"
DEFAULT_DATASET = Path(
    r"C:\Users\Jibin.LAPTOP-MV56L2UP\Desktop\FINAL_Mumbai_CPCB_ERA5_GEOSCF_COASTAL_COMMON25_2023_2025_MODEL_READY.csv"
)
PACKAGED_DATASET = APP_DIR / "data" / "observations"
PAGE_SIZE_CHOICES = {20, 50, 100}
POLLUTANT_COLUMNS = {"pm25", "pm10", "no2", "so2", "co", "o3"}
SORT_COLUMNS = {
    "timestamp", "station_name", "pm25", "pm10", "no2", "so2", "co", "o3",
    "Temperature_2m", "Humidity_RH", "Wind_Speed",
}
INDEX_COLUMNS = [
    "station_id", "timestamp", "station_name", "latitude", "longitude",
    "pm25", "pm10", "no2", "so2", "co", "o3",
    "Temperature_2m", "Dewpoint_2m", "Humidity_RH", "Surface_Pressure",
    "Precipitation", "Wind_Direction", "Wind_Speed", "PM25_GEOSCF",
    "is_sea_breeze", "is_land_breeze", "has_era5", "has_geoscf",
]
NUMERIC_COLUMNS = set(INDEX_COLUMNS) - {"station_id", "timestamp", "station_name"}
state_lock = threading.Lock()
index_state: dict = {"status": "not-started", "rows": 0, "progress": 0.0, "message": "Waiting for the source CSV."}
dataset_path: Path | None = None
snapshot: dict = {}


def open_dataset(path: Path):
    """Open the source CSV in plain, gzip, or xz-compressed form."""
    if path.suffix.casefold() == ".gz":
        return gzip.open(path, "rt", encoding="utf-8-sig", newline="")
    if path.suffix.casefold() == ".xz":
        return lzma.open(path, "rt", encoding="utf-8-sig", newline="")
    return path.open("r", encoding="utf-8-sig", newline="")


def numeric(value: str | None) -> float | None:
    if value is None or value.strip().casefold() in {"", "na", "nan", "null", "none"}:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def set_index_state(**changes) -> None:
    with state_lock:
        index_state.update(changes)


def get_index_state() -> dict:
    with state_lock:
        return dict(index_state)


def source_signature(path: Path) -> tuple[int, int]:
    files = dataset_files(path)
    if not files:
        raise FileNotFoundError(f"No observation CSV parts found at {path}")
    stats = [(item.name, item.stat().st_size, item.stat().st_mtime_ns) for item in files]
    signature = "\n".join(f"{name}:{size}:{modified}" for name, size, modified in stats).encode("utf-8")
    digest = hashlib.sha256(signature).digest()
    return sum(size for _, size, _ in stats), int.from_bytes(digest[:8], "big") & 0x7FFFFFFFFFFFFFFF


def dataset_files(path: Path) -> list[Path]:
    if path.is_dir():
        return sorted(path.glob("observations-part-*.csv.xz"))
    return [path] if path.is_file() else []


def database_is_current(path: Path) -> bool:
    if not DATABASE.exists():
        return False
    try:
        connection = sqlite3.connect(f"file:{DATABASE.as_posix()}?mode=ro", uri=True)
        row = connection.execute(
            "SELECT source_size, source_mtime_ns, row_count FROM source_info WHERE id = 1"
        ).fetchone()
        connection.close()
        size, mtime = source_signature(path)
        return bool(row and row[0] == size and row[1] == mtime and row[2] == snapshot["meta"]["rows"])
    except (sqlite3.Error, OSError, KeyError):
        return False


def build_index(path: Path) -> None:
    set_index_state(status="indexing", rows=0, progress=0.0, message="Indexing the source observations…", error=None)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    temporary = CACHE_DIR / "observations.building.sqlite"
    connection = None
    try:
        temporary.unlink(missing_ok=True)
        connection = sqlite3.connect(temporary)
        connection.execute("PRAGMA journal_mode = OFF")
        connection.execute("PRAGMA synchronous = OFF")
        connection.execute("PRAGMA temp_store = MEMORY")
        connection.execute("PRAGMA cache_size = -64000")
        definitions = [
            'id INTEGER PRIMARY KEY',
            'station_id TEXT NOT NULL',
            'timestamp TEXT NOT NULL',
            'station_name TEXT NOT NULL',
            'latitude REAL', 'longitude REAL',
            'pm25 REAL', 'pm10 REAL', 'no2 REAL', 'so2 REAL', 'co REAL', 'o3 REAL',
            'Temperature_2m REAL', 'Dewpoint_2m REAL', 'Humidity_RH REAL',
            'Surface_Pressure REAL', 'Precipitation REAL', 'Wind_Direction REAL',
            'Wind_Speed REAL', 'PM25_GEOSCF REAL', 'is_sea_breeze INTEGER',
            'is_land_breeze INTEGER', 'has_era5 INTEGER', 'has_geoscf INTEGER',
        ]
        connection.execute(f"CREATE TABLE observations ({', '.join(definitions)})")
        connection.execute("CREATE TABLE source_info (id INTEGER PRIMARY KEY, source_size INTEGER, source_mtime_ns INTEGER, row_count INTEGER)")
        insert_sql = f"INSERT INTO observations ({', '.join(INDEX_COLUMNS)}) VALUES ({', '.join('?' for _ in INDEX_COLUMNS)})"
        expected = int(snapshot["meta"]["rows"])
        batch = []
        imported = 0
        for source_file in dataset_files(path):
            with open_dataset(source_file) as stream:
                reader = csv.DictReader(stream)
                missing = set(INDEX_COLUMNS) - set(reader.fieldnames or [])
                if missing:
                    raise ValueError(f"The CSV is missing required fields: {', '.join(sorted(missing))}")
                with connection:
                    for source_row in reader:
                        raw_timestamp = source_row.get("timestamp", "")
                        stamp = datetime.strptime(raw_timestamp, "%d-%m-%Y %H:%M").isoformat(timespec="minutes")
                        values = []
                        for column in INDEX_COLUMNS:
                            if column == "timestamp":
                                values.append(stamp)
                            elif column in {"station_id", "station_name"}:
                                values.append((source_row.get(column) or "").strip())
                            elif column in NUMERIC_COLUMNS:
                                value = numeric(source_row.get(column))
                                values.append(int(value) if column in {"is_sea_breeze", "is_land_breeze", "has_era5", "has_geoscf"} and value is not None else value)
                            else:
                                values.append(None)
                        batch.append(values)
                        imported += 1
                        if len(batch) >= 3000:
                            connection.executemany(insert_sql, batch)
                            batch.clear()
                            if imported % 30000 == 0:
                                set_index_state(rows=imported, progress=min(imported / max(expected, 1), 0.99), message=f"Indexing observations · {imported:,} of {expected:,}")
        with connection:
            if batch:
                connection.executemany(insert_sql, batch)
            size, mtime = source_signature(path)
            connection.execute("INSERT INTO source_info VALUES (1, ?, ?, ?)", (size, mtime, imported))
        connection.execute("CREATE INDEX observations_station_time ON observations (station_id, timestamp)")
        connection.execute("CREATE INDEX observations_time ON observations (timestamp)")
        connection.commit()
        connection.close()
        connection = None
        if imported != expected:
            raise ValueError(f"Indexed {imported:,} rows, while the verified snapshot describes {expected:,} rows. Check the configured CSV.")
        os.replace(temporary, DATABASE)
        set_index_state(status="ready", rows=imported, progress=1.0, message=f"{imported:,} observations ready for search.", error=None)
    except Exception as exc:  # The dashboard remains useful from its compact snapshot.
        if connection is not None:
            try:
                connection.close()
            except sqlite3.Error:
                pass
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        set_index_state(status="error", message="The full observation index could not be created.", error=str(exc))


def prepare_index(path: Path | None) -> None:
    global dataset_path
    dataset_path = path
    if path is None or not dataset_files(path):
        set_index_state(status="unavailable", rows=0, progress=0.0, message="Full row search needs the supplied project CSV.")
        return
    if database_is_current(path):
        try:
            db = sqlite3.connect(f"file:{DATABASE.as_posix()}?mode=ro", uri=True)
            count = db.execute("SELECT COUNT(*) FROM observations").fetchone()[0]
            db.close()
            set_index_state(status="ready", rows=count, progress=1.0, message=f"{count:,} observations ready for search.")
            return
        except sqlite3.Error:
            pass
    worker = threading.Thread(target=build_index, args=(path,), daemon=True, name="geooracle-indexer")
    worker.start()


def filters_from(query: dict[str, list[str]]) -> tuple[str, list, dict]:
    clauses = []
    values: list = []
    clean: dict = {}
    station = query.get("station", [""])[0].strip()
    year = query.get("year", [""])[0].strip()
    search = query.get("q", [""])[0].strip()[:120]
    start_date = query.get("from", [""])[0].strip()
    end_date = query.get("to", [""])[0].strip()
    pollutant = query.get("pollutant", [""])[0].strip().lower()
    min_value = query.get("min", [""])[0].strip()
    max_value = query.get("max", [""])[0].strip()
    if station:
        clauses.append("station_id = ?")
        values.append(station)
        clean["station"] = station
    if year in {"2023", "2024", "2025"}:
        clauses.append("substr(timestamp, 1, 4) = ?")
        values.append(year)
        clean["year"] = year
    if search:
        clauses.append("station_name LIKE ?")
        values.append(f"%{search.replace('%', '')}%")
        clean["q"] = search
    for label, value, op, inclusive in (("from", start_date, ">=", "T00:00"), ("to", end_date, "<=", "T23:59")):
        if value:
            try:
                datetime.strptime(value, "%Y-%m-%d")
                clauses.append(f"timestamp {op} ?")
                values.append(value + inclusive)
                clean[label] = value
            except ValueError:
                pass
    if pollutant in POLLUTANT_COLUMNS:
        column = pollutant
        for label, value, op in (("min", min_value, ">="), ("max", max_value, "<=")):
            if value:
                try:
                    number = float(value)
                    clauses.append(f"{column} {op} ?")
                    values.append(number)
                    clean[label] = number
                except ValueError:
                    pass
        if "min" in clean or "max" in clean:
            clean["pollutant"] = pollutant
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    return where, values, clean


class Handler(BaseHTTPRequestHandler):
    server_version = "GeoOracleLocal/1.0"

    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def send_json(self, value: object, status: int = 200) -> None:
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def db_connection(self):
        if get_index_state()["status"] != "ready" or not DATABASE.exists():
            return None
        connection = sqlite3.connect(f"file:{DATABASE.as_posix()}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        return connection

    def do_GET(self):
        parsed = urlsplit(self.path)
        path = unquote(parsed.path)
        query = parse_qs(parsed.query, keep_blank_values=True)

        if path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        if path == "/api/summary":
            self.send_json(snapshot)
            return
        if path == "/api/status":
            self.send_json(get_index_state())
            return
        if path == "/api/observations":
            self.observations(query)
            return
        if path == "/api/export":
            self.export_rows(query)
            return
        if path.startswith("/api/observation/"):
            self.observation(path.rsplit("/", 1)[-1])
            return
        if path == "/" or path == "/index.html":
            path = "/index.html"
        local_path = (APP_DIR / path.lstrip("/")).resolve()
        allowed = { (APP_DIR / name).resolve() for name in ("index.html", "app.js", "styles.css", "README.md") }
        allowed.add(SNAPSHOT.resolve())
        if local_path not in allowed or not local_path.is_file():
            self.send_error(404, "Not found")
            return
        content_type = "text/html; charset=utf-8" if local_path.suffix == ".html" else "text/css; charset=utf-8" if local_path.suffix == ".css" else "application/javascript; charset=utf-8" if local_path.suffix == ".js" else "application/json; charset=utf-8" if local_path.suffix == ".json" else "text/plain; charset=utf-8"
        body = local_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def observations(self, query: dict[str, list[str]]) -> None:
        connection = self.db_connection()
        if connection is None:
            self.send_json({"error": "index-unavailable", "status": get_index_state()}, 503)
            return
        where, params, clean = filters_from(query)
        try:
            total = connection.execute(f"SELECT COUNT(*) FROM observations{where}", params).fetchone()[0]
            try:
                page = max(1, int(query.get("page", ["1"])[0]))
            except ValueError:
                page = 1
            try:
                page_size = int(query.get("page_size", ["20"])[0])
            except ValueError:
                page_size = 20
            if page_size not in PAGE_SIZE_CHOICES:
                page_size = 20
            sort = query.get("sort", ["timestamp"])[0]
            sort = sort if sort in SORT_COLUMNS else "timestamp"
            direction = "DESC" if query.get("direction", ["desc"])[0].lower() == "desc" else "ASC"
            offset = (page - 1) * page_size
            rows = connection.execute(
                f"SELECT id, station_id, timestamp, station_name, latitude, longitude, pm25, pm10, no2, so2, co, o3, Temperature_2m, Humidity_RH, Wind_Speed, PM25_GEOSCF, is_sea_breeze FROM observations{where} ORDER BY {sort} {direction}, id ASC LIMIT ? OFFSET ?",
                [*params, page_size, offset],
            ).fetchall()
            self.send_json({
                "items": [dict(row) for row in rows],
                "total": total,
                "page": page,
                "page_size": page_size,
                "pages": max(1, (total + page_size - 1) // page_size),
                "filters": clean,
            })
        finally:
            connection.close()

    def observation(self, raw_id: str) -> None:
        try:
            row_id = int(raw_id)
        except ValueError:
            self.send_error(400, "Invalid observation id")
            return
        connection = self.db_connection()
        if connection is None:
            self.send_json({"error": "index-unavailable", "status": get_index_state()}, 503)
            return
        try:
            row = connection.execute("SELECT * FROM observations WHERE id = ?", (row_id,)).fetchone()
            if row is None:
                self.send_error(404, "Observation not found")
                return
            self.send_json(dict(row))
        finally:
            connection.close()

    def export_rows(self, query: dict[str, list[str]]) -> None:
        connection = self.db_connection()
        if connection is None:
            self.send_json({"error": "index-unavailable", "status": get_index_state()}, 503)
            return
        where, params, _ = filters_from(query)
        columns = ["station_id", "timestamp", "station_name", "latitude", "longitude", "pm25", "pm10", "no2", "so2", "co", "o3", "Temperature_2m", "Dewpoint_2m", "Humidity_RH", "Surface_Pressure", "Precipitation", "Wind_Direction", "Wind_Speed", "PM25_GEOSCF", "is_sea_breeze", "is_land_breeze", "has_era5", "has_geoscf"]
        try:
            count = connection.execute(f"SELECT COUNT(*) FROM observations{where}", params).fetchone()[0]
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", 'attachment; filename="geooracle-observations.csv"')
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(("\ufeff" + ",".join(columns) + "\r\n").encode("utf-8"))
            cursor = connection.execute(f"SELECT {', '.join(columns)} FROM observations{where} ORDER BY timestamp ASC", params)
            import io
            for row in cursor:
                buffer = io.StringIO(newline="")
                csv.writer(buffer).writerow(row)
                self.wfile.write(buffer.getvalue().encode("utf-8"))
            self.log_message("Exported %s filtered observations", f"{count:,}")
        finally:
            connection.close()


def main() -> None:
    global snapshot
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, default=None, help="Path to a source CSV or folder containing packaged CSV parts.")
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"), help="Bind address (default: local machine only)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    args = parser.parse_args()

    if not SNAPSHOT.is_file():
        raise SystemExit(f"Missing chart snapshot: {SNAPSHOT}")
    snapshot = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    chosen_dataset = args.dataset
    if chosen_dataset is None:
        chosen_dataset = next((candidate for candidate in (DEFAULT_DATASET, PACKAGED_DATASET) if dataset_files(candidate)), None)
    prepare_index(chosen_dataset)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"GeoOracle is available at http://{args.host}:{args.port}")
    print("Press Ctrl+C to stop the local server.")
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        print("\nStopping GeoOracle…")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
