'use strict';

// Main-process side of session work tracking (see work-items.js for the model):
//   - tails each tab's agent transcript and reports the PRs / tickets it touches
//   - resolves tracked tickets through the configured trackers' resolvers
//   - polls GitHub for the status of every tracked PR (one batched GraphQL call)
// The renderer owns which refs a tab tracks (it persists them and lets the user
// attach / detach); it tells us via sync() and we push status back via send().

const fs = require('fs');
const { execFile } = require('child_process');
const agents = require('./agents');
const trackersLib = require('./trackers');
const work = require('./work-items');

const TRANSCRIPT_TICK_MS = 3000;
const AGENT_DISCOVERY_MS = 15 * 1000;
const PR_POLL_MS = 2 * 60 * 1000;
const PR_BATCH = 40;
const READ_CHUNK = 4 * 1024 * 1024;
const FINAL_PR_STATES = new Set(['MERGED', 'CLOSED']);

function createWorkTracker({ configDir, registryDir, liveShells, send, env = process.env, log = console }) {
  let config = { file: null, trackers: [], errors: [] };
  let tracked = new Map(); // slug -> { tickets: [key], prs: [url] }
  const transcripts = new Map(); // slug -> { file, offset, partial, pending }
  const ticketInfo = new Map(); // key -> { label, url, title, state, prs, done, error }
  const prStatus = new Map(); // url -> { ...status, fetchedAt } | { error, fetchedAt }
  const timers = [];
  const trackerTimers = []; // per-tracker refresh intervals (reset on config reload)
  const watchedFiles = [];
  let running = false;
  const pendingTimeouts = new Map(); // name -> timeout (debounce)
  let scanning = false;
  let lastGhError = null;

  // ---------- helpers ----------
  function debounce(name, delay, fn) {
    clearTimeout(pendingTimeouts.get(name));
    pendingTimeouts.set(
      name,
      setTimeout(() => {
        pendingTimeouts.delete(name);
        Promise.resolve(fn()).catch((error) => log.error(`[vibedeck] work ${name}:`, error));
      }, delay)
    );
  }

  function trackerFor(name) {
    return config.trackers.find((t) => t.name === name) || null;
  }

  function allTicketKeys() {
    return work.uniqLast([...tracked.values()].flatMap((s) => s.tickets));
  }

  function allPrUrls() {
    const fromTickets = allTicketKeys().flatMap((key) => ticketInfo.get(key)?.prs || []);
    return work.uniqLast([...[...tracked.values()].flatMap((s) => s.prs), ...fromTickets]);
  }

  function baseTicketInfo(key) {
    const ref = work.splitTicketKey(key);
    const tracker = ref && trackerFor(ref.tracker);
    return {
      label: tracker ? tracker.label.split('{id}').join(ref.id) : ref?.id || key,
      url: tracker ? trackersLib.fillTemplate(tracker.url, ref.id) : null,
      title: null,
      state: null,
      prs: [],
      done: false,
      error: null,
    };
  }

  // ---------- config ----------
  function loadConfig() {
    config = trackersLib.loadConfig(configDir);
    for (const error of config.errors) log.warn(`[vibedeck] tracker config: ${error}`);
    for (const file of watchedFiles.splice(0)) fs.unwatchFile(file);
    for (const timer of trackerTimers.splice(0)) clearInterval(timer);
    if (!running) return;
    for (const tracker of config.trackers) {
      trackerTimers.push(setInterval(() => resolveTracker(tracker).catch(() => {}), tracker.refreshSeconds * 1000));
      for (const file of tracker.watch) {
        fs.watchFile(file, { interval: 2000 }, (cur, prev) => {
          if (cur.mtimeMs !== prev.mtimeMs) debounce(`resolve:${tracker.name}`, 300, () => resolveTracker(tracker));
        });
        watchedFiles.push(file);
      }
    }
  }

  // ---------- transcripts ----------
  function discoverTranscripts() {
    const shells = liveShells();
    const { agents: bySlug } = agents.discoverAgents(shells, registryDir);
    const liveSlugs = new Set(shells.map((s) => s.slug));
    for (const slug of transcripts.keys()) if (!liveSlugs.has(slug)) transcripts.delete(slug);
    for (const [slug, agent] of Object.entries(bySlug)) {
      if (!agent.sessionFile) continue;
      const current = transcripts.get(slug);
      if (current?.file === agent.sessionFile) continue;
      // New or switched conversation (e.g. pi /resume): scan it from the top.
      transcripts.set(slug, { file: agent.sessionFile, offset: 0, partial: '', pending: new Map(), initial: true });
    }
  }

  async function readNew(t) {
    const stat = await fs.promises.stat(t.file).catch(() => null);
    if (!stat) return null;
    if (stat.size < t.offset) Object.assign(t, { offset: 0, partial: '', pending: new Map() }); // rewritten
    if (stat.size === t.offset) return null;
    const handle = await fs.promises.open(t.file, 'r');
    try {
      const lines = [];
      while (t.offset < stat.size) {
        const length = Math.min(READ_CHUNK, stat.size - t.offset);
        const buf = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buf, 0, length, t.offset);
        if (!bytesRead) break;
        t.offset += bytesRead;
        const parts = (t.partial + buf.toString('utf8', 0, bytesRead)).split('\n');
        t.partial = parts.pop(); // incomplete last line (or '' after a trailing \n)
        lines.push(...parts);
      }
      return lines;
    } finally {
      await handle.close();
    }
  }

  async function scanTranscripts() {
    if (scanning) return;
    scanning = true;
    try {
      for (const [slug, t] of transcripts) {
        const lines = await readNew(t).catch(() => null);
        if (!lines?.length) {
          t.initial = false;
          continue;
        }
        const refs = work.scanTranscriptLines(lines, { trackers: config.trackers, pending: t.pending });
        if (refs.tickets.length || refs.prs.length) send('work:refs', { slug, tickets: refs.tickets, prs: refs.prs });
        // History read on first sight isn't news; only live pushes / merges are.
        if (refs.prEvent && !t.initial) onPrEvent(slug);
        t.initial = false;
      }
    } finally {
      scanning = false;
    }
  }

  // The agent just created / pushed / merged: re-check this tab's PRs now, and
  // again shortly after (new CI runs take a moment to register).
  function onPrEvent(slug) {
    const urls = () => {
      const s = tracked.get(slug);
      if (!s) return [];
      return work.uniqLast([...s.prs, ...s.tickets.flatMap((key) => ticketInfo.get(key)?.prs || [])]);
    };
    debounce(`pr-event:${slug}`, 2000, () => refreshPrs(urls(), { force: true }));
    debounce(`pr-event-late:${slug}`, 30 * 1000, () => refreshPrs(urls(), { force: true }));
    for (const key of tracked.get(slug)?.tickets || []) {
      const tracker = trackerFor(work.splitTicketKey(key)?.tracker);
      if (tracker) debounce(`resolve:${tracker.name}`, 5000, () => resolveTracker(tracker));
    }
  }

  // ---------- tickets ----------
  function sendTickets() {
    const out = {};
    for (const key of allTicketKeys()) out[key] = ticketInfo.get(key) || baseTicketInfo(key);
    send('work:tickets', out);
  }

  async function resolveTracker(tracker) {
    const keys = allTicketKeys().filter((key) => work.splitTicketKey(key)?.tracker === tracker.name);
    for (const key of keys) if (!ticketInfo.has(key)) ticketInfo.set(key, baseTicketInfo(key));
    if (!keys.length || !tracker.resolve) return sendTickets();
    const ids = keys.map((key) => work.splitTicketKey(key).id);
    let resolved = null;
    let error = null;
    try {
      resolved = await trackersLib.runResolver(tracker, ids, { env });
    } catch (e) {
      error = e.message;
      log.warn(`[vibedeck] ${e.message}`);
    }
    for (const [i, key] of keys.entries()) {
      const prev = ticketInfo.get(key);
      const info = resolved?.[ids[i]];
      if (!info) {
        ticketInfo.set(key, { ...prev, error });
        continue;
      }
      const prs = work.uniqLast(info.prs.map((u) => work.parsePrUrl(u)?.url).filter(Boolean));
      ticketInfo.set(key, { ...baseTicketInfo(key), ...info, url: info.url || prev.url, prs, error: null });
    }
    sendTickets();
    const unknown = allPrUrls().filter((url) => !prStatus.has(url));
    if (unknown.length) await refreshPrs(unknown);
  }

  function resolveAll() {
    return Promise.all(config.trackers.map((tracker) => resolveTracker(tracker)));
  }

  // ---------- PRs ----------
  function gh(args) {
    return new Promise((resolve, reject) => {
      execFile('gh', args, { env, timeout: 20 * 1000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          error.message = error.code === 'ENOENT' ? 'GitHub CLI (gh) not found' : String(stderr || error.message).trim().slice(0, 300);
          error.stdout = stdout;
          return reject(error);
        }
        resolve(stdout);
      });
    });
  }

  async function refreshPrs(urls, { force = false } = {}) {
    const due = work.uniqLast(urls).filter((url) => {
      const cur = prStatus.get(url);
      if (!cur || force || cur.error) return true;
      return !FINAL_PR_STATES.has(cur.state) && Date.now() - cur.fetchedAt > PR_POLL_MS / 2;
    });
    if (!due.length) return;
    const updates = {};
    for (let i = 0; i < due.length; i += PR_BATCH) {
      const { urls: batch, query } = work.buildPrStatusQuery(due.slice(i, i + PR_BATCH));
      if (!query) continue;
      let stdout;
      let failure = null;
      try {
        stdout = await gh(['api', 'graphql', '-f', `query=${query}`]);
      } catch (error) {
        // gh exits non-zero when *some* aliases fail (e.g. a deleted PR) but
        // still prints the rest — use whatever came back.
        stdout = error.stdout;
        failure = error.message;
      }
      const parsed = work.parsePrStatusResponse(stdout || '', batch);
      const gotAny = Object.keys(parsed).length > 0;
      lastGhError = gotAny ? null : failure;
      for (const url of batch) {
        const prev = prStatus.get(url);
        let status;
        if (parsed[url]) status = { ...parsed[url], fetchedAt: Date.now() };
        else if (!gotAny && prev && !prev.error) status = prev; // transient failure: keep last good
        else status = { error: gotAny || !failure ? 'PR not found' : failure, fetchedAt: Date.now() };
        prStatus.set(url, status);
        updates[url] = status;
      }
    }
    send('work:prs', { statuses: updates, error: lastGhError });
  }

  // ---------- public ----------
  function sync(sessions) {
    const next = new Map();
    for (const s of Array.isArray(sessions) ? sessions : []) {
      if (!s || typeof s.slug !== 'string') continue;
      next.set(s.slug, {
        tickets: (Array.isArray(s.tickets) ? s.tickets : []).filter((k) => work.splitTicketKey(k)),
        prs: (Array.isArray(s.prs) ? s.prs : []).map((u) => work.parsePrUrl(u)?.url).filter(Boolean),
      });
    }
    const before = new Set(allTicketKeys());
    tracked = next;
    const added = allTicketKeys().filter((key) => !before.has(key));
    const trackersToResolve = new Set(added.map((key) => work.splitTicketKey(key).tracker));
    for (const name of trackersToResolve) {
      const tracker = trackerFor(name);
      if (tracker) debounce(`resolve:${name}`, 200, () => resolveTracker(tracker));
    }
    if (added.some((key) => !trackerFor(work.splitTicketKey(key).tracker))) sendTickets();
    debounce('prs:new', 300, () => refreshPrs(allPrUrls().filter((url) => !prStatus.has(url))));
    debounce('discover', 500, discoverTranscripts);
  }

  // Manual refresh also re-reads the config, so edits apply without a restart
  // (new `detect` rules only affect transcript lines read from now on).
  async function refresh({ force = true } = {}) {
    loadConfig();
    await resolveAll();
    await refreshPrs(allPrUrls(), { force });
    return describe();
  }

  function snapshot() {
    const tickets = {};
    for (const key of allTicketKeys()) tickets[key] = ticketInfo.get(key) || baseTicketInfo(key);
    const statuses = {};
    for (const [url, status] of prStatus) statuses[url] = status;
    return { tickets, statuses, error: lastGhError, ...describe() };
  }

  function describe() {
    return { configFile: config.file, trackers: trackersLib.publicTrackers(config.trackers), configErrors: config.errors };
  }

  // Text typed into "Attach ticket or PR…" → { kind, key|url } or null.
  function parseRef(text) {
    const pr = work.parsePrUrl(text);
    if (pr) return { kind: 'pr', url: pr.url };
    const ticket = trackersLib.parseTicketInput(config.trackers, text);
    return ticket ? { kind: 'ticket', key: work.ticketKey(ticket.tracker, ticket.id) } : null;
  }

  function start() {
    running = true;
    loadConfig();
    discoverTranscripts();
    timers.push(setInterval(() => scanTranscripts().catch(() => {}), TRANSCRIPT_TICK_MS));
    timers.push(setInterval(() => {
      try {
        discoverTranscripts();
      } catch {
        /* ps hiccup — next round */
      }
    }, AGENT_DISCOVERY_MS));
    timers.push(setInterval(() => refreshPrs(allPrUrls()).catch(() => {}), PR_POLL_MS));
  }

  function stop() {
    running = false;
    for (const timer of timers.splice(0)) clearInterval(timer);
    for (const timer of trackerTimers.splice(0)) clearInterval(timer);
    for (const timeout of pendingTimeouts.values()) clearTimeout(timeout);
    pendingTimeouts.clear();
    for (const file of watchedFiles.splice(0)) fs.unwatchFile(file);
  }

  return { start, stop, sync, refresh, snapshot, parseRef, describe };
}

module.exports = { createWorkTracker };
