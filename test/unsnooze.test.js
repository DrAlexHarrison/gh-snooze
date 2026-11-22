import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { unsnoozeRepo } from '../src/unsnooze.js';

// Frozen "now": 2026-06-15 noon in America/Phoenix (UTC-7), so the
// Phoenix date is 2026-06-15.
const FROZEN_NOW = new Date('2026-06-15T19:00:00Z');
const BOT = 'github-actions[bot]';
const FULL = 'octo/demo';
const TZ = 'America/Phoenix';

function botComment(body) {
  return { user: { login: BOT }, body };
}
function humanComment(body) {
  return { user: { login: 'alice' }, body };
}
function snoozeComment(date) {
  return botComment(`🔕 **Snoozed until someday** (${date})\n\n<!-- snooze-until: ${date} -->`);
}
function openIssue(number) {
  return { number, state: 'open', labels: ['snoozed'] };
}

// In-memory stand-in for the GitHub issues API behind a mocked Octokit.
// listForRepo honors the state and labels filters and page slicing, like
// the real API. paginate loops pages until a short page comes back.
function mockOctokit({
  issues = [],
  commentsByIssue = new Map(),
  failCommentsFor = new Set(),
  failCreateFor = new Set(),
  removeLabelError = null,
} = {}) {
  function pageSlice(rows, per_page, page) {
    const start = (page - 1) * per_page;
    return rows.slice(start, start + per_page);
  }
  const listForRepo = vi.fn(async ({ labels, state, per_page = 30, page = 1 }) => {
    const rows = issues.filter((i) =>
      (state === undefined || i.state === state) &&
      (!labels || i.labels.includes(labels)));
    return { data: pageSlice(rows, per_page, page) };
  });
  const listComments = vi.fn(async ({ issue_number, per_page = 30, page = 1 }) => {
    if (failCommentsFor.has(issue_number)) {
      const err = new Error('Not Found');
      err.status = 404;
      throw err;
    }
    return { data: pageSlice(commentsByIssue.get(issue_number) ?? [], per_page, page) };
  });
  const paginate = vi.fn(async (fn, params) => {
    const per_page = params.per_page ?? 100;
    const all = [];
    for (let page = 1; ; page++) {
      const { data } = await fn({ ...params, per_page, page });
      all.push(...data);
      if (data.length < per_page) break;
    }
    return all;
  });
  const removeLabel = vi.fn(async () => {
    if (removeLabelError) throw removeLabelError;
    return {};
  });
  const createComment = vi.fn(async ({ issue_number }) => {
    if (failCreateFor.has(issue_number)) {
      const err = new Error('Not Found');
      err.status = 404;
      throw err;
    }
    return {};
  });
  return {
    paginate,
    rest: { issues: { listForRepo, listComments, removeLabel, createComment } },
  };
}

describe('unsnoozeRepo (cron scan of one repo)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('wakes an issue whose snooze date has passed: removes label and posts a wake comment', async () => {
    const octokit = mockOctokit({
      issues: [openIssue(1)],
      commentsByIssue: new Map([[1, [snoozeComment('2026-06-01')]]]),
    });
    const stats = await unsnoozeRepo(octokit, FULL, TZ);
    expect(stats).toEqual({ processed: 1, woken: 1, skipped: 0 });
    expect(octokit.rest.issues.removeLabel).toHaveBeenCalledWith({
      owner: 'octo', repo: 'demo', issue_number: 1, name: 'snoozed',
    });
    const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
    expect(body).toContain('Snooze ended');
    expect(body).toContain('Was snoozed until 2026-06-01');
  });

  it('wakes an issue whose snooze date is today', async () => {
    const octokit = mockOctokit({
      issues: [openIssue(1)],
      commentsByIssue: new Map([[1, [snoozeComment('2026-06-15')]]]),
    });
    const stats = await unsnoozeRepo(octokit, FULL, TZ);
    expect(stats.woken).toBe(1);
  });

  it('leaves an issue snoozed until tomorrow untouched', async () => {
    const octokit = mockOctokit({
      issues: [openIssue(1)],
      commentsByIssue: new Map([[1, [snoozeComment('2026-06-16')]]]),
    });
    const stats = await unsnoozeRepo(octokit, FULL, TZ);
    expect(stats).toEqual({ processed: 1, woken: 0, skipped: 0 });
    expect(octokit.rest.issues.removeLabel).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('only scans open issues carrying the snoozed label, so a closed snoozed issue is never woken', async () => {
    const closed = { number: 2, state: 'closed', labels: ['snoozed'] };
    const unlabeled = { number: 3, state: 'open', labels: [] };
    const octokit = mockOctokit({
      issues: [openIssue(1), closed, unlabeled],
      commentsByIssue: new Map([
        [1, [snoozeComment('2026-06-01')]],
        [2, [snoozeComment('2026-06-01')]],
        [3, [snoozeComment('2026-06-01')]],
      ]),
    });
    const stats = await unsnoozeRepo(octokit, FULL, TZ);
    const params = octokit.rest.issues.listForRepo.mock.calls[0][0];
    expect(params).toMatchObject({ owner: 'octo', repo: 'demo', state: 'open', labels: 'snoozed' });
    expect(stats).toEqual({ processed: 1, woken: 1, skipped: 0 });
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(octokit.rest.issues.createComment.mock.calls[0][0].issue_number).toBe(1);
  });

  it('skips an issue with no bot snooze date and warns', async () => {
    const octokit = mockOctokit({
      issues: [openIssue(1)],
      commentsByIssue: new Map([[1, [humanComment('snooze: 15d')]]]),
    });
    const stats = await unsnoozeRepo(octokit, FULL, TZ);
    expect(stats).toEqual({ processed: 1, woken: 0, skipped: 1 });
    expect(console.warn).toHaveBeenCalled();
    expect(octokit.rest.issues.removeLabel).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('ignores a machine date marker forged in a human comment', async () => {
    const octokit = mockOctokit({
      issues: [openIssue(1)],
      commentsByIssue: new Map([[1, [humanComment('<!-- snooze-until: 2026-06-01 -->')]]]),
    });
    const stats = await unsnoozeRepo(octokit, FULL, TZ);
    expect(stats).toEqual({ processed: 1, woken: 0, skipped: 1 });
  });

  it('lets the newest bot snooze date govern: a later extension keeps the issue asleep', async () => {
    const octokit = mockOctokit({
      issues: [openIssue(1)],
      commentsByIssue: new Map([[1, [snoozeComment('2026-06-01'), snoozeComment('2026-12-01')]]]),
    });
    const stats = await unsnoozeRepo(octokit, FULL, TZ);
    expect(stats.woken).toBe(0);
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('lets the newest bot snooze date govern: a later shortening wakes the issue', async () => {
    const octokit = mockOctokit({
      issues: [openIssue(1)],
      commentsByIssue: new Map([[1, [snoozeComment('2026-12-01'), snoozeComment('2026-06-01')]]]),
    });
    const stats = await unsnoozeRepo(octokit, FULL, TZ);
    expect(stats.woken).toBe(1);
    const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
    expect(body).toContain('Was snoozed until 2026-06-01');
  });

  it('does not wake an issue whose snooze was cancelled, even if the label is still present', async () => {
    const cancelled = botComment('🔔 **Snooze cancelled.** This issue is now active.\n\n_Was snoozed until 2026-06-01_');
    const octokit = mockOctokit({
      issues: [openIssue(1)],
      commentsByIssue: new Map([[1, [snoozeComment('2026-06-01'), cancelled]]]),
    });
    const stats = await unsnoozeRepo(octokit, FULL, TZ);
    expect(stats).toEqual({ processed: 1, woken: 0, skipped: 1 });
    expect(octokit.rest.issues.removeLabel).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('skips a malformed date of 2026-02-30 instead of waking on string order', async () => {
    const octokit = mockOctokit({
      issues: [openIssue(1)],
      commentsByIssue: new Map([[1, [snoozeComment('2026-02-30')]]]),
    });
    const stats = await unsnoozeRepo(octokit, FULL, TZ);
    expect(stats).toEqual({ processed: 1, woken: 0, skipped: 1 });
    expect(console.warn).toHaveBeenCalled();
    expect(octokit.rest.issues.removeLabel).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('skips a malformed date of 2026-13-45 instead of leaving it stuck silently', async () => {
    const octokit = mockOctokit({
      issues: [openIssue(1)],
      commentsByIssue: new Map([[1, [snoozeComment('2026-13-45')]]]),
    });
    const stats = await unsnoozeRepo(octokit, FULL, TZ);
    expect(stats).toEqual({ processed: 1, woken: 0, skipped: 1 });
    expect(console.warn).toHaveBeenCalled();
  });

  it('skips a marker whose value is not a date at all', async () => {
    const octokit = mockOctokit({
      issues: [openIssue(1)],
      commentsByIssue: new Map([[1, [botComment('🔕 **Snoozed**\n\n<!-- snooze-until: soon -->')]]]),
    });
    const stats = await unsnoozeRepo(octokit, FULL, TZ);
    expect(stats).toEqual({ processed: 1, woken: 0, skipped: 1 });
  });

  it('keeps scanning after an issue deleted mid-scan (comments return 404)', async () => {
    const octokit = mockOctokit({
      issues: [openIssue(1), openIssue(2)],
      commentsByIssue: new Map([[2, [snoozeComment('2026-06-01')]]]),
      failCommentsFor: new Set([1]),
    });
    const stats = await unsnoozeRepo(octokit, FULL, TZ);
    expect(stats).toEqual({ processed: 2, woken: 1, skipped: 1 });
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(octokit.rest.issues.createComment.mock.calls[0][0].issue_number).toBe(2);
  });

  it('keeps scanning after the wake comment fails for one issue', async () => {
    const octokit = mockOctokit({
      issues: [openIssue(1), openIssue(2)],
      commentsByIssue: new Map([
        [1, [snoozeComment('2026-06-01')]],
        [2, [snoozeComment('2026-06-01')]],
      ]),
      failCreateFor: new Set([1]),
    });
    const stats = await unsnoozeRepo(octokit, FULL, TZ);
    expect(stats.processed).toBe(2);
    expect(stats.woken).toBe(1);
    expect(octokit.rest.issues.createComment.mock.calls.at(-1)[0].issue_number).toBe(2);
  });

  it('still posts the wake comment when removing the label fails (already removed)', async () => {
    const err = new Error('Label does not exist');
    err.status = 404;
    const octokit = mockOctokit({
      issues: [openIssue(1)],
      commentsByIssue: new Map([[1, [snoozeComment('2026-06-01')]]]),
      removeLabelError: err,
    });
    const stats = await unsnoozeRepo(octokit, FULL, TZ);
    expect(stats.woken).toBe(1);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
  });

  it('scans past 100 issues: a due issue on the third page still wakes', async () => {
    const issues = [];
    const commentsByIssue = new Map();
    for (let n = 1; n <= 250; n++) {
      issues.push(openIssue(n));
      commentsByIssue.set(n, [snoozeComment(n === 250 ? '2026-06-01' : '2026-12-01')]);
    }
    const octokit = mockOctokit({ issues, commentsByIssue });
    const stats = await unsnoozeRepo(octokit, FULL, TZ);
    expect(stats).toEqual({ processed: 250, woken: 1, skipped: 0 });
    expect(octokit.rest.issues.listForRepo.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(octokit.rest.issues.createComment.mock.calls[0][0].issue_number).toBe(250);
  });

  it('finds the snooze date past 100 comments on one issue', async () => {
    const comments = [];
    for (let i = 0; i < 149; i++) comments.push(humanComment(`note ${i}`));
    comments.push(snoozeComment('2026-06-01'));
    const octokit = mockOctokit({
      issues: [openIssue(1)],
      commentsByIssue: new Map([[1, comments]]),
    });
    const stats = await unsnoozeRepo(octokit, FULL, TZ);
    expect(stats.woken).toBe(1);
    expect(octokit.rest.issues.listComments.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  describe('time zones', () => {
    // 2026-06-15T05:00:00Z is 2026-06-14 22:00 in America/Phoenix (UTC-7)
    // and 2026-06-15 14:00 in Asia/Tokyo (UTC+9). One instant, two dates.
    const INSTANT = new Date('2026-06-15T05:00:00Z');

    it('does not wake before the date arrives in America/Phoenix', async () => {
      vi.setSystemTime(INSTANT);
      const octokit = mockOctokit({
        issues: [openIssue(1)],
        commentsByIssue: new Map([[1, [snoozeComment('2026-06-15')]]]),
      });
      const stats = await unsnoozeRepo(octokit, FULL, 'America/Phoenix');
      expect(stats.woken).toBe(0);
    });

    it('wakes at the same instant in Asia/Tokyo, where the date has arrived', async () => {
      vi.setSystemTime(INSTANT);
      const octokit = mockOctokit({
        issues: [openIssue(1)],
        commentsByIssue: new Map([[1, [snoozeComment('2026-06-15')]]]),
      });
      const stats = await unsnoozeRepo(octokit, FULL, 'Asia/Tokyo');
      expect(stats.woken).toBe(1);
    });

    it('wakes in Pacific/Kiritimati (UTC+14) at an instant when Pacific/Honolulu (UTC-10) is still a day behind', async () => {
      // 2026-06-15T11:00:00Z is 2026-06-16 01:00 in Kiritimati and
      // 2026-06-15 01:00 in Honolulu.
      vi.setSystemTime(new Date('2026-06-15T11:00:00Z'));
      const octokit = mockOctokit({
        issues: [openIssue(1)],
        commentsByIssue: new Map([[1, [snoozeComment('2026-06-16')]]]),
      });
      expect((await unsnoozeRepo(octokit, FULL, 'Pacific/Honolulu')).woken).toBe(0);
      expect((await unsnoozeRepo(octokit, FULL, 'Pacific/Kiritimati')).woken).toBe(1);
    });
  });
});
