import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runCron, main } from '../src/unsnooze-cron.js';

// Frozen "now": 2026-06-15 noon in America/Phoenix
const FROZEN_NOW = new Date('2026-06-15T19:00:00Z');
const BOT = 'github-actions[bot]';
const TZ = 'America/Phoenix';
const SAVED_TOKEN = process.env.GITHUB_TOKEN;

function snoozeComment(date) {
  return { user: { login: BOT }, body: `🔕 **Snoozed until someday** (${date})\n\n<!-- snooze-until: ${date} -->` };
}

// Mocked Octokit serving several repos. A repo listed in failRepos makes
// its issue listing throw, like a deleted or renamed repository would.
function mockOctokit({ dueByRepo = new Map(), failRepos = new Set() } = {}) {
  const listForRepo = vi.fn(async ({ owner, repo, per_page = 30, page = 1 }) => {
    const full = `${owner}/${repo}`;
    if (failRepos.has(full)) throw new Error(`Not Found: ${full}`);
    const due = dueByRepo.get(full) ?? 0;
    const rows = due > 0 && page === 1 ? [{ number: 1, state: 'open', labels: ['snoozed'] }] : [];
    return { data: rows.slice(0, per_page) };
  });
  const listComments = vi.fn(async () => ({ data: [snoozeComment('2026-06-01')] }));
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
  const removeLabel = vi.fn(async () => ({}));
  const createComment = vi.fn(async () => ({}));
  return {
    paginate,
    rest: { issues: { listForRepo, listComments, removeLabel, createComment } },
  };
}

describe('unsnooze cron entry point', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (SAVED_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = SAVED_TOKEN;
  });

  describe('runCron', () => {
    it('aggregates processed, woken and skipped totals across repos', async () => {
      const octokit = mockOctokit({
        dueByRepo: new Map([['octo/a', 1], ['octo/b', 1], ['octo/c', 0]]),
      });
      const totals = await runCron(octokit, ['octo/a', 'octo/b', 'octo/c'], TZ);
      expect(totals).toEqual({ processed: 2, woken: 2, skipped: 0 });
      expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(2);
    });

    it('keeps scanning later repos when one repo fails (deleted or renamed repo)', async () => {
      const octokit = mockOctokit({
        dueByRepo: new Map([['octo/good', 1]]),
        failRepos: new Set(['octo/gone']),
      });
      const totals = await runCron(octokit, ['octo/gone', 'octo/good'], TZ);
      expect(totals).toEqual({ processed: 1, woken: 1, skipped: 0 });
      expect(console.error).toHaveBeenCalled();
      expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    });

    it('returns zero totals for an empty repo list and makes no API calls', async () => {
      const octokit = mockOctokit({});
      const totals = await runCron(octokit, [], TZ);
      expect(totals).toEqual({ processed: 0, woken: 0, skipped: 0 });
      expect(octokit.rest.issues.listForRepo).not.toHaveBeenCalled();
    });

    it('passes owner and repo split from each full repo name', async () => {
      const octokit = mockOctokit({ dueByRepo: new Map([['SomeOrg/some-repo', 1]]) });
      await runCron(octokit, ['SomeOrg/some-repo'], TZ);
      expect(octokit.rest.issues.listForRepo.mock.calls[0][0]).toMatchObject({
        owner: 'SomeOrg', repo: 'some-repo',
      });
    });
  });

  describe('main', () => {
    it('exits with code 1 and an error when GITHUB_TOKEN is missing', async () => {
      delete process.env.GITHUB_TOKEN;
      const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`process.exit(${code})`);
      });
      await expect(main()).rejects.toThrow('process.exit(1)');
      expect(exit).toHaveBeenCalledWith(1);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('GITHUB_TOKEN'),
      );
    });
  });
});
