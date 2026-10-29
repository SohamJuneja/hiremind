import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMatch, extractBullets, extractSkills, extractYears } from '../src/analysis.js';
import { executeTool, createState, validateInput } from '../src/tools.js';
import { runDemoAgent } from '../src/demoAgent.js';
import { SAMPLE_JOB, SAMPLE_RESUME } from '../public/samples.js';

test('extractSkills finds canonical skills via aliases', () => {
  const skills = extractSkills('Built APIs in NodeJS and ReactJS, deployed on k8s with GitHub Actions').map((s) => s.skill);
  for (const s of ['Node.js', 'React', 'Kubernetes', 'CI/CD', 'Git']) assert.ok(skills.includes(s), `missing ${s}`);
});

test('extractSkills does not match substrings', () => {
  const skills = extractSkills('I like gopher snacks and javanese coffee').map((s) => s.skill);
  assert.ok(!skills.includes('Java'));
  assert.ok(!skills.includes('Go'));
});

test('extractYears picks the largest figure', () => {
  assert.equal(extractYears('2+ years Python, 5 years total'), 5);
  assert.equal(extractYears('fresher'), null);
});

test('computeMatch: identical documents score high, unrelated score low', () => {
  assert.ok(computeMatch(SAMPLE_JOB, SAMPLE_JOB).score >= 95);
  const low = computeMatch('Chef with 10 years of experience in Italian cuisine and kitchen management.', SAMPLE_JOB);
  assert.ok(low.score < 30, `score was ${low.score}`);
});

test('computeMatch on the sample reports real gaps', () => {
  const m = computeMatch(SAMPLE_RESUME, SAMPLE_JOB);
  const missing = m.missingSkills.map((s) => s.skill);
  assert.ok(m.matchedSkills.includes('React'));
  assert.ok(missing.includes('TypeScript'));
  assert.ok(missing.includes('PostgreSQL'));
  assert.ok(m.score > 20 && m.score < 90, `score was ${m.score}`);
});

test('extractBullets strips markers and skips headings', () => {
  const bullets = extractBullets('EXPERIENCE\n- Built a full stack app with React used by 300 students\nSKILLS:');
  assert.deepEqual(bullets, ['Built a full stack app with React used by 300 students']);
});

test('validateInput rejects missing fields and bad enums', () => {
  assert.match(validateInput('write_cover_letter', { note: 'x' }), /text/);
  assert.match(validateInput('finish', { note: 'x', verdict: 'maybe', headline: 'h', next_steps: [] }), /verdict/);
  assert.equal(validateInput('compute_match', { note: 'x' }), null);
  assert.match(validateInput('nope', {}), /Unknown/);
});

test('tailor_resume re-scores the resume', () => {
  const state = createState(SAMPLE_RESUME, SAMPLE_JOB);
  executeTool('compute_match', { note: 'x' }, state);
  const { result } = executeTool('tailor_resume', {
    note: 'x',
    summary: 'Full stack developer with JavaScript, React, Node.js, communication and problem solving skills.',
    bullets: [{ original: 'Worked on the customer dashboard built in React and fixed UI bugs reported by users', rewritten: 'Improved the React customer dashboard and resolved user-reported UI bugs', why: 'verb' }],
  }, state);
  assert.ok(result.scoreAfter >= result.scoreBefore);
});

test('demo agent runs the full workflow end to end', async () => {
  const events = [];
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => origSetTimeout(fn, 0);
  try {
    await runDemoAgent({ resume: SAMPLE_RESUME, job: SAMPLE_JOB, emit: (e) => events.push(e) });
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }
  const tools = events.filter((e) => e.type === 'step').map((e) => e.tool);
  assert.deepEqual(tools, ['analyze_documents', 'compute_match', 'tailor_resume', 'plan_skill_gaps', 'write_cover_letter', 'prepare_interview', 'finish']);
  const reports = new Set(events.filter((e) => e.type === 'report').map((e) => e.key));
  for (const k of ['match', 'tailored', 'gaps', 'coverLetter', 'interview', 'verdict']) assert.ok(reports.has(k), `missing report ${k}`);
  assert.equal(events.at(-1).type, 'done');
});
