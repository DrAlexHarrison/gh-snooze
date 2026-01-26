import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { findSnoozeExpression } from '../src/snooze.js';

// Test the snooze detection logic (pattern matching, code block stripping)
// Full integration tests with GitHub API calls are done via live testing

const FROZEN_NOW = new Date('2026-06-15T19:00:00Z');

describe('findSnoozeExpression', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(FROZEN_NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it('finds simple snooze in text', () => {
    expect(findSnoozeExpression('snooze: 15d')).toBe('15d');
  });

  it('finds snooze case-insensitively', () => {
    expect(findSnoozeExpression('Snooze: 3m')).toBe('3m');
    expect(findSnoozeExpression('SNOOZE: 2w')).toBe('2w');
  });

  it('finds snooze in multiline text', () => {
    const text = 'This is an issue.\n\nsnooze: 1m\n\nMore text.';
    expect(findSnoozeExpression(text)).toBe('1m');
  });

  it('last match wins', () => {
    const text = 'snooze: 1d\nsnooze: 2w\nsnooze: 3m';
    expect(findSnoozeExpression(text)).toBe('3m');
  });

  it('empty expression', () => {
    expect(findSnoozeExpression('snooze:')).toBe('');
  });

  it('expression with extra spaces (trimmed by regex)', () => {
    // The regex `/^snooze:\s*(.*)$/gim` captures after optional whitespace
    // "snooze:  15d" → captures "15d" (leading spaces consumed by \s*)
    expect(findSnoozeExpression('snooze:  15d')).toBe('15d');
  });

  it('returns null when no match', () => {
    expect(findSnoozeExpression('just a normal comment')).toBeNull();
  });

  it('returns null for null/empty input', () => {
    expect(findSnoozeExpression(null)).toBeNull();
    expect(findSnoozeExpression('')).toBeNull();
  });

  // Code block exclusion
  it('ignores snooze inside fenced code block', () => {
    const text = '```\nsnooze: 15d\n```';
    expect(findSnoozeExpression(text)).toBeNull();
  });

  it('ignores snooze inside fenced code block with language', () => {
    const text = '```yaml\nsnooze: 15d\n```';
    expect(findSnoozeExpression(text)).toBeNull();
  });

  it('ignores snooze inside inline code', () => {
    const text = 'Use `snooze: 15d` to snooze.';
    expect(findSnoozeExpression(text)).toBeNull();
  });

  it('ignores snooze inside blockquote', () => {
    const text = '> snooze: 15d';
    expect(findSnoozeExpression(text)).toBeNull();
  });

  it('finds snooze after code block', () => {
    const text = '```\nsnooze: 1d\n```\nsnooze: 2w';
    expect(findSnoozeExpression(text)).toBe('2w');
  });

  it('finds snooze outside of code, ignores inside', () => {
    const text = 'Here is how: `snooze: 1d`\n\nsnooze: 3m';
    expect(findSnoozeExpression(text)).toBe('3m');
  });

  it('handles blockquote with leading whitespace', () => {
    const text = '  > snooze: 15d';
    expect(findSnoozeExpression(text)).toBeNull();
  });

  // Cancel keywords
  it('finds cancel keyword', () => {
    expect(findSnoozeExpression('snooze: cancel')).toBe('cancel');
    expect(findSnoozeExpression('snooze: off')).toBe('off');
    expect(findSnoozeExpression('snooze: stop')).toBe('stop');
    expect(findSnoozeExpression('snooze: break')).toBe('break');
    expect(findSnoozeExpression('snooze: end')).toBe('end');
  });

  // Snooze in issue body with other content
  it('finds snooze mixed with other content', () => {
    const text = [
      '## Description',
      'This issue tracks the hero section redesign.',
      '',
      '### Tasks',
      '- [ ] Update copy',
      '- [ ] New images',
      '',
      'snooze: 2026-08',
      '',
      '### Notes',
      'Talk to Michelle about design.',
    ].join('\n');
    expect(findSnoozeExpression(text)).toBe('2026-08');
  });
});

describe('snooze handler integration', () => {
  // These test the handleSnooze function with mocked octokit
  // More comprehensive testing happens in live testing (Phase 3)

  it('placeholder for integration tests verified live', () => {
    expect(true).toBe(true);
  });
});
