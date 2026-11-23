# Refugee Homelessness Tracker

An automatically updating dashboard showing where people leaving Home Office asylum
accommodation are becoming homeless in England, by region and local authority.

It replaces the manual Flourish charts and comparison spreadsheet. It reads GOV.UK's
release calendar and updates itself on the day each new release comes out, plus a weekly
sweep for corrections. No-one needs to touch it when new statistics come out.

## What it shows

| Section | Contents |
|---|---|
| **Overview** | England headline figures, quarterly prevention and relief duties (the old Flourish chart), monthly rough sleeping after leaving asylum support (the other Flourish chart), share of all duties, asylum support population, and grants of protection compared with duties. Any region or local authority can be selected. |
| **Regions** | Regional comparison table (latest quarter, change on previous quarter and year, share, trend) and the **top 5 local authorities in every region** for any quarter and measure. |
| **Local authority trends** | A profile for each council: figures, national and regional rank, trends, rough sleeping, people in asylum support and a quarterly table. |
| **Map** | Choropleth of every council by measure and quarter, with zoom to region. |
| **Local authority tables** | Sortable and filterable table of all councils, with CSV download. |
| **About the data** | Definitions, caveats, the exact source files in use, full dataset downloads, and how to embed charts. |

## Data sources (found automatically)

| Data | Source | Frequency |
|---|---|---|
| Prevention / relief duties where the reason was "Required to leave accommodation provided by Home Office as asylum support" (tables A2P, A2R, and A2 before April 2020) | MHCLG [Live tables on homelessness](https://www.gov.uk/government/statistical-data-sets/live-tables-on-homelessness), detailed local authority-level tables | Quarterly |
| People sleeping rough who left asylum support in the last 85 days (Table 12), and all rough sleeping (Table 1) | MHCLG Rough Sleeping Data Framework (latest release found through GOV.UK search) | Monthly figures, published quarterly |
| People in receipt of asylum support by local authority (Asy_D11) | Home Office [Immigration system statistics data tables](https://www.gov.uk/government/statistical-data-sets/immigration-system-statistics-data-tables) | Quarterly |
| Grants of protection, main applicants (Asy_D02) | As above | Quarterly |
| Local authority boundaries | ONS Open Geography Portal (December 2024, ultra-generalised) | One-off |

## How it fits together

```
GOV.UK release calendar ──► pipeline/release_check.py ── release day? ──► pipeline/update_data.py
                                                                              │
                         docs/ (static site, GitHub Pages)  ◄──  docs/data/*.json, *.csv
```

### When it updates

The workflow (`.github/workflows/update-data.yml`) wakes for a few seconds each weekday
at 10:00 UTC and runs `pipeline/release_check.py`, which downloads nothing. It runs the
full update only when:

- **it is a release day**, meaning GOV.UK's release calendar has a *confirmed* release
  of MHCLG statutory homelessness or Home Office immigration statistics dated today. It
  also checks the day after, in case files reach the page late;
- **a source page changed in the last two days**. This catches the Rough Sleeping Data
  Framework, which is management information and not on the release calendar, and any
  unscheduled corrections;
- **it is Monday**: a weekly sweep for anything else; or
- **someone presses *Run workflow***.

Release dates come straight from GOV.UK, so nobody has to enter them, and the dashboard
header shows the next scheduled release. If GOV.UK can't be reached, it runs anyway.

### The pieces

- `pipeline/update_data.py` finds the files through the GOV.UK Content API, parses them,
  and writes `docs/data/data.json` (read by the site) plus three CSV downloads.
- `pipeline/cache/` holds the parsed result for each source file, keyed by its URL.
  Only new or revised files are downloaded, so a normal run takes about a minute.
- `pipeline/check_data.py` sanity-checks the result before anything is published.
  For example, it checks that local authority figures add up to the England total.
- `docs/` is the website: plain HTML, CSS and JavaScript (d3), with no build step.
- When a new release appears, the workflow commits the new data, redeploys the site and
  opens a GitHub issue. Anyone watching the repository gets an email.

## Setting it up on GitHub (one time, about 10 minutes)

1. Create a free GitHub account or organisation, then create a new **public** repository
   (for example `migrant-homelessness-tracker`).
2. Upload everything in this folder to the repository, including the hidden `.github` folder.
   GitHub Desktop is the easiest way: *File → Add local repository*, then *Publish*.
3. In the repository go to **Settings → Pages** and set *Source* to **GitHub Actions**.
4. Go to **Settings → Actions → General → Workflow permissions** and choose
   **Read and write permissions**.
5. Go to **Actions → Update data and publish dashboard → Run workflow** to run it once.
   The site will appear at `https://<your-account>.github.io/<repository-name>/`.
6. Optional: under **Settings → Pages** you can add a custom domain
   (for example `data.yourorganisation.org.uk`).

After that it runs itself. To force an update, use *Run workflow* again. If MHCLG
changes its table layout and the pipeline cannot read a file, the run fails and GitHub
emails the repository owner.

## Running it on your own computer

```powershell
pip install -r pipeline/requirements.txt
python pipeline/update_data.py
python -m http.server 8765 --directory docs
```

Then open http://localhost:8765. Use `python pipeline/update_data.py --force` to re-parse
every file after changing the parsing code.

## Embedding on a website

Add `?embed=1` to any page address to hide the header and navigation, for example:

```html
<iframe src="https://<your-account>.github.io/<repo>/?embed=1#/overview?area=E12000002"
        width="100%" height="900" style="border:0" title="Refugee homelessness tracker"></iframe>
```

## Notes on the figures

- MHCLG rounds national and regional figures to the nearest 10. Local authority figures
  are not rounded.
- The tracker always uses the **latest revised** version of each quarter. MHCLG revises
  earlier quarters, so figures can differ from those in the first release.
- Suppressed (`[x]`) and missing values are shown as gaps, never as zero.
- Before April 2020 MHCLG published prevention and relief combined, so only totals are
  available for 2019-20.

## Changing things

- Author credit, link and footer text: `CONFIG` at the top of `docs/app.js`.
- Colours: CSS variables at the top of `docs/style.css`.
- How far back the data goes: `HL_START` and related settings in `pipeline/update_data.py`.
- Map boundaries after a local government reorganisation: edit `SERVICE` in
  `pipeline/fetch_boundaries.py` and run it once.
