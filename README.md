# gh-snooze

Snooze GitHub issues until a future date. When the date arrives, the issue wakes up automatically.

## How it works

1. Comment `snooze: 15d` on any issue (or put it in the issue body)
2. The action adds a `snoozed` label and posts a confirmation comment
3. A daily cron job checks all snoozed issues and wakes up any that are past due

## Setup

Add `.github/workflows/snooze.yml` to your repo:

```yaml
name: Issue Snooze
on:
  issues:
    types: [opened, edited, unlabeled, closed]
  issue_comment:
    types: [created, edited]

permissions:
  issues: write

jobs:
  snooze:
    runs-on: ubuntu-latest
    steps:
      - uses: DrAlexHarrison/gh-snooze@v1
        with:
          timezone: America/Phoenix
```

## Syntax Reference

| Expression | Result |
|---|---|
| `snooze: 15d` | 15 days from now |
| `snooze: 3m2w` | 3 months + 2 weeks from now |
| `snooze: 0.5m` | Half a month (15 days) from now |
| `snooze: 2/3y` | Two-thirds of a year (244 days) from now |
| `snooze: 2026-08` | August 1, 2026 |
| `snooze: 2026-01-15+6m` | January 15 plus 6 months |
| `snooze: +2w` | Extend current snooze by 2 weeks |
| `snooze: cancel` | Cancel snooze (also: `off`, `stop`, `break`, `end`) |
| `snooze:` | (empty) Snooze for 7 days |

### Units

- `d` — days
- `w` — weeks (7 days)
- `m` — months (calendar arithmetic for whole numbers, 30 days for fractions)
- `y` — years (calendar arithmetic for whole numbers, 365 days for fractions)

### Relative adjustments

- `15d` — always from **now** (fresh snooze)
- `+15d` — from **existing snooze date** (falls back to now if none)
- `-3m` — subtract from existing snooze date

### Decimals and fractions

Supported: `0.5w`, `.6m`, `1.5m`, `2/3y`, `1/4m`. Fractional values are converted to days and rounded up (ceiling).

## Behavior

- Snooze patterns inside code blocks, inline code, or blockquotes are ignored
- Multiple `snooze:` patterns in one comment → last one wins
- Comments accumulate (audit trail)
- Only posts when state actually changes (no duplicate comments)
- Closing a snoozed issue cancels the snooze
- Reopening does NOT renew a cancelled snooze
- Manually removing the `snoozed` label cancels the snooze

## License

MIT
