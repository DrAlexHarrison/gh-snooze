// Date expression parser for gh-snooze
// Parses snooze expressions like "15d", "3m2w", "2026-08", "+15d", "cancel"

const CANCEL_KEYWORDS = ['cancel', 'off', 'stop', 'break', 'end'];

const DAYS_PER_UNIT = { d: 1, w: 7, m: 30, y: 365 };

// Get "today" in the given timezone as a Date at midnight UTC
// representing that local date
export function todayInTimezone(timezone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(new Date());
  const y = parseInt(parts.find(p => p.type === 'year').value, 10);
  const m = parseInt(parts.find(p => p.type === 'month').value, 10);
  const d = parseInt(parts.find(p => p.type === 'day').value, 10);
  return new Date(Date.UTC(y, m - 1, d));
}

// Format a Date to YYYY-MM-DD (UTC components)
export function formatDate(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Format a Date to human-readable "Wednesday, August 5, 2026"
export function formatDateHuman(date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

// Days in a given month (1-indexed), accounting for leap years
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Clamp day to valid range for month
function clampDay(year, month, day) {
  const max = daysInMonth(year, month);
  return Math.min(day, max);
}

// Add whole-integer months using calendar arithmetic with clamping
function addMonths(date, months) {
  let y = date.getUTCFullYear();
  let m = date.getUTCMonth() + 1; // 1-indexed
  let d = date.getUTCDate();

  const totalMonths = (y * 12 + (m - 1)) + months;
  y = Math.floor(totalMonths / 12);
  m = (totalMonths % 12) + 1;
  if (m <= 0) { m += 12; y -= 1; }

  d = clampDay(y, m, d);
  return new Date(Date.UTC(y, m - 1, d));
}

// Add whole-integer years using calendar arithmetic with clamping
function addYears(date, years) {
  return addMonths(date, years * 12);
}

// Add days to a date
function addDays(date, days) {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

// Parse a number: integer, decimal, or fraction
function parseNumber(str) {
  str = str.trim();

  // Fraction: N/D
  const fracMatch = str.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (fracMatch) {
    const num = parseInt(fracMatch[1], 10);
    const den = parseInt(fracMatch[2], 10);
    if (den === 0) return null; // division by zero
    return num / den;
  }

  // Decimal (including leading dot like .6)
  if (/^\.?\d+(\.\d+)?$/.test(str) || /^\d+\.\d*$/.test(str)) {
    const val = parseFloat(str);
    if (isNaN(val)) return null;
    return val;
  }

  return null;
}

// Check if a number is effectively a whole integer
function isWholeInteger(n) {
  return Math.abs(n - Math.round(n)) < 1e-9;
}

// Apply a single duration to a date
// For whole integers: calendar arithmetic for m/y, day arithmetic for d/w
// For fractional: convert to days using fixed factors, ceil
function applyDuration(date, amount, unit, sign) {
  unit = unit.toLowerCase();
  const effectiveAmount = sign * amount;

  if (isWholeInteger(amount)) {
    const wholeAmount = Math.round(effectiveAmount);
    switch (unit) {
      case 'd': return addDays(date, wholeAmount);
      case 'w': return addDays(date, wholeAmount * 7);
      case 'm': return addMonths(date, wholeAmount);
      case 'y': return addYears(date, wholeAmount);
      default: return null;
    }
  }

  // Fractional: convert to days, ceil in magnitude direction
  const factor = DAYS_PER_UNIT[unit];
  if (factor === undefined) return null;
  const rawDays = amount * factor;
  const ceiledDays = Math.ceil(rawDays);
  return addDays(date, sign * ceiledDays);
}

// Tokenize the expression into structured tokens
function tokenize(expr) {
  const tokens = [];
  let i = 0;

  while (i < expr.length) {
    // Skip whitespace
    if (/\s/.test(expr[i])) { i++; continue; }

    // Operator: + or -
    if (expr[i] === '+' || expr[i] === '-') {
      tokens.push({ type: 'op', value: expr[i] });
      i++;
      continue;
    }

    // Number (possibly with fraction slash) + unit
    // Match: digits, optional dot/digits, optional /digits, then a unit letter
    // Also handles leading dot like .6m
    const numUnitMatch = expr.slice(i).match(
      /^(\d+\s*\/\s*\d+|\.?\d+(?:\.\d*)?|\d+\.?\d*)([dwmyDWMY])/
    );
    if (numUnitMatch) {
      const numStr = numUnitMatch[1];
      const unit = numUnitMatch[2].toLowerCase();
      const parsed = parseNumber(numStr);
      if (parsed === null) return null; // parse error (e.g., division by zero)
      tokens.push({ type: 'duration', amount: parsed, unit });
      i += numUnitMatch[0].length;
      continue;
    }

    // YYYY-MM-DD, YYYY-MM, or YYYY
    // Use word boundary / non-digit lookahead to avoid greedily consuming
    // digits that belong to a subsequent number+unit (e.g., "2028-200d")
    const dateMatch = expr.slice(i).match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/);
    if (dateMatch) {
      const afterDate = expr.slice(i + dateMatch[0].length);

      // If after the match there's a digit, the date regex was too greedy.
      // E.g., "2028-200d" matched "2028-20" leaving "0d".
      // In that case, only take the YYYY part if the rest makes sense.
      if (/^\d/.test(afterDate) && dateMatch[2]) {
        // The "month" part was actually part of a bigger number.
        // Re-parse as just YYYY (4 digits), rest stays for next iteration.
        const justYear = expr.slice(i).match(/^(\d{4})/);
        if (justYear) {
          const year = parseInt(justYear[1], 10);
          tokens.push({ type: 'date', year, month: null, day: null, raw: justYear[0] });
          i += justYear[0].length;
          continue;
        }
      }

      // Check this isn't actually a number+unit (e.g., "2028d")
      if (/^[dwmyDWMY]/.test(afterDate) && !dateMatch[2]) {
        // It's a number+unit like "2028d", not a year
        const bigNumMatch = expr.slice(i).match(/^(\d+)([dwmyDWMY])/);
        if (bigNumMatch) {
          tokens.push({ type: 'duration', amount: parseInt(bigNumMatch[1], 10), unit: bigNumMatch[2].toLowerCase() });
          i += bigNumMatch[0].length;
          continue;
        }
      }

      const year = parseInt(dateMatch[1], 10);
      const month = dateMatch[2] ? parseInt(dateMatch[2], 10) : null;
      const day = dateMatch[3] ? parseInt(dateMatch[3], 10) : null;
      tokens.push({ type: 'date', year, month, day, raw: dateMatch[0] });
      i += dateMatch[0].length;
      continue;
    }

    // Unrecognized character
    return null;
  }

  return tokens;
}

/**
 * Parse a snooze expression and compute the target date.
 *
 * @param {string} expression - The raw snooze expression (after "snooze:")
 * @param {string} timezone - IANA timezone (e.g., "America/Phoenix")
 * @param {string|null} existingSnoozeDate - Existing snooze date as YYYY-MM-DD, or null
 * @returns {{ type: string, date?: string, dateHuman?: string, error?: string }}
 *   type: "snooze" | "cancel" | "error"
 */
export function parseSnoozeExpression(expression, timezone, existingSnoozeDate = null) {
  const trimmed = (expression || '').trim();
  const today = todayInTimezone(timezone);
  const currentYear = today.getUTCFullYear();

  // Empty expression → default 7d
  if (!trimmed) {
    const target = addDays(today, 7);
    return { type: 'snooze', date: formatDate(target), dateHuman: formatDateHuman(target) };
  }

  // Cancel keywords
  if (CANCEL_KEYWORDS.includes(trimmed.toLowerCase())) {
    return { type: 'cancel' };
  }

  // Tokenize
  const tokens = tokenize(trimmed);
  if (tokens === null || tokens.length === 0) {
    return { type: 'error', error: trimmed };
  }

  // Determine structure: does it start with a date, an operator, or a duration?
  let baseDate;
  let startIdx = 0;
  let isRelative = false; // relative to existing snooze

  if (tokens[0].type === 'date') {
    // Absolute date
    const { year, month, day } = tokens[0];

    // Validate year range
    if (year < 2026 || year > currentYear + 5) {
      return { type: 'error', error: trimmed };
    }

    // Validate month
    if (month !== null && (month < 1 || month > 12)) {
      return { type: 'error', error: trimmed };
    }

    const m = month || 1;
    let d = day || 1;

    // Validate/clamp day
    if (day !== null) {
      if (day < 1) return { type: 'error', error: trimmed };
      // Clamp day overflow (e.g., Feb 29 in non-leap, Apr 31)
      d = clampDay(year, m, day);
    }

    baseDate = new Date(Date.UTC(year, m - 1, d));
    startIdx = 1;

  } else if (tokens[0].type === 'op') {
    // Leading +/- → relative to existing snooze
    isRelative = true;
    if (existingSnoozeDate) {
      const [y, m, d] = existingSnoozeDate.split('-').map(Number);
      baseDate = new Date(Date.UTC(y, m - 1, d));
    } else {
      baseDate = new Date(today.getTime());
    }
    // Don't consume the operator — the adjustment loop handles it
    startIdx = 0;

  } else if (tokens[0].type === 'duration') {
    // Bare duration → relative to NOW always
    baseDate = new Date(today.getTime());
    startIdx = 0;

  } else {
    return { type: 'error', error: trimmed };
  }

  // Process remaining tokens as adjustments
  let currentDate = baseDate;
  let currentSign = 1; // default sign for bare durations
  let expectingDuration = (tokens[startIdx]?.type === 'duration');

  for (let i = startIdx; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.type === 'op') {
      currentSign = token.value === '+' ? 1 : -1;
      expectingDuration = true;
      continue;
    }

    if (token.type === 'duration') {
      const result = applyDuration(currentDate, token.amount, token.unit, currentSign);
      if (result === null) return { type: 'error', error: trimmed };
      currentDate = result;
      // After processing a duration, reset sign to +1 for the next
      // bare duration in a chain (e.g., "3m2w" → +3m then +2w)
      // But if there was an explicit operator, the sign was already set
      if (!expectingDuration) {
        currentSign = 1;
      }
      expectingDuration = false;
      currentSign = 1; // reset for next duration in chain
      continue;
    }

    // Unexpected token type
    return { type: 'error', error: trimmed };
  }

  // If we ended expecting a duration after an operator, that's an error
  if (expectingDuration && startIdx < tokens.length && tokens[tokens.length - 1].type === 'op') {
    return { type: 'error', error: trimmed };
  }

  const dateStr = formatDate(currentDate);

  // Past date → cancel
  if (currentDate < today) {
    return {
      type: 'past',
      date: dateStr,
      dateHuman: formatDateHuman(currentDate),
    };
  }

  return {
    type: 'snooze',
    date: dateStr,
    dateHuman: formatDateHuman(currentDate),
  };
}
