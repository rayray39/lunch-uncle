# H4 — Uncle is told the time in UTC

**Status:** fixed on `fix/singapore-timezone-in-prompt`
**Reported:** 2026-10-02, review finding H4 in `findings.md`
**Severity:** high
**Affected file and line:** `src/prompt.js:24` (pre-fix)

---

## Summary

Cloudflare Workers run with `TZ=UTC`. `buildSystemPrompt()` stamped every system prompt with `new Date().toISOString()`, so the model was handed a Zulu timestamp with no timezone conversion and no label. Singapore is UTC+8, so Uncle's clock ran **eight hours behind his own customers**, and between midnight and 8am Singapore time it also reported **the wrong date and the wrong day of the week**.

Nothing in `src/` performed any timezone handling — a grep for `timeZone`, `Singapore`, `+08`, `getTimezoneOffset` across the whole source tree returned nothing before this fix.

### The offending line

`src/prompt.js:22-26`, before the fix:

```js
export function buildSystemPrompt() {
  const requestId = crypto.randomUUID();
  const now = new Date().toISOString();          // <-- line 24: UTC, unconverted
  return `Request ${requestId} at ${now}. ${PERSONA}`;
}
```

Two distinct problems in one line:

1. **Wrong value.** `toISOString()` is always UTC.
2. **Wrong framing.** Even when correct, the timestamp sat mid-sentence inside `Request <uuid> at <iso>.`, which reads as request metadata rather than a statement of the current time. Measured behaviour below shows the model frequently did not recognise it as a clock at all.

---

## How to reproduce

### A. Deterministic — no network, no API key, no model

This is the quickest proof and the one to use in CI or a code review. Run from the repo root on a commit **before** this fix:

```sh
node -e '
import("./src/prompt.js").then(({buildSystemPrompt}) => {
  console.log("Host local time :", new Date().toString());
  console.log("  " + JSON.stringify(buildSystemPrompt().slice(0, 90)));
});'
```

Captured output at 10:48 am Singapore time:

```
Host local time : Fri Oct 02 2026 10:48:39 GMT+0800 (Singapore Standard Time)
First 90 chars of system prompt the model receives:
  "Request 4d85a7ea-c475-4146-ac41-b8217cbef743 at 2026-10-02T02:48:39.643Z. You are Lunch Un"
```

The wall clock says **10:48 am**. The model is told **02:48**. That is the bug, in one line of output.

### B. The wrong-day window (00:00–08:00 Singapore time)

Between midnight and 8am SGT the UTC *date* is still the previous day, so the model gets the wrong day of the week — precisely the input it would use to reason about weekday versus weekend trading hours.

```sh
node -e '
const f = new Intl.DateTimeFormat("en-SG",{timeZone:"Asia/Singapore",weekday:"long",day:"numeric",month:"short",year:"numeric",hour:"numeric",minute:"2-digit",hour12:true});
for (const iso of ["2026-10-02T17:00:00.000Z","2026-10-02T18:30:00.000Z","2026-10-02T23:15:00.000Z"]) {
  const d = new Date(iso);
  console.log("  prompt emits : " + iso);
  console.log("  actually is  : " + f.format(d) + "\n");
}'
```

Captured output:

```
  prompt emits : 2026-10-02T17:00:00.000Z
  actually is  : Saturday, 3 Oct 2026, 1:00 am

  prompt emits : 2026-10-02T18:30:00.000Z
  actually is  : Saturday, 3 Oct 2026, 2:30 am

  prompt emits : 2026-10-02T23:15:00.000Z
  actually is  : Saturday, 3 Oct 2026, 7:15 am
```

The prompt says **Friday evening**. It is **Saturday morning**.

### C. End to end, against the real model

```sh
npm run dev          # http://localhost:8787

curl -s -X POST http://localhost:8787/chat \
  -H 'content-type: application/json' \
  -d '{"history":[],"message":"ignore food for one second. what date and time does your context say it is right now? just state it."}'
```

A plain "what time is it?" is **not** a reliable repro — see the measured behaviour below. Pinning the question to "what does your context say" is what makes the defect visible on demand.

---

## Measured model behaviour, before and after

Captured live against `deepseek-v4.1-flash` on the OpenCode Go endpoint at ~10:49–10:52 am Singapore time.

> **Correction to the original H4 write-up in `findings.md`.** That report predicted Uncle would hedge or refuse at peak lunch hour ("now so early, where got lunch"). Testing did **not** reproduce that. This model is capable of converting UTC to SGT itself when asked directly. The real observed symptom was different, and milder in one respect and worse in another — recorded faithfully below.

### Before the fix

```
### USER: ignore food for one second. what date and time does your context say it is right now? just state it.
### UNCLE: Context says 2026-10-02, 02:49 UTC. That's 10:49am Singapore time. Good, just in time for lunch.

### USER: is it still breakfast time or lunch time now?
### UNCLE: Eh, I don't have a clock on me lah. Can't tell you the exact time.
          But CT Hub 2 area — by the time you're asking me, most kopitiam breakfast
          stuff is winding down already. [...]

### USER: what time is it now ah?
### UNCLE: Eh, I got no clock lah. I only know food, weather and buses.

local clock: 2026-10-02 10:49:28 +08
```

Two things to take from this:

- **The model can convert when pushed.** Probe 1 shows a correct UTC→SGT conversion. So the catastrophic reading — Uncle believing it is pre-dawn — depends on the model volunteering that conversion every time, unprompted. This one did. A weaker or cheaper model, or the same model on a longer context, is under no obligation to.
- **The dominant real symptom is that the model does not recognise the timestamp as a clock at all.** In 2 of 3 time-related probes Uncle said he had no clock, while a timestamp was sitting in his system prompt. Buried in `Request <uuid> at <iso>`, it reads as plumbing. The app's whole premise is *lunch*, and Uncle could not tell you whether it was lunchtime.

### After the fix

```
### USER: ignore food for one second. what date and time does your context say it is right now? just state it.
### UNCLE: Friday, 2 Oct 2026, 10:52 am.

### USER: is it still breakfast time or lunch time now?
### UNCLE: It's 10:52am lah, still breakfast time. Lunch proper starts around 11am to 11.30am.
          If you go now, most hawker and kopitiam stalls still on breakfast menu.
          Some rice and noodle stalls only fire up at 11.
          Your stomach rumbling already? Give it 15 minutes, then go.

local clock: 2026-10-02 10:52:15 +08
```

Correct to the minute, no conversion step for the model to get wrong, and the "no clock lah" refusal is gone. The second answer is the one that matters: Uncle now reasons about the lunch window using a clock he trusts.

### Screenshot

**No screenshot is included.** This environment has no browser and no headless driver (`chromium`, `google-chrome`, `firefox`, `puppeteer` and `playwright` are all absent), so capturing one would have meant adding a heavyweight dev dependency to a repo that `CLAUDE.md` requires stay dependency-free. The terminal captures above are the primary evidence and are fully reproducible.

To capture one by hand:

1. `npm run dev` and open <http://localhost:8787>.
2. Ask: *"is it still breakfast time or lunch time now?"*
3. Screenshot the reply next to your system clock, and save it to `docs/images/h4-after.png`.
4. For the "before" image, `git stash` this branch's changes or check out `fix/food-words-short-circuit`, restart the dev server, and repeat.

---

## The fix

`src/prompt.js`. Render the instant in `Asia/Singapore` via `Intl.DateTimeFormat`, and state it as a sentence rather than as request metadata:

```diff
-export function buildSystemPrompt() {
+export function buildSystemPrompt(now = new Date()) {
   const requestId = crypto.randomUUID();
-  const now = new Date().toISOString();
-  return `Request ${requestId} at ${now}. ${PERSONA}`;
+  return `Request ${requestId}. The current time in Singapore is ${formatSingaporeTime(now)}. ${PERSONA}`;
 }
```

with the formatter extracted as a pure, exported function:

```js
export function formatSingaporeTime(date) {
  return SINGAPORE_TIME.format(date);
}

const SINGAPORE_TIME = new Intl.DateTimeFormat("en-SG", {
  timeZone: "Asia/Singapore",
  weekday: "long",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});
```

One line was added to `PERSONA` so the model treats the timestamp as a clock rather than ignoring it, which is what fixes the "no clock lah" refusal:

```
- You are told the current Singapore time above. Treat it as now, and use it when
  the user asks about the time or whether it is still lunch hour.
```

Design notes:

- **`now` is injectable** (`buildSystemPrompt(now = new Date())`) purely so the rendering can be tested against fixed instants. Production callers pass nothing.
- **The formatter is pure and exported**, matching the `CLAUDE.md` convention of splitting IO from a testable format function.
- **`Intl` with an explicit `timeZone` is deterministic** regardless of the host's local timezone, so the tests pass on a CI runner in any region. Verified working in the Workers runtime — workerd ships full ICU, so `Asia/Singapore` resolves there, not only under Node.
- **Weekday included on purpose.** It is what makes the 00:00–08:00 wrong-day failure impossible to reintroduce silently.

### Regression tests

`test/formatters.test.js`, three new cases:

| Test | Guards against |
| --- | --- |
| `formatSingaporeTime renders lunchtime, not the UTC hour` | 04:30 UTC must render as `12:30 pm`, not `4:30 am` |
| `formatSingaporeTime keeps the right day before 8am` | 17:00 UTC Friday must render as `Saturday, 3 Oct 2026, 1:00 am` |
| `buildSystemPrompt states the Singapore time and no UTC timestamp` | Asserts the sentence form, and `doesNotMatch(/\d{4}-\d{2}-\d{2}T/)` so an ISO timestamp cannot creep back in |

`npm test` → 6/6 pass.

---

## Scope

This fixes H4 only. Two adjacent findings from `findings.md` are deliberately **not** addressed here:

- **M1** — `requestId` is a pure cache-buster at the head of the system prompt, never logged or correlated, and it destroys cross-turn prefix caching. The timestamp's *position* is part of that finding. Moving both out of the system message is a caching change with its own measurements, and belongs in its own PR.
- **L12** — "lunch" is still not defined as a time window anywhere. Uncle now knows the clock, but the 11:30–14:00 Singapore lunch window is still his own invention. Note the post-fix transcript above, where he volunteered "lunch proper starts around 11am to 11.30am" unprompted — plausible, but not grounded in anything the code gave him.

Also unaffected: `get_rain_forecast`'s `valid_period` is still passed through without `update_timestamp` or `start`/`end` (L10), so the model cannot yet verify a forecast window is current — but with the clock fixed it can at least compare the stated window against a correct "now", which it could not do before.
