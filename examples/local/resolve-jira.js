#!/usr/bin/env node
'use strict';

// Example VibeDeck ticket resolver for Jira, using jira-cli
// (https://github.com/ankitpokhrel/jira-cli, already logged in).
//
// Protocol: stdin  {"tickets": ["ABC-1", …]}
//           stdout {"tickets": {"ABC-1": {"title", "state", "url", "prs", "done"}}}
// Every field is optional; omit a ticket you can't resolve. Exit non-zero on a
// total failure — VibeDeck logs it and keeps the last known data.

const { execFile } = require('node:child_process');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (chunk) => (data += chunk)).on('end', () => resolve(data));
  });
}

function viewIssue(key) {
  return new Promise((resolve) => {
    execFile('jira', ['issue', 'view', key, '--raw'], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}

(async () => {
  const { tickets = [] } = JSON.parse((await readStdin()) || '{}');
  const out = {};
  await Promise.all(
    tickets.map(async (key) => {
      const issue = await viewIssue(key);
      if (!issue?.fields) return;
      const status = issue.fields.status || {};
      out[key] = {
        title: issue.fields.summary || '',
        state: status.name || '',
        done: status.statusCategory?.key === 'done',
        // PRs: jira-cli doesn't expose the development panel. VibeDeck still
        // tracks PRs the agent opened itself; list more here if you can.
        prs: [],
      };
    })
  );
  process.stdout.write(JSON.stringify({ tickets: out }));
})().catch((error) => {
  process.stderr.write(String(error?.message || error));
  process.exit(1);
});
