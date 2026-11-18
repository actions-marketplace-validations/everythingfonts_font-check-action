# Everything Fonts Font Check

A GitHub Action that checks the fonts in your repository with [Everything Fonts](https://everythingfonts.com) Font Health. Each font gets a score, a band (healthy, needs attention, unhealthy), counts of errors, warnings and notes, and a link to the full report. Results go to the job summary, to annotations and, on pull requests, to one comment that is updated on each run.

## Get a free CI key

Create a CI key at <https://everythingfonts.com/dashboard/subscriptions> and save it as a repository secret named `EVERYTHINGFONTS_CI_KEY` (Settings, Secrets and variables, Actions).

## Usage

```yaml
- uses: everythingfonts/font-check-action@v1
  with:
    api-key: ${{ secrets.EVERYTHINGFONTS_CI_KEY }}
```

A complete workflow to copy:

```yaml
name: Font Check

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  pull-requests: write

jobs:
  font-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: everythingfonts/font-check-action@v1
        with:
          api-key: ${{ secrets.EVERYTHINGFONTS_CI_KEY }}
```

Pushes run only on the default branch (`main` here; change it to yours), so feature-branch pushes do not upload the same fonts again before their pull request does.

`pull-requests: write` is only needed for the pull request comment. Without it the Action warns and carries on. `changed-only` also reads the pull request's file list through `github-token`; if that list cannot be read, the Action warns and checks every matched font.

The Action treats `pull_request_target` like `pull_request` (changed files and comment on by default).

The comment is found by a hidden marker and a bot author, so the default `github-token` updates one comment in place. With a personal access token the comment's author is not a bot, and each run posts a new comment.

## Inputs

| Input | Default | Description |
|---|---|---|
| `api-key` | required | Your Everything Fonts API key. Store it as a secret. |
| `paths` | `**/*.{ttf,otf,woff,woff2}` and `!**/node_modules/**` | Glob patterns of the fonts to check, one per line or comma-separated. A pattern starting with `!` excludes. Patterns are case-sensitive: the default does not match `FONT.TTF`. |
| `changed-only` | `true` on `pull_request` and `pull_request_target`, otherwise `false` | Check only the fonts changed in the pull request. |
| `fail-below` | off | Fail the job when a font scores below this number (0 to 100). |
| `fail-on` | `error` | Fail on findings of this severity or worse: `error`, `warning` or `none`. Based on the full finding counts. |
| `comment` | `true` on `pull_request` and `pull_request_target`, otherwise `false` | Post the results as a pull request comment. |
| `fail-on-quota` | `false` | Fail the job when your allowance or upload limit is used up. Otherwise it is a warning and the job passes. |
| `github-token` | `${{ github.token }}` | Used to list changed files and to post the comment. |
| `api-url` | `https://font.rest/api/v1` | Base URL of the Everything Fonts API. Must be `https` (plain `http` only for `localhost` and `127.0.0.1`). Empty uses the default. |
| `timeout-minutes` | `10` | Overall time to wait for inspections. When it runs out the job fails and says so. |

## Outputs

| Output | Description |
|---|---|
| `results` | JSON array with one entry per font: `file`, `score`, `band`, `counts` (`error`, `warning`, `info`, `pass`), `report_url`, and `error` when a font could not be checked. |
| `failed` | `true` when the check failed, otherwise `false`. |

## Pull requests from forks

GitHub does not give secrets to workflows triggered by pull requests from forks. In that case `api-key` is empty and the Action skips the check with a notice instead of failing.

## Limits

The free CI key allows:

- 100 checks a month
- 10 MB per font
- 300 uploads a month
- summary results only (score, band, counts and the top findings; the full report is behind the report link)

Every upload counts toward the 300 a month, even when the font is unchanged and its inspection is reused.

When a limit is reached the Action prints a warning and the job passes, unless `fail-on-quota` is `true`. A font over 10 MB is not uploaded: it is skipped with the same kind of warning. For higher limits, see the plans at <https://everythingfonts.com/api>. API outages (server errors or no connection) fail the step; re-run the job.

## Privacy

Fonts are uploaded to Everything Fonts and kept according to its retention policy. Your repository is identified only by a SHA-256 hash of its name, never the name itself. The API key is masked and never logged.

## Licence

MIT. See [LICENSE](LICENSE).
