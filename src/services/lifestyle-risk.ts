/**
 * Lifestyle Risk — turns the user's consultation answers into explicit, ranked
 * risks. This runs in code, not in the LLM, so a worrying answer ("I don't eat",
 * "I don't sleep") can never be smoothed over by a friendly-sounding report.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type Severity = 'critical' | 'high' | 'moderate';
export type LifestyleLevel = Severity | 'low';

export type RiskTopic =
  | 'sleep'
  | 'eating'
  | 'water'
  | 'stress'
  | 'sun'
  | 'smoking'
  | 'alcohol'
  | 'exercise'
  | 'disordered_eating'
  | 'fainting'
  | 'self_harm';

const EATING_PATTERNS = [
  'regular',
  'irregular',
  'skips_meals',
  'intermittent_fasting',
  'extended_fasting',
  'not_eating',
] as const;
const STRESS_LEVELS = ['low', 'moderate', 'high', 'severe'] as const;
const SKINCARE_LEVELS = ['none', 'basic', 'full', 'prescription'] as const;
const SUN_PROTECTION = ['daily', 'sometimes', 'never'] as const;
const ALCOHOL_LEVELS = ['none', 'occasional', 'frequent', 'heavy'] as const;
const EXERCISE_LEVELS = ['none', 'light', 'regular'] as const;

export interface LifestyleProfile {
  sleepHours: number | null;
  waterLiters: number | null;
  mealsPerDay: number | null;
  eatingPattern: (typeof EATING_PATTERNS)[number] | null;
  stress: (typeof STRESS_LEVELS)[number] | null;
  skincare: (typeof SKINCARE_LEVELS)[number] | null;
  sunProtection: (typeof SUN_PROTECTION)[number] | null;
  smoking: boolean | null;
  alcohol: (typeof ALCOHOL_LEVELS)[number] | null;
  exercise: (typeof EXERCISE_LEVELS)[number] | null;
}

export type SafetyFlagId =
  | 'not_eating'
  | 'eating_very_little'
  | 'disordered_eating'
  | 'no_sleep'
  | 'sleep_problem'
  | 'fainting'
  | 'self_harm'
  | 'not_drinking';

export interface SafetyFlag {
  id: SafetyFlagId;
  topic: RiskTopic;
  severity: Severity;
  /** Short description, e.g. "Not eating". */
  label: string;
  /** The user's own words, for the report brief. */
  quote: string;
}

export interface LifestyleRisk {
  topic: RiskTopic;
  severity: Severity;
  /** Short tag text, e.g. "Severe sleep deprivation". */
  label: string;
  /** What the user reported, in plain words. */
  detail: string;
  seeDoctor: boolean;
}

export interface LifestyleAssessment {
  level: LifestyleLevel;
  /** Most severe first. */
  risks: LifestyleRisk[];
  profile: LifestyleProfile;
}

export type VerdictLevel = 'good' | 'fair' | 'attention' | 'urgent';

export interface Verdict {
  level: VerdictLevel;
  label: string;
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, moderate: 2 };

export function emptyProfile(): LifestyleProfile {
  return {
    sleepHours: null,
    waterLiters: null,
    mealsPerDay: null,
    eatingPattern: null,
    stress: null,
    skincare: null,
    sunProtection: null,
    smoking: null,
    alcohol: null,
    exercise: null,
  };
}

// ── Safety statements (regex safety net, independent of the LLM) ────────────

interface SafetyPattern {
  id: SafetyFlagId;
  topic: RiskTopic;
  severity: Severity;
  pattern: RegExp;
  /** Ignore the match when the clause denies it ("I've never fainted", "no suicidal thoughts"). */
  negatable?: boolean;
}

const NEGATION = "(?:don't|dont|do not|never)";
const FILLER = '(?:really |even |ever )?';
// The statement must end its clause (optionally with "anything"/"food"), so
// "I don't eat junk food", "I don't eat anything after 8pm" or "I never sleep
// less than 7 hours" don't match. Conjunctions and time words also end it.
const clauseEnd = (conjunctions: string) =>
  `(?=\\s*(?:$|[.,!?;)]|(?:${conjunctions})\\b|at all\\b|all day\\b|anymore\\b|these days\\b|lately\\b|nowadays\\b|recently\\b|for (?:\\w+ )?(?:days?|nights?|weeks?)\\b))`;
const CLAUSE_END = clauseEnd('and|or|nor|but');
const OBJECT = '(?: (?:anything|any food|food))?';

const regex = (source: string) => new RegExp(source, 'g');

/** Ends a phrase that also has everyday uses ("end it with him", "wake up early"). */
const PHRASE_END = '(?=\\s*(?:$|[.,!?;)]|(?:and|but|now|tonight|soon|forever)\\b))';

// Ways people say they want to die. A false alarm is the safer mistake here, so
// only phrases with common everyday meanings get extra guards.
const SELF_HARM = [
  'kill(?:ed|ing)? myself',
  'suicid\\w*',
  'end(?:ing)? (?:my (?:own )?life|it all)',
  'take my (?:own )?life',
  'self[- ]?harm\\w*',
  `(?:want|going|ready|planning|need) to end it${PHRASE_END}`,
  '(?:think|thinking|thought|thoughts) (?:of|about) ending (?:it|things|everything|my life)',
  `(?:don't|dont|do not|never) want to (?:live|be alive|(?:wake up|be here)(?: again| anymore| any more)?${PHRASE_END})`,
  'want(?:ed)? to die',
  'better off dead',
  '(?:better off|happier) without me',
  `(?:i'd|i would) rather (?:be dead|die|not (?:be alive|exist|wake up(?: again)?${PHRASE_END}))(?! than\\b)`,
  "wish (?:i|i'd) (?:was|were|had been) dead",
  'wish i (?:had )?never (?:been born|woken up|woke up)',
  "wish i (?:wasn't|weren't|was not|were not) (?:alive|born)",
  "wish i didn't exist",
  `(?:want to|wish i could) disappear${PHRASE_END}`,
  'no (?:will|reason|desire|point) (?:to|in) (?:live|living|go on|going on)',
  "(?:isn't|is not|not|no longer) worth living",
  '(?<![\\d.]\\s?)kms', // "kill myself" in chat slang; "5 kms" is a distance
];

/** "2 hours of sleep", "2-3 hrs sleep", "sleep 2 to 3 hours", "sleeping only about 4h". */
function sleepHours(amounts: string, upTo: string): RegExp {
  const hours = `(?:${amounts})(?: ?(?:-|to|or) ?(?:${upTo}))? ?(?:hours?|hrs?|h)\\b`;
  return regex(`\\b${hours} (?:of )?sleep|\\bsleep(?:ing)? (?:only |just |about |around |like |maybe |roughly )*(?:for )?${hours}`);
}

const SAFETY_PATTERNS: SafetyPattern[] = [
  // Eating
  { id: 'not_eating', topic: 'eating', severity: 'critical', pattern: regex(`\\b${NEGATION} ${FILLER}eat(?:ing)?${OBJECT}${CLAUSE_END}`) },
  { id: 'not_eating', topic: 'eating', severity: 'critical', pattern: regex(`\\b${NEGATION} ${FILLER}sleep (?:or|and|nor) eat\\b`) },
  { id: 'not_eating', topic: 'eating', severity: 'critical', pattern: regex(`\\bnot ${FILLER}eating${OBJECT}${CLAUSE_END}`) },
  {
    id: 'not_eating',
    topic: 'eating',
    severity: 'critical',
    pattern: regex(`\\b(?:haven't|havent|have not|hasn't) ${FILLER}eaten${OBJECT}(?=\\s*(?:$|[.,!?;)]|(?:and|or|but)\\b|in\\b|for\\b|since\\b|at all\\b))`),
  },
  { id: 'not_eating', topic: 'eating', severity: 'critical', pattern: regex(`\\b(?:stopped|quit) eating${CLAUSE_END}`) },
  // "nothing but rice" means only rice, so "but" doesn't end this one.
  { id: 'not_eating', topic: 'eating', severity: 'critical', pattern: regex(`\\beat(?:ing)? nothing${clauseEnd('and|or|nor')}`) },
  { id: 'not_eating', topic: 'eating', severity: 'critical', pattern: /\bskip(?:ping)? (?:all|every) (?:of )?(?:my )?meals?\b/g },
  { id: 'not_eating', topic: 'eating', severity: 'critical', pattern: /\b(?:zero|0) meals?\b/g },
  {
    // Its own topic: how much someone eats (or a meal count) must never hide it.
    id: 'disordered_eating',
    topic: 'disordered_eating',
    severity: 'critical',
    negatable: true,
    pattern: /\b(?:starv(?:e|ing) myself|purg(?:e|ing)\b|make myself (?:throw up|vomit|sick)|throw(?:ing)? up after (?:eating|meals?|food))/g,
  },
  { id: 'eating_very_little', topic: 'eating', severity: 'high', pattern: regex(`\\b(?:barely|hardly) eat(?:ing)?${OBJECT}${CLAUSE_END}`) },
  {
    id: 'eating_very_little',
    topic: 'eating',
    severity: 'high',
    pattern: regex(`\\b(?:(?:don't|dont|do not) eat|not eating) (?:much|enough|properly|regularly)${CLAUSE_END}`),
  },
  { id: 'eating_very_little', topic: 'eating', severity: 'high', pattern: /\bskip(?:ping)? (?:most|many) (?:of )?(?:my )?meals\b/g },
  {
    id: 'eating_very_little',
    topic: 'eating',
    severity: 'high',
    pattern: regex(`\\b(?:haven't|havent|have not|hasn't|didn't|didnt|did not) ${FILLER}(?:eat|eaten)${OBJECT} (?:today|all day|this morning)\\b`),
  },

  // Sleep
  { id: 'no_sleep', topic: 'sleep', severity: 'critical', pattern: regex(`\\b${NEGATION} ${FILLER}sleep${CLAUSE_END}`) },
  { id: 'no_sleep', topic: 'sleep', severity: 'critical', pattern: regex(`\\b${NEGATION} ${FILLER}eat (?:or|and|nor) sleep\\b`) },
  { id: 'no_sleep', topic: 'sleep', severity: 'critical', pattern: regex(`\\bnot ${FILLER}sleeping${CLAUSE_END}`) },
  {
    id: 'no_sleep',
    topic: 'sleep',
    severity: 'critical',
    pattern: /\bno sleep(?=\s*(?:$|[.,!?;)]|(?:and|or|but)\b|at all\b|for\b|in\b|lately\b|these days\b))/g,
  },
  {
    id: 'no_sleep',
    topic: 'sleep',
    severity: 'critical',
    pattern: regex(`\\b(?:haven't|havent|have not|hasn't) ${FILLER}slept(?=\\s*(?:$|[.,!?;)]|(?:and|or|but)\\b|in\\b|for\\b|since\\b|at all\\b))`),
  },
  {
    id: 'no_sleep',
    topic: 'sleep',
    severity: 'critical',
    pattern: sleepHours('0|zero|1|one|2|two|3|three', '1|2|3|4|one|two|three|four'),
  },
  { id: 'sleep_problem', topic: 'sleep', severity: 'high', pattern: /\b(?:can't|cant|cannot|can not) (?:really )?sleep\b/g },
  { id: 'sleep_problem', topic: 'sleep', severity: 'high', pattern: /\b(?:barely|hardly) sleep\b/g },
  { id: 'sleep_problem', topic: 'sleep', severity: 'high', negatable: true, pattern: /\binsomnia\b/g },
  {
    id: 'sleep_problem',
    topic: 'sleep',
    severity: 'high',
    pattern:
      /\b(?:don't|dont|do not) (?:get )?(?:sleep (?:much|well|enough|properly)|(?:much|enough) sleep)\b|\bnot sleeping (?:much|well|enough|properly)\b/g,
  },
  { id: 'sleep_problem', topic: 'sleep', severity: 'high', pattern: sleepHours('4|four|5|five', '5|6|five|six') },

  // Fainting, self-harm, water
  {
    id: 'fainting',
    topic: 'fainting',
    severity: 'critical',
    negatable: true,
    pattern: /\bfaint(?:ed|ing)\b|\bi (?:often |sometimes |keep )?faint\b|\bpass(?:ed|ing)? out\b|\bblack(?:ed|ing) out\b|\bcollaps(?:ed|ing)\b/g,
  },
  { id: 'self_harm', topic: 'self_harm', severity: 'critical', negatable: true, pattern: regex(`\\b(?:${SELF_HARM.join('|')})\\b`) },
  {
    // Cutting or hurting oneself counts only with intent ("I cut myself shaving" doesn't).
    id: 'self_harm',
    topic: 'self_harm',
    severity: 'critical',
    negatable: true,
    pattern:
      /\b(?:cut|cutting|hurt|hurting|harm|harming|burn|burning) myself (?:on purpose|deliberately|intentionally)\b|\b(?:want|wanted|thinking about|thought about|urge) (?:to )?(?:cut|hurt|harm|burn) myself\b/g,
  },
  {
    id: 'not_drinking',
    topic: 'water',
    severity: 'high',
    pattern: /\b(?:don't|dont|do not|never|barely|hardly) (?:really )?drink (?:any |much |enough )?water\b/g,
  },
];

const FLAG_LABELS: Record<SafetyFlagId, string> = {
  not_eating: 'Not eating',
  eating_very_little: 'Eating very little',
  disordered_eating: 'Signs of disordered eating',
  no_sleep: 'Severe sleep deprivation',
  sleep_problem: 'Trouble sleeping',
  fainting: 'Fainting episodes',
  self_harm: 'Thoughts of self-harm',
  not_drinking: 'Barely drinks water',
};

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// A denial counts only when the negation governs the statement directly: "never
// fainted", "no suicidal thoughts", "don't have insomnia", "haven't had any
// fainting episodes", "no dizziness or fainting". Any other words in between ("I'm
// not okay and I want to die", "I don't know why I fainted") mean the negation
// belongs to something else, so the flag stands: here a false alarm is the safer mistake.
const DENIAL = new RegExp(
  "\\b(?:never|not|no|without|nor|don't|dont|do not|doesn't|didn't|haven't|havent|hasn't|have not|isn't|wasn't|aren't|won't|wouldn't)" +
    '(?: (?:really|ever|actually|at all|any|a|an|have|had|has|been|be|feel|feeling|felt|get|got|history of|thoughts? of|thought about|thinking (?:about|of)|signs? of|episodes? of))*' +
    '(?: \\w+(?: \\w+)? (?:or|nor))?' +
    ' ?$'
);

/** True when a negation directly governs the statement that starts at `index`. */
function deniedBefore(text: string, index: number): boolean {
  return DENIAL.test(text.slice(0, index));
}

/**
 * Finds statements that are a health concern on their own, whatever the LLM
 * makes of them. Returns at most one flag per topic (the most severe).
 */
export function detectSafetyFlags(text: string): SafetyFlag[] {
  const normalized = normalizeText(text);
  const byTopic = new Map<RiskTopic, SafetyFlag>();

  for (const { id, topic, severity, pattern, negatable } of SAFETY_PATTERNS) {
    const stated = [...normalized.matchAll(pattern)].some((m) => !negatable || !deniedBefore(normalized, m.index ?? 0));
    if (!stated) continue;
    const existing = byTopic.get(topic);
    if (!existing || SEVERITY_RANK[severity] < SEVERITY_RANK[existing.severity]) {
      byTopic.set(topic, { id, topic, severity, label: FLAG_LABELS[id], quote: text.trim().slice(0, 160) });
    }
  }

  return [...byTopic.values()].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

// ── Risk rules ───────────────────────────────────────────────────────────────

function risk(topic: RiskTopic, severity: Severity, label: string, detail: string, seeDoctor = false): LifestyleRisk {
  return { topic, severity, label, detail, seeDoctor: seeDoctor || severity === 'critical' };
}

const formatAmount = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function sleepRisk(p: LifestyleProfile): LifestyleRisk | null {
  const h = p.sleepHours;
  if (h === null) return null;
  const detail = `Sleeps about ${formatAmount(h)} hours a night`;
  if (h < 4) return risk('sleep', 'critical', 'Severe sleep deprivation', detail);
  if (h < 6) return risk('sleep', 'high', 'Not enough sleep', detail);
  if (h < 7) return risk('sleep', 'moderate', 'Slightly short on sleep', detail);
  return null;
}

function eatingRisk(p: LifestyleProfile): LifestyleRisk | null {
  const meals = p.mealsPerDay;
  if (p.eatingPattern === 'not_eating' || (meals !== null && meals < 1)) {
    return risk('eating', 'critical', 'Not eating', 'Says they are not eating');
  }
  if (p.eatingPattern === 'extended_fasting') {
    return risk('eating', 'high', 'Long fasts without food', 'Fasts for long stretches without food', true);
  }
  if (meals !== null && meals < 2) {
    return risk('eating', 'high', 'Eating only one meal a day', 'Eats about one meal a day');
  }
  if (p.eatingPattern === 'skips_meals') return risk('eating', 'moderate', 'Often skips meals', 'Often skips meals');
  if (p.eatingPattern === 'irregular') return risk('eating', 'moderate', 'Irregular meals', 'Eats at irregular times');
  return null;
}

function waterRisk(p: LifestyleProfile): LifestyleRisk | null {
  const l = p.waterLiters;
  if (l === null) return null;
  const detail = `Drinks about ${formatAmount(l)} litres of water a day`;
  if (l < 1) return risk('water', 'high', 'Very low water intake', detail);
  if (l < 1.5) return risk('water', 'moderate', 'Low water intake', detail);
  return null;
}

function habitRisks(p: LifestyleProfile): LifestyleRisk[] {
  const risks: LifestyleRisk[] = [];
  if (p.stress === 'severe') risks.push(risk('stress', 'high', 'Very high stress', 'Describes their stress as severe'));
  else if (p.stress === 'high') risks.push(risk('stress', 'moderate', 'High stress', 'Describes their stress as high'));
  if (p.sunProtection === 'never') risks.push(risk('sun', 'moderate', 'No sun protection', 'Never uses sun protection'));
  if (p.smoking === true) risks.push(risk('smoking', 'high', 'Smoking', 'Smokes'));
  if (p.alcohol === 'heavy') risks.push(risk('alcohol', 'high', 'Heavy drinking', 'Drinks alcohol heavily'));
  else if (p.alcohol === 'frequent') risks.push(risk('alcohol', 'moderate', 'Frequent drinking', 'Drinks alcohol often'));
  if (p.exercise === 'none') risks.push(risk('exercise', 'moderate', 'Little physical activity', 'Gets no exercise'));
  return risks;
}

function flagRisk(flag: SafetyFlag): LifestyleRisk {
  return risk(flag.topic, flag.severity, flag.label, `Said: "${flag.quote}"`);
}

/**
 * Whether the extracted answers give a concrete figure for a topic. Only a figure
 * overrides a keyword flag; a vague category ("irregular") can't soften "I don't eat".
 */
function measured(profile: LifestyleProfile, topic: RiskTopic): boolean {
  if (topic === 'sleep') return profile.sleepHours !== null;
  if (topic === 'eating') return profile.mealsPerDay !== null;
  if (topic === 'water') return profile.waterLiters !== null;
  return false; // disordered eating, fainting and self-harm have no extracted figure, so their flags always stand
}

/**
 * Combines the structured answers with any safety statements into ranked risks.
 * A keyword flag is the safety net: it counts unless the extraction gives a
 * concrete figure on that topic (which saw the question and any follow-up, e.g.
 * "I don't eat" about breakfast, then "lunch and dinner"). Otherwise the more
 * severe reading wins.
 */
export function assessLifestyle(profile: LifestyleProfile, safetyFlags: SafetyFlag[] = []): LifestyleAssessment {
  const candidates = [
    sleepRisk(profile),
    eatingRisk(profile),
    waterRisk(profile),
    ...habitRisks(profile),
    ...safetyFlags.filter((f) => !measured(profile, f.topic)).map(flagRisk),
  ].filter((r): r is LifestyleRisk => r !== null);

  const byTopic = new Map<RiskTopic, LifestyleRisk>();
  for (const candidate of candidates) {
    const existing = byTopic.get(candidate.topic);
    if (!existing || SEVERITY_RANK[candidate.severity] < SEVERITY_RANK[existing.severity]) {
      byTopic.set(candidate.topic, candidate);
    }
  }

  const risks = [...byTopic.values()].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return { level: risks[0]?.severity ?? 'low', risks, profile };
}

// ── LLM extraction validation ────────────────────────────────────────────────

function parseNumber(value: unknown, min: number, max: number): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function parseChoice<T extends string>(value: unknown, choices: readonly T[]): T | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return (choices as readonly string[]).includes(normalized) ? (normalized as T) : null;
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === 'no') return false;
  return null;
}

const PROFILE_KEYS = Object.keys(emptyProfile());

/** The model sometimes nests the answers ({"answers": {...}}): use the one object that holds them. */
function unwrap(o: Record<string, unknown>): Record<string, unknown> {
  if (PROFILE_KEYS.some((k) => k in o)) return o;
  const objects = Object.values(o).filter(
    (v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  );
  return objects.length === 1 ? unwrap(objects[0]) : o;
}

/** Validates the LLM's extracted answers; anything unusable becomes null. */
export function parseLifestyleProfile(raw: unknown): LifestyleProfile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyProfile();
  const o = unwrap(raw as Record<string, unknown>);
  return {
    sleepHours: parseNumber(o.sleepHours, 0, 24),
    waterLiters: parseNumber(o.waterLiters, 0, 15),
    mealsPerDay: parseNumber(o.mealsPerDay, 0, 12),
    eatingPattern: parseChoice(o.eatingPattern, EATING_PATTERNS),
    stress: parseChoice(o.stress, STRESS_LEVELS),
    skincare: parseChoice(o.skincare, SKINCARE_LEVELS),
    sunProtection: parseChoice(o.sunProtection, SUN_PROTECTION),
    smoking: parseBoolean(o.smoking),
    alcohol: parseChoice(o.alcohol, ALCOHOL_LEVELS),
    exercise: parseChoice(o.exercise, EXERCISE_LEVELS),
  };
}

// ── Overall verdict ──────────────────────────────────────────────────────────

const VERDICT_LABELS: Record<VerdictLevel, string> = {
  urgent: 'Please see a doctor',
  attention: 'Needs attention',
  fair: 'A few things to work on',
  good: 'Looking good',
};

/**
 * The headline for the report: the worse of the skin score and the lifestyle
 * risk. Never "good" when the answers couldn't be read or the score is missing.
 */
export function overallVerdict(
  skinHealthScore: number,
  lifestyleLevel: LifestyleLevel,
  opts: { incomplete?: boolean } = {}
): Verdict {
  let level: VerdictLevel = 'good';
  if (lifestyleLevel === 'critical') level = 'urgent';
  else if (lifestyleLevel === 'high' || skinHealthScore < 60) level = 'attention';
  else if (lifestyleLevel === 'moderate' || skinHealthScore < 80) level = 'fair';
  else if (!Number.isFinite(skinHealthScore) || opts.incomplete) level = 'fair';
  return { level, label: VERDICT_LABELS[level] };
}
