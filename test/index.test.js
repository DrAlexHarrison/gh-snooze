import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// index.js runs itself on import, so each scenario mocks the Actions
// toolkit and the two handler modules, sets the webhook context, then
// imports a fresh copy of the entry point.
vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  setFailed: vi.fn(),
}));
vi.mock('@actions/github', () => ({
  getOctokit: vi.fn(),
  context: { eventName: '', payload: {}, repo: { owner: 'octo', repo: 'demo' } },
}));
vi.mock('../src/snooze.js', () => ({
  handleSnooze: vi.fn(),
}));
vi.mock('../src/cancel.js', () => ({
  handleLabelRemoved: vi.fn(),
  handleIssueClosed: vi.fn(),
}));

const SAVED_TOKEN = process.env.GITHUB_TOKEN;

async function loadEntry({ eventName, payload, inputs = {}, envToken } = {}) {
  vi.resetModules();
  const core = await import('@actions/core');
  const github = await import('@actions/github');
  const snooze = await import('../src/snooze.js');
  const cancel = await import('../src/cancel.js');

  if (envToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = envToken;

  core.getInput.mockImplementation((name) => inputs[name] ?? '');
  const octokit = { fakeOctokit: true };
  github.getOctokit.mockReturnValue(octokit);
  github.context.eventName = eventName;
  github.context.payload = payload;
  github.context.repo = { owner: 'octo', repo: 'demo' };
  snooze.handleSnooze.mockResolvedValue(undefined);
  cancel.handleLabelRemoved.mockResolvedValue(undefined);
  cancel.handleIssueClosed.mockResolvedValue(undefined);

  await import('../src/index.js');
  // Let the un-awaited run() promise settle (rejection path included).
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return { core, github, snooze, cancel, octokit };
}

function commentPayload({ action = 'created', body = 'snooze: 15d', commentUser = 'alice', sender = 'alice' } = {}) {
  const payload = {
    action,
    issue: { number: 7 },
    comment: { body, user: { login: commentUser } },
  };
  if (sender !== null) payload.sender = { login: sender };
  return payload;
}

function issuePayload({ action, body = 'snooze: 15d', issueUser = 'alice', sender = 'alice', labels, label } = {}) {
  const issue = { number: 7, body, user: { login: issueUser } };
  if (labels !== undefined) issue.labels = labels;
  const payload = { action, issue };
  if (sender !== null) payload.sender = { login: sender };
  if (label !== undefined) payload.label = label;
  return payload;
}

describe('index entry point routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    if (SAVED_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = SAVED_TOKEN;
  });

  it('routes issue_comment created to the snooze handler with comment body and actor', async () => {
    const { snooze, cancel, octokit, core } = await loadEntry({
      eventName: 'issue_comment',
      payload: commentPayload({}),
    });
    expect(snooze.handleSnooze).toHaveBeenCalledTimes(1);
    expect(snooze.handleSnooze).toHaveBeenCalledWith(
      octokit,
      { owner: 'octo', repo: 'demo', issueNumber: 7, body: 'snooze: 15d', actorLogin: 'alice' },
      'America/Phoenix',
    );
    expect(cancel.handleLabelRemoved).not.toHaveBeenCalled();
    expect(cancel.handleIssueClosed).not.toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('routes issue_comment edited to the snooze handler', async () => {
    const { snooze } = await loadEntry({
      eventName: 'issue_comment',
      payload: commentPayload({ action: 'edited', body: 'snooze: 3m' }),
    });
    expect(snooze.handleSnooze).toHaveBeenCalledTimes(1);
    expect(snooze.handleSnooze.mock.calls[0][1].body).toBe('snooze: 3m');
  });

  it('ignores issue_comment deleted so deleting a comment cannot apply its snooze', async () => {
    const { snooze, cancel, core } = await loadEntry({
      eventName: 'issue_comment',
      payload: commentPayload({ action: 'deleted' }),
    });
    expect(snooze.handleSnooze).not.toHaveBeenCalled();
    expect(cancel.handleLabelRemoved).not.toHaveBeenCalled();
    expect(cancel.handleIssueClosed).not.toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('credits the comment editor (sender), not the original author, as actor', async () => {
    const { snooze } = await loadEntry({
      eventName: 'issue_comment',
      payload: commentPayload({ action: 'edited', commentUser: 'bob', sender: 'alice' }),
    });
    expect(snooze.handleSnooze.mock.calls[0][1].actorLogin).toBe('alice');
  });

  it('falls back to the comment author when the payload has no sender', async () => {
    const { snooze } = await loadEntry({
      eventName: 'issue_comment',
      payload: commentPayload({ commentUser: 'bob', sender: null }),
    });
    expect(snooze.handleSnooze.mock.calls[0][1].actorLogin).toBe('bob');
  });

  it('routes issues opened to the snooze handler with the issue body', async () => {
    const { snooze, octokit } = await loadEntry({
      eventName: 'issues',
      payload: issuePayload({ action: 'opened', body: 'Details\n\nsnooze: 2026-08' }),
    });
    expect(snooze.handleSnooze).toHaveBeenCalledWith(
      octokit,
      { owner: 'octo', repo: 'demo', issueNumber: 7, body: 'Details\n\nsnooze: 2026-08', actorLogin: 'alice' },
      'America/Phoenix',
    );
  });

  it('routes issues edited and credits the editor, not a bot issue author, as actor', async () => {
    const { snooze } = await loadEntry({
      eventName: 'issues',
      payload: issuePayload({ action: 'edited', issueUser: 'github-actions[bot]', sender: 'alice' }),
    });
    expect(snooze.handleSnooze).toHaveBeenCalledTimes(1);
    expect(snooze.handleSnooze.mock.calls[0][1].actorLogin).toBe('alice');
  });

  it('routes removal of the snoozed label to the label-removed handler', async () => {
    const { snooze, cancel, octokit } = await loadEntry({
      eventName: 'issues',
      payload: issuePayload({ action: 'unlabeled', label: { name: 'snoozed' } }),
    });
    expect(cancel.handleLabelRemoved).toHaveBeenCalledWith(octokit, 'octo', 'demo', 7);
    expect(snooze.handleSnooze).not.toHaveBeenCalled();
    expect(cancel.handleIssueClosed).not.toHaveBeenCalled();
  });

  it('ignores removal of any other label', async () => {
    const { snooze, cancel } = await loadEntry({
      eventName: 'issues',
      payload: issuePayload({ action: 'unlabeled', label: { name: 'bug' } }),
    });
    expect(cancel.handleLabelRemoved).not.toHaveBeenCalled();
    expect(snooze.handleSnooze).not.toHaveBeenCalled();
  });

  it('ignores an unlabeled event with no label in the payload', async () => {
    const { cancel, core } = await loadEntry({
      eventName: 'issues',
      payload: issuePayload({ action: 'unlabeled' }),
    });
    expect(cancel.handleLabelRemoved).not.toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('routes issues closed to the closed handler with the issue labels', async () => {
    const labels = [{ name: 'snoozed' }, { name: 'bug' }];
    const { cancel, octokit } = await loadEntry({
      eventName: 'issues',
      payload: issuePayload({ action: 'closed', labels }),
    });
    expect(cancel.handleIssueClosed).toHaveBeenCalledWith(octokit, 'octo', 'demo', 7, labels);
  });

  it('passes an empty label list when a closed payload omits labels', async () => {
    const { cancel, octokit } = await loadEntry({
      eventName: 'issues',
      payload: issuePayload({ action: 'closed' }),
    });
    expect(cancel.handleIssueClosed).toHaveBeenCalledWith(octokit, 'octo', 'demo', 7, []);
  });

  it.each(['reopened', 'labeled', 'assigned', 'deleted', 'milestoned'])(
    'ignores issues action "%s" (reopening never renews a snooze)',
    async (action) => {
      const { snooze, cancel, core } = await loadEntry({
        eventName: 'issues',
        payload: issuePayload({ action }),
      });
      expect(snooze.handleSnooze).not.toHaveBeenCalled();
      expect(cancel.handleLabelRemoved).not.toHaveBeenCalled();
      expect(cancel.handleIssueClosed).not.toHaveBeenCalled();
      expect(core.setFailed).not.toHaveBeenCalled();
    },
  );

  it.each(['push', 'schedule', 'pull_request', 'workflow_dispatch'])(
    'ignores unrecognized event "%s" and exits cleanly',
    async (eventName) => {
      const { snooze, cancel, core } = await loadEntry({
        eventName,
        payload: issuePayload({ action: 'opened' }),
      });
      expect(snooze.handleSnooze).not.toHaveBeenCalled();
      expect(cancel.handleLabelRemoved).not.toHaveBeenCalled();
      expect(cancel.handleIssueClosed).not.toHaveBeenCalled();
      expect(core.setFailed).not.toHaveBeenCalled();
    },
  );

  it('passes a configured timezone input through to the snooze handler', async () => {
    const { snooze } = await loadEntry({
      eventName: 'issue_comment',
      payload: commentPayload({}),
      inputs: { timezone: 'Asia/Tokyo' },
    });
    expect(snooze.handleSnooze.mock.calls[0][2]).toBe('Asia/Tokyo');
  });

  it('builds the client from the github-token input', async () => {
    const { github } = await loadEntry({
      eventName: 'push',
      payload: {},
      inputs: { 'github-token': 'input-token' },
      envToken: 'env-token',
    });
    expect(github.getOctokit).toHaveBeenCalledWith('input-token');
  });

  it('falls back to GITHUB_TOKEN when the token input is empty', async () => {
    const { github } = await loadEntry({
      eventName: 'push',
      payload: {},
      envToken: 'env-token',
    });
    expect(github.getOctokit).toHaveBeenCalledWith('env-token');
  });

  it('reports a handler failure through setFailed with the error message', async () => {
    vi.resetModules();
    const core = await import('@actions/core');
    const github = await import('@actions/github');
    const snooze = await import('../src/snooze.js');
    core.getInput.mockReturnValue('');
    github.getOctokit.mockReturnValue({});
    github.context.eventName = 'issue_comment';
    github.context.payload = commentPayload({});
    github.context.repo = { owner: 'octo', repo: 'demo' };
    snooze.handleSnooze.mockRejectedValue(new Error('boom'));
    await import('../src/index.js');
    await vi.waitFor(() => {
      expect(core.setFailed).toHaveBeenCalledWith('boom');
    });
  });
});
