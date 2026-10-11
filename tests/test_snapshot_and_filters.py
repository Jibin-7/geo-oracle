import json
import sqlite3
import sys
import unittest
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_DIR))
import server  # noqa: E402


class SnapshotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = json.loads((APP_DIR / "data" / "analytics.json").read_text(encoding="utf-8"))

    def test_snapshot_matches_verified_source_dimensions(self):
        meta = self.data["meta"]
        self.assertEqual(meta["rows"], 657600)
        self.assertEqual(meta["columns_count"], 59)
        self.assertEqual(meta["station_count"], 25)
        self.assertEqual(meta["blank_cells"], 0)
        self.assertEqual(meta["invalid_timestamps"], 0)
        self.assertEqual(meta["duplicate_station_timestamps"], 0)
        self.assertEqual(meta["period_start"], "2023-01-01T00:00")
        self.assertEqual(meta["period_end"], "2025-12-31T23:00")

    def test_all_sites_have_complete_hourly_coverage(self):
        meta = self.data["meta"]
        self.assertEqual(set(meta["station_row_counts"].values()), {26304})
        self.assertEqual(len(self.data["monthly"]), 36)
        self.assertEqual(len(self.data["hourly"]), 24)
        self.assertEqual(set(self.data["yearly_hourly"]), {"2023", "2024", "2025"})
        self.assertTrue(all(len(series) == 24 for series in self.data["yearly_hourly"].values()))
        self.assertTrue(all(len(station["monthly"]) == 36 for station in self.data["stations"]))

    def test_annual_and_monthly_aggregates_are_numeric(self):
        self.assertGreater(self.data["global_means"]["pm25"], 0)
        self.assertAlmostEqual(self.data["global_means"]["pm25"], 37.840921, places=5)
        self.assertTrue(all(item["pm25"] is not None for item in self.data["monthly"]))


class FilterTests(unittest.TestCase):
    def test_filter_builder_uses_parameters_for_user_values(self):
        where, values, clean = server.filters_from({
            "station": ["6927"], "year": ["2023"], "q": ["Colaba"],
            "from": ["2023-02-01"], "to": ["2023-02-03"],
            "pollutant": ["pm25"], "min": ["12.5"], "max": ["60"],
        })
        self.assertIn("station_id = ?", where)
        self.assertIn("substr(timestamp, 1, 4) = ?", where)
        self.assertIn("pm25 >= ?", where)
        self.assertIn("pm25 <= ?", where)
        self.assertNotIn("Colaba", where)
        self.assertEqual(values, ["6927", "2023", "%Colaba%", "2023-02-01T00:00", "2023-02-03T23:59", 12.5, 60.0])
        self.assertEqual(clean["pollutant"], "pm25")

    def test_invalid_date_and_unknown_pollutant_are_ignored(self):
        where, values, clean = server.filters_from({"from": ["not-a-date"], "pollutant": ["aqi"], "min": ["10"]})
        self.assertEqual(where, "")
        self.assertEqual(values, [])
        self.assertEqual(clean, {})


class BuiltIndexTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.database = APP_DIR / ".cache" / "observations.sqlite"
        if not cls.database.is_file():
            raise unittest.SkipTest("The local source index has not been built yet")
        cls.connection = sqlite3.connect(f"file:{cls.database.as_posix()}?mode=ro", uri=True)

    @classmethod
    def tearDownClass(cls):
        connection = getattr(cls, "connection", None)
        if connection:
            connection.close()

    def test_full_source_index_and_station_year_filter(self):
        count = self.connection.execute("SELECT COUNT(*) FROM observations").fetchone()[0]
        self.assertEqual(count, 657600)
        where, values, _ = server.filters_from({"station": ["6927"], "year": ["2023"]})
        filtered = self.connection.execute(f"SELECT COUNT(*) FROM observations{where}", values).fetchone()[0]
        self.assertEqual(filtered, 8760)

    def test_index_preserves_first_hourly_reading_and_environment_fields(self):
        row = self.connection.execute(
            "SELECT station_id, timestamp, pm25, pm10, PM25_GEOSCF, has_era5, has_geoscf FROM observations ORDER BY id LIMIT 1"
        ).fetchone()
        self.assertEqual(row[0:2], ("6927", "2023-01-01T00:00"))
        self.assertAlmostEqual(row[2], 52.0)
        self.assertAlmostEqual(row[3], 86.25)
        self.assertEqual(row[5:7], (1, 1))

    def test_pages_are_disjoint_and_ordered_for_a_station_year(self):
        where, values, _ = server.filters_from({"station": ["6927"], "year": ["2023"]})
        first = self.connection.execute(
            f"SELECT id, timestamp FROM observations{where} ORDER BY timestamp DESC, id ASC LIMIT 20 OFFSET 0", values
        ).fetchall()
        second = self.connection.execute(
            f"SELECT id, timestamp FROM observations{where} ORDER BY timestamp DESC, id ASC LIMIT 20 OFFSET 20", values
        ).fetchall()
        self.assertEqual(len(first), 20)
        self.assertEqual(len(second), 20)
        self.assertEqual(first[0][1], "2023-12-31T23:00")
        self.assertGreater(first[0][1], first[-1][1])
        self.assertTrue(set(row[0] for row in first).isdisjoint(row[0] for row in second))


if __name__ == "__main__":
    unittest.main()
