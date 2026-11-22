// Unsnooze logic: shared between cron entry point and potential direct use
import { LABEL_NAME, findSnoozeDateInComments } from './snooze.js';
import { todayInTimezone, formatDate } from './parse-date.js';

// A YYYY-MM-DD string is only usable if it names a real calendar date.
// The marker pattern alone also accepts dates like 2026-02-30 or
// 2026-13-45, which string ordering would wake at the wrong time or
// never wake at all.
function isValidDateString(value) {
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

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

    // One failing issue (for example deleted mid-scan) must not stop
    // the scan of the remaining issues in the repo.
    try {
      // Find the most recent bot comment with machine-readable date
      const comments = await octokit.paginate(
        octokit.rest.issues.listComments,
        { owner, repo, issue_number: issue.number, per_page: 100 },
      );

      const snoozeDate = findSnoozeDateInComments(comments);

      if (!snoozeDate) {
        // No machine-readable date found — log warning, skip
        console.warn(`[${repoFullName}#${issue.number}] No snooze date found in bot comments, skipping`);
        skipped++;
        continue;
      }

      if (!isValidDateString(snoozeDate)) {
        console.warn(`[${repoFullName}#${issue.number}] Malformed snooze date "${snoozeDate}" in bot comments, skipping`);
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
    } catch (e) {
      console.warn(`[${repoFullName}#${issue.number}] Failed to process issue, skipping: ${e.message}`);
      skipped++;
    }
  }

  return { processed, woken, skipped };
}
