import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleLabelRemoved, handleIssueClosed } from '../src/cancel.js';
import { handleSnooze } from '../src/snooze.js';

// Frozen "now": 2026-06-15 noon in America/Phoenix (UTC-7)
const FROZEN_NOW = new Date('2026-06-15T19:00:00Z');
const BOT = 'github-actions[bot]';
const OWNER = 'octo';
const REPO = 'demo';
const ISSUE = 42;

const RECENT = '2026-06-15T18:59:30Z'; // 30s before frozen now
const OLD = '2026-06-10T19:00:00Z';
const OLDER = '2026-06-01T19:00:00Z';

function botComment(body, created_at) {
  return { user: { login: BOT }, body, created_at };
}
function humanComment(body, created_at) {
  return { user: { login: 'alice' }, body, created_at };
}
function snoozeComment(date, created_at) {
  return botComment(
    `🔕 **Snoozed until someday** (${date})\n\n<!-- snooze-until: ${date} -->`,
    created_at,
  );
}
function cancelComment(date, created_at) {
  return botComment(
    `🔔 **Snooze cancelled.** This issue is now active.\n\n_Was snoozed until ${date}_`,
    created_at,
  );
}
function endedComment(date, created_at) {
  return botComment(
    `⏰ **Snooze ended!** This issue is now active again.\n\n_Was snoozed until ${date}_`,
    created_at,
  );
}

// Mocked Octokit client. listComments emulates the GitHub API returning
// comments in ascending creation order, sliced by page/per_page. paginate
// loops pages until a short page comes back, like the real helper.
function mockOctokit({ comments = [], removeLabelError = null } = {}) {
  const listComments = vi.fn(async ({ per_page = 30, page = 1 }) => {
    const start = (page - 1) * per_page;
    return { data: comments.slice(start, start + per_page) };
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
  const createComment = vi.fn(async () => ({}));
  const removeLabel = vi.fn(async () => {
    if (removeLabelError) throw removeLabelError;
    return {};
  });
  const addLabels = vi.fn(async () => ({}));
  const getLabel = vi.fn(async () => ({}));
  const createLabel = vi.fn(async () => ({}));
  return {
    paginate,
    rest: {
      issues: { listComments, createComment, removeLabel, addLabels, getLabel, createLabel },
    },
  };
}

describe('cancel handlers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('handleLabelRemoved', () => {
    it('posts a cancellation comment with the last snooze date on manual label removal', async () => {
      const octokit = mockOctokit({ comments: [snoozeComment('2026-08-01', OLD)] });
      await handleLabelRemoved(octokit, OWNER, REPO, ISSUE);
      expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      const args = octokit.rest.issues.createComment.mock.calls[0][0];
      expect(args).toMatchObject({ owner: OWNER, repo: REPO, issue_number: ISSUE });
      expect(args.body).toContain('Snooze cancelled');
      expect(args.body).toContain('(label removed)');
      expect(args.body).toContain('Was snoozed until 2026-08-01');
    });

    it('does not remove the label itself, since the user already removed it', async () => {
      const octokit = mockOctokit({ comments: [snoozeComment('2026-08-01', OLD)] });
      await handleLabelRemoved(octokit, OWNER, REPO, ISSUE);
      expect(octokit.rest.issues.removeLabel).not.toHaveBeenCalled();
    });

    it('uses the newest snooze date when the snooze was updated', async () => {
      const updated = botComment(
        '🔕 **Snooze updated to someday** (2026-09-15)\n\n_Previous snooze: 2026-08-01_\n\n<!-- snooze-until: 2026-09-15 -->',
        OLD,
      );
      const octokit = mockOctokit({
        comments: [snoozeComment('2026-08-01', OLDER), updated],
      });
      await handleLabelRemoved(octokit, OWNER, REPO, ISSUE);
      const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
      expect(body).toContain('Was snoozed until 2026-09-15');
    });

    it('posts nothing when the bot itself just cancelled (loop prevention)', async () => {
      const octokit = mockOctokit({
        comments: [snoozeComment('2026-08-01', OLD), cancelComment('2026-08-01', RECENT)],
      });
      await handleLabelRemoved(octokit, OWNER, REPO, ISSUE);
      expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it('posts nothing when the bot itself just ended the snooze at wake time', async () => {
      const octokit = mockOctokit({
        comments: [snoozeComment('2026-06-15', OLD), endedComment('2026-06-15', RECENT)],
      });
      await handleLabelRemoved(octokit, OWNER, REPO, ISSUE);
      expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it('finds a recent bot action past the first page of comments (more than 5 comments)', async () => {
      const comments = [snoozeComment('2026-08-01', OLDER)];
      for (let i = 0; i < 8; i++) {
        comments.push(humanComment(`discussion ${i}`, '2026-06-12T19:00:00Z'));
      }
      comments.push(cancelComment('2026-08-01', RECENT));
      const octokit = mockOctokit({ comments });
      await handleLabelRemoved(octokit, OWNER, REPO, ISSUE);
      expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it('posts nothing when no snooze was ever set', async () => {
      const octokit = mockOctokit({
        comments: [humanComment('just talking', OLD), humanComment('snooze: 15d', OLD)],
      });
      await handleLabelRemoved(octokit, OWNER, REPO, ISSUE);
      expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it('ignores a machine date marker forged in a human comment', async () => {
      const octokit = mockOctokit({
        comments: [humanComment('<!-- snooze-until: 2026-08-01 -->', OLD)],
      });
      await handleLabelRemoved(octokit, OWNER, REPO, ISSUE);
      expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it('posts nothing when the snooze already ended long ago and the label was re-added then removed', async () => {
      const octokit = mockOctokit({
        comments: [snoozeComment('2026-06-05', OLDER), endedComment('2026-06-05', OLD)],
      });
      await handleLabelRemoved(octokit, OWNER, REPO, ISSUE);
      expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it('posts nothing when the snooze was already cancelled long ago', async () => {
      const octokit = mockOctokit({
        comments: [snoozeComment('2026-08-01', OLDER), cancelComment('2026-08-01', OLD)],
      });
      await handleLabelRemoved(octokit, OWNER, REPO, ISSUE);
      expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });
  });

  describe('handleIssueClosed', () => {
    it('posts a cancellation comment and removes the label when a snoozed issue is closed', async () => {
      const octokit = mockOctokit({ comments: [snoozeComment('2026-08-01', OLD)] });
      await handleIssueClosed(octokit, OWNER, REPO, ISSUE, [{ name: 'snoozed' }, { name: 'bug' }]);
      expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
      expect(body).toContain('Snooze cancelled');
      expect(body).toContain('(issue closed)');
      expect(body).toContain('Was snoozed until 2026-08-01');
      expect(octokit.rest.issues.removeLabel).toHaveBeenCalledWith({
        owner: OWNER, repo: REPO, issue_number: ISSUE, name: 'snoozed',
      });
    });

    it('does nothing when the closed issue has no snoozed label', async () => {
      const octokit = mockOctokit({ comments: [snoozeComment('2026-08-01', OLD)] });
      await handleIssueClosed(octokit, OWNER, REPO, ISSUE, [{ name: 'bug' }]);
      expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(octokit.rest.issues.removeLabel).not.toHaveBeenCalled();
      expect(octokit.paginate).not.toHaveBeenCalled();
    });

    it('does nothing when the closed issue has no labels at all', async () => {
      const octokit = mockOctokit({});
      await handleIssueClosed(octokit, OWNER, REPO, ISSUE, []);
      expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(octokit.rest.issues.removeLabel).not.toHaveBeenCalled();
    });

    it('still removes the label and omits the date line when no snooze date is on record', async () => {
      const octokit = mockOctokit({ comments: [humanComment('hi', OLD)] });
      await handleIssueClosed(octokit, OWNER, REPO, ISSUE, [{ name: 'snoozed' }]);
      const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
      expect(body).toContain('Snooze cancelled');
      expect(body).not.toContain('Was snoozed until');
      expect(octokit.rest.issues.removeLabel).toHaveBeenCalledTimes(1);
    });

    it('does not throw when the label is already gone at removal time', async () => {
      const err = new Error('Label does not exist');
      err.status = 404;
      const octokit = mockOctokit({
        comments: [snoozeComment('2026-08-01', OLD)],
        removeLabelError: err,
      });
      await expect(
        handleIssueClosed(octokit, OWNER, REPO, ISSUE, [{ name: 'snoozed' }]),
      ).resolves.toBeUndefined();
      expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    });

    it('does not quote a stale date from a snooze that was already cancelled', async () => {
      const octokit = mockOctokit({
        comments: [snoozeComment('2026-08-01', OLDER), cancelComment('2026-08-01', OLD)],
      });
      await handleIssueClosed(octokit, OWNER, REPO, ISSUE, [{ name: 'snoozed' }]);
      const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
      expect(body).not.toContain('Was snoozed until 2026-08-01');
      expect(octokit.rest.issues.removeLabel).toHaveBeenCalledTimes(1);
    });
  });

  // The snooze keyword commands live in snooze.js, but they share the
  // "current snooze" state with cancel.js: a cancelled snooze must stop
  // counting as an existing snooze everywhere.
  describe('snooze: cancel keyword and re-snoozing after a cancel', () => {
    function context(body) {
      return { owner: OWNER, repo: REPO, issueNumber: ISSUE, body, actorLogin: 'alice' };
    }
    const TZ = 'America/Phoenix';

    it('cancels an active snooze and removes its label', async () => {
      const octokit = mockOctokit({ comments: [snoozeComment('2026-08-01', OLD)] });
      await handleSnooze(octokit, context('snooze: cancel'), TZ);
      expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
      expect(body).toContain('Snooze cancelled');
      expect(body).toContain('Was snoozed until 2026-08-01');
      expect(octokit.rest.issues.removeLabel).toHaveBeenCalledWith({
        owner: OWNER, repo: REPO, issue_number: ISSUE, name: 'snoozed',
      });
    });

    it('does not post a second cancellation when the snooze was already cancelled', async () => {
      const octokit = mockOctokit({
        comments: [snoozeComment('2026-08-01', OLDER), cancelComment('2026-08-01', OLD)],
      });
      await handleSnooze(octokit, context('snooze: cancel'), TZ);
      expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(octokit.rest.issues.removeLabel).not.toHaveBeenCalled();
    });

    it('re-snoozes to the same date after a cancel instead of silently skipping', async () => {
      const octokit = mockOctokit({
        comments: [snoozeComment('2026-08-01', OLDER), cancelComment('2026-08-01', OLD)],
      });
      await handleSnooze(octokit, context('snooze: 2026-08-01'), TZ);
      expect(octokit.rest.issues.addLabels).toHaveBeenCalledWith({
        owner: OWNER, repo: REPO, issue_number: ISSUE, labels: ['snoozed'],
      });
      expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
      expect(body).toContain('<!-- snooze-until: 2026-08-01 -->');
    });

    it('extends from now, not from the cancelled date, for +2w after a cancel', async () => {
      const octokit = mockOctokit({
        comments: [snoozeComment('2026-08-01', OLDER), cancelComment('2026-08-01', OLD)],
      });
      await handleSnooze(octokit, context('snooze: +2w'), TZ);
      const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
      // Frozen today is 2026-06-15, so now + 2 weeks is 2026-06-29.
      expect(body).toContain('<!-- snooze-until: 2026-06-29 -->');
    });

    it('still extends the existing date for +2w while a snooze is active', async () => {
      const octokit = mockOctokit({ comments: [snoozeComment('2026-08-01', OLD)] });
      await handleSnooze(octokit, context('snooze: +2w'), TZ);
      const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
      expect(body).toContain('<!-- snooze-until: 2026-08-15 -->');
    });
  });
});
