# External Lek Mint outage monitor

This is an **inactive, opt-in** GitHub Actions monitor. Adding these files does not
configure GitHub, install secrets, enable monitoring, or send an email. Run it in
the private repository outside Start9 so a Start9 outage does not stop the checker.
The monitor only uses Node's built-in `fetch` and a standalone, pinned Nodemailer
dependency. No root dependencies are added.

## Behavior and limitations

- One HTTPS readiness request per execution, with a 15-second timeout and 16 KiB
  response limit. Redirects are rejected. HTTP success plus JSON
  `{"status":"ready","mode":"active"}` is required; a `release` field is permitted
  but not used. Standby, maintenance, invalid JSON, network failures and
  unsuccessful HTTP responses all count as failed checks.
- Two **consecutive observed failed checks** create an outage. There is one queued
  email per outage and one on the first observed recovery. Failed email attempts
  remain queued and retry on the next execution. If an outage recovers before its
  email can be delivered, both timestamped notifications remain queued in order.
- The state lives in a dedicated open GitHub issue, updated with `GITHUB_TOKEN`.
  It contains counters, timestamps and notification state only, never endpoint
  URLs, SMTP credentials, response bodies or errors. It is not an artifact/cache.
  A repository-wide workflow concurrency group prevents concurrent executions
  of this workflow. Do not run a second monitor against the same issue.
- The `*/5` schedule is **best-effort**, not a guaranteed five-minute service.
  GitHub can delay, skip or drop runs, especially during load. Concurrency may
  replace pending runs. A gap does not count as multiple failed checks. Detection
  normally takes two runs, but there is no guaranteed maximum detection time.
  Scheduled workflows run from the default branch.
- Private-repository Actions minutes depend on your account's current allowance
  and billing configuration; this is **not guaranteed free**. About 8,640 jobs
  per 30-day month at this cadence can consume significant minutes (including
  billed job rounding and dependency setup). Review GitHub billing/limits first.
  Mailgun pricing, SMTP domain verification and sending limits are separate.
- SMTP delivery and GitHub state updates cannot be one atomic transaction.
  Before sending, a durable `sending` marker is stored. If the process crashes
  or storage fails after delivery, subsequent runs **fail closed** rather than
  repeatedly emailing. Operator intervention is required as described below.
  An SMTP error can itself be ambiguous (e.g. timeout after server acceptance),
  so retrying a failed send may duplicate mail. Exactly-once delivery cannot be
  guaranteed with SMTP. Sustained healthy/unhealthy runs do not generate new
  emails unless the observed incident state changes.
- Configuration/storage failures fail the job rather than masquerading as mint
  outages. No email is possible when SMTP configuration is missing. Watch failed
  Actions runs using GitHub's own workflow notifications. An unmonitored disabled
  scheduler or exhausted allowance cannot report its own failure.
- This is application-readiness monitoring, not a full mint transaction test.
  Endpoint queries, URL credentials, remote bodies and raw SMTP errors are never
  logged or included in mail. Treat the configured URL as secret anyway.

## Manual setup (nothing here has been activated)

1. Ensure the readiness endpoint is deployed to the **active production mint**.
   Use its HTTPS `/api/readyz` URL, not Replit standby. The URL must not include
   `user:password@host` or a fragment. If query authentication is necessary, put
   the entire URL in a secret; it will not be included in the state issue or mail.
2. In your private repository, ensure Issues and Actions are enabled and policies
   permit `GITHUB_TOKEN` to write issues. No personal access token is required.
   The workflow requests only `contents: read` and `issues: write`.
3. With monitoring **disabled**, create one dedicated open issue. Its entire body
   must be the following; the title can be “Lek Mint monitor state”:

   ````text
   Lek Mint outage monitor state v1 — do not edit while enabled

   ```json
   {
     "version": 1,
     "failures": 0,
     "outage": false,
     "incidentStartedAt": null,
     "lastCheckAt": null,
     "queue": []
   }
   ```
   ````

   You can generate this body locally (no network) with:

   ```sh
   node --input-type=module -e 'import {initialState,encodeState} from "./ops/monitor/monitor.mjs"; console.log(encodeState(initialState()))'
   ```

4. Add these **GitHub repository Actions secrets separately**. Existing Replit or
   Start9 secrets are not automatically available to GitHub; do not commit them:

   | Secret | Required value |
   | --- | --- |
   | `MINT_MONITOR_URL` | Production HTTPS readiness URL |
   | `MAILGUN_SMTP_USER` | Mailgun domain SMTP username |
   | `MAILGUN_SMTP_PASS` | Mailgun domain SMTP password |

5. Set these **repository Actions variables**:

   | Variable | Value / default |
   | --- | --- |
   | `MINT_MONITOR_STATE_ISSUE` | Required dedicated issue number |
   | `MINT_MONITOR_ENABLED` | Set exactly `true` only when ready to activate |
   | `MINT_MONITOR_FROM` | Verified sender; default `monitor@lekmint.cash` |
   | `MINT_MONITOR_TO` | Default `info@lekmint.cash` |
   | `MINT_MONITOR_SMTP_HOST` | Default `smtp.mailgun.org`; use your Mailgun region's SMTP host if needed |
   | `MINT_MONITOR_SMTP_PORT` | Default `587` (STARTTLS required); `465` for implicit TLS |

   Defaults do not imply that the sender or Mailgun domain is verified. Verify
   sender/domain and recipient permissions (including sandbox restrictions) in
   your Mailgun account.
6. Merge the workflow onto the default branch after review. When you deliberately
   enable monitoring, you may run `workflow_dispatch` to check setup, then inspect
   the job result and issue state. **This can send real mail** if an event is
   queued. Both manual and scheduled executions are gated by the enabled variable.

## State repair and operating safely

Do not delete, close or edit the state issue while enabled. Missing, malformed,
closed or inaccessible state fails the job; the monitor will **not** automatically
recreate/reset it and risk repeated outage alerts. State writes are retried up to
three times for transient GitHub failures; a failed write fails the workflow.

For repair, set `MINT_MONITOR_ENABLED` to `false`, then wait for any in-flight run
to finish. Inspect the issue edit history and Mailgun delivery records:

- Restore lost/corrupt state from the last known valid issue body/history. Do not
  initialize a fresh issue during an ongoing outage unless you knowingly accept
  losing deduplication history.
- A queue entry with `status: "sending"` is an ambiguous delivery. If delivery is
  confirmed, remove that entry. If confirmed not delivered, change its status to
  `queued`. If uncertain, explicitly decide whether a potential duplicate or a
  potential missed notification is acceptable. Do not reset other counters.
- Re-enable only once the JSON is valid and records the intended incident state.
  The queue is capped at 100 events to bound state size. If mail is broken long
  enough to fill it, repair SMTP and review pending events before re-enabling.

Never store secrets in this issue, even in a private repository. Restrict repository
write access: anyone able to change monitor code, variables, or state can affect
alerting. Do not reuse the concurrency group for independent monitors.

## Local tests (no emails, GitHub or endpoint requests)

Requires Node 22. Tests inject readiness, SMTP and GitHub mocks; no install needed:

```sh
node --test ops/monitor/monitor.test.mjs
# or
npm --prefix ops/monitor test
```

For a deliberate production run only, install the isolated dependency:

```sh
npm install --prefix ops/monitor --ignore-scripts --no-package-lock --no-audit --no-fund
# Supply required environment configuration via your secret manager first.
node ops/monitor/run.mjs
```

The last command makes live requests and may send emails; it is **not** a test.
The workflow uses that same isolated install, not the root workspace installer.