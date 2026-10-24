import Anthropic from '@anthropic-ai/sdk';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as assistant from './assistant.js';
import { AppError, Db } from './db.js';

/**
 * The assistant on the owner's Claude subscription: each turn runs `claude -p` (Claude Code CLI),
 * which reaches the game data through the bank's own MCP endpoint. The CLI gets no built-in tools
 * (no shell, no files), only the bank tools, and every CLI run gets its own short-lived token.
 */

export interface CliTurn {
  content: unknown[];
  resume: string | null;
  mcpUrl: string;
  token: string;
}
export interface CliResult { sessionId: string; text: string; isError: boolean }
export type CliRunner = (turn: CliTurn) => Promise<CliResult>;
export type Ask = (gameId: number, staffId: number, input: assistant.ChatInput) => ReturnType<typeof assistant.threadView>;

const TIMEOUT_MS = 5 * 60_000;

/** Subscription when a Claude Code token is set (or ASSISTANT_BACKEND=cli), else an API key. */
export function cliEnabled() {
  const mode = process.env.ASSISTANT_BACKEND;
  if (mode) return mode === 'cli';
  const file = process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE;
  return !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || (file && existsSync(file)));
}

/** The assistant backend for this server, or null when neither a subscription token nor an API key is set. */
export function pickBackend(db: Db, opts: { claude?: assistant.ClaudeClient; cli?: CliRunner } = {}): Ask | null {
  if (opts.cli || (!opts.claude && cliEnabled())) {
    const run = opts.cli ?? runClaudeCli;
    const mcpUrl = process.env.ASSISTANT_MCP_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}/api/mcp`;
    return (gameId, staffId, input) => chat(db, run, mcpUrl, gameId, staffId, input);
  }
  const client = opts.claude ?? (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? new Anthropic() : null);
  return client ? (gameId, staffId, input) => assistant.chat(db, client, gameId, staffId, input) : null;
}

// ---------- MCP: the bank tools for the CLI ----------

const grants = new Map<string, { gameId: number; threadId: number }>();

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** The game and thread of the CLI run that holds `token`; only the bank's own host may call. */
export function mcpContext(ip: string, token: string) {
  const ctx = grants.get(token);
  if (!LOOPBACK.has(ip) || !ctx) throw new AppError('Нет доступа', 401);
  return ctx;
}

/** Serves one MCP request (stateless): the bank tools, bound to one game and thread. */
export async function serveMcp(db: Db, ctx: { gameId: number; threadId: number }, req: IncomingMessage, res: ServerResponse, body: unknown) {
  const server = new Server({ name: 'bank', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: assistant.TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema as any })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (r) => {
    try {
      const out = await assistant.runTool(db, ctx, r.params.name, r.params.arguments ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    } catch (e: any) {
      return { content: [{ type: 'text', text: e.message ?? 'Ошибка' }], isError: true };
    }
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

// ---------- Chat ----------

async function chat(db: Db, run: CliRunner, mcpUrl: string, gameId: number, staffId: number, input: assistant.ChatInput) {
  const { thread, userMsg } = await assistant.startTurn(db, gameId, staffId, input);
  const token = randomBytes(24).toString('hex');
  grants.set(token, { gameId, threadId: thread.id });
  try {
    const turn = { content: userMsg.content as unknown[], mcpUrl, token };
    let res = thread.cli_session ? await run({ ...turn, resume: thread.cli_session }).catch(() => null) : null;
    // No session to continue (new thread, or the CLI lost it): start over with the chat so far as context.
    if (!res || res.isError) res = await run({ ...turn, content: [...(await recap(db, thread.id)), ...turn.content], resume: null });
    if (res.isError) throw new AppError(`Помощник не ответил: ${res.text.slice(0, 300) || 'ошибка Claude Code'}`, 502);
    await db.query('update assistant_thread set cli_session = $2 where id = $1', [thread.id, res.sessionId]);
    const text = res.text.trim() || 'Готово.';
    await assistant.saveMessage(db, thread.id, { role: 'assistant', content: [{ type: 'text', text }] }, text, true);
  } finally {
    grants.delete(token);
  }
  return assistant.threadView(db, thread.id);
}

/** Earlier visible messages of the thread as one text block (empty for a fresh thread). */
async function recap(db: Db, threadId: number) {
  const rows = await db.query(
    'select role, text, has_image from assistant_message where thread_id = $1 and visible order by id', [threadId]);
  const earlier = rows.slice(0, -1).slice(-30);
  if (!earlier.length) return [];
  const lines = earlier.map((m) => `${m.role === 'user' ? 'Ведущий' : 'Помощник'}: ${m.text || (m.has_image ? '(фото)' : '')}`);
  return [{ type: 'text', text: `Предыдущая переписка в этом чате:\n${lines.join('\n')}\n\nНовое сообщение:` }];
}

// ---------- Running the CLI ----------

function cliEnv() {
  const env: NodeJS.ProcessEnv = { ...process.env, DISABLE_AUTOUPDATER: '1' };
  // The subscription, not an API key, pays for the CLI.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE) {
    env.CLAUDE_CODE_OAUTH_TOKEN = readFileSync(process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE, 'utf8').trim();
  }
  return env;
}

/** Sessions are stored per working directory, so every run uses the same one. */
function workDir() {
  const dir = process.env.ASSISTANT_CLI_DIR ?? join(homedir(), 'assistant');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const runClaudeCli: CliRunner = (turn) => new Promise((resolve, reject) => {
  const mcp = { mcpServers: { bank: { type: 'http', url: turn.mcpUrl, headers: { Authorization: `Bearer ${turn.token}` } } } };
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--model', process.env.ASSISTANT_CLI_MODEL ?? 'opus', '--effort', 'medium',
    '--system-prompt', assistant.SYSTEM,
    '--tools', '', '--strict-mcp-config', '--mcp-config', JSON.stringify(mcp), '--allowedTools', 'mcp__bank',
    '--setting-sources', '', '--disable-slash-commands',
    ...(turn.resume ? ['--resume', turn.resume] : []),
  ];
  const child = spawn(process.env.CLAUDE_BIN ?? 'claude', args, { cwd: workDir(), env: cliEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('error', (e) => { clearTimeout(timer); reject(new AppError(`Claude Code не запустился: ${e.message}`, 503)); });
  child.on('close', () => {
    clearTimeout(timer);
    const result = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((m) => m?.type === 'result').at(-1);
    if (!result) return reject(new AppError(`Claude Code не ответил: ${err.trim().slice(0, 300) || 'нет результата'}`, 502));
    resolve({ sessionId: result.session_id, text: String(result.result ?? ''), isError: !!result.is_error });
  });
  child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content: turn.content } })}\n`);
});
