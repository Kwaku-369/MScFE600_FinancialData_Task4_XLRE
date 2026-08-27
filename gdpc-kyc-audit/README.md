# GDPC KYC Alignment & Audit

A platform for Ghanaian rural and community banks that turns a customer extract
from any core banking system into a submission the Ghana Deposit Protection
Corporation portal will accept — and, in the same pass, audits every depositor
record against the Ghana Card held by the National Identification Authority.

The problem it solves is not really a file-format problem. A rural bank's export
is rejected by the GDPC portal because the columns are named differently, the
phone numbers lost their leading zeros in Excel, and half the Ghana Card numbers
were typed without hyphens. Fixing that is necessary but easy. The hard part is
underneath: the depositor registered at the branch in 2009 as *Kojo Mensa* is
recorded at the NIA as *Kwadwo Mensah*, and the same person's date of birth was
captured as `03/04/1985` by a clerk writing day-first into a spreadsheet a US
locale then read as 4 March. Both records are internally valid. Neither the
bank nor the portal will notice. In a payout, that depositor is not found.

This platform finds those cases, explains each one in terms an auditor can sign
off, and separates the ones it can fix on its own from the ones a person must
decide.

## What it does

1. **Reads whatever the bank sends.** `.xlsx` or `.csv`, with the bank's own
   column headings and the title banner branch staff put above them.
2. **Maps the columns onto the GDPC template.** Deterministically where the
   heading is recognised, and with an agent — shown sample values, not just
   headings — for the rest. Uncertain mappings are never applied silently.
3. **Normalises the values.** Ghana Card PINs to `GHA-000000000-0`, phone
   numbers to `+233XXXXXXXXX` (restoring the zero Excel ate), dates to ISO,
   amounts stripped of currency symbols, product codes to the template's
   vocabulary.
4. **Verifies each depositor against the NIA** through MetaMap's Ghana GovCheck.
5. **Audits.** Around fifty exception types across identity, name, date of
   birth, contact, account and cross-record checks, each with a severity, a
   disposition and written guidance.
6. **Produces two workbooks.** The aligned submission, colour-coded by what
   happened to each cell, and an audit report with a findings register, a
   before/after change ledger and a summary.

## The name matcher

This is the part that does not exist off the shelf, and it is why a generic
fuzzy-match library is not good enough.

Matching is **order-insensitive**, because the most common defect in rural-bank
data is a reordering — the branch captured `KWAME MENSAH ADU` where the card
reads `ADU KWAME MENSAH`. Those are the same person. The ordering still matters
for the upload, so it is reported separately from the identity verdict rather
than being conflated with it.

On top of that sit equivalence tables that encode how Ghanaian names actually
vary:

- **Akan day names.** Kwadwo/Kojo, Kwabena/Kobina, Kwaku/Kweku, Kwame/Kwamena,
  Kwasi/Kwesi, Yaw/Ekow, Kofi/Fiifi; Adwoa/Adjoa, Abena/Araba, Akua/Ekua,
  Afua/Afia/Efua, Akosua/Esi. These are not similar names — they are the same
  name, and a matcher that scores them near zero generates thousands of false
  "different person" exceptions.
- **Arabic transliteration.** Mohammed/Muhammad/Mahama, Abdul/Abdulai,
  Ibrahim/Braimah, Issah/Isa, Fuseini/Husseini.
- **A phonetic coder tuned for Ghanaian orthography** — the `KW`/`QU` and
  `DZ`/`DJ` onsets, doubled vowels carrying tone, the silent trailing `H` in
  Mensah/Mensa.
- **Diminutives** kept in a separate table scoring below a true equivalence, so
  Fred/Frederick stays reviewable rather than being waved through.

Every comparison returns a **token-by-token alignment with a reason code**, not
just a score. An auditor can see that `KOJO` matched `KWADWO` because they are
accepted renderings of one name — which is the difference between an audit trail
that survives a regulator's scrutiny and one that does not.

## Two findings about MetaMap that shaped the design

**The Ghana GovCheck is asynchronous.** `POST /govchecks/v1/gh/verify-card`
returns `202` with an empty body and delivers the NIA record to a callback URL
later. There is no synchronous read-back. So verification is modelled as a
queued job with a correlation token; a batch finalises itself when the last
callback lands, and can be forced to finalise early with outstanding lookups
reported as unverified rather than stalling indefinitely.

**MetaMap cannot trace a phone number to a Ghana Card.** Phone Risk returns
carrier, line type and a risk score. Phone Ownership sends an OTP, which needs
the depositor present. Neither yields an identity. What the platform does
instead is validate and normalise the number, attribute it to a network from the
NCA prefix allocations, detect filler values and numbers shared across unrelated
depositors, and flag the rest. A `PhoneIdentityProvider` interface is in place
so that a source which *can* do the reverse lookup — Ghanaian SIM registration
is tied to the Ghana Card — drops in later without touching the audit engine.

## Submission modes

- **Review** — every batch is held for an operator to work through in the back
  office before anything is published.
- **Direct** — the bank pushes straight through, and records publish
  automatically. Only those whose disposition is `clean` or `auto_corrected`.

The direct-mode gate keys on the **disposition**, not on a list of known
exception codes. That is deliberate, and it is the answer to the obvious worry
about running unattended: a rule added next year, or an exception nobody
anticipated, quarantines its record automatically. Nothing can slip through
because it was not on a list. The ceiling is configurable via
`DIRECT_PUBLISH_MAX_DISPOSITION`, and an unrecognised value falls back to the
*stricter* setting so a typo cannot widen what reaches the live view.

## Colour coding

The same five colours are used in the exported workbook and in the UI, so a
branch officer reads one explanation rather than two.

| Colour | Meaning |
|---|---|
| Green | Verified and unchanged. Nothing to do. |
| Blue | Auto-corrected deterministically — reformatting, name re-ordering, adopting the card's reading of a transposed date. Listed in the change ledger. |
| Amber | Needs review. A person must decide. |
| Orange | Conflict. The bank record and the Ghana Card disagree on something material. |
| Red | Rejected. Cannot be submitted as it stands. |
| Grey | A required field with no value supplied. |

## Agents

Three, all advisory:

- **Identity adjudicator** — takes the residue the rules cannot settle and
  decides whether two records describe the same person, briefed on Ghanaian
  naming conventions and instructed to defer rather than guess.
- **Column mapper** — places columns the deterministic mapper could not, judging
  by sample values as much as by heading.
- Recommendations are stored in `agent_reviews`, **separate from rule output**,
  so an auditor can always tell a model's judgement from a rule's. An agent
  never writes a value into a submission and never closes a finding.

## Architecture

```
apps/web      Vite + React UI, served as static assets by the Worker
apps/worker   Hono API on Cloudflare Workers, D1, R2, Queues
packages/core Domain engine — zero runtime dependencies on Cloudflare or Node
```

`packages/core` is deliberately runtime-free: the same code runs in the Worker,
in tests, and in a batch job, and produces byte-identical findings. That
reproducibility is what makes a past submission re-auditable months later.

The XLSX reader and writer are written directly against the OOXML format rather
than using SheetJS or ExcelJS, because those are Node-targeted and this has to
run in a Worker. Output is verified against `openpyxl`, not only against the
reader in this repo.

## The GDPC template caveat — read this

**The GDPC does not publish its depositor upload template openly.** The profile
in `packages/core/src/profiles/gdpc-scv-v1.ts` follows the standard four-table
Single Customer View layout (A depositor, B address, C account, D compensation),
with field names and types chosen to match what Ghanaian rural banks hold. It is
marked `1.0.0-draft` and carries a `provenance` string saying so.

**Replace it with the official template before any production submission.**
Nothing else needs to change: mapping, normalisation, audit and export all read
the profile rather than hard-coding columns, so correcting it is a config edit.
Bump the version and update `provenance` so an auditor can tell which template a
past submission was validated against.

The statutory coverage limits in `COVERAGE_LIMITS` should likewise be confirmed
against the prevailing Bank of Ghana directive.

## Getting started

```bash
npm install
npm test                     # 73 tests over the domain engine

# Local development
cd apps/worker
npx wrangler d1 migrations apply gdpc-kyc --local
echo "SESSION_SECRET=$(openssl rand -hex 32)" > .dev.vars
npx wrangler dev             # API on :8787

cd ../web && npm run dev     # UI on :5173, proxying /api to :8787
```

Then create the first administrator through the sign-in screen.

## Deploying to Cloudflare

```bash
# Create the resources
npx wrangler d1 create gdpc-kyc          # put the id in wrangler.toml
npx wrangler r2 bucket create gdpc-kyc-files
npx wrangler queues create gdpc-verify
npx wrangler queues create gdpc-verify-dlq

# Secrets — never in wrangler.toml
npx wrangler secret put SESSION_SECRET
npx wrangler secret put METAMAP_CLIENT_ID
npx wrangler secret put METAMAP_CLIENT_SECRET
npx wrangler secret put METAMAP_WEBHOOK_SECRET
npx wrangler secret put ANTHROPIC_API_KEY

npx wrangler d1 migrations apply gdpc-kyc --remote
cd ../web && npm run build && cd ../worker && npx wrangler deploy
```

Set `PUBLIC_BASE_URL` in `wrangler.toml` to the deployed origin — it is what the
MetaMap callback URL is built from, so verification results will not come back
if it is wrong. In the MetaMap dashboard, set the webhook secret to the same
value as `METAMAP_WEBHOOK_SECRET`; it must be at least 16 characters with an
upper-case letter, a lower-case letter and a digit.

The platform runs without MetaMap credentials — batches process and audit, with
every record reported as unverified rather than the run failing. It runs without
`ANTHROPIC_API_KEY` too; the agent endpoints return a clear error and everything
deterministic still works.

## Security

- Tenant isolation is enforced twice: the principal carries a fixed institution
  id, and every repository function takes one and puts it in the `WHERE` clause.
- Passwords use PBKDF2-SHA256 at 210,000 iterations (WebCrypto; Workers has no
  native argon2). Sessions are HMAC-signed and HttpOnly.
- The MetaMap webhook signature is verified with a constant-time comparison
  before the body is parsed — it is the only thing between a stranger and the
  ability to write an identity record.
- Login runs a password verification even for an unknown account, so a missing
  account and a wrong password cannot be told apart by timing.
- Negative verification results are cached for one day, not six months: a card
  not on file today may be tomorrow, and caching that would keep a depositor
  rejected long after they had fixed it.
- The audit log is append-only and records every state change.

## Status

The domain engine, the API, the verification pipeline and the UI are complete
and tested end to end against a live local Worker: upload, auto-mapping,
normalisation, audit, direct-mode publish gating, and both generated workbooks.

Not yet done: a reconciliation module (planned next), the B/C/D table flows
exercised only through the same generic pipeline as table A, and bulk
re-verification scheduling.
