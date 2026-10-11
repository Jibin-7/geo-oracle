#!/usr/bin/env python3
"""Build the compact, verified GeoOracle chart snapshot from the source CSV.

Uses only the Python standard library. Concentration averages preserve the
source rows and do not apply AQI thresholds, interpolation, or model output.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
from collections import defaultdict
from datetime import datetime
from pathlib import Path


POLLUTANTS = {
    "pm25": {"column": "pm25", "label": "PM₂.₅", "unit": "µg/m³", "color": "#f28a62", "source": "CPCB observed", "group": "CPCB"},
    "pm10": {"column": "pm10", "label": "PM₁₀", "unit": "µg/m³", "color": "#4e9489", "source": "CPCB observed", "group": "CPCB"},
    "no2": {"column": "no2", "label": "NO₂", "unit": "µg/m³", "color": "#7182cf", "source": "CPCB observed", "group": "CPCB"},
    "so2": {"column": "so2", "label": "SO₂", "unit": "µg/m³", "color": "#a779bd", "source": "CPCB observed", "group": "CPCB"},
    "co": {"column": "co", "label": "CO", "unit": "mg/m³", "color": "#d7a53f", "source": "CPCB observed", "group": "CPCB"},
    "o3": {"column": "o3", "label": "O₃", "unit": "µg/m³", "color": "#4989b0", "source": "CPCB observed", "group": "CPCB"},
    "PM25_GEOSCF": {"column": "PM25_GEOSCF", "label": "PM₂.₅ · GEOS-CF", "unit": "Source scale", "color": "#ff5e7d", "source": "GEOS-CF model", "group": "GEOS-CF"},
    "PM25_DUST_GEOSCF": {"column": "PM25_DUST_GEOSCF", "label": "PM₂.₅ dust", "unit": "Source scale", "color": "#ff9d59", "source": "GEOS-CF model", "group": "GEOS-CF"},
    "PM25_OC_GEOSCF": {"column": "PM25_OC_GEOSCF", "label": "PM₂.₅ organic carbon", "unit": "Source scale", "color": "#e774c6", "source": "GEOS-CF model", "group": "GEOS-CF"},
    "PM25_SEASALT_GEOSCF": {"column": "PM25_SEASALT_GEOSCF", "label": "PM₂.₅ sea salt", "unit": "Source scale", "color": "#42d5d0", "source": "GEOS-CF model", "group": "GEOS-CF"},
    "PM25_SULFATE_GEOSCF": {"column": "PM25_SULFATE_GEOSCF", "label": "PM₂.₅ sulfate", "unit": "Source scale", "color": "#c7f15c", "source": "GEOS-CF model", "group": "GEOS-CF"},
    "PM25_BC_GEOSCF": {"column": "PM25_BC_GEOSCF", "label": "PM₂.₅ black carbon", "unit": "Source scale", "color": "#c77aff", "source": "GEOS-CF model", "group": "GEOS-CF"},
    "PM25_NITRATE_GEOSCF": {"column": "PM25_NITRATE_GEOSCF", "label": "PM₂.₅ nitrate", "unit": "Source scale", "color": "#62a9ff", "source": "GEOS-CF model", "group": "GEOS-CF"},
    "PM25_SOA_GEOSCF": {"column": "PM25_SOA_GEOSCF", "label": "PM₂.₅ secondary organic aerosol", "unit": "Source scale", "color": "#ffcb4b", "source": "GEOS-CF model", "group": "GEOS-CF"},
    "NO2_GEOSCF": {"column": "NO2_GEOSCF", "label": "NO₂ · GEOS-CF", "unit": "Source scale", "color": "#6cb7ff", "source": "GEOS-CF model", "group": "GEOS-CF"},
    "SO2_GEOSCF": {"column": "SO2_GEOSCF", "label": "SO₂ · GEOS-CF", "unit": "Source scale", "color": "#ad8aff", "source": "GEOS-CF model", "group": "GEOS-CF"},
    "CO_GEOSCF": {"column": "CO_GEOSCF", "label": "CO · GEOS-CF", "unit": "Source scale", "color": "#ffac63", "source": "GEOS-CF model", "group": "GEOS-CF"},
    "O3_GEOSCF": {"column": "O3_GEOSCF", "label": "O₃ · GEOS-CF", "unit": "Source scale", "color": "#70e3aa", "source": "GEOS-CF model", "group": "GEOS-CF"},
}

MAP_CONTEXT = {
    "Temperature_2m": {"column": "Temperature_2m", "label": "Temperature · 2 m", "unit": "Source scale", "color": "#ff875e", "source": "ERA5 weather", "group": "ERA5"},
    "Dewpoint_2m": {"column": "Dewpoint_2m", "label": "Dewpoint · 2 m", "unit": "Source scale", "color": "#6fd0c0", "source": "ERA5 weather", "group": "ERA5"},
    "Humidity_RH": {"column": "Humidity_RH", "label": "Relative humidity", "unit": "Source scale", "color": "#6baeff", "source": "ERA5 weather", "group": "ERA5"},
    "Surface_Pressure": {"column": "Surface_Pressure", "label": "Surface pressure", "unit": "Source scale", "color": "#bd91ff", "source": "ERA5 weather", "group": "ERA5"},
    "Precipitation": {"column": "Precipitation", "label": "Precipitation", "unit": "Source scale", "color": "#49d4e8", "source": "ERA5 weather", "group": "ERA5"},
    "Wind_Speed": {"column": "Wind_Speed", "label": "Wind speed", "unit": "Source scale", "color": "#b0ec69", "source": "ERA5 weather", "group": "ERA5"},
}
MAP_FIELDS = {**POLLUTANTS, **MAP_CONTEXT}


def add(aggregate: dict, key: str, value: float) -> None:
    pair = aggregate.setdefault(key, [0.0, 0])
    pair[0] += value
    pair[1] += 1


def mean_map(aggregate: dict) -> dict[str, float | None]:
    return {
        key: (round(value[0] / value[1], 6) if value[1] else None)
        for key, value in aggregate.items()
    }


def read_number(value: str) -> float | None:
    if value is None or value.strip().casefold() in {"", "na", "nan", "null", "none"}:
        return None
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def build(input_path: Path, output_path: Path) -> dict:
    source_bytes = input_path.stat().st_size
    rows = 0
    blank_cells = 0
    invalid_timestamps = 0
    duplicate_station_timestamps = 0
    seen: set[tuple[str, str]] = set()
    station_rows: dict[str, int] = defaultdict(int)
    station_data: dict[str, dict] = {}
    global_stats: dict[str, list[float | int]] = {
        key: [0.0, 0, math.inf, -math.inf] for key in MAP_FIELDS
    }
    monthly_stats: dict[str, dict] = defaultdict(dict)
    city_hour_stats: dict[int, dict] = defaultdict(dict)
    city_yearly_hour_stats: dict[str, dict] = defaultdict(dict)
    source_flags: dict[str, int] = defaultdict(int)
    year_rows: dict[str, int] = defaultdict(int)
    start = end = None

    with input_path.open("r", encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        columns = reader.fieldnames or []
        required = {"station_id", "timestamp", "station_name", "latitude", "longitude", *[p["column"] for p in MAP_FIELDS.values()]}
        missing = required - set(columns)
        if missing:
            raise ValueError(f"Source CSV is missing required columns: {', '.join(sorted(missing))}")

        for row in reader:
            rows += 1
            blank_cells += sum(1 for value in row.values() if value is None or not value.strip())
            try:
                stamp = datetime.strptime(row["timestamp"], "%d-%m-%Y %H:%M")
            except (TypeError, ValueError):
                invalid_timestamps += 1
                continue

            station_id = row["station_id"].strip()
            station_timestamp = (station_id, stamp.isoformat(timespec="minutes"))
            if station_timestamp in seen:
                duplicate_station_timestamps += 1
            else:
                seen.add(station_timestamp)

            iso_month = stamp.strftime("%Y-%m")
            year = str(stamp.year)
            hour = stamp.hour
            year_rows[year] += 1
            start = stamp if start is None or stamp < start else start
            end = stamp if end is None or stamp > end else end

            station = station_data.setdefault(station_id, {
                "id": station_id,
                "name": row["station_name"].strip(),
                "latitude": read_number(row["latitude"]),
                "longitude": read_number(row["longitude"]),
                "rows": 0,
                "sums": {},
                "monthly_sums": defaultdict(dict),
                "hourly_sums": defaultdict(dict),
                "yearly_hourly_sums": defaultdict(lambda: defaultdict(dict)),
            })
            station["rows"] += 1
            station_rows[station_id] += 1

            for flag in ("has_era5", "has_geoscf", "era5_valid"):
                if row.get(flag, "").strip() == "1":
                    source_flags[flag] += 1

            for key, spec in MAP_FIELDS.items():
                value = read_number(row.get(spec["column"], ""))
                if value is None:
                    continue
                overall = global_stats[key]
                overall[0] += value
                overall[1] += 1
                overall[2] = min(overall[2], value)
                overall[3] = max(overall[3], value)
                add(monthly_stats[iso_month], key, value)
                add(station["sums"], key, value)
                add(station["monthly_sums"][iso_month], key, value)
                if key in POLLUTANTS:
                    add(city_hour_stats[hour], key, value)
                    add(city_yearly_hour_stats[year], key + ":" + str(hour), value)
                    add(station["hourly_sums"][hour], key, value)
                    add(station["yearly_hourly_sums"][year][hour], key, value)

            breeze = read_number(row.get("is_sea_breeze", ""))
            if breeze is not None:
                add(city_hour_stats[hour], "sea_breeze", breeze)
                add(city_yearly_hour_stats[year], "sea_breeze:" + str(hour), breeze)
                add(station["hourly_sums"][hour], "sea_breeze", breeze)
                add(station["yearly_hourly_sums"][year][hour], "sea_breeze", breeze)

    if rows == 0:
        raise ValueError("Source CSV contains no observations")

    def packed_stats(stats: dict) -> dict:
        return {
            key: (round(pair[0] / pair[1], 6) if pair[1] else None)
            for key, pair in stats.items()
        }

    monthly = []
    for month in sorted(monthly_stats):
        values = packed_stats(monthly_stats[month])
        values["month"] = month
        monthly.append(values)

    hourly = []
    for hour in range(24):
        values = packed_stats(city_hour_stats.get(hour, {}))
        values["hour"] = hour
        hourly.append(values)

    yearly_hourly = {}
    for year in sorted(year_rows):
        year_values = []
        for hour in range(24):
            values = {}
            for key in POLLUTANTS:
                pair = city_yearly_hour_stats[year].get(f"{key}:{hour}", [0.0, 0])
                values[key] = round(pair[0] / pair[1], 6) if pair[1] else None
            pair = city_yearly_hour_stats[year].get(f"sea_breeze:{hour}", [0.0, 0])
            values["sea_breeze"] = round(pair[0] / pair[1], 6) if pair[1] else None
            values["hour"] = hour
            year_values.append(values)
        yearly_hourly[year] = year_values

    stations = []
    for station_id, station in sorted(station_data.items(), key=lambda pair: pair[1]["name"].casefold()):
        station_months = []
        for month in sorted(station["monthly_sums"]):
            values = packed_stats(station["monthly_sums"][month])
            values["month"] = month
            values["n"] = next(iter(station["monthly_sums"][month].values()))[1]
            station_months.append(values)
        station_hours = []
        for hour in range(24):
            values = packed_stats(station["hourly_sums"].get(hour, {}))
            values["hour"] = hour
            station_hours.append(values)
        station_yearly_hourly = {}
        for year in sorted(station["yearly_hourly_sums"]):
            year_values = []
            for hour in range(24):
                values = packed_stats(station["yearly_hourly_sums"][year].get(hour, {}))
                values["hour"] = hour
                year_values.append(values)
            station_yearly_hourly[year] = year_values
        means = packed_stats(station["sums"])
        stations.append({
            "id": station_id,
            "name": station["name"],
            "latitude": station["latitude"],
            "longitude": station["longitude"],
            "rows": station["rows"],
            "means": means,
            "monthly": station_months,
            "hourly": station_hours,
            "yearly_hourly": station_yearly_hourly,
        })

    global_means = {}
    ranges = {}
    for key, (total, count, low, high) in global_stats.items():
        global_means[key] = round(total / count, 6) if count else None
        ranges[key] = [low if count else None, high if count else None]

    snapshot = {
        "meta": {
            "project": "GeoOracle",
            "source_file": input_path.name,
            "source_bytes": source_bytes,
            "rows": rows,
            "columns_count": len(columns),
            "columns": columns,
            "station_count": len(stations),
            "period_start": start.isoformat(timespec="minutes") if start else None,
            "period_end": end.isoformat(timespec="minutes") if end else None,
            "year_rows": dict(sorted(year_rows.items())),
            "blank_cells": blank_cells,
            "invalid_timestamps": invalid_timestamps,
            "duplicate_station_timestamps": duplicate_station_timestamps,
            "station_row_counts": dict(sorted(station_rows.items())),
            "source_flag_counts": dict(source_flags),
            "summary_method": "Arithmetic means over source CSV rows; the snapshot does not apply AQI conversion or forecast models. Optional map surfaces are client-side IDW visual estimates from monthly station means.",
        },
        "pollutants": [{"key": key, **spec} for key, spec in POLLUTANTS.items()],
        "map_fields": [{"key": key, **spec} for key, spec in MAP_FIELDS.items()],
        "global_means": global_means,
        "global_ranges": ranges,
        "monthly": monthly,
        "hourly": hourly,
        "yearly_hourly": yearly_hourly,
        "stations": stations,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    return snapshot


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True, help="Path to the project CSV")
    parser.add_argument("--output", type=Path, required=True, help="Path for analytics.json")
    args = parser.parse_args()
    result = build(args.input, args.output)
    meta = result["meta"]
    print(json.dumps({
        "rows": meta["rows"],
        "columns": meta["columns_count"],
        "stations": meta["station_count"],
        "period": [meta["period_start"], meta["period_end"]],
        "blank_cells": meta["blank_cells"],
        "invalid_timestamps": meta["invalid_timestamps"],
        "duplicate_station_timestamps": meta["duplicate_station_timestamps"],
        "snapshot_bytes": args.output.stat().st_size,
    }, indent=2))


if __name__ == "__main__":
    main()
