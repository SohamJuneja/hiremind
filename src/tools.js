// Tool definitions shared by the Claude agent and the offline demo agent.
// Each tool reads/writes a per-run `state` object, so every artifact the UI shows
// comes from a tool call the agent actually made.

import { computeMatch, extractBullets, extractSkills, extractYears } from './analysis.js';

const note = {
  type: 'string',
  description: 'One short sentence, shown to the user, saying why you are taking this step.',
};

export const TOOL_DEFINITIONS = [
  {
    name: 'analyze_documents',
    description:
      'Parse the resume and the job description. Returns the skills detected in each, years of experience mentioned, and the resume bullet points that are candidates for rewriting. Call this first.',
    input_schema: { type: 'object', properties: { note }, required: ['note'] },
  },
  {
    name: 'compute_match',
    description:
      'Compute a deterministic ATS-style fit score (0-100) between the current resume and the job description, with a breakdown (hard skills, soft skills, keyword coverage), matched skills, missing skills and missing keywords. Use these numbers instead of guessing.',
    input_schema: { type: 'object', properties: { note }, required: ['note'] },
  },
  {
    name: 'tailor_resume',
    description:
      'Submit a tailored professional summary and rewritten resume bullets aimed at this job. Rewrites must stay truthful: rephrase, quantify where the original implies it, and surface job keywords only where the candidate genuinely has that experience. Never invent employers, tools or numbers. Returns the new match score after applying the rewrites so you can see the improvement.',
    input_schema: {
      type: 'object',
      properties: {
        note,
        summary: { type: 'string', description: '2-3 sentence tailored professional summary.' },
        bullets: {
          type: 'array',
          description: 'Rewritten bullets, 3-6 items.',
          items: {
            type: 'object',
            properties: {
              original: { type: 'string', description: 'The original bullet, copied exactly.' },
              rewritten: { type: 'string', description: 'The improved bullet.' },
              why: { type: 'string', description: 'What changed and why it helps for this job.' },
            },
            required: ['original', 'rewritten', 'why'],
          },
        },
      },
      required: ['note', 'summary', 'bullets'],
    },
  },
  {
    name: 'plan_skill_gaps',
    description:
      'Submit a prioritised learning plan for the skills the candidate is missing (from compute_match). Each gap gets a concrete 1-2 week plan and a free resource.',
    input_schema: {
      type: 'object',
      properties: {
        note,
        gaps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              skill: { type: 'string' },
              priority: { type: 'string', enum: ['high', 'medium', 'low'] },
              why: { type: 'string', description: 'Why this job needs it.' },
              plan: { type: 'string', description: 'Concrete steps, e.g. a mini-project to build.' },
              resource: { type: 'string', description: 'A well-known free resource (official docs, course name).' },
            },
            required: ['skill', 'priority', 'why', 'plan', 'resource'],
          },
        },
      },
      required: ['note', 'gaps'],
    },
  },
  {
    name: 'write_cover_letter',
    description:
      'Submit a tailored cover letter (220-320 words). Reference the company and role from the job description, connect 2-3 real resume achievements to the job requirements, and avoid clichés.',
    input_schema: {
      type: 'object',
      properties: { note, text: { type: 'string', description: 'The full cover letter.' } },
      required: ['note', 'text'],
    },
  },
  {
    name: 'prepare_interview',
    description:
      'Submit 6-8 likely interview questions for this role, mixing technical, behavioural and gap-probing questions, each with a tip that uses the candidate\'s real experience.',
    input_schema: {
      type: 'object',
      properties: {
        note,
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              type: { type: 'string', enum: ['technical', 'behavioural', 'gap'] },
              tip: { type: 'string', description: 'How this candidate should answer, citing their experience.' },
            },
            required: ['question', 'type', 'tip'],
          },
        },
      },
      required: ['note', 'questions'],
    },
  },
  {
    name: 'finish',
    description: 'Finish the run with a final recommendation. Call this last, after all other deliverables are submitted.',
    input_schema: {
      type: 'object',
      properties: {
        note,
        verdict: { type: 'string', enum: ['apply_now', 'apply_after_upskilling', 'not_a_fit'] },
        headline: { type: 'string', description: 'One-sentence recommendation for the candidate.' },
        next_steps: { type: 'array', items: { type: 'string' }, description: '3-5 concrete next steps.' },
      },
      required: ['note', 'verdict', 'headline', 'next_steps'],
    },
  },
];

const DEFS = Object.fromEntries(TOOL_DEFINITIONS.map((t) => [t.name, t]));

/** Minimal validation: required fields present, arrays are arrays, enums respected. */
export function validateInput(name, input) {
  const def = DEFS[name];
  if (!def) return `Unknown tool "${name}".`;
  if (!input || typeof input !== 'object') return 'Input must be an object.';
  const { properties, required = [] } = def.input_schema;
  for (const key of required) {
    if (input[key] === undefined || input[key] === null || input[key] === '') return `Missing required field "${key}".`;
  }
  for (const [key, schema] of Object.entries(properties)) {
    const v = input[key];
    if (v === undefined) continue;
    if (schema.type === 'array' && !Array.isArray(v)) return `"${key}" must be an array.`;
    if (schema.type === 'string' && typeof v !== 'string') return `"${key}" must be a string.`;
    if (schema.enum && !schema.enum.includes(v)) return `"${key}" must be one of ${schema.enum.join(', ')}.`;
    if (schema.type === 'array' && schema.items?.required) {
      for (const [i, item] of v.entries()) {
        for (const r of schema.items.required) {
          if (!item || item[r] === undefined || item[r] === '') return `"${key}[${i}]" is missing "${r}".`;
        }
      }
    }
  }
  return null;
}

/** Apply tailored summary + bullets to the resume text (used to re-score). */
export function applyTailoring(resume, { summary, bullets }) {
  let out = String(resume);
  for (const b of bullets || []) {
    if (b.original && out.includes(b.original)) out = out.replace(b.original, b.rewritten);
    else out += `\n- ${b.rewritten}`;
  }
  return `${summary || ''}\n${out}`;
}

export function createState(resume, job) {
  return { resume, job, report: {} };
}

/**
 * Execute a tool. Returns { result, report } where `result` goes back to the model
 * and `report` (optional) is a { key, data } pair for the UI.
 */
export function executeTool(name, input, state) {
  const error = validateInput(name, input);
  if (error) return { result: { error }, isError: true };

  switch (name) {
    case 'analyze_documents': {
      const data = {
        resumeSkills: extractSkills(state.resume).map((s) => s.skill),
        jobSkills: extractSkills(state.job).map((s) => s.skill),
        resumeYears: extractYears(state.resume),
        requiredYears: extractYears(state.job),
        bullets: extractBullets(state.resume),
        resumeWords: state.resume.split(/\s+/).filter(Boolean).length,
      };
      return { result: data, report: { key: 'analysis', data } };
    }
    case 'compute_match': {
      const data = computeMatch(state.resume, state.job);
      state.baseline = data;
      return { result: data, report: { key: 'match', data } };
    }
    case 'tailor_resume': {
      const before = state.baseline ?? computeMatch(state.resume, state.job);
      const tailored = applyTailoring(state.resume, input);
      const after = computeMatch(tailored, state.job);
      const data = { summary: input.summary, bullets: input.bullets, scoreBefore: before.score, scoreAfter: after.score };
      return {
        result: { scoreBefore: before.score, scoreAfter: after.score, stillMissing: after.missingSkills.map((s) => s.skill) },
        report: { key: 'tailored', data },
      };
    }
    case 'plan_skill_gaps':
      return { result: { saved: input.gaps.length }, report: { key: 'gaps', data: input.gaps } };
    case 'write_cover_letter': {
      const words = input.text.split(/\s+/).filter(Boolean).length;
      return { result: { saved: true, words }, report: { key: 'coverLetter', data: { text: input.text, words } } };
    }
    case 'prepare_interview':
      return { result: { saved: input.questions.length }, report: { key: 'interview', data: input.questions } };
    case 'finish': {
      const data = { verdict: input.verdict, headline: input.headline, nextSteps: input.next_steps };
      return { result: { done: true }, report: { key: 'verdict', data }, done: true };
    }
    default:
      return { result: { error: `Unknown tool "${name}".` }, isError: true };
  }
}

/** Short human-readable summary of a tool result, for the live trace. */
export function summarizeResult(name, result) {
  if (result?.error) return `Error: ${result.error}`;
  switch (name) {
    case 'analyze_documents':
      return `Found ${result.resumeSkills.length} skills in resume, ${result.jobSkills.length} in job description, ${result.bullets.length} bullets to improve.`;
    case 'compute_match':
      return `Match score ${result.score}/100 — ${result.matchedSkills.length} skills matched, ${result.missingSkills.length} missing.`;
    case 'tailor_resume':
      return `Score after tailoring: ${result.scoreBefore} → ${result.scoreAfter}.`;
    case 'plan_skill_gaps':
      return `Learning plan saved for ${result.saved} skill gaps.`;
    case 'write_cover_letter':
      return `Cover letter saved (${result.words} words).`;
    case 'prepare_interview':
      return `${result.saved} interview questions prepared.`;
    case 'finish':
      return 'Final recommendation ready.';
    default:
      return 'Done.';
  }
}
