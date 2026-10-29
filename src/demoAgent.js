// Offline demo agent. Used when no ANTHROPIC_API_KEY is set, so the app always
// works for a live demo. It drives the same tools in the same order as the
// Claude agent, but writes the deliverables with rules and templates.

import { createState, executeTool, summarizeResult } from './tools.js';

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

const WEAK_STARTS = [
  [/^was responsible for writing\s+/i, 'Wrote '],
  [/^(was )?responsible for\s+/i, 'Owned '],
  [/^worked on\s+/i, 'Developed '],
  [/^helped the team\s+/i, 'Partnered with the team to '],
  [/^(helped( to)?|involved in|assisted( in| with)?)\s+/i, 'Contributed to '],
  [/^(did|handled)\s+/i, 'Delivered '],
];

const STRONG_VERBS = {
  built: 'Built', developed: 'Developed', created: 'Engineered', designed: 'Designed', made: 'Built',
  implemented: 'Implemented', wrote: 'Wrote', improved: 'Improved', led: 'Led', managed: 'Led',
  analysed: 'Analysed', analyzed: 'Analysed', deployed: 'Deployed', automated: 'Automated',
};

const RESOURCES = {
  Docker: 'Docker official "Get Started" guide (docs.docker.com)',
  Kubernetes: 'Kubernetes Basics interactive tutorial (kubernetes.io)',
  AWS: 'AWS Skill Builder: Cloud Practitioner Essentials (free)',
  Azure: 'Microsoft Learn: Azure Fundamentals path',
  GCP: 'Google Cloud Skills Boost free labs',
  TypeScript: 'The TypeScript Handbook (typescriptlang.org)',
  React: 'react.dev "Learn React" tutorial',
  'Node.js': 'nodejs.org Learn guides',
  'System Design': '"System Design Primer" on GitHub (donnemartin)',
  'CI/CD': 'GitHub Actions quickstart (docs.github.com)',
  PostgreSQL: 'PostgreSQL Tutorial (postgresqltutorial.com)',
  MongoDB: 'MongoDB University free courses',
  Redis: 'Redis University: RU101',
  GraphQL: 'graphql.org "Learn" section',
  'Machine Learning': 'Andrew Ng\'s Machine Learning Specialization (audit free)',
  LLMs: 'Anthropic and OpenAI cookbook guides on GitHub',
  Testing: 'Jest / Pytest official getting-started docs',
  'Data Structures & Algorithms': 'NeetCode 150 problem list',
  Kotlin: 'Kotlin Koans (kotlinlang.org)',
  Microservices: 'microservices.io patterns by Chris Richardson',
};

function strengthen(bullet, matchedSkills) {
  let text = bullet.trim().replace(/\.$/, '');
  for (const [re, rep] of WEAK_STARTS) text = text.replace(re, rep);
  const first = text.split(/\s+/)[0]?.toLowerCase();
  if (STRONG_VERBS[first]) text = text.replace(/^\S+/, STRONG_VERBS[first]);
  else text = text.charAt(0).toUpperCase() + text.slice(1);

  // Surface a job-relevant skill the candidate already has, if the bullet hints at it.
  const lower = text.toLowerCase();
  const relevant = matchedSkills.find((s) => !lower.includes(s.toLowerCase()) && lower.includes(s.split(/[ .]/)[0].toLowerCase()));
  const hasImpact = /\d|%|reduc|increas|improv|faster|users|customers/i.test(text);
  const changed = text.toLowerCase() !== bullet.trim().replace(/\.$/, '').toLowerCase();
  let why = changed ? 'Opens with a strong action verb so recruiters see ownership.' : 'Already action-led; kept as is.';
  if (relevant) { text += ` using ${relevant}`; why = `Names ${relevant} explicitly, which the job asks for.`; }
  if (!hasImpact) why += ' Add a real number (time saved, users, %) before sending.';
  return { rewritten: `${text}.`, why };
}

function companyAndRole(job) {
  const role = (job.match(/(?:role|position|title)\s*[:\-]\s*(.+)/i)?.[1] || job.split(/\r?\n/).find((l) => l.trim())?.trim() || 'this role').slice(0, 80);
  const company = job.match(/(?:[Cc]ompany|[Oo]rgani[sz]ation|[Ee]mployer)\s*[:\-]\s*([A-Z][\w&.]*(?:\s[A-Z][\w&.]*){0,2})/)?.[1]
    || job.match(/About\s+([A-Z][\w&.]*(?:\s[A-Z][\w&.]*){0,2})/)?.[1]
    || job.match(/\bat\s+([A-Z][\w&.]+(?:\s[A-Z][\w&.]+)?)/)?.[1]
    || 'your team';
  return { role: role.replace(/[.:]$/, ''), company };
}

function candidateName(resume) {
  const first = resume.split(/\r?\n/).find((l) => l.trim());
  return first && first.trim().split(/\s+/).length <= 4 && !/[@\d]/.test(first) ? first.trim() : 'Your name';
}

export async function runDemoAgent({ resume, job, emit, signal }) {
  const state = createState(resume, job);
  const call = async (tool, input) => {
    await sleep(650, signal);
    if (signal?.aborted) return null;
    const { result, report } = executeTool(tool, input, state);
    emit({ type: 'step', tool, note: input.note, summary: summarizeResult(tool, result) });
    if (report) emit({ type: 'report', ...report });
    return result;
  };

  emit({ type: 'message', text: 'Running in demo mode (no API key set): same tools and workflow, template-based writing.' });

  const analysis = await call('analyze_documents', { note: 'Reading the resume and job description to find skills and bullets.' });
  if (!analysis) return;
  const match = await call('compute_match', { note: 'Scoring the fit before changing anything, to get a baseline.' });
  if (!match) return;

  const { role, company } = companyAndRole(job);
  const top = match.matchedSkills.slice(0, 4);
  const bullets = analysis.bullets.slice(0, 5).map((original) => ({ original, ...strengthen(original, match.matchedSkills) }));
  const years = analysis.resumeYears ? `${analysis.resumeYears}+ years of` : 'hands-on';
  const summary = `${role.split(/[,(]/)[0].trim()} candidate with ${years} experience in ${top.join(', ') || 'software development'}. ` +
    `Has shipped real projects end to end and is ready to bring that to ${company}.`;

  const tailored = await call('tailor_resume', { note: 'Rewriting the summary and weakest bullets around the job\'s keywords.', summary, bullets });
  if (!tailored) return;

  const important = match.missingSkills.filter((s) => !s.soft).slice(0, 4);
  if (important.length) {
    const gaps = important.map((g) => ({
      skill: g.skill,
      priority: g.importance === 'high' ? 'high' : 'medium',
      why: `The job description lists ${g.skill}${g.importance === 'high' ? ' more than once' : ''}, but the resume never mentions it.`,
      plan: `Spend 1-2 weeks on the fundamentals of ${g.skill}, then add it to one of your existing projects and write a short README about it so you can show it in the interview.`,
      resource: RESOURCES[g.skill] || `${g.skill} official documentation and getting-started guide`,
    }));
    if (!(await call('plan_skill_gaps', { note: 'Turning the missing skills into a short learning plan.', gaps }))) return;
  }

  const name = candidateName(resume);
  const letter = `Dear Hiring Manager,

I am writing to apply for the ${role} position at ${company}. My background in ${top.slice(0, 3).join(', ') || 'software development'} lines up closely with what your team is looking for, and I would welcome the chance to contribute.

${bullets[0] ? `In my recent work I ${bullets[0].rewritten.charAt(0).toLowerCase()}${bullets[0].rewritten.slice(1)}` : 'In my recent work I have built and shipped complete projects.'} ${bullets[1] ? `I also ${bullets[1].rewritten.charAt(0).toLowerCase()}${bullets[1].rewritten.slice(1)}` : ''}

What draws me to ${company} is the chance to work on problems where ${top[0] || 'good engineering'} makes a visible difference for users. ${important.length ? `I am actively strengthening my ${important.map((g) => g.skill).slice(0, 2).join(' and ')} skills so I can contribute across your stack from the first month.` : 'I am confident I can contribute across your stack from the first month.'}

Thank you for your time. I would be glad to discuss how I can help your team.

Sincerely,
${name}`;
  if (!(await call('write_cover_letter', { note: 'Drafting a cover letter that links real achievements to the role.', text: letter }))) return;

  const questions = [
    ...top.slice(0, 3).map((s) => ({ question: `Walk me through a project where you used ${s}. What trade-offs did you make?`, type: 'technical', tip: `Pick the strongest bullet that mentions ${s}; explain the problem, your choice, and the result.` })),
    ...important.slice(0, 2).map((g) => ({ question: `This role uses ${g.skill}. How would you get productive with it?`, type: 'gap', tip: `Be honest that it is new to you, then describe the learning plan and any mini-project you have built with ${g.skill}.` })),
    { question: 'Tell me about a time you disagreed with a teammate on a technical decision.', type: 'behavioural', tip: 'Use the STAR format and end with what the team shipped.' },
    { question: 'Describe a bug or failure you owned and what you changed afterwards.', type: 'behavioural', tip: 'Show ownership; name the process change you made, not only the fix.' },
  ];
  if (!(await call('prepare_interview', { note: 'Predicting the interview questions, including ones about the gaps.', questions }))) return;

  const verdict = tailored.scoreAfter >= 65 ? 'apply_now' : tailored.scoreAfter >= 35 ? 'apply_after_upskilling' : 'not_a_fit';
  await call('finish', {
    note: 'Wrapping up with an honest recommendation.',
    verdict,
    headline: verdict === 'apply_now'
      ? `Strong fit (${tailored.scoreAfter}/100 after tailoring). Apply this week with the tailored resume.`
      : verdict === 'apply_after_upskilling'
        ? `Reasonable fit (${tailored.scoreAfter}/100). Close the top gap first, then apply.`
        : `Big skill gap (${tailored.scoreAfter}/100). Use the learning plan before applying to roles like this.`,
    next_steps: [
      'Copy the tailored summary and bullets into your resume and add real numbers where marked.',
      important[0] ? `Start the ${important[0].skill} plan today and add it to a project.` : 'Add one more quantified achievement to the resume.',
      'Personalise the cover letter\'s third paragraph with something specific about the company.',
      'Practise the interview answers out loud using the STAR format.',
    ],
  });
  emit({ type: 'done' });
}
