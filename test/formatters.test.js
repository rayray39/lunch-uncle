import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatForecast,
  formatBusArrivals,
  haversineMetres,
} from "../src/tools.js";
import { formatSingaporeTime, buildSystemPrompt } from "../src/prompt.js";

test("formatForecast picks the requested area", () => {
  const payload = {
    data: {
      items: [
        {
          valid_period: { text: "12 pm to 2 pm" },
          forecasts: [
            { area: "Geylang", forecast: "Fair" },
            { area: "Kallang", forecast: "Light Rain" },
          ],
        },
      ],
    },
  };

  assert.deepEqual(formatForecast(payload, "Kallang"), {
    area: "Kallang",
    forecast: "Light Rain",
    valid_period: "12 pm to 2 pm",
  });
});

test("formatBusArrivals converts durations to whole minutes", () => {
  const payload = {
    services: [
      {
        no: "13",
        next: { duration_ms: 100_798 },
        subsequent: { duration_ms: 1_210_000 },
      },
      { no: "107M", next: { duration_ms: 30_000 }, subsequent: null },
    ],
  };

  assert.deepEqual(formatBusArrivals(payload, "07371"), {
    stop_code: "07371",
    services: [
      { service: "13", next_min: 2, subsequent_min: 20 },
      { service: "107M", next_min: 1, subsequent_min: null },
    ],
  });
});

test("haversineMetres measures CT Hub 2 to Lavender MRT at under 600 m", () => {
  const ctHub2 = { latitude: 1.3115, longitude: 103.8615 };
  const lavenderMrt = { latitude: 1.3073, longitude: 103.8631 };
  const distance = haversineMetres(ctHub2, lavenderMrt);
  assert.ok(distance > 400 && distance < 550, `got ${distance}`);
});

test("formatSingaporeTime renders lunchtime, not the UTC hour", () => {
  // 04:30 UTC is 12:30 pm in Singapore: peak lunch, not pre-dawn.
  const noon = new Date("2026-10-02T04:30:00.000Z");
  assert.equal(formatSingaporeTime(noon), "Friday, 2 Oct 2026, 12:30 pm");
});

test("formatSingaporeTime keeps the right day before 8am", () => {
  // 17:00 UTC on Friday is already 1am Saturday in Singapore. Rendering this
  // in UTC reports both the wrong time and the wrong day of the week.
  const pastMidnight = new Date("2026-10-02T17:00:00.000Z");
  assert.equal(
    formatSingaporeTime(pastMidnight),
    "Saturday, 3 Oct 2026, 1:00 am",
  );
});

test("buildSystemPrompt states the Singapore time and no UTC timestamp", () => {
  const prompt = buildSystemPrompt(new Date("2026-10-02T04:30:00.000Z"));
  assert.match(
    prompt,
    /The current time in Singapore is Friday, 2 Oct 2026, 12:30 pm\./,
  );
  assert.doesNotMatch(prompt, /\d{4}-\d{2}-\d{2}T/, "leaked an ISO timestamp");
});
