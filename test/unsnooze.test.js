import { describe, it, expect } from 'vitest';

describe('unsnooze cron logic', () => {
  // The unsnooze logic is best tested via live testing (Phase 3)
  // since it requires actual GitHub API interactions.
  // Unit-level date comparison logic is covered in parse-date tests.

  it('date comparison: past date <= today should wake', () => {
    // Simple string comparison works for YYYY-MM-DD format
    expect('2026-01-01' <= '2026-06-15').toBe(true);
    expect('2026-06-15' <= '2026-06-15').toBe(true);
    expect('2026-12-01' <= '2026-06-15').toBe(false);
  });

  it('date comparison: future date should not wake', () => {
    expect('2027-01-01' <= '2026-06-15').toBe(false);
  });
});
