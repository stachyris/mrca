# Most Recent Common Advisor

> [!NOTE]
> **Built entirely by Claude.** All code in this repository was written by Claude (Anthropic) through conversation alone; Vinay did not write any of it. This CSV-driven version was built by Claude Opus 5.5 (`claude-opus-5-5`) in October 2026, starting from an earlier single-page version that Claude also generated.

An interactive academic genealogy of evolutionary biology, genetics and ornithology: who trained whom, who worked together, and who argued. Built as a study aid for a PhD general exam.

The page code is fixed; the network comes from one spreadsheet, `data/people.csv`. Edit the CSV and the site updates.

## Updating the network

- **On GitHub:** open `data/people.csv`, click the pencil icon, edit, and commit. GitHub Pages republishes within a minute or two.
- **In a spreadsheet:** open the CSV in Excel, Numbers or Google Sheets, edit, export as CSV, and replace the file.
- **Preview without saving:** on the site, click **Load CSV** (or drop a file onto the page). Nothing is saved; reload to return to the repository's data.

The panel on the right lists problems in the data, such as an advisor id with no matching row.

## Columns

| Column | Required | Contents |
|---|---|---|
| `id` | yes | Short unique key, e.g. `edwards_s`. Used by the relationship columns. |
| `name` | yes | Full name. |
| `label` | no | Short name drawn on the graph. Defaults to the last word of `name`. |
| `years` | no | e.g. `1904-2005` or `1955-`. |
| `era` | no | One of the era ids in `config.json`. A new id gets a default color. |
| `institution`, `field` | no | Shown under the name. |
| `desc` | no | Short biography. |
| `contributions` | no | Separated by semicolons. Shown as tags and included in search. |
| `advisors` | no | Ids of this person's advisors, separated by semicolons. Draws an arrow from advisor to student. |
| `collaborators` | no | Ids, separated by semicolons. Listing a pair on one side is enough. |
| `opposition` | no | Ids of intellectual opponents, separated by semicolons. |

Any other column you add (e.g. `key_papers`, `exam_notes`) appears in the person's panel under its own heading.

## Configuration

`config.json` sets the title, the data file and the era names and colors. `data` can be any CSV URL the browser can fetch, such as a Google Sheet published to the web as CSV. You can also load one temporarily with `?data=<url>` on the site's address.

## Running locally

Browsers won't let a page opened straight from disk read the CSV, so serve the folder:

```sh
python3 -m http.server
```

then open <http://localhost:8000>.
