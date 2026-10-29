// HireMind server: serves the UI and streams agent runs as Server-Sent Events.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClaudeAgent, MODEL } from './src/agent.js';
import { runDemoAgent } from './src/demoAgent.js';

const here = fileURLToPath(new URL('.', import.meta.url));
if (existsSync(join(here, '.env'))) process.loadEnvFile(join(here, '.env'));

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = join(here, 'public');
const MAX_CHARS = 20000;
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.txt': 'text/plain' };

const hasKey = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_CHARS * 3) throw new Error('Request too large');
  }
  return JSON.parse(body || '{}');
}

async function handleRun(req, res) {
  let input;
  try {
    input = await readBody(req);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }
  const resume = String(input.resume || '').trim().slice(0, MAX_CHARS);
  const job = String(input.job || '').trim().slice(0, MAX_CHARS);
  if (resume.length < 50 || job.length < 50) {
    res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Paste a full resume and job description (at least 50 characters each).' }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const emit = (event) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };

  const useDemo = input.mode === 'demo' || !hasKey();
  emit({ type: 'mode', mode: useDemo ? 'demo' : 'claude', model: useDemo ? null : MODEL });
  try {
    await (useDemo ? runDemoAgent : runClaudeAgent)({ resume, job, emit, signal: controller.signal });
  } catch (err) {
    if (!controller.signal.aborted) {
      console.error(err);
      emit({ type: 'error', message: err?.status === 401 ? 'Invalid ANTHROPIC_API_KEY.' : `Agent error: ${err?.message || err}` });
    }
  }
  res.end();
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = normalize(url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname));
  const file = join(PUBLIC_DIR, path);
  if (!file.startsWith(PUBLIC_DIR)) return res.writeHead(403).end();
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }).end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/run') return handleRun(req, res);
  if (req.method === 'GET' && req.url === '/api/health') {
    return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, mode: hasKey() ? 'claude' : 'demo', model: MODEL }));
  }
  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(405).end();
});

server.listen(PORT, () => {
  console.log(`HireMind running at http://localhost:${PORT} (${hasKey() ? `Claude agent, ${MODEL}` : 'demo mode: set ANTHROPIC_API_KEY for the Claude agent'})`);
});
