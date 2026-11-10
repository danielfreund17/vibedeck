'use strict';

// Ticket trackers are local configuration, not code: VibeDeck ships no
// knowledge of any issue tracker. A tracker tells VibeDeck how to spot its
// ticket ids in the shell commands an agent runs, how to label and link them,
// and (optionally) which executable resolves ids to title / state / PRs.
//
// Config: <configDir>/config.json (see examples/local/ in the repo).
//   { "trackers": [{
//       "name": "jira",                                // [a-z0-9_-]+
//       "label": "{id}",                               // chip text
//       "url": "https://example.atlassian.net/browse/{id}",
//       "id": "^([A-Z][A-Z0-9]+-\\d+)$",               // parses a typed "Attach ticket…" value
//       "detect": {
//         "command": ["\\bjira\\s+(?:start|view)\\s+([A-Z][A-Z0-9]+-\\d+)"],
//         "output": [{ "when": "\\bjira\\s+create\\b", "match": "Created ([A-Z][A-Z0-9]+-\\d+)" }]
//       },
//       "resolve": "./resolve-jira.js",                // optional, relative to configDir
//       "watch": ["~/.cache/jira/status.json"],        // optional: re-resolve when these change
//       "refreshSeconds": 300                          // optional: re-resolve interval
//   }] }
//
// Resolver protocol: stdin {"tickets":["ABC-1", …]} → stdout
//   {"tickets":{"ABC-1":{"title":"…","state":"In Review","url":"…","prs":["https://github.com/o/r/pull/1"],"done":false}}}
// Every field is optional. `.js/.cjs/.mjs` resolvers run on VibeDeck's bundled
// Node (no system Node needed); anything else is executed directly.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const CONFIG_FILE = 'config.json';
const NAME_RE = /^[a-z0-9_-]{1,32}$/;
const DEFAULT_REFRESH_SECONDS = 300;
const RESOLVE_TIMEOUT_MS = 20 * 1000;

function expandHome(p) {
  return typeof p === 'string' && p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function compile(source, flags, errors, where) {
  if (typeof source !== 'string' || !source) {
    errors.push(`${where}: expected a regex string`);
    return null;
  }
  try {
    return new RegExp(source, flags);
  } catch (error) {
    errors.push(`${where}: invalid regex (${error.message})`);
    return null;
  }
}

function asList(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

// Validate + compile one config object. Bad trackers are dropped with an error
// message; bad regexes are dropped individually — config mistakes never crash.
function normalizeConfig(raw, configDir = '') {
  const errors = [];
  const trackers = [];
  const seen = new Set();
  for (const [index, t] of asList(raw?.trackers).entries()) {
    const where = `trackers[${index}]`;
    if (!t || typeof t !== 'object' || !NAME_RE.test(String(t.name || ''))) {
      errors.push(`${where}: "name" must match ${NAME_RE}`);
      continue;
    }
    if (seen.has(t.name)) {
      errors.push(`${where}: duplicate tracker "${t.name}"`);
      continue;
    }
    seen.add(t.name);
    const command = asList(t.detect?.command)
      .map((src, i) => compile(src, 'g', errors, `${where}.detect.command[${i}]`))
      .filter(Boolean);
    const output = asList(t.detect?.output)
      .map((rule, i) => {
        const when = compile(rule?.when, '', errors, `${where}.detect.output[${i}].when`);
        const match = compile(rule?.match, 'g', errors, `${where}.detect.output[${i}].match`);
        return when && match ? { when, match } : null;
      })
      .filter(Boolean);
    const resolve = typeof t.resolve === 'string' && t.resolve ? path.resolve(configDir, expandHome(t.resolve)) : null;
    trackers.push({
      name: t.name,
      label: typeof t.label === 'string' && t.label.includes('{id}') ? t.label : '{id}',
      url: typeof t.url === 'string' && /^https?:\/\//.test(t.url) ? t.url : null,
      id: t.id ? compile(t.id, '', errors, `${where}.id`) : null,
      command,
      output,
      resolve,
      watch: asList(t.watch).filter((p) => typeof p === 'string').map((p) => path.resolve(configDir, expandHome(p))),
      refreshSeconds: Math.max(30, Number(t.refreshSeconds) || DEFAULT_REFRESH_SECONDS),
    });
  }
  return { trackers, errors };
}

function loadConfig(configDir) {
  const file = configDir ? path.join(configDir, CONFIG_FILE) : null;
  if (!file || !fs.existsSync(file)) return { file, trackers: [], errors: [] };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { file, trackers: [], errors: [`${file}: ${error.message}`] };
  }
  return { file, ...normalizeConfig(raw, configDir) };
}

function fillTemplate(template, id) {
  return template ? template.split('{id}').join(encodeURIComponent(id).replace(/%2F/gi, '/')) : null;
}

// What the renderer needs to label/link tickets (no regexes, no paths).
function publicTrackers(trackers) {
  return trackers.map((t) => ({ name: t.name, label: t.label, url: t.url }));
}

function firstCapture(match) {
  for (let i = 1; i < match.length; i++) if (match[i]) return match[i];
  return match[0];
}

// Parse a value the user typed into "Attach ticket…" → { tracker, id } or null.
// "jira:ABC-1" picks a tracker explicitly; otherwise the first `id` regex wins.
function parseTicketInput(trackers, raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const explicit = text.match(/^([a-z0-9_-]+):(.+)$/);
  if (explicit) {
    const tracker = trackers.find((t) => t.name === explicit[1]);
    if (tracker) {
      const m = tracker.id ? explicit[2].trim().match(tracker.id) : null;
      return { tracker: tracker.name, id: m ? firstCapture(m) : explicit[2].trim() };
    }
  }
  for (const tracker of trackers) {
    const m = tracker.id && text.match(tracker.id);
    if (m) return { tracker: tracker.name, id: firstCapture(m) };
  }
  return null;
}

function parseResolverOutput(stdout) {
  let data;
  try {
    data = JSON.parse(String(stdout || ''));
  } catch {
    return null;
  }
  const tickets = data && typeof data.tickets === 'object' && data.tickets ? data.tickets : {};
  const out = {};
  for (const [id, info] of Object.entries(tickets)) {
    if (!info || typeof info !== 'object') continue;
    out[id] = {
      title: typeof info.title === 'string' ? info.title : null,
      state: typeof info.state === 'string' ? info.state : null,
      url: typeof info.url === 'string' && /^https?:\/\//.test(info.url) ? info.url : null,
      prs: asList(info.prs).filter((u) => typeof u === 'string'),
      done: info.done === true,
    };
  }
  return out;
}

// Run a tracker's resolver for ids → { [id]: info }. Rejects on failure.
function runResolver(tracker, ids, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    if (!tracker.resolve) return resolve({});
    const isScript = /\.[cm]?js$/.test(tracker.resolve);
    const command = isScript ? process.execPath : tracker.resolve;
    const args = isScript ? [tracker.resolve] : [];
    const child = execFile(
      command,
      args,
      {
        cwd: path.dirname(tracker.resolve),
        env: isScript ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env,
        timeout: RESOLVE_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.message = `${tracker.name} resolver failed: ${String(stderr || error.message).trim().slice(0, 300)}`;
          return reject(error);
        }
        const parsed = parseResolverOutput(stdout);
        if (!parsed) return reject(new Error(`${tracker.name} resolver printed invalid JSON`));
        resolve(parsed);
      }
    );
    child.stdin.end(JSON.stringify({ tickets: ids }));
  });
}

module.exports = {
  CONFIG_FILE,
  normalizeConfig,
  loadConfig,
  fillTemplate,
  publicTrackers,
  parseTicketInput,
  parseResolverOutput,
  runResolver,
};
