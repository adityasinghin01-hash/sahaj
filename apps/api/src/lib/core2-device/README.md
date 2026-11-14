# Phone handover (C-12)

`POST /api/core2/device-status`: own authenticated family/person only. Body:
`{ battery_level: 0..100 | null, is_charging: boolean | null, sampled_at: ISO UTC }`.
Requires the usual bearer, family-selection and idempotency headers. `null` means
the device API is unavailable, never a fabricated zero. `GET` returns the own last
state, or `device_status: null`. Heartbeat uses server receipt time. Replays and
out-of-order samples do not refresh it.

Every report processes that person's pending handovers. The independent stale
processor is `POST /api/core2/device-status/tick`, authenticated by `X-Cron-Secret`
(`CRON_SECRET`), honoring `MAINTENANCE_KILL`. **The deployment's existing scheduler
must invoke this endpoint at least once a minute**, or invoke
`productionDeviceService().tick()` from its worker. For a scaled demo, invoke more
often than `180 * DEMO_TIMER_SCALE` seconds. No interval is started in a route.
The card's edit boundary excludes the shared cron route, so its scheduler wiring
is a lead integration step. A stopped client is not required to trigger this path.

Device writes and idempotency commit together. Jobs are unique per watch/SOS;
duplicate ticks complete under a row lock. Completion locks the source watch/SOS
and the family dispatch fence, rechecks contact/preference state, then commits
the Ed25519 timeline, existing outbox commands, dispatch fences and truth-line
rows together. A failed signature/storage step rolls everything back. No new
providers are called here. Delivery and acceptance remain unverified.

Maa's line contains no location. It says an approved contact notice was queued,
never claims that Priya is already in contact without acceptance evidence. A
new watch/SOS gets a new handover; repeated low reports and stale ticks for the
same watch/SOS do not send duplicates.
