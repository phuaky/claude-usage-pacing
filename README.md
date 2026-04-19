# Claude Usage Pacing

A tiny Chrome extension that overlays linear-pace targets on your `claude.ai/settings/usage` page so you can see, at a glance, whether you are ahead or behind on each limit — All models, Sonnet, Design, spend, session — in your **local time**.

![demo](https://placehold.co/600x100?text=Overlay+shows+on+claude.ai/settings/usage)

## What it adds

For every limit row on the usage page:

- **Pace marker** — a thin vertical line on the bar at where you *should* be right now if you used your quota linearly until reset.
- **Status badge** — `On pace`, `Buffer -X%`, or `Ahead +X%` (colour-coded green / amber / red).
- **Budget hint** — e.g. `Target 45% · 3d 19h left · budget 19.8%/day to hit 100%`.

Reset detection handles all formats Claude currently shows:

- `Resets in 1 hr 59 min` (5-hour session window)
- `Resets Fri 3:00 AM` / `Resets Sun 4:00 AM` (weekly)
- `Resets May 1` (monthly spend)

All times are parsed in the browser's local timezone.

## Install

1. Clone or download this repo.
2. Open `chrome://extensions`, toggle **Developer mode** on.
3. Click **Load unpacked** and pick this folder.
4. Visit `https://claude.ai/settings/usage` — the overlay appears automatically.

## How the pacing math works

```
prev_reset  = next_reset - cycle_length   (7 days / 5 hours / 1 month)
elapsed_pct = (now - prev_reset) / (next_reset - prev_reset) * 100
delta       = used_pct - elapsed_pct      (positive → burning too fast)
budget/day  = (100 - used_pct) / days_remaining
```

Linear pacing means: if you want to land at exactly 100% usage at reset, your used-% should track time-% all the way there. The marker is time-%; the filled bar is used-%. Keep the filled bar at or behind the marker.

## Files

- `manifest.json` — MV3 manifest, matches `claude.ai/settings/usage`.
- `content.js` — everything: parsing, math, rendering, MutationObserver.

No background service worker, no storage, no network calls.

## License

MIT.
