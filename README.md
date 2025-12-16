# vag-hooks

Express + Prisma webhook collector and cashout dashboard.

## Manual backfill (single master script)

Use `scripts/masterBackfillCsv.ts` to re-upload missing/incorrect webhook data from a CSV export in a guided, repeatable way.

What it does:
- Prompts for `year`, `month`, `day(s)`, CSV directory + filename
- Groups CSV rows by America/New_York day
- For each selected day:
	- Deletes existing `WebhookEvent` rows for that day
	- Inserts “manual” `WebhookEvent` rows using a Vagaro-like JSON wrapper

### Prereqs

- `DATABASE_URL` must be set to your Railway Postgres connection string.
	- You can put it in `.env` locally, or use Railway environment variables.

### Run (dry-run first)

```powershell
npx tsx scripts/masterBackfillCsv.ts
```

The script will ask whether to run in dry-run mode. Dry-run does not delete/insert.

### CSV expectations

CSV column names vary by export. The script currently tries common headers like:
- Dates/times: `date`, `transaction date`, `created date`
- Amounts: `cash`, `cash amount`, `cc`, `credit card`, `total`, `total amount`

If your export uses different headers, tell me the exact header row and I’ll map them.