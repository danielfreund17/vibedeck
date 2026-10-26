/**
 * VibeDeck companion extension for pi.
 *
 * Emits contextual terminal titles plus hidden VibeDeck metadata so VibeDeck can
 * auto-name the vertical session tab and follow pi's current cwd after /resume.
 * Manual VibeDeck renames still win because VibeDeck treats user-provided tab
 * names as a hard override.
 */

import { Buffer } from 'node:buffer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

const GENERIC_PROMPTS = new Set([
  'do it',
  'go',
  'yes',
  'yep',
  'ok',
  'okay',
  'continue',
  'proceed',
  'ship it',
  'implement it',
]);

function cleanupPrompt(prompt: string): string {
  return prompt
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('/') && !line.startsWith('```'))
    ?.replace(/https?:\/\/\S+/g, '')
    .replace(/\/var\/folders\/\S+/g, '')
    .replace(/^(can you|could you|please|pls|i want you to|let'?s|we need to|help me)\s+/i, '')
    .replace(/[.!?]+$/g, '')
    .trim() ?? '';
}

function toTitle(prompt: string): string | null {
  const cleaned = cleanupPrompt(prompt);
  if (!cleaned) return null;

  const lower = cleaned.toLowerCase();
  if (GENERIC_PROMPTS.has(lower) || lower.length < 8) return null;

  const prMatch = cleaned.match(/\b(?:pr|pull request)\s*#?(\d+)\b/i);
  if (prMatch) return `PR #${prMatch[1]}`;

  const ticketMatch = cleaned.match(/\b(t\d{5,}|CONVO\d[\d_-]*)\b/i);
  const words = cleaned
    .replace(/[^\p{L}\p{N}#/_-]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => !/^(the|a|an|to|for|with|this|that|and|or|of|in|on)$/i.test(word));

  const picked = words.slice(0, 5).join(' ');
  if (!picked) return ticketMatch?.[1] ?? null;

  const title = picked.charAt(0).toUpperCase() + picked.slice(1);
  return title.length > 42 ? `${title.slice(0, 41)}…` : title;
}

function encodeMetadata(metadata: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64url');
}

function fallbackTitle(ctx: ExtensionContext): string {
  return basename(ctx.cwd) || 'session';
}

function defaultUpdatesDir(): string {
  return join(homedir(), 'Library/Application Support/vibedeck/session-updates');
}

function writeVibeDeckUpdate(cwd: string, title: string): void {
  const slug = process.env.VIBEDECK_SESSION_SLUG || null;
  const updatesDir = process.env.VIBEDECK_UPDATES_DIR || defaultUpdatesDir();
  mkdirSync(updatesDir, { recursive: true });
  writeFileSync(
    join(updatesDir, `${slug || 'active'}-${Date.now()}.json`),
    JSON.stringify({ slug, source: 'pi', cwd, title, updatedAt: new Date().toISOString() }),
    'utf8'
  );
}

function emitVibeDeckTitle(ctx: ExtensionContext, title: string, options: { writeUpdate?: boolean } = {}): void {
  if (options.writeUpdate) writeVibeDeckUpdate(ctx.cwd, title);
  const metadata = encodeMetadata({ source: 'pi', cwd: ctx.cwd, title });
  ctx.ui.setTitle(`pi · ${title} ⟦vd:${metadata}⟧`);
}

export default function (pi: ExtensionAPI) {
  let generated = false;

  pi.registerCommand('update-worktree', {
    description: 'Update VibeDeck tab context from this pi session cwd (usage: /update-worktree [title])',
    handler: async (args, ctx) => {
      const title = args.trim() || pi.getSessionName() || fallbackTitle(ctx);
      emitVibeDeckTitle(ctx, title, { writeUpdate: true });
      ctx.ui.notify(`VibeDeck worktree context updated: ${title}`, 'info');
    },
  });

  pi.on('session_start', async (_event, ctx) => {
    emitVibeDeckTitle(ctx, pi.getSessionName() || fallbackTitle(ctx));
  });

  pi.on('session_info_changed', async (event, ctx) => {
    emitVibeDeckTitle(ctx, event.name || fallbackTitle(ctx));
  });

  pi.on('before_agent_start', async (event, ctx) => {
    if (generated) {
      emitVibeDeckTitle(ctx, pi.getSessionName() || fallbackTitle(ctx));
      return;
    }

    const title = toTitle(event.prompt);
    if (!title) {
      emitVibeDeckTitle(ctx, pi.getSessionName() || fallbackTitle(ctx));
      return;
    }

    generated = true;
    if (!pi.getSessionName()) pi.setSessionName(title);
    emitVibeDeckTitle(ctx, title);
  });
}
