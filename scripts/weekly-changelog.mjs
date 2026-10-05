#!/usr/bin/env node
// Posts the week's changelog to a Discord channel webhook.
//
// Reads merged pull requests and GitHub Releases through `gh`, then writes one embed per release
// published in the window and one "Unreleased" embed for what has merged since the latest release.
// It reports versions; it never bumps one. Releases are still cut by release.yml.
//
// Each pull request belongs to the first release published after it merged. Its Conventional Commit
// title decides the group and the bump it implies for the next release:
//   `type!:` or "BREAKING CHANGE" in the body -> major, `feat` -> minor, anything else -> patch.
//
// Usage:
//   node scripts/weekly-changelog.mjs                      # post the last 7 days
//   node scripts/weekly-changelog.mjs --since 2026-09-28   # post from a given UTC date
//   node scripts/weekly-changelog.mjs --dry-run            # print the payloads, post nothing
// Posting needs DISCORD_WEBHOOK_URL in the environment.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// execFile with an argument array: no shell, so nothing in a title or body is ever interpreted.
const run = promisify(execFile);
const REPO = 'Terum-Inc/terum-skills';
const DAY = 24 * 60 * 60 * 1000;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const sinceArg = args[args.indexOf('--since') + 1];
const since = args.includes('--since') ? new Date(`${sinceArg}T00:00:00Z`) : new Date(Date.now() - 7 * DAY);
if (Number.isNaN(since.getTime())) {
  process.stderr.write(`--since needs a date like 2026-09-28, not ${sinceArg}.\n`);
  process.exit(2);
}
const webhook = process.env.DISCORD_WEBHOOK_URL;
if (!dryRun && !webhook) {
  process.stderr.write('DISCORD_WEBHOOK_URL is not set. Add it as a repository secret, or pass --dry-run.\n');
  process.exit(2);
}

async function gh(ghArgs) {
  try {
    const { stdout } = await run('gh', ghArgs, { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`gh ${ghArgs.join(' ')} failed: ${detail}\nThis script needs the GitHub CLI logged in (or GH_TOKEN set).\n`);
    process.exit(2);
  }
}

const SEMVER = /^v(\d+)\.(\d+)\.(\d+)$/;
const parts = tag => SEMVER.exec(tag).slice(1, 4).map(Number);
const bumpBetween = (older, newer) => {
  const [a, b] = [parts(older), parts(newer)];
  return b[0] !== a[0] ? 'major' : b[1] !== a[1] ? 'minor' : 'patch';
};
const nextVersion = (tag, bump) => {
  const [major, minor, patch] = parts(tag);
  if (bump === 'major') return `v${major + 1}.0.0`;
  if (bump === 'minor') return `v${major}.${minor + 1}.0`;
  return `v${major}.${minor}.${patch + 1}`;
};
const RANK = { patch: 0, minor: 1, major: 2 };

// Stable releases only, oldest first by publish time.
const releases = JSON.parse(await gh(['release', 'list', '--repo', REPO, '--limit', '200', '--json', 'tagName,publishedAt,isPrerelease']))
  .filter(release => SEMVER.test(release.tagName) && !release.isPrerelease)
  .map(release => ({ ...release, published: new Date(release.publishedAt) }))
  .sort((a, b) => a.published - b.published);
const inWindow = releases.filter(release => release.published >= since);

// Fetch a week before the release preceding the window, so a release this week also lists
// pull requests that merged earlier and waited for it. Membership is decided by commit below,
// so fetching extra pull requests is harmless.
const firstIndex = inWindow.length ? releases.indexOf(inWindow[0]) : -1;
const anchor = firstIndex > 0 && releases[firstIndex - 1].published < since ? releases[firstIndex - 1].published : since;
const fetchFrom = new Date(anchor.getTime() - 7 * DAY);
const pulls = JSON.parse(await gh(['pr', 'list', '--repo', REPO, '--state', 'merged', '--limit', '500',
  '--search', `merged:>=${fetchFrom.toISOString().slice(0, 10)}`,
  '--json', 'number,title,body,author,mergedAt,url,headRefName,mergeCommit']))
  .filter(pull => !/^release\//.test(pull.headRefName) && !/^(?:release|chore\(release\)):/.test(pull.title))
  .sort((a, b) => new Date(a.mergedAt) - new Date(b.mergedAt));

// The commits a range adds, from GitHub's compare view (up to 250, far more than a week holds).
async function commitsBetween(base, head) {
  const shas = await gh(['api', `repos/${REPO}/compare/${base}...${head}`, '--jq', '.commits[].sha']);
  return new Set(shas.split('\n').filter(Boolean));
}

const TITLE = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;
function classify(pull) {
  const match = TITLE.exec(pull.title);
  const type = match?.[1].toLowerCase() ?? null;
  const breaking = Boolean(match?.[3]) || /BREAKING[ -]CHANGE/.test(pull.body ?? '');
  const group = breaking ? 'Breaking changes' : type === 'feat' ? 'Features' : type === 'fix' ? 'Fixes' : type === 'docs' ? 'Docs' : 'Other';
  const bump = breaking ? 'major' : type === 'feat' ? 'minor' : 'patch';
  return { group, bump };
}

// Semantic-version order, oldest first, for "the release before this one".
const bySemver = releases.map(release => release.tagName).sort((a, b) => {
  const [x, y] = [parts(a), parts(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
});
const previousOf = tag => bySemver[bySemver.indexOf(tag) - 1] ?? null;
const latest = bySemver.at(-1) ?? null;

// A pull request belongs to a release when its merge commit is in that release's range.
const contains = (commits, pull) => Boolean(pull.mergeCommit?.oid && commits.has(pull.mergeCommit.oid));
const buckets = new Map();
for (const release of inWindow) {
  const previous = previousOf(release.tagName);
  const commits = previous ? await commitsBetween(previous, release.tagName) : new Set();
  buckets.set(release.tagName, pulls.filter(pull => contains(commits, pull)));
}
let unreleased = [];
if (latest) {
  const commits = await commitsBetween(latest, 'main');
  unreleased = pulls.filter(pull => contains(commits, pull));
} else {
  unreleased = pulls.filter(pull => new Date(pull.mergedAt) >= since);
}

const GROUPS = ['Breaking changes', 'Features', 'Fixes', 'Docs', 'Other'];
const escape = text => text.replace(/([*_~|`\\])/g, '\\$1');
function describe(list, moreUrl) {
  const byGroup = new Map(GROUPS.map(group => [group, []]));
  for (const pull of list) byGroup.get(classify(pull).group).push(pull);
  const lines = [];
  for (const [group, items] of byGroup) {
    if (!items.length) continue;
    lines.push(`**${group}**`);
    for (const pull of items) lines.push(`- [#${pull.number}](${pull.url}) ${escape(pull.title)} · ${escape(pull.author.login)}`);
    lines.push('');
  }
  // Discord caps a description at 4096 characters; keep whole lines and say what was left out.
  let text = '';
  let shown = 0;
  const rows = lines.filter(line => line.startsWith('- ')).length;
  for (const line of lines) {
    if (text.length + line.length + 120 > 4096) {
      text += `…and ${rows - shown} more. [See them all](${moreUrl})`;
      return text.trim();
    }
    text += `${line}\n`;
    if (line.startsWith('- ')) shown++;
  }
  return text.trim() || 'No pull requests besides the release itself.';
}

const COLORS = { major: 0xe5484d, minor: 0x3e63dd, patch: 0x30a46c, unreleased: 0x8b8d98 };
const embeds = [];
for (const release of inWindow) {
  const previous = previousOf(release.tagName);
  const bump = previous ? bumpBetween(previous, release.tagName) : 'minor';
  const url = `https://github.com/${REPO}/releases/tag/${release.tagName}`;
  embeds.push({
    title: `${release.tagName} · ${bump} release`,
    url,
    description: describe(buckets.get(release.tagName), url),
    color: COLORS[bump],
    timestamp: release.publishedAt,
    footer: { text: previous ? `Since ${previous}` : 'First release' },
  });
}
if (unreleased.length) {
  const base = latest ?? 'v0.0.0';
  const bump = unreleased.map(pull => classify(pull).bump).reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'patch');
  const url = latest ? `https://github.com/${REPO}/compare/${latest}...main` : `https://github.com/${REPO}/commits/main`;
  embeds.push({
    title: `Unreleased · next ${nextVersion(base, bump)} (${bump})`,
    url,
    description: describe(unreleased, url),
    color: COLORS.unreleased,
    footer: { text: `Merged to main since ${base}; not in a release yet` },
  });
}

if (!embeds.length) {
  process.stderr.write(`Nothing merged or released since ${since.toISOString().slice(0, 10)}; nothing posted.\n`);
  process.exit(0);
}

// One message holds at most 10 embeds and 6000 characters of embed text.
const fmt = date => date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const heading = `**terum-skills changelog** · ${fmt(since)} – ${fmt(new Date())}`;
const size = embed => embed.title.length + embed.description.length + (embed.footer?.text.length ?? 0);
const messages = [];
for (const embed of embeds) {
  const last = messages.at(-1);
  if (last && last.embeds.length < 10 && last.embeds.reduce((n, e) => n + size(e), 0) + size(embed) <= 6000) last.embeds.push(embed);
  else messages.push({ embeds: [embed] });
}
const payloads = messages.map((message, i) => ({
  username: 'terum-skills changelog',
  content: i === 0 ? heading : undefined,
  embeds: message.embeds,
  allowed_mentions: { parse: [] },
}));

if (dryRun) {
  process.stdout.write(`${JSON.stringify(payloads, null, 2)}\n`);
  process.exit(0);
}
for (const payload of payloads) {
  const response = await fetch(`${webhook}?wait=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    process.stderr.write(`Discord refused the post: ${response.status} ${await response.text()}\n`);
    process.exit(1);
  }
}
process.stderr.write(`Posted ${embeds.length} embed(s) in ${payloads.length} message(s).\n`);
