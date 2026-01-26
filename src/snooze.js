// Snooze handler: detect snooze: patterns, parse dates, add labels, post comments
import { parseSnoozeExpression, formatDate, formatDateHuman } from './parse-date.js';

const BOT_LOGIN = 'github-actions[bot]';
const SNOOZE_REGEX = /^snooze:\s*(.*)$/gim;
const MACHINE_DATE_REGEX = /<!-- snooze-until: (\d{4}-\d{2}-\d{2}) -->/;

const LABEL_NAME = 'snoozed';
const LABEL_COLOR = 'E5B58B';
const LABEL_DESC = 'Issue snoozed until a future date';

// Strip code blocks, inline code, and blockquotes before scanning
function stripExcludedContent(text) {
  // 1. Fenced code blocks (```...```)
  let result = text.replace(/```[\s\S]*?```/g, '');
  // 2. Inline code (`...`)
  result = result.replace(/`[^`]+`/g, '');
  // 3. Blockquote lines (lines starting with optional whitespace + >)
  result = result.replace(/^\s*>.*$/gm, '');
  return result;
}

// Find snooze expression in text (last match wins)
export function findSnoozeExpression(text) {
  if (!text) return null;
  const stripped = stripExcludedContent(text);
  const matches = [...stripped.matchAll(SNOOZE_REGEX)];
  if (matches.length === 0) return null;
  // Last match wins, capture group is the expression
  return matches[matches.length - 1][1];
}

// Find existing snooze date from bot comments
export async function findExistingSnoozeDate(octokit, owner, repo, issueNumber) {
  // Fetch comments in reverse order (newest first)
  const comments = await octokit.paginate(
    octokit.rest.issues.listComments,
    { owner, repo, issue_number: issueNumber, per_page: 100 },
  );

  // Walk backwards to find the most recent bot comment with machine date
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (comment.user?.login !== BOT_LOGIN) continue;
    const match = comment.body?.match(MACHINE_DATE_REGEX);
    if (match) return match[1];
  }
  return null;
}

// Ensure the snoozed label exists in the repo
async function ensureLabel(octokit, owner, repo) {
  try {
    await octokit.rest.issues.getLabel({ owner, repo, name: LABEL_NAME });
  } catch (e) {
    if (e.status === 404) {
      await octokit.rest.issues.createLabel({
        owner, repo, name: LABEL_NAME,
        color: LABEL_COLOR, description: LABEL_DESC,
      });
    }
  }
}

// Build the confirmation or adjustment comment
function buildSnoozeComment(result, existingDate) {
  if (existingDate) {
    return [
      `🔕 **Snooze updated to ${result.dateHuman}** (${result.date})`,
      '',
      `_Previous snooze: ${existingDate}_`,
      '',
      `<!-- snooze-until: ${result.date} -->`,
    ].join('\n');
  }
  return [
    `🔕 **Snoozed until ${result.dateHuman}** (${result.date})`,
    '',
    `<!-- snooze-until: ${result.date} -->`,
  ].join('\n');
}

// Build the error comment
function buildErrorComment(errorExpr) {
  return [
    `⚠️ Could not parse snooze expression: \`${errorExpr}\``,
    '',
    '**Valid formats:**',
    '- `snooze: 15d` — 15 days from now',
    '- `snooze: 3m2w` — 3 months + 2 weeks from now',
    '- `snooze: 0.5m` — half a month (15 days) from now',
    '- `snooze: 2/3y` — two-thirds of a year (244 days) from now',
    '- `snooze: 2026-08` — August 1, 2026',
    '- `snooze: 2026-01-15+6m` — January 15 plus 6 months',
    '- `snooze: +2w` — extend current snooze by 2 weeks',
    '- `snooze: cancel` — cancel snooze (also: off, stop, break, end)',
    '- `snooze:` — (empty) snooze for 7 days',
  ].join('\n');
}

// Build the past-date cancel comment
function buildPastDateCancelComment(result, existingDate) {
  const lines = [
    `🔔 **Snooze cancelled** — computed date **${result.date}** is in the past.`,
  ];
  if (existingDate) {
    lines.push('', `_Was snoozed until ${existingDate}_`);
  }
  return lines.join('\n');
}

/**
 * Handle a snooze detection event.
 * @param {object} octokit - Authenticated Octokit instance
 * @param {object} context - { owner, repo, issueNumber, body, actorLogin }
 * @param {string} timezone - IANA timezone
 */
export async function handleSnooze(octokit, context, timezone) {
  const { owner, repo, issueNumber, body, actorLogin } = context;

  // Skip if actor is bot (prevent loops)
  if (actorLogin === BOT_LOGIN) return;

  // Find snooze expression
  const expression = findSnoozeExpression(body);
  if (expression === null) return;

  // Find existing snooze date for relative adjustments
  const existingDate = await findExistingSnoozeDate(octokit, owner, repo, issueNumber);

  // Parse the expression
  const result = parseSnoozeExpression(expression, timezone, existingDate);

  if (result.type === 'error') {
    // Post error comment
    await octokit.rest.issues.createComment({
      owner, repo, issue_number: issueNumber,
      body: buildErrorComment(result.error),
    });
    return;
  }

  if (result.type === 'cancel') {
    // Explicit cancel via keyword
    if (!existingDate) return; // already not snoozed, skip

    await octokit.rest.issues.createComment({
      owner, repo, issue_number: issueNumber,
      body: [
        '🔔 **Snooze cancelled.** This issue is now active.',
        '',
        `_Was snoozed until ${existingDate}_`,
      ].join('\n'),
    });

    // Remove label
    try {
      await octokit.rest.issues.removeLabel({
        owner, repo, issue_number: issueNumber, name: LABEL_NAME,
      });
    } catch (e) {
      // Label might already be removed
    }
    return;
  }

  if (result.type === 'past') {
    // Computed date is in the past → cancel
    await octokit.rest.issues.createComment({
      owner, repo, issue_number: issueNumber,
      body: buildPastDateCancelComment(result, existingDate),
    });

    // Remove label if present
    try {
      await octokit.rest.issues.removeLabel({
        owner, repo, issue_number: issueNumber, name: LABEL_NAME,
      });
    } catch (e) { /* label may not be present */ }
    return;
  }

  // type === 'snooze'
  // Check if date is the same as existing (skip if no change)
  if (existingDate === result.date) return;

  // Ensure label exists
  await ensureLabel(octokit, owner, repo);

  // Add label
  await octokit.rest.issues.addLabels({
    owner, repo, issue_number: issueNumber,
    labels: [LABEL_NAME],
  });

  // Post comment
  await octokit.rest.issues.createComment({
    owner, repo, issue_number: issueNumber,
    body: buildSnoozeComment(result, existingDate),
  });
}

export { LABEL_NAME, BOT_LOGIN, MACHINE_DATE_REGEX };
