# GeoOracle · Mumbai air intelligence

A local, evidence-led interface for exploring the supplied Mumbai CPCB + ERA5 + GEOS-CF model-ready dataset. The app shows historical observations and derived means; it does not train a model, issue a forecast, calculate AQI, or create risk classifications.

## Run locally

Python 3.10 or later is sufficient. There are no package-install steps. The satellite atlas loads Leaflet and map tiles from the internet when you open it.

```powershell
cd "C:\Users\Jibin.LAPTOP-MV56L2UP\Documents\Codex\2026-10-11\files-mentioned-by-the-user-final\outputs\geooracle"
python server.py
```

Then open [http://127.0.0.1:8000](http://127.0.0.1:8000). The app checks for the source CSV at the Desktop path supplied for this task, then falls back to the packaged compressed parts in `data/observations/`. On first run, it indexes the CSV in the background into a local SQLite cache so the observation table can filter and paginate all 657,600 rows. The first index takes a little time; the summary charts are available while it runs.

If the CSV is in a different location, pass its path:

```powershell
python server.py --dataset "D:\data\FINAL_Mumbai_CPCB_ERA5_GEOSCF_COASTAL_COMMON25_2023_2025_MODEL_READY.csv"
```

The cache is held in `.cache/` and can be recreated by removing that app-local cache directory. Keep the server bound to its default `127.0.0.1` address for local use.

## Deploy to Render

This repository includes a Render Blueprint at `render.yaml`. Push the project to GitHub, then in Render choose **New → Blueprint** and connect the repository. Render will build and start the Python web service; it binds to `0.0.0.0` and Render's `PORT` automatically. The service uses only Python's standard library, so it does not need API keys or a dependency install step.

The original CSV is about 348 MB, so the repository stores eight xz-compressed parts in `data/observations/`. The app reads the parts in sequence and builds its searchable SQLite index in `.cache/` after startup. That cache is temporary on Render and is rebuilt after an instance restart; the summary views remain available while the index is building. The atlas uses external Leaflet and Esri imagery services, as described below.

Use GitHub Desktop or Git to publish the repository so the app files and all compressed dataset parts keep their folder structure.

## What's included

- **Overview:** verified dataset coverage, pollutant monthly means, the hour-of-day pollutant curve overlaid with the source sea-breeze flag share, and station coordinate / ranking views.
- **Satellite atlas:** Interactive Esri World Imagery tiles with selectable CPCB, GEOS-CF and ERA5 station layers. Pan and zoom the map, scrub or play through 36 months, inspect a station, and tune an optional colorful inverse-distance-weighted (IDW) surface.
- **Station field:** compare all sites and focus the charts on a selected station.
- **Observations:** search by station, filter by year / dates / station / pollutant range, sort, paginate, inspect a row, and export the filtered records to CSV.
- **Method & limits:** the input-field inventory and a clear distinction between available data and the proposed DL / LLM work described in the report.

Station and monthly summaries are arithmetic means of source rows. CPCB pollutant units follow the [CPCB concentration conventions](https://cpcb.nic.in/displaypdf.php?id=bWFudWFsLW1vbml0b3JpbmcvQVFJX05BTVBfUmVwX1NlcHRlbWJlcjIwMTYucGRm): PM₂.₅, PM₁₀, NO₂, SO₂, and O₃ in µg/m³; CO in mg/m³. The provided CSV does not declare units for ERA5 / GEOS-CF fields, so they are shown in source scale without conversion. The optional map surface uses inverse-distance-squared weighting of station monthly means and fades to transparent beyond the selected influence radius. It is a visualization estimate, not a measured gridded product or forecast.

The atlas loads Leaflet 1.9.4 from its public CDN and requests Esri World Imagery tiles from the browser. An internet connection is required for the interactive basemap. Tile attribution is displayed on the map; the local pollutant data and station summaries continue to work if the imagery service is unavailable.

The attached report and presentation describe model forecasting, progressive fusion experiments, risk analysis, and LLM interpretation as the proposed GeoOracle framework. Neither file contains completed GeoOracle model predictions or validation metrics. This UI therefore labels the data as observations and does not invent those results.

## Refresh the compact charts

`data/analytics.json` is a compact summary generated from the supplied source CSV. To rebuild it after restoring the same dataset file:

```powershell
python tools/build_snapshot.py `
  --input "C:\Users\Jibin.LAPTOP-MV56L2UP\Desktop\FINAL_Mumbai_CPCB_ERA5_GEOSCF_COASTAL_COMMON25_2023_2025_MODEL_READY.csv" `
  --output "data\analytics.json"
```

The snapshot includes the source header, row coverage, station means for all 18 pollutant fields and six ERA5 context fields, 36 monthly means, and hourly pollutant series. It does not include raw observations.

## Design and motion

The interface uses CSS motion, SVG charts, canvas interpolation, Leaflet map interactions, and native JavaScript controls; it respects `prefers-reduced-motion`. Esri World Imagery and the Leaflet CDN are external services used by the atlas. The dark editorial layout uses oversized type, image-led sections, and deliberate reveals as broad pacing cues; it does not use Rockstar logos, art, or copied page assets.

## Checks

```powershell
python -m unittest discover -s tests -v
python -m py_compile server.py tools/build_snapshot.py
```
