import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseSnoozeExpression, todayInTimezone, formatDate } from '../src/parse-date.js';

// Helper: freeze "today" to a known date for deterministic tests
// We'll mock todayInTimezone indirectly by testing with a fixed reference
const TZ = 'America/Phoenix';

// For most tests we need a deterministic "now".
// We'll freeze Date to 2026-06-15 (a Monday) in MST (UTC-7).
// todayInTimezone('America/Phoenix') at 2026-06-15T12:00:00Z → 2026-06-15
const FROZEN_NOW = new Date('2026-06-15T19:00:00Z'); // noon MST = 19:00 UTC

function freezeDate() {
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_NOW);
}

function unfreezeDate() {
  vi.useRealTimers();
}

// Shorthand
function parse(expr, existing = null) {
  return parseSnoozeExpression(expr, TZ, existing);
}

describe('parse-date', () => {
  beforeEach(() => freezeDate());
  afterEach(() => unfreezeDate());

  // ── Empty expression ──
  describe('empty expression → default 7d', () => {
    it('empty string', () => {
      const r = parse('');
      expect(r.type).toBe('snooze');
      expect(r.date).toBe('2026-06-22');
    });

    it('whitespace only', () => {
      const r = parse('   ');
      expect(r.type).toBe('snooze');
      expect(r.date).toBe('2026-06-22');
    });

    it('newline only', () => {
      const r = parse('\n');
      expect(r.type).toBe('snooze');
      expect(r.date).toBe('2026-06-22');
    });

    it('null', () => {
      const r = parse(null);
      expect(r.type).toBe('snooze');
      expect(r.date).toBe('2026-06-22');
    });
  });

  // ── Cancel keywords ──
  describe('cancel keywords', () => {
    for (const kw of ['cancel', 'CANCEL', 'Cancel', 'off', 'Off', 'OFF', 'stop', 'STOP', 'break', 'BREAK', 'end', 'END']) {
      it(`"${kw}" → cancel`, () => {
        expect(parse(kw).type).toBe('cancel');
      });
    }
  });

  // ── Simple durations from now ──
  describe('simple durations from now', () => {
    it('15d → now + 15 days', () => {
      const r = parse('15d');
      expect(r.type).toBe('snooze');
      expect(r.date).toBe('2026-06-30');
    });

    it('3m → now + 3 months (calendar)', () => {
      const r = parse('3m');
      expect(r.date).toBe('2026-09-15');
    });

    it('2w → now + 14 days', () => {
      const r = parse('2w');
      expect(r.date).toBe('2026-06-29');
    });

    it('1y → now + 1 year', () => {
      const r = parse('1y');
      expect(r.date).toBe('2027-06-15');
    });

    it('1d → tomorrow', () => {
      const r = parse('1d');
      expect(r.date).toBe('2026-06-16');
    });
  });

  // ── Compound durations ──
  describe('compound durations', () => {
    it('3m2w → now + 3 months + 14 days', () => {
      const r = parse('3m2w');
      expect(r.date).toBe('2026-09-29');
    });

    it('1y6m → now + 1 year + 6 months', () => {
      const r = parse('1y6m');
      expect(r.date).toBe('2027-12-15');
    });

    it('2w3d → now + 14 + 3 = 17 days', () => {
      const r = parse('2w3d');
      expect(r.date).toBe('2026-07-02');
    });
  });

  // ── Decimals ──
  describe('decimal durations', () => {
    it('0.5w → 3.5 → ceil 4 days', () => {
      const r = parse('0.5w');
      expect(r.date).toBe('2026-06-19'); // +4 days
    });

    it('.6m → 0.6 × 30 = 18 days', () => {
      const r = parse('.6m');
      expect(r.date).toBe('2026-07-03'); // +18 days
    });

    it('1.5m → 1.5 × 30 = 45 days', () => {
      const r = parse('1.5m');
      expect(r.date).toBe('2026-07-30'); // +45 days
    });

    it('0.5d → 0.5 × 1 = 0.5 → ceil 1 day', () => {
      const r = parse('0.5d');
      expect(r.date).toBe('2026-06-16'); // +1 day
    });
  });

  // ── Fractions ──
  describe('fraction durations', () => {
    it('2/3y → 0.6667 × 365 = 243.3 → ceil 244 days', () => {
      const r = parse('2/3y');
      expect(r.date).toBe('2027-02-14'); // June 15 + 244 days
    });

    it('1/4m → 0.25 × 30 = 7.5 → ceil 8 days', () => {
      const r = parse('1/4m');
      expect(r.date).toBe('2026-06-23'); // +8 days
    });

    it('1/2w → 0.5 × 7 = 3.5 → ceil 4 days', () => {
      const r = parse('1/2w');
      expect(r.date).toBe('2026-06-19'); // +4 days
    });

    it('1/0y → division by zero → error', () => {
      const r = parse('1/0y');
      expect(r.type).toBe('error');
    });
  });

  // ── Whole-number fractions use calendar arithmetic ──
  describe('whole-number fractions', () => {
    it('2/2m → 1m calendar arithmetic', () => {
      const r = parse('2/2m');
      expect(r.date).toBe('2026-07-15');
    });

    it('3/1m → 3m calendar arithmetic', () => {
      const r = parse('3/1m');
      expect(r.date).toBe('2026-09-15');
    });
  });

  // ── Absolute dates ──
  describe('absolute dates', () => {
    it('2026-08 → August 1, 2026', () => {
      const r = parse('2026-08');
      expect(r.type).toBe('snooze');
      expect(r.date).toBe('2026-08-01');
    });

    it('2027 → January 1, 2027', () => {
      const r = parse('2027');
      expect(r.type).toBe('snooze');
      expect(r.date).toBe('2027-01-01');
    });

    it('2026-08-15 → exact date', () => {
      const r = parse('2026-08-15');
      expect(r.date).toBe('2026-08-15');
    });

    it('2026-06-15 → today (valid, wakes tomorrow at cron)', () => {
      const r = parse('2026-06-15');
      expect(r.type).toBe('snooze');
      expect(r.date).toBe('2026-06-15');
    });
  });

  // ── Absolute + arithmetic ──
  describe('absolute dates with adjustments', () => {
    it('2026-01-15+6m → 2026-07-15', () => {
      const r = parse('2026-01-15+6m');
      expect(r.date).toBe('2026-07-15');
    });

    it('2026-01-31+1m → Feb 28 (clamped)', () => {
      const r = parse('2026-01-31+1m');
      expect(r.date).toBe('2026-02-28');
    });

    it('2026-01-31+3m → Apr 30 (clamped)', () => {
      const r = parse('2026-01-31+3m');
      expect(r.date).toBe('2026-04-30');
    });

    it('2027+3m2w → 2027-04-15', () => {
      const r = parse('2027+3m2w');
      expect(r.date).toBe('2027-04-15');
    });

    it('2028-200d → 2027-06-15', () => {
      const r = parse('2028-200d');
      // 2028-01-01 minus 200 days = 2027-06-15
      expect(r.date).toBe('2027-06-15');
    });
  });

  // ── Relative to existing snooze ──
  describe('relative adjustments (+/-)', () => {
    it('+15d with existing snooze Aug 5 → Aug 20', () => {
      const r = parse('+15d', '2026-08-05');
      expect(r.type).toBe('snooze');
      expect(r.date).toBe('2026-08-20');
    });

    it('+15d with no existing snooze → now + 15d', () => {
      const r = parse('+15d', null);
      expect(r.date).toBe('2026-06-30');
    });

    it('-3m with existing snooze Aug 5 → May 5', () => {
      const r = parse('-3m', '2026-08-05');
      // Aug 5 - 3m = May 5 — but May 5 is in the past (today is June 15)
      expect(r.type).toBe('past');
      expect(r.date).toBe('2026-05-05');
    });

    it('+6m-1w+3d from existing Aug 5', () => {
      const r = parse('+6m-1w+3d', '2026-08-05');
      // Aug 5 + 6m = Feb 5, 2027; - 7d = Jan 29; + 3d = Feb 1
      expect(r.date).toBe('2027-02-01');
    });

    it('-0.5w from existing Aug 5 → Aug 5 - 4 days = Aug 1', () => {
      const r = parse('-0.5w', '2026-08-05');
      expect(r.date).toBe('2026-08-01');
    });
  });

  // ── Month/year clamping ──
  describe('month/year clamping', () => {
    it('Jan 31 + 1m → Feb 28 (non-leap)', () => {
      const r = parse('2026-01-31+1m');
      expect(r.date).toBe('2026-02-28');
    });

    it('Jan 31 + 1m → Feb 29 (leap year 2028)', () => {
      const r = parse('2028-01-31+1m');
      expect(r.date).toBe('2028-02-29');
    });

    it('Jan 30 + 1m → Feb 28 (non-leap)', () => {
      const r = parse('2026-01-30+1m');
      expect(r.date).toBe('2026-02-28');
    });

    it('Mar 31 - 1m → Feb 28', () => {
      const r = parse('2026-03-31-1m');
      expect(r.date).toBe('2026-02-28');
    });

    it('Feb 29 (leap) + 1y → Feb 28 (non-leap)', () => {
      const r = parse('2028-02-29+1y');
      expect(r.date).toBe('2029-02-28');
    });
  });

  // ── Day-overflow clamping in explicit dates ──
  describe('day-overflow clamping', () => {
    it('2026-02-29 (non-leap) → Feb 28', () => {
      const r = parse('2026-02-29');
      expect(r.type).toBe('past'); // Feb 28, 2026 is in the past (today June 15)
      expect(r.date).toBe('2026-02-28');
    });

    it('2026-04-31 → Apr 30', () => {
      const r = parse('2026-04-31');
      expect(r.type).toBe('past'); // Apr 30, 2026 is past
      expect(r.date).toBe('2026-04-30');
    });

    it('2027-02-30 → Feb 28', () => {
      const r = parse('2027-02-30');
      expect(r.date).toBe('2027-02-28');
    });

    it('2028-02-30 → Feb 29 (leap)', () => {
      const r = parse('2028-02-30');
      expect(r.date).toBe('2028-02-29');
    });
  });

  // ── Whitespace tolerance ──
  describe('whitespace handling', () => {
    it('3m 2w → same as 3m2w', () => {
      const r = parse('3m 2w');
      expect(r.date).toBe('2026-09-29');
    });

    it('2026-01-15 +6m → same as 2026-01-15+6m', () => {
      const r = parse('2026-01-15 +6m');
      expect(r.date).toBe('2026-07-15');
    });

    it('2026-01-15 + 6m → same as 2026-01-15+6m', () => {
      const r = parse('2026-01-15 + 6m');
      expect(r.date).toBe('2026-07-15');
    });

    it('+ 15d → same as +15d', () => {
      const r = parse('+ 15d', '2026-08-05');
      expect(r.date).toBe('2026-08-20');
    });

    it('+ 3m 2w → same as +3m2w', () => {
      const r = parse('+ 3m 2w', '2026-08-05');
      // Aug 5 + 3m = Nov 5; + 14d = Nov 19
      expect(r.date).toBe('2026-11-19');
    });

    it('3m  2w (double space) → same as 3m2w', () => {
      const r = parse('3m  2w');
      expect(r.date).toBe('2026-09-29');
    });
  });

  // ── Past date computation ──
  describe('past dates → cancel/past', () => {
    it('2025-01-01 → year out of range error', () => {
      const r = parse('2025-01-01');
      expect(r.type).toBe('error');
    });

    it('2026-01-01 → past date', () => {
      const r = parse('2026-01-01');
      expect(r.type).toBe('past');
      expect(r.date).toBe('2026-01-01');
    });

    it('2026-06-14 → past (yesterday)', () => {
      const r = parse('2026-06-14');
      expect(r.type).toBe('past');
    });
  });

  // ── Date precedence ──
  describe('date precedence', () => {
    it('2026-03 → March 1 (YYYY-MM, not subtraction)', () => {
      const r = parse('2026-03');
      expect(r.type).toBe('past');
      expect(r.date).toBe('2026-03-01');
    });

    it('2028d → 2028 days (number + unit)', () => {
      const r = parse('2028d');
      // 2026-06-15 + 2028 days ≈ 2032-01-06
      expect(r.type).toBe('snooze');
      const d = new Date('2026-06-15T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 2028);
      expect(r.date).toBe(formatDate(d));
    });
  });

  // ── Invalid expressions ──
  describe('invalid expressions', () => {
    it('3x → error', () => {
      expect(parse('3x').type).toBe('error');
    });

    it('abc → error', () => {
      expect(parse('abc').type).toBe('error');
    });

    it('2026-13 → invalid month → error', () => {
      expect(parse('2026-13').type).toBe('error');
    });

    it('2026-00-01 → invalid month → error', () => {
      expect(parse('2026-00-01').type).toBe('error');
    });

    it('3h → error (hours not supported)', () => {
      expect(parse('3h').type).toBe('error');
    });

    it('3x2q → error', () => {
      expect(parse('3x2q').type).toBe('error');
    });
  });

  // ── Year range validation ──
  describe('year range', () => {
    it('2025 → error (< 2026)', () => {
      expect(parse('2025').type).toBe('error');
    });

    it('2026 → valid (but past if before today)', () => {
      const r = parse('2026');
      // 2026-01-01 is in the past (today is June 15)
      expect(r.type).toBe('past');
    });

    it('current_year + 5 → valid', () => {
      const r = parse('2031');
      expect(r.type).toBe('snooze');
      expect(r.date).toBe('2031-01-01');
    });

    it('current_year + 6 → error', () => {
      expect(parse('2032').type).toBe('error');
    });
  });

  // ── Timezone ──
  describe('timezone', () => {
    it('todayInTimezone returns correct date for America/Phoenix', () => {
      const today = todayInTimezone('America/Phoenix');
      expect(formatDate(today)).toBe('2026-06-15');
    });
  });

  // ── Negative fractions ──
  describe('negative fractions', () => {
    it('-0.5w from existing → minus 4 days', () => {
      const r = parse('-0.5w', '2026-08-05');
      expect(r.date).toBe('2026-08-01');
    });

    it('-2/3y from existing far future', () => {
      const r = parse('-2/3y', '2028-06-15');
      // 2028-06-15 - 244 days = 2027-10-14
      expect(r.type).toBe('snooze');
      const d = new Date('2028-06-15T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - 244);
      expect(r.date).toBe(formatDate(d));
    });
  });

  // ── Edge: today is valid ──
  describe('edge: today', () => {
    it('2026-06-15 → snooze (today is valid, wakes tomorrow)', () => {
      const r = parse('2026-06-15');
      expect(r.type).toBe('snooze');
      expect(r.date).toBe('2026-06-15');
    });
  });

  // ── Worked examples from plan ──
  describe('worked examples from plan', () => {
    it('"" → 2026-06-22', () => {
      expect(parse('').date).toBe('2026-06-22');
    });

    it('"15d" → 2026-06-30', () => {
      expect(parse('15d').date).toBe('2026-06-30');
    });

    it('"3m2w" → 2026-09-29', () => {
      expect(parse('3m2w').date).toBe('2026-09-29');
    });

    it('"0.5w" → +4d = 2026-06-19', () => {
      expect(parse('0.5w').date).toBe('2026-06-19');
    });

    it('".6m" → +18d = 2026-07-03', () => {
      expect(parse('.6m').date).toBe('2026-07-03');
    });

    it('"2/3y" → +244d = 2027-02-14', () => {
      expect(parse('2/3y').date).toBe('2027-02-14');
    });

    it('"1.5m" → +45d = 2026-07-30', () => {
      expect(parse('1.5m').date).toBe('2026-07-30');
    });

    it('"2026-08" → 2026-08-01', () => {
      expect(parse('2026-08').date).toBe('2026-08-01');
    });

    it('"2027" → 2027-01-01', () => {
      expect(parse('2027').date).toBe('2027-01-01');
    });

    it('"2026-01-15+6m" → 2026-07-15', () => {
      expect(parse('2026-01-15+6m').date).toBe('2026-07-15');
    });

    it('"2026-01-31+1m" → 2026-02-28', () => {
      expect(parse('2026-01-31+1m').date).toBe('2026-02-28');
    });

    it('"2026-01-31+3m" → 2026-04-30', () => {
      expect(parse('2026-01-31+3m').date).toBe('2026-04-30');
    });

    it('"2027+3m2w" → 2027-04-15', () => {
      expect(parse('2027+3m2w').date).toBe('2027-04-15');
    });

    it('"2028-200d" → 2027-06-15', () => {
      expect(parse('2028-200d').date).toBe('2027-06-15');
    });

    it('"+15d" (snooze=Aug 5) → 2026-08-20', () => {
      expect(parse('+15d', '2026-08-05').date).toBe('2026-08-20');
    });

    it('"+15d" (no snooze) → 2026-06-30', () => {
      expect(parse('+15d', null).date).toBe('2026-06-30');
    });

    it('"-3m" (snooze=Aug 5) → 2026-05-05 (past)', () => {
      const r = parse('-3m', '2026-08-05');
      expect(r.type).toBe('past');
      expect(r.date).toBe('2026-05-05');
    });

    it('"+6m-1w+3d" (snooze=Aug 5) → 2027-02-01', () => {
      expect(parse('+6m-1w+3d', '2026-08-05').date).toBe('2027-02-01');
    });

    it('"-0.5w" (snooze=Aug 5) → 2026-08-01', () => {
      expect(parse('-0.5w', '2026-08-05').date).toBe('2026-08-01');
    });

    it('"cancel" → cancel', () => {
      expect(parse('cancel').type).toBe('cancel');
    });

    it('"off" → cancel', () => {
      expect(parse('off').type).toBe('cancel');
    });

    it('"stop" → cancel', () => {
      expect(parse('stop').type).toBe('cancel');
    });
  });
});
