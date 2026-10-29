// The HireMind agent: a Claude tool-use loop. Claude decides which tool to call
// next; our code executes the tool and streams every step to the UI.

import Anthropic from '@anthropic-ai/sdk';
import { TOOL_DEFINITIONS, createState, executeTool, summarizeResult } from './tools.js';

export const MODEL = process.env.HIREMIND_MODEL || 'claude-opus-5-5';
const MAX_TURNS = 14;

const SYSTEM_PROMPT = `You are HireMind, an expert career coach and technical recruiter agent.
Your job: help one candidate apply for one specific job, using the tools provided.

Workflow (adapt if needed, but deliver everything):
1. analyze_documents, then compute_match to get real numbers. Never guess scores.
2. tailor_resume: a tailored summary and 3-6 rewritten bullets. Check the returned score; if it barely moved, reconsider which job keywords the candidate truthfully supports.
3. plan_skill_gaps for the missing skills that matter most (skip if nothing important is missing).
4. write_cover_letter.
5. prepare_interview, including at least one question probing a gap.
6. finish with an honest verdict.

Rules:
- Be truthful. Never invent employers, degrees, tools, certifications or metrics the resume does not support. If a number is implied but not stated, phrase it without a fake figure.
- Use Indian or international English matching the job description.
- Keep every "note" to one short sentence; it is shown live to the user.
- Do the work through tool calls. Do not write the deliverables as plain text.`;

/**
 * Run the agent. `emit(event)` receives:
 *   { type: 'step', tool, note, summary } | { type: 'report', key, data }
 *   { type: 'message', text } | { type: 'done' } | { type: 'error', message }
 */
export async function runClaudeAgent({ resume, job, emit, signal }) {
  const client = new Anthropic();
  const state = createState(resume, job);

  const messages = [
    {
      role: 'user',
      content: `<resume>\n${resume}\n</resume>\n\n<job_description>\n${job}\n</job_description>\n\nRun the full workflow for this candidate and job.`,
    },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (signal?.aborted) return;

    const response = await client.beta.messages.create(
      {
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        tools: TOOL_DEFINITIONS,
        messages,
        output_config: { effort: 'medium' },
        // Server-side fallback: if a safety classifier declines, the API reroutes the request.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      },
      { signal },
    );

    if (response.stop_reason === 'refusal') {
      emit({ type: 'error', message: 'The model declined this request. Try different input text.' });
      return;
    }

    messages.push({ role: 'assistant', content: response.content });

    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) emit({ type: 'message', text: block.text.trim() });
    }

    if (response.stop_reason === 'pause_turn') continue;

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (response.stop_reason === 'max_tokens' && toolUses.length) {
      // A tool input may be truncated; ask the model to retry rather than running it.
      messages.push({
        role: 'user',
        content: toolUses.map((t) => ({
          type: 'tool_result',
          tool_use_id: t.id,
          is_error: true,
          content: 'Your output was cut off. Call the tool again with shorter content.',
        })),
      });
      continue;
    }
    if (!toolUses.length) break;

    let finished = false;
    const results = [];
    for (const call of toolUses) {
      const { result, report, isError, done } = executeTool(call.name, call.input, state);
      emit({ type: 'step', tool: call.name, note: call.input?.note || '', summary: summarizeResult(call.name, result), isError: !!isError });
      if (report) emit({ type: 'report', ...report });
      if (done) finished = true;
      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: JSON.stringify(result),
        ...(isError ? { is_error: true } : {}),
      });
    }
    // All tool results go back in one user message.
    messages.push({ role: 'user', content: results });
    if (finished) break;
  }

  emit({ type: 'done' });
}
