// Cancel handler: label removal and issue close events
import { BOT_LOGIN, LABEL_NAME, MACHINE_DATE_REGEX } from './snooze.js';

// Check if the action itself recently posted a comment (within 60s)
// to prevent loops when action removes label → triggers unlabeled event
async function isRecentBotAction(octokit, owner, repo, issueNumber) {
  const { data: comments } = await octokit.rest.issues.listComments({
    owner, repo, issue_number: issueNumber,
    per_page: 5,
    direction: 'desc',
  });

  // Note: GitHub API returns comments in ascending order even with direction desc
  // for listComments. We reverse to check most recent first.
  const sorted = [...comments].sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at)
  );

  const now = Date.now();
  for (const comment of sorted) {
    if (comment.user?.login !== BOT_LOGIN) continue;
    const commentTime = new Date(comment.created_at).getTime();
    if (now - commentTime < 60_000) {
      // Check if it's a wake-up or cancel message
      if (
        comment.body?.includes('Snooze ended') ||
        comment.body?.includes('Snooze cancelled') ||
        comment.body?.includes('Snooze updated') ||
        comment.body?.includes('Snoozed until')
      ) {
        return true;
      }
    }
  }
  return false;
}

// Find the most recent snooze date from bot comments
async function findLastSnoozeDate(octokit, owner, repo, issueNumber) {
  const comments = await octokit.paginate(
    octokit.rest.issues.listComments,
    { owner, repo, issue_number: issueNumber, per_page: 100 },
  );

  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (comment.user?.login !== BOT_LOGIN) continue;
    const match = comment.body?.match(MACHINE_DATE_REGEX);
    if (match) return match[1];
  }
  return null;
}

/**
 * Handle label removal event.
 * Posts a cancellation comment if the snoozed label was manually removed.
 */
export async function handleLabelRemoved(octokit, owner, repo, issueNumber) {
  // Check if this was caused by the action itself (loop prevention)
  const recentBot = await isRecentBotAction(octokit, owner, repo, issueNumber);
  if (recentBot) return;

  const lastDate = await findLastSnoozeDate(octokit, owner, repo, issueNumber);
  if (!lastDate) return; // no snooze found, nothing to cancel

  await octokit.rest.issues.createComment({
    owner, repo, issue_number: issueNumber,
    body: [
      '🔔 **Snooze cancelled** (label removed). This issue is now active.',
      '',
      `_Was snoozed until ${lastDate}_`,
    ].join('\n'),
  });
}

/**
 * Handle issue close event.
 * If the issue has the snoozed label, remove it and post cancellation.
 */
export async function handleIssueClosed(octokit, owner, repo, issueNumber, labels) {
  // Check if the issue currently has the snoozed label
  const hasSnoozed = labels.some(l => l.name === LABEL_NAME);
  if (!hasSnoozed) return;

  const lastDate = await findLastSnoozeDate(octokit, owner, repo, issueNumber);

  // Post cancel comment
  const lines = ['🔔 **Snooze cancelled** (issue closed). This issue is now active.'];
  if (lastDate) {
    lines.push('', `_Was snoozed until ${lastDate}_`);
  }
  await octokit.rest.issues.createComment({
    owner, repo, issue_number: issueNumber,
    body: lines.join('\n'),
  });

  // Remove label
  try {
    await octokit.rest.issues.removeLabel({
      owner, repo, issue_number: issueNumber, name: LABEL_NAME,
    });
  } catch (e) { /* label might already be gone */ }
}
