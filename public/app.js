import { SAMPLE_JOB, SAMPLE_RESUME } from './samples.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const TOOL_LABELS = {
  analyze_documents: 'Analyse documents',
  compute_match: 'Compute match score',
  tailor_resume: 'Tailor resume',
  plan_skill_gaps: 'Plan skill gaps',
  write_cover_letter: 'Write cover letter',
  prepare_interview: 'Prepare interview',
  finish: 'Final recommendation',
};
const VERDICTS = {
  apply_now: 'Apply now',
  apply_after_upskilling: 'Apply after upskilling',
  not_a_fit: 'Not a fit yet',
};

let report = {};
let running = false;

// ---------- inputs ----------
const wordCount = (t) => t.trim().split(/\s+/).filter(Boolean).length;
for (const id of ['resume', 'job']) {
  const el = $(id);
  const update = () => { $(`${id}Count`).textContent = `${wordCount(el.value)} words`; };
  el.addEventListener('input', update);
  $(`${id}File`).addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) { el.value = await file.text(); update(); }
  });
}
$('sampleBtn').addEventListener('click', () => {
  $('resume').value = SAMPLE_RESUME;
  $('job').value = SAMPLE_JOB;
  $('resume').dispatchEvent(new Event('input'));
  $('job').dispatchEvent(new Event('input'));
});

fetch('/api/health').then((r) => r.json()).then((h) => {
  const badge = $('modeBadge');
  badge.textContent = h.mode === 'claude' ? `Live agent · ${h.model}` : 'Demo mode';
  badge.classList.add(h.mode === 'claude' ? 'live' : 'demo');
  badge.title = h.mode === 'claude' ? 'Claude decides each step through tool calls.' : 'No API key set: a built-in agent runs the same tools with templates.';
}).catch(() => { $('modeBadge').textContent = 'Offline'; });

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => showTab(tab.dataset.tab)));
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
}
const panel = (name) => document.querySelector(`[data-panel="${name}"]`);
function markTab(name) {
  const tab = document.querySelector(`.tab[data-tab="${name}"]`);
  if (tab && !tab.querySelector('.dot')) tab.insertAdjacentHTML('beforeend', '<span class="dot"></span>');
}

// ---------- run ----------
$('runBtn').addEventListener('click', run);

async function run() {
  if (running) return;
  const resume = $('resume').value.trim();
  const job = $('job').value.trim();
  const err = $('error');
  err.hidden = true;
  if (resume.length < 50 || job.length < 50) {
    err.textContent = 'Paste a full resume and job description first (or click "Try a sample").';
    err.hidden = false;
    return;
  }

  reset();
  running = true;
  $('runBtn').disabled = true;
  $('runBtn').textContent = 'Agent working…';
  $('results').hidden = false;
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  addPending();

  try {
    const res = await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resume, job }) });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();
      for (const part of parts) {
        const line = part.split('\n').find((l) => l.startsWith('data: '));
        if (line) handle(JSON.parse(line.slice(6)));
      }
    }
  } catch (e) {
    handle({ type: 'error', message: e.message });
  } finally {
    removePending();
    running = false;
    $('runBtn').disabled = false;
    $('runBtn').textContent = 'Run again →';
    $('downloadBtn').disabled = Object.keys(report).length === 0;
  }
}

function reset() {
  report = {};
  $('steps').innerHTML = '';
  $('scorecard').hidden = true;
  $('verdict').hidden = true;
  $('deliverables').hidden = true;
  document.querySelectorAll('.tab .dot').forEach((d) => d.remove());
  document.querySelectorAll('.panel').forEach((p) => { p.innerHTML = '<p class="muted">Waiting for the agent…</p>'; });
  showTab('tailored');
}

function addPending() {
  removePending();
  $('steps').insertAdjacentHTML('beforeend', '<li class="step running" id="pending"><div class="note muted">Thinking about the next step…</div></li>');
}
function removePending() { $('pending')?.remove(); }

function handle(ev) {
  switch (ev.type) {
    case 'mode':
      $('modeLine').textContent = ev.mode === 'claude'
        ? `Claude (${ev.model}) is choosing each tool call.`
        : 'Demo mode: built-in agent, same tools. Add an API key for the live Claude agent.';
      break;
    case 'message':
      removePending();
      $('steps').insertAdjacentHTML('beforeend', `<li class="step msg"><div class="note">${esc(ev.text)}</div></li>`);
      if (running) addPending();
      break;
    case 'step':
      removePending();
      $('steps').insertAdjacentHTML('beforeend', `<li class="step${ev.isError ? ' err' : ''}">
        <div class="tool">${esc(TOOL_LABELS[ev.tool] || ev.tool)}</div>
        <div class="note">${esc(ev.note)}</div>
        <div class="sum">${esc(ev.summary)}</div></li>`);
      if (ev.tool !== 'finish') addPending();
      break;
    case 'report':
      report[ev.key] = ev.data;
      render(ev.key, ev.data);
      break;
    case 'error':
      removePending();
      $('steps').insertAdjacentHTML('beforeend', `<li class="step err"><div class="tool">Error</div><div class="note">${esc(ev.message)}</div></li>`);
      break;
    case 'done':
      removePending();
      break;
  }
}

// ---------- renderers ----------
function render(key, data) {
  if (key === 'match') return renderMatch(data);
  if (key === 'verdict') return renderVerdict(data);
  if (key === 'analysis') return;
  $('deliverables').hidden = false;
  if (key === 'tailored') renderTailored(data);
  if (key === 'gaps') renderGaps(data);
  if (key === 'coverLetter') renderLetter(data);
  if (key === 'interview') renderInterview(data);
  markTab(key);
}

function setScore(score) {
  const circumference = 2 * Math.PI * 52;
  const fg = $('ringFg');
  fg.style.strokeDashoffset = String(circumference * (1 - score / 100));
  fg.style.stroke = score >= 75 ? 'var(--good)' : score >= 50 ? 'var(--warn)' : 'var(--bad)';
  const el = $('scoreNum');
  const from = Number(el.textContent) || 0;
  const start = performance.now();
  const tick = (t) => {
    const p = Math.min(1, (t - start) / 800);
    el.textContent = String(Math.round(from + (score - from) * p));
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function renderMatch(m) {
  $('scorecard').hidden = false;
  $('scoreTitle').innerHTML = `Match score <span class="muted small">(${esc(m.verdict)} fit)</span>`;
  setScore(m.score);
  const rows = [['Hard skills', m.breakdown.hardSkills], ['Soft skills', m.breakdown.softSkills], ['ATS keywords', m.breakdown.keywords]];
  $('bars').innerHTML = rows.map(([label, v]) => `<div class="bar-row"><span>${label}</span><div class="bar"><i style="width:${v}%"></i></div><span>${v}%</span></div>`).join('');
  $('matched').innerHTML = m.matchedSkills.map((s) => `<span class="chip ok">${esc(s)}</span>`).join('') || '<span class="muted small">None yet</span>';
  $('missing').innerHTML = m.missingSkills.map((s) => `<span class="chip miss ${s.importance === 'high' ? 'high' : ''}" title="${s.importance} importance">${esc(s.skill)}</span>`).join('') || '<span class="muted small">Nothing important missing</span>';
}

function copyBtn(id) { return `<button class="btn small ghost" data-copy="${id}">Copy</button>`; }
document.addEventListener('click', async (e) => {
  const id = e.target.dataset?.copy;
  if (!id) return;
  const text = id === 'tailored'
    ? `${report.tailored.summary}\n\n${report.tailored.bullets.map((b) => `- ${b.rewritten}`).join('\n')}`
    : report.coverLetter.text;
  await navigator.clipboard.writeText(text);
  e.target.textContent = 'Copied ✓';
  setTimeout(() => { e.target.textContent = 'Copy'; }, 1500);
});

function renderTailored(t) {
  const gain = t.scoreAfter - t.scoreBefore;
  panel('tailored').innerHTML = `
    <div class="panel-head"><strong>Tailored summary and bullets <span class="improve">${t.scoreBefore} → ${t.scoreAfter}${gain > 0 ? ` (+${gain})` : ''}</span></strong>${copyBtn('tailored')}</div>
    <div class="summary-box">${esc(t.summary)}</div>
    ${t.bullets.map((b) => `<div class="bullet"><div class="before">${esc(b.original)}</div><div class="after">${esc(b.rewritten)}</div><div class="why">${esc(b.why)}</div></div>`).join('')}`;
  if (gain > 0) setScore(t.scoreAfter);
}

function renderGaps(gaps) {
  panel('gaps').innerHTML = gaps.length ? gaps.map((g) => `
    <div class="gap"><h4>${esc(g.skill)} <span class="prio ${esc(g.priority)}">${esc(g.priority)}</span></h4>
    <p>${esc(g.why)}</p><p><strong>Plan:</strong> ${esc(g.plan)}</p><p class="res">Resource: ${esc(g.resource)}</p></div>`).join('')
    : '<p class="muted">No important gaps found.</p>';
}

function renderLetter(l) {
  panel('coverLetter').innerHTML = `<div class="panel-head"><strong>Cover letter <span class="muted small">${l.words} words</span></strong>${copyBtn('coverLetter')}</div><div class="letter">${esc(l.text)}</div>`;
}

function renderInterview(qs) {
  panel('interview').innerHTML = qs.map((q, i) => `
    <div class="qa"><span class="type ${esc(q.type)}">${esc(q.type)}</span><div class="q">${i + 1}. ${esc(q.question)}</div><div class="tip">${esc(q.tip)}</div></div>`).join('');
}

function renderVerdict(v) {
  const el = $('verdict');
  el.hidden = false;
  el.className = `card verdict ${v.verdict}`;
  el.innerHTML = `<span class="label">Recommendation · ${esc(VERDICTS[v.verdict] || v.verdict)}</span><h3>${esc(v.headline)}</h3>
    <ol>${v.nextSteps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`;
}

// ---------- export ----------
$('downloadBtn').addEventListener('click', () => {
  const r = report;
  const md = [
    '# HireMind application report',
    r.match && `## Match score: ${r.match.score}/100 (${r.match.verdict})\n\n- Hard skills: ${r.match.breakdown.hardSkills}%\n- Soft skills: ${r.match.breakdown.softSkills}%\n- ATS keywords: ${r.match.breakdown.keywords}%\n\n**Matched:** ${r.match.matchedSkills.join(', ') || 'none'}\n\n**Missing:** ${r.match.missingSkills.map((s) => s.skill).join(', ') || 'none'}`,
    r.verdict && `## Recommendation: ${VERDICTS[r.verdict.verdict]}\n\n${r.verdict.headline}\n\n${r.verdict.nextSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
    r.tailored && `## Tailored resume (score ${r.tailored.scoreBefore} → ${r.tailored.scoreAfter})\n\n${r.tailored.summary}\n\n${r.tailored.bullets.map((b) => `- ${b.rewritten}`).join('\n')}`,
    r.gaps && `## Skill gap plan\n\n${r.gaps.map((g) => `### ${g.skill} (${g.priority})\n${g.why}\n\n**Plan:** ${g.plan}\n\n**Resource:** ${g.resource}`).join('\n\n')}`,
    r.coverLetter && `## Cover letter\n\n${r.coverLetter.text}`,
    r.interview && `## Interview prep\n\n${r.interview.map((q, i) => `${i + 1}. **${q.question}** _(${q.type})_\n   ${q.tip}`).join('\n')}`,
  ].filter(Boolean).join('\n\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
  a.download = 'hiremind-report.md';
  a.click();
  URL.revokeObjectURL(a.href);
});
