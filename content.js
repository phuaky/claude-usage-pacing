// Claude Usage Pacing Tracker
// Reads each usage bar on https://claude.ai/settings/usage and overlays:
//  - a linear pace marker (where you should be right now)
//  - a status badge (Behind / On pace / Ahead)
//  - a budget hint (% left over remaining time = per-day rate)
//
// All times are interpreted in the user's local timezone.

(() => {
  const STYLE_ID = 'claude-usage-pacing-style';
  const MARK = 'data-cup-done'; // idempotency marker

  const WEEKDAY = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const MONTH = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      .cup-wrap { position: relative; }
      .cup-marker {
        position: absolute; top: -2px; bottom: -2px; width: 2px;
        background: #fff; box-shadow: 0 0 0 1px rgba(0,0,0,.6);
        pointer-events: none; z-index: 5;
      }
      .cup-marker::after {
        content: ''; position: absolute; left: -3px; top: -5px;
        border-left: 4px solid transparent; border-right: 4px solid transparent;
        border-top: 5px solid #fff;
      }
      .cup-badge {
        display: inline-block; margin-left: 8px;
        padding: 1px 6px; border-radius: 4px;
        font-size: 11px; font-weight: 600; letter-spacing: .2px;
        vertical-align: middle;
      }
      .cup-badge.green { background: #1f6f3a; color: #d7f5e0; }
      .cup-badge.amber { background: #7a5200; color: #ffe6a8; }
      .cup-badge.red   { background: #7a2a2a; color: #ffd0d0; }
      .cup-hint {
        margin-top: 4px; font-size: 11px; opacity: .75;
        font-variant-numeric: tabular-nums;
      }
    `;
    document.head.appendChild(s);
  }

  // --- Reset parsing ---------------------------------------------------------

  // "Resets in 1 hr 59 min" | "Resets in 45 min" | "Resets in 2 hr"
  function parseRelative(text, now) {
    const m = text.match(/Resets in\s+(?:(\d+)\s*hr)?\s*(?:(\d+)\s*min)?/i);
    if (!m || (!m[1] && !m[2])) return null;
    const h = parseInt(m[1] || '0', 10);
    const min = parseInt(m[2] || '0', 10);
    return { next: new Date(now.getTime() + (h * 60 + min) * 60_000), kind: 'session' };
  }

  // "Resets Fri 3:00 AM" | "Resets Sun 4:00 AM" | "Resets Fri 1:00 PM"
  function parseWeekday(text, now) {
    const m = text.match(/Resets\s+(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\w*\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!m) return null;
    const targetDow = WEEKDAY[m[1].slice(0, 3).toLowerCase()];
    let hour = parseInt(m[2], 10) % 12;
    if (m[4].toUpperCase() === 'PM') hour += 12;
    const minute = parseInt(m[3], 10);

    const next = new Date(now);
    next.setSeconds(0, 0);
    next.setHours(hour, minute, 0, 0);
    const dowDiff = (targetDow - next.getDay() + 7) % 7;
    next.setDate(next.getDate() + dowDiff);
    if (next <= now) next.setDate(next.getDate() + 7);
    return { next, kind: 'weekly' };
  }

  // "Resets May 1" | "Resets Oct 15"
  function parseMonthDay(text, now) {
    const m = text.match(/Resets\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+(\d{1,2})/i);
    if (!m) return null;
    const month = MONTH[m[1].slice(0, 3).toLowerCase()];
    const day = parseInt(m[2], 10);
    let year = now.getFullYear();
    let next = new Date(year, month, day, 0, 0, 0, 0);
    if (next <= now) next = new Date(year + 1, month, day, 0, 0, 0, 0);
    return { next, kind: 'monthly' };
  }

  function parseReset(text, now) {
    return parseRelative(text, now) || parseWeekday(text, now) || parseMonthDay(text, now);
  }

  function prevReset(reset, now) {
    const d = new Date(reset.next);
    if (reset.kind === 'weekly') d.setDate(d.getDate() - 7);
    else if (reset.kind === 'session') d.setHours(d.getHours() - 5); // Max plan session window
    else if (reset.kind === 'monthly') d.setMonth(d.getMonth() - 1);
    return d;
  }

  // --- Row discovery ---------------------------------------------------------

  function findUsageRows() {
    // Each row on /settings/usage contains a "Resets ..." node and a "% used" node.
    // Find all text nodes matching "Resets", then walk up to a container that also holds "% used"
    // or numeric bar.
    const results = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        return /Resets\s/.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const seenContainers = new Set();
    let node;
    while ((node = walker.nextNode())) {
      // Walk up to find a row container with the progress bar.
      let el = node.parentElement;
      for (let i = 0; i < 8 && el; i++, el = el.parentElement) {
        // Consider this a row if it contains both "Resets" text and either "% used" or a bar-like element.
        const txt = el.textContent || '';
        const hasReset = /Resets\s/.test(txt);
        const hasBar = el.querySelector('[role="progressbar"], [class*="progress"], [class*="Progress"]');
        const hasUsedPct = /\d+%\s*used/.test(txt);
        if (hasReset && (hasBar || hasUsedPct)) {
          if (!seenContainers.has(el)) {
            seenContainers.add(el);
            results.push(el);
          }
          break;
        }
      }
    }
    return results;
  }

  function getBarElement(row) {
    // Prefer an explicit progressbar ARIA role; fall back to a rectangular track with a filled child.
    let bar = row.querySelector('[role="progressbar"]');
    if (bar) return bar;
    const candidates = row.querySelectorAll('div');
    for (const c of candidates) {
      const cs = getComputedStyle(c);
      if (cs.position !== 'static' || cs.display === 'none') {
        const child = c.firstElementChild;
        if (child && /%$/.test(getComputedStyle(child).width || '')) return c;
      }
      const w = c.getBoundingClientRect();
      if (w.width > 120 && w.height >= 4 && w.height <= 14) {
        const childBG = cs.backgroundColor;
        if (childBG && childBG !== 'rgba(0, 0, 0, 0)') return c;
      }
    }
    return null;
  }

  function getUsedPct(row) {
    const txt = row.textContent || '';
    const m = txt.match(/(\d+)\s*%\s*used/i);
    if (m) return parseInt(m[1], 10);
    // Daily routine runs "0 / 15"
    const r = txt.match(/(\d+)\s*\/\s*(\d+)(?!\s*%)/);
    if (r) return Math.round((parseInt(r[1], 10) / parseInt(r[2], 10)) * 100);
    return null;
  }

  function getResetText(row) {
    const m = (row.textContent || '').match(/Resets[^\n]+/);
    return m ? m[0] : null;
  }

  // --- Formatting ------------------------------------------------------------

  function fmtRemaining(ms) {
    const totalMin = Math.max(0, Math.round(ms / 60_000));
    const d = Math.floor(totalMin / 1440);
    const h = Math.floor((totalMin % 1440) / 60);
    const m = totalMin % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function classify(delta) {
    // delta = used% - target%. Positive = ahead (burning too fast).
    if (delta > 10) return 'red';
    if (delta > 3) return 'amber';
    return 'green';
  }

  function statusLabel(delta) {
    if (delta > 10) return `Ahead +${delta.toFixed(0)}%`;
    if (delta > 3) return `Ahead +${delta.toFixed(0)}%`;
    if (delta < -3) return `Buffer ${delta.toFixed(0)}%`;
    return 'On pace';
  }

  // --- Render ----------------------------------------------------------------

  function renderRow(row, now) {
    const resetText = getResetText(row);
    const used = getUsedPct(row);
    if (resetText == null || used == null) return;
    const reset = parseReset(resetText, now);
    if (!reset) return;
    const prev = prevReset(reset, now);
    const total = reset.next - prev;
    const elapsed = Math.max(0, Math.min(1, (now - prev) / total));
    const targetPct = elapsed * 100;
    const remainingMs = reset.next - now;
    const deltaRemaining = Math.max(0, 100 - used);
    const remainingDays = remainingMs / 86_400_000;
    const perDay = remainingDays > 0 ? deltaRemaining / remainingDays : 0;

    // Remove old overlay so we re-render fresh values each pass.
    row.querySelectorAll('.cup-marker, .cup-badge, .cup-hint').forEach((n) => n.remove());

    const bar = getBarElement(row);
    if (bar && reset.kind !== 'session') {
      const wrapper = bar;
      wrapper.classList.add('cup-wrap');
      const marker = document.createElement('div');
      marker.className = 'cup-marker';
      marker.style.left = `${Math.min(100, Math.max(0, targetPct))}%`;
      marker.title = `Linear target: ${targetPct.toFixed(1)}%`;
      wrapper.appendChild(marker);
    }

    const delta = used - targetPct;

    // Badge goes next to the reset text.
    const resetNode = findTextNode(row, 'Resets');
    if (resetNode && resetNode.parentElement) {
      const badge = document.createElement('span');
      badge.className = `cup-badge ${classify(delta)}`;
      if (reset.kind === 'session') {
        badge.textContent = `${fmtRemaining(remainingMs)} left`;
      } else {
        badge.textContent = statusLabel(delta);
      }
      resetNode.parentElement.appendChild(badge);
    }

    // Hint line under the bar container.
    const hint = document.createElement('div');
    hint.className = 'cup-hint';
    if (reset.kind === 'session') {
      hint.textContent = `${used}% used · ${fmtRemaining(remainingMs)} until reset`;
    } else {
      const tgt = targetPct.toFixed(0);
      const rem = fmtRemaining(remainingMs);
      hint.textContent = `Target ${tgt}% · ${rem} left · budget ${perDay.toFixed(1)}%/day to hit 100%`;
    }
    (bar?.parentElement || row).appendChild(hint);
  }

  function findTextNode(root, needle) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue.includes(needle) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    return w.nextNode();
  }

  function renderAll() {
    injectStyles();
    const now = new Date();
    const rows = findUsageRows();
    rows.forEach((r) => renderRow(r, now));
  }

  // --- Boot ------------------------------------------------------------------

  // Kill any legacy overlay from v1 if present.
  document.querySelectorAll('[data-claude-usage-v1]').forEach((n) => n.remove());

  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      try { renderAll(); } catch (_) { /* ignore */ }
    });
  };

  const isOurs = (n) =>
    n.nodeType === 1 &&
    (n.classList?.contains('cup-marker') ||
      n.classList?.contains('cup-badge') ||
      n.classList?.contains('cup-hint') ||
      n.id === STYLE_ID);

  const start = () => {
    schedule();
    new MutationObserver((muts) => {
      // Ignore mutations caused solely by our own inserts/removes.
      for (const m of muts) {
        const added = Array.from(m.addedNodes);
        const removed = Array.from(m.removedNodes);
        if (added.some((n) => !isOurs(n)) || removed.some((n) => !isOurs(n))) {
          schedule();
          return;
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
    setInterval(schedule, 60_000);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
