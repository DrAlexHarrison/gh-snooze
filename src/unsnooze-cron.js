// Cron entry point: reads repos.json and runs unsnooze for each repo
import { Octokit } from '@octokit/rest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { unsnoozeRepo } from './unsnooze.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Run the wake-up scan over every repo. One failing repo is logged and
 * does not stop the rest.
 * @returns {{ processed: number, woken: number, skipped: number }} totals
 */
export async function runCron(octokit, repos, timezone) {
  console.log(`Unsnooze cron starting — ${repos.length} repos, timezone: ${timezone}`);
  console.log('---');

  let totalProcessed = 0;
  let totalWoken = 0;
  let totalSkipped = 0;

  for (const repoFullName of repos) {
    try {
      console.log(`\nScanning ${repoFullName}...`);
      const stats = await unsnoozeRepo(octokit, repoFullName, timezone);
      console.log(`  ${repoFullName}: processed ${stats.processed}, woke ${stats.woken}, skipped ${stats.skipped}`);
      totalProcessed += stats.processed;
      totalWoken += stats.woken;
      totalSkipped += stats.skipped;
    } catch (err) {
      console.error(`  ERROR in ${repoFullName}: ${err.message}`);
    }
  }

  console.log('\n---');
  console.log(`Done. Total: processed ${totalProcessed}, woke ${totalWoken}, skipped ${totalSkipped}`);

  return { processed: totalProcessed, woken: totalWoken, skipped: totalSkipped };
}

export async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('GITHUB_TOKEN environment variable is required');
    process.exit(1);
  }

  const timezone = process.env.TIMEZONE || 'America/Phoenix';

  // Read repos.json from repo root (one level up from src/)
  const reposPath = resolve(__dirname, '..', 'repos.json');
  const repos = JSON.parse(readFileSync(reposPath, 'utf-8'));

  const octokit = new Octokit({ auth: token });

  await runCron(octokit, repos, timezone);
}

// Run only when invoked as a script, so tests can import runCron and main
// without starting a live scan.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
