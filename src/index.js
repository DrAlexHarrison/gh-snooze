// GitHub Action entry point: detect trigger type and route to handler
import * as core from '@actions/core';
import * as github from '@actions/github';
import { handleSnooze } from './snooze.js';
import { handleLabelRemoved, handleIssueClosed } from './cancel.js';

async function run() {
  try {
    const token = core.getInput('github-token') || process.env.GITHUB_TOKEN;
    const timezone = core.getInput('timezone') || 'America/Phoenix';
    const octokit = github.getOctokit(token);

    const { eventName, payload } = github.context;
    const { owner, repo } = github.context.repo;

    if (eventName === 'issue_comment') {
      // Comment created or edited. Other actions (for example a deleted
      // comment) must not apply the text they carried.
      if (payload.action === 'created' || payload.action === 'edited') {
        const issue = payload.issue;
        const comment = payload.comment;

        await handleSnooze(octokit, {
          owner, repo,
          issueNumber: issue.number,
          body: comment.body,
          // The actor is whoever triggered this event (the editor of an
          // edited comment), not necessarily the original author.
          actorLogin: payload.sender?.login ?? comment.user?.login,
        }, timezone);
      }

    } else if (eventName === 'issues') {
      const issue = payload.issue;
      const action = payload.action;

      if (action === 'opened' || action === 'edited') {
        // Check issue body for snooze pattern
        await handleSnooze(octokit, {
          owner, repo,
          issueNumber: issue.number,
          body: issue.body,
          // The actor is whoever triggered this event (the editor), not
          // the issue author. Crediting the author would mistake a human
          // edit of a bot-opened issue for a bot action and drop it.
          actorLogin: payload.sender?.login ?? issue.user?.login,
        }, timezone);

      } else if (action === 'unlabeled') {
        // Check if the snoozed label was removed
        const removedLabel = payload.label;
        if (removedLabel?.name === 'snoozed') {
          await handleLabelRemoved(octokit, owner, repo, issue.number);
        }

      } else if (action === 'closed') {
        // If issue has snoozed label, cancel the snooze
        await handleIssueClosed(octokit, owner, repo, issue.number, issue.labels || []);
      }
    }
    // Unrecognized event → exit cleanly
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
