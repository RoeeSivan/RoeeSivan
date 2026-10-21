#!/usr/bin/env node
/**
 * Rewrites the open source section of README.md, between the OSS markers, from
 * GitHub's search API: every merged pull request RoeeSivan opened on a public
 * repository he does not own.
 *
 * Nothing fires in this repository when another repository merges a pull request,
 * so .github/workflows/oss-contributions.yml runs this on a schedule and commits
 * only when the output changed. It also runs locally:
 *
 *   GITHUB_TOKEN=$(gh auth token) node scripts/oss-contributions.mjs
 *
 * Every failure (missing token, API error, incomplete search, no results, missing
 * markers) throws before README.md is written, so a bad run can never blank the
 * section. The output is deterministic, so an unchanged input is a no-op.
 */

import { readFile, writeFile } from "node:fs/promises";

const USER = "RoeeSivan";
const README = new URL("../README.md", import.meta.url);
const START = "<!-- OSS:START -->";
const END = "<!-- OSS:END -->";
const QUERY = `is:pr is:merged is:public author:${USER} -user:${USER}`;
// Search, not /pulls: /pulls redirects a logged-out visitor to the login page.
const ALL_PRS = `https://github.com/search?q=${encodeURIComponent(QUERY)}&type=pullrequests`;

/**
 * One-line descriptions for repositories whose own GitHub description is too long
 * for the heading line. Anything not listed falls back to the first clause of its
 * GitHub description.
 */
const NOTES = {
  "wagtail/wagtail": "Django CMS",
  "suitenumerique/docs": "Real-time collaborative editor, part of France's La Suite numérique",
  "suitenumerique/meet": "Video conferencing on LiveKit, part of France's La Suite numérique",
};

const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error("GITHUB_TOKEN is not set.");

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": `${USER}-profile-readme`,
    },
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${path}: ${await res.text()}`);
  return res.json();
}

async function mergedPullRequests() {
  const items = [];
  for (let page = 1; ; page++) {
    const q = encodeURIComponent(QUERY);
    const res = await gh(`/search/issues?q=${q}&sort=created&order=desc&per_page=100&page=${page}`);
    // A partial result would silently drop entries from the README, so treat it as a failure.
    if (res.incomplete_results) throw new Error("GitHub returned incomplete search results.");
    items.push(...res.items);
    if (res.items.length < 100) return items;
  }
}

/**
 * suitenumerique titles open with a gitmoji and a scope ("🐛(frontend) keep ..."),
 * others with a Conventional Commits type ("fix(curriculum): add ..."). Both are
 * noise on a profile, so strip them and capitalise what is left.
 */
function cleanTitle(title) {
  const text = title
    .trim()
    .replace(/^(?:[\p{Extended_Pictographic}️‍]|:[a-z0-9_+-]+:)+\s*(?:\([^)]*\))?:?\s*/u, "")
    .replace(/^[a-z]+(?:\([^)]*\))?!?:\s+/, "");
  const escaped = text
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/[\\[\]*_<>]/g, "\\$&")))
    .join("");
  return escaped.charAt(0).toUpperCase() + escaped.slice(1);
}

function describe(repo) {
  if (NOTES[repo.full_name]) return NOTES[repo.full_name];
  return repo.description?.split(/[.:;]\s|\s[—–-]\s/)[0].trim() || null;
}

const stars = (n) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`);

const month = (iso) =>
  new Date(iso).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function render(groups) {
  const total = groups.reduce((sum, g) => sum + g.prs.length, 0);
  const lines = ["## Open Source", "", "Merged contributions to projects maintained by other teams.", ""];
  for (const { repo, prs } of groups) {
    const note = describe(repo);
    lines.push(
      [`**[${repo.full_name}](${repo.html_url})**`, note, `★ ${stars(repo.stargazers_count)}`]
        .filter(Boolean)
        .join(" · "),
    );
    for (const pr of prs) {
      lines.push(`- [#${pr.number}](${pr.html_url}) ${cleanTitle(pr.title)} · ${month(pr.mergedAt)}`);
    }
    lines.push("");
  }
  lines.push(
    `<sub>${plural(total, "merged pull request")} across ${plural(groups.length, "project")} · ` +
      `[All of them on GitHub →](${ALL_PRS})</sub>`,
  );
  return lines.join("\n");
}

const prs = await mergedPullRequests();
if (prs.length === 0) throw new Error("The search found no merged pull requests; refusing to blank the section.");

const byRepo = new Map();
for (const item of prs) {
  const name = item.repository_url.replace("https://api.github.com/repos/", "");
  const mergedAt = item.pull_request?.merged_at ?? item.closed_at;
  if (!byRepo.has(name)) byRepo.set(name, []);
  byRepo.get(name).push({ number: item.number, title: item.title, html_url: item.html_url, mergedAt });
}

const groups = await Promise.all(
  [...byRepo].map(async ([name, list]) => ({
    repo: await gh(`/repos/${name}`),
    prs: list.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt) || b.number - a.number),
  })),
);
groups.sort(
  (a, b) =>
    b.repo.stargazers_count - a.repo.stargazers_count || a.repo.full_name.localeCompare(b.repo.full_name),
);

const readme = await readFile(README, "utf8");
const from = readme.indexOf(START);
const to = readme.indexOf(END);
if (from === -1 || to === -1 || to < from || readme.indexOf(START, from + 1) !== -1) {
  throw new Error(`README.md needs exactly one ${START} ... ${END} pair.`);
}

const next = `${readme.slice(0, from + START.length)}\n${render(groups)}\n${readme.slice(to)}`;
if (next === readme) {
  console.log("Open source section is already current.");
} else {
  await writeFile(README, next);
  console.log(`Open source section rewritten: ${prs.length} pull requests across ${groups.length} projects.`);
}
