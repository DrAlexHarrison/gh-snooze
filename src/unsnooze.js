// Unsnooze logic: shared between cron entry point and potential direct use
import { BOT_LOGIN, LABEL_NAME, MACHINE_DATE_REGEX } from './snooze.js';
import { todayInTimezone, formatDate } from './parse-date.js';

/**
 * Process a single repo: find snoozed issues past due and wake them.
 * @param {object} octokit - Authenticated Octokit instance
 * @param {string} repoFullName - "owner/repo"
 * @param {string} timezone - IANA timezone
 * @returns {{ processed: number, woken: number, skipped: number }}
 */
export async function unsnoozeRepo(octokit, repoFullName, timezone) {
  const [owner, repo] = repoFullName.split('/');
  const today = todayInTimezone(timezone);
  const todayStr = formatDate(today);

  let processed = 0;
  let woken = 0;
  let skipped = 0;

  // Fetch all open issues with the snoozed label (paginated)
  const issues = await octokit.paginate(
    octokit.rest.issues.listForRepo,
    {
      owner, repo,
      labels: LABEL_NAME,
      state: 'open',
      per_page: 100,
    },
  );

  for (const issue of issues) {
    processed++;

    // Find the most recent bot comment with machine-readable date
    const comments = await octokit.paginate(
      octokit.rest.issues.listComments,
      { owner, repo, issue_number: issue.number, per_page: 100 },
    );

    let snoozeDate = null;
    for (let i = comments.length - 1; i >= 0; i--) {
      const comment = comments[i];
      if (comment.user?.login !== BOT_LOGIN) continue;
      const match = comment.body?.match(MACHINE_DATE_REGEX);
      if (match) {
        snoozeDate = match[1];
        break;
      }
    }

    if (!snoozeDate) {
      // No machine-readable date found — log warning, skip
      console.warn(`[${repoFullName}#${issue.number}] No snooze date found in bot comments, skipping`);
      skipped++;
      continue;
    }

    // Compare: if snooze_date <= today, wake it up
    if (snoozeDate <= todayStr) {
      // Remove label
      try {
        await octokit.rest.issues.removeLabel({
          owner, repo,
          issue_number: issue.number,
          name: LABEL_NAME,
        });
      } catch (e) { /* label might already be removed */ }

      // Post wake-up comment
      await octokit.rest.issues.createComment({
        owner, repo,
        issue_number: issue.number,
        body: [
          '⏰ **Snooze ended!** This issue is now active again.',
          '',
          `_Was snoozed until ${snoozeDate}_`,
        ].join('\n'),
      });

      woken++;
      console.log(`[${repoFullName}#${issue.number}] Woken (was snoozed until ${snoozeDate})`);
    }
  }

  return { processed, woken, skipped };
}
