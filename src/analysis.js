// Deterministic analysis engine. These functions back the agent's tools, so the
// numbers the agent reasons about (match score, missing skills) are computed,
// not hallucinated.

// Canonical skill -> aliases. Matching is case-insensitive on word boundaries.
export const SKILL_LEXICON = {
  // Languages
  JavaScript: ['javascript', 'js', 'es6'],
  TypeScript: ['typescript', 'ts'],
  Python: ['python'],
  Java: ['java'],
  'C++': ['c\\+\\+', 'cpp'],
  C: ['c language', 'ansi c'],
  'C#': ['c#', 'csharp', '\\.net'],
  Go: ['golang', 'go lang'],
  Rust: ['rust'],
  Kotlin: ['kotlin'],
  Swift: ['swift'],
  SQL: ['sql'],
  // Frontend
  React: ['react', 'reactjs', 'react\\.js'],
  'Next.js': ['next\\.js', 'nextjs'],
  Angular: ['angular'],
  Vue: ['vue', 'vuejs', 'vue\\.js'],
  HTML: ['html', 'html5'],
  CSS: ['css', 'css3', 'tailwind', 'sass', 'scss'],
  Redux: ['redux'],
  // Backend
  'Node.js': ['node', 'nodejs', 'node\\.js'],
  Express: ['express', 'expressjs'],
  Django: ['django'],
  Flask: ['flask'],
  FastAPI: ['fastapi'],
  'Spring Boot': ['spring boot', 'springboot', 'spring'],
  'REST APIs': ['rest', 'restful', 'rest api', 'rest apis'],
  GraphQL: ['graphql'],
  Microservices: ['microservices', 'microservice'],
  // Data / ML
  'Machine Learning': ['machine learning', 'ml'],
  'Deep Learning': ['deep learning'],
  TensorFlow: ['tensorflow'],
  PyTorch: ['pytorch'],
  'scikit-learn': ['scikit-learn', 'sklearn'],
  Pandas: ['pandas'],
  NumPy: ['numpy'],
  NLP: ['nlp', 'natural language processing'],
  LLMs: ['llm', 'llms', 'large language models', 'generative ai', 'genai'],
  'Computer Vision': ['computer vision', 'opencv'],
  'Data Analysis': ['data analysis', 'data analytics'],
  'Power BI': ['power bi', 'powerbi'],
  Tableau: ['tableau'],
  // Databases
  PostgreSQL: ['postgresql', 'postgres'],
  MySQL: ['mysql'],
  MongoDB: ['mongodb', 'mongo'],
  Redis: ['redis'],
  Firebase: ['firebase'],
  // Cloud / DevOps
  AWS: ['aws', 'amazon web services', 'ec2', 's3', 'lambda'],
  Azure: ['azure'],
  GCP: ['gcp', 'google cloud'],
  Docker: ['docker', 'containers'],
  Kubernetes: ['kubernetes', 'k8s'],
  'CI/CD': ['ci/cd', 'ci cd', 'github actions', 'jenkins', 'continuous integration'],
  Git: ['git', 'github', 'gitlab'],
  Linux: ['linux', 'unix', 'bash'],
  Terraform: ['terraform'],
  // Practices
  'System Design': ['system design', 'distributed systems', 'scalable systems'],
  'Data Structures & Algorithms': ['data structures', 'algorithms', 'dsa'],
  Testing: ['unit testing', 'jest', 'pytest', 'testing', 'tdd'],
  Agile: ['agile', 'scrum', 'jira'],
  // Soft skills
  Communication: ['communication', 'communicate'],
  Leadership: ['leadership', 'led a team', 'mentored', 'mentoring'],
  'Problem Solving': ['problem solving', 'problem-solving'],
  Teamwork: ['teamwork', 'collaboration', 'collaborative', 'cross-functional'],
};

const SOFT_SKILLS = new Set(['Communication', 'Leadership', 'Problem Solving', 'Teamwork']);

const STOPWORDS = new Set(
  ('a an the and or of to in on for with by at from as is are be will you your our we ' +
    'this that these those it its their they them who what which can should must have has ' +
    'experience years year work working role team strong ability good excellent knowledge ' +
    'skills skill using use etc including plus preferred required requirements responsibilities ' +
    'job candidate company looking opportunity build building develop developing understanding ' +
    'about across also any all into new more other such than well per within like one two three ' +
    'end big bonus count what help helps small businesses manage take part')
    .split(' '),
);

const KNOWN_ALIASES = new Set(
  Object.values(SKILL_LEXICON).flat().map((a) => a.replace(/\\/g, '')).filter((a) => /^[a-z0-9+#.-]+$/.test(a)),
);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function aliasRegex(alias) {
  // Aliases in the lexicon are already regex fragments; wrap in word-ish boundaries.
  return new RegExp(`(^|[^a-z0-9+#])(${alias})(?=$|[^a-z0-9+#])`, 'i');
}

const COMPILED = Object.entries(SKILL_LEXICON).map(([skill, aliases]) => ({
  skill,
  patterns: aliases.map(aliasRegex),
}));

/** Return canonical skills found in text, with mention counts. */
export function extractSkills(text) {
  const lower = ` ${String(text || '').toLowerCase()} `;
  const found = [];
  for (const { skill, patterns } of COMPILED) {
    let count = 0;
    for (const p of patterns) {
      const g = new RegExp(p.source, 'gi');
      count += (lower.match(g) || []).length;
    }
    if (count > 0) found.push({ skill, mentions: count, soft: SOFT_SKILLS.has(skill) });
  }
  return found.sort((a, b) => b.mentions - a.mentions);
}

/** Pull the largest "N+ years" figure from text, or null. */
export function extractYears(text) {
  const matches = [...String(text || '').matchAll(/(\d{1,2})\s*\+?\s*(?:years|yrs)/gi)];
  if (!matches.length) return null;
  return Math.max(...matches.map((m) => Number(m[1])));
}

/** Top non-stopword keywords in the job description (for ATS keyword coverage).
 *  Proper nouns (company, city) are skipped unless they are known skills. */
export function extractKeywords(text, limit = 20) {
  const counts = new Map();
  const lowercaseSeen = new Set();
  for (const raw of String(text || '').match(/[A-Za-z][A-Za-z+#.-]{2,}/g) || []) {
    const word = raw.toLowerCase().replace(/[.-]+$/, '');
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
    if (raw[0] === raw[0].toLowerCase()) lowercaseSeen.add(word);
  }
  return [...counts.entries()]
    .filter(([word, n]) => (lowercaseSeen.has(word) || KNOWN_ALIASES.has(word)) && (n >= 2 || KNOWN_ALIASES.has(word)))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}

/**
 * Compute an ATS-style fit score between a resume and a job description.
 * Weighted: 60% hard-skill coverage, 15% soft-skill coverage, 25% keyword coverage.
 */
export function computeMatch(resume, job) {
  const jobSkills = extractSkills(job);
  const resumeSkills = new Set(extractSkills(resume).map((s) => s.skill));

  const hard = jobSkills.filter((s) => !s.soft);
  const soft = jobSkills.filter((s) => s.soft);
  const matched = jobSkills.filter((s) => resumeSkills.has(s.skill)).map((s) => s.skill);
  const missing = jobSkills.filter((s) => !resumeSkills.has(s.skill));

  // Skills mentioned more often in the JD weigh more.
  const weighted = (list) => {
    const total = list.reduce((n, s) => n + s.mentions, 0);
    if (!total) return 1;
    return list.filter((s) => resumeSkills.has(s.skill)).reduce((n, s) => n + s.mentions, 0) / total;
  };

  const keywords = extractKeywords(job);
  const resumeLower = String(resume || '').toLowerCase();
  const keywordHits = keywords.filter((k) => new RegExp(`\\b${escapeRe(k.replace(/s$/, ''))}`, 'i').test(resumeLower));
  const keywordCoverage = keywords.length ? keywordHits.length / keywords.length : 1;

  const hardScore = weighted(hard);
  const softScore = weighted(soft);
  const score = Math.round((hardScore * 0.6 + softScore * 0.15 + keywordCoverage * 0.25) * 100);

  const requiredYears = extractYears(job);
  const resumeYears = extractYears(resume);

  return {
    score,
    breakdown: {
      hardSkills: Math.round(hardScore * 100),
      softSkills: Math.round(softScore * 100),
      keywords: Math.round(keywordCoverage * 100),
    },
    matchedSkills: matched,
    missingSkills: missing.map((s) => ({
      skill: s.skill,
      importance: s.mentions >= 2 ? 'high' : 'medium',
      soft: s.soft,
    })),
    missingKeywords: keywords.filter((k) => !keywordHits.includes(k)).slice(0, 12),
    experience: { requiredYears, resumeYears },
    verdict: score >= 75 ? 'strong' : score >= 50 ? 'moderate' : 'weak',
  };
}

/** Resume bullet points worth rewriting. Prefers real bullets (-, *, •). */
export function extractBullets(resume, limit = 8) {
  const lines = String(resume || '').split(/\r?\n/);
  const isBullet = (l) => /^\s*[-*•▪●]\s+/.test(l);
  const clean = (l) => l.replace(/^\s*[-*•▪●]\s*/, '').trim();
  const usable = (l) => l.length > 30 && l.length < 300 && !/[@|]/.test(l) && (l.match(/,/g) || []).length < 5 && !/:$/.test(l);
  const bullets = lines.filter(isBullet).map(clean).filter(usable);
  return (bullets.length ? bullets : lines.map(clean).filter(usable)).slice(0, limit);
}
