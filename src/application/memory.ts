import { AppError } from './errors.js';

// Agent memory.
//
// Memory is a single markdown document with a fixed, small taxonomy — not rows,
// not a vector store, not per-fact CRUD. `recall` returns the whole document and
// every write rewrites it. The governing invariant is the data/memory boundary
// test: if a fact could become wrong tomorrow because a transaction, balance,
// income, holding, or credit-report row changed, it is DATA, not memory, and is
// never stored. That invariant is enforced redundantly at the prompt layer AND
// here in code via `stripFinancialNumbers`.

export const MEMORY_SECTIONS = [
  'Identity',
  'Preferences',
  'Goals & Background',
  'Behavior Patterns',
] as const;

export type MemorySection = (typeof MEMORY_SECTIONS)[number];

const PLACEHOLDER = 'none yet';
const MAX_LINE = 500;

export const DEFAULT_PROFILE = `${MEMORY_SECTIONS.map((section) => `## ${section}\n- ${PLACEHOLDER}`).join('\n\n')}\n`;

// Loose `kind`/`section` strings the model may pass get mapped onto one of the
// four canonical sections. Anything unrecognized falls back to Identity.
const SECTION_ALIASES: Record<string, MemorySection> = {
  identity: 'Identity',
  profile: 'Identity',
  persona: 'Identity',
  who: 'Identity',
  preference: 'Preferences',
  preferences: 'Preferences',
  convention: 'Preferences',
  reporting: 'Preferences',
  style: 'Preferences',
  goal: 'Goals & Background',
  goals: 'Goals & Background',
  background: 'Goals & Background',
  context: 'Goals & Background',
  behavior: 'Behavior Patterns',
  behaviour: 'Behavior Patterns',
  pattern: 'Behavior Patterns',
  patterns: 'Behavior Patterns',
  habit: 'Behavior Patterns',
};

export function sectionFromKind(kind?: string | null, section?: string | null): MemorySection {
  if (section) {
    const normalized = section.trim().toLowerCase();
    const direct = MEMORY_SECTIONS.find((candidate) => candidate.toLowerCase() === normalized);
    if (direct) return direct;
    const aliased = SECTION_ALIASES[normalized];
    if (aliased) return aliased;
  }
  if (kind) {
    const aliased = SECTION_ALIASES[kind.trim().toLowerCase()];
    if (aliased) return aliased;
  }
  return 'Identity';
}

// The load-bearing guardrail. Anything that reads like a currency amount, a
// percentage, or a bare number is replaced with a placeholder so financial data
// can never leak into durable memory. Both the Latin and CJK figure suffixes
// from the original design are kept so the net is wide.
const FINANCIAL_NUMBER =
  /(?:[$€£¥]\s*\d[\d,]*(?:\.\d+)?\s*(?:k|m|b|万|千|百万|亿)?|\d[\d,]*(?:\.\d+)?\s*(?:%|percent|pct|bps|bp|dollars?|usd|cad|eur|gbp|rmb|元|块|美元|k|m|b|万|千|百万|亿))/gi;
const BARE_NUMBER = /\b\d[\d,]*(?:\.\d+)?\b/g;

export function stripFinancialNumbers(value: string): string {
  return value
    .replace(FINANCIAL_NUMBER, '[financial number omitted]')
    .replace(BARE_NUMBER, '[number omitted]');
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_LINE);
}

type ProfileSections = Record<MemorySection, string[]>;

function emptySections(): ProfileSections {
  return {
    Identity: [],
    Preferences: [],
    'Goals & Background': [],
    'Behavior Patterns': [],
  };
}

export function parseProfile(markdown: string): ProfileSections {
  const sections = emptySections();
  let current: MemorySection | null = null;
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = line.match(/^##\s+(.*)$/);
    if (heading) {
      const name = (heading[1] ?? '').trim().toLowerCase();
      current = MEMORY_SECTIONS.find((candidate) => candidate.toLowerCase() === name) ?? null;
      continue;
    }
    if (!current) continue;
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (!bullet) continue;
    const text = (bullet[1] ?? '').trim();
    if (!text || text.toLowerCase() === PLACEHOLDER) continue;
    sections[current].push(text);
  }
  return sections;
}

export function renderProfile(sections: ProfileSections): string {
  return `${MEMORY_SECTIONS.map((section) => {
    const lines = sections[section];
    const body = lines.length ? lines.map((line) => `- ${line}`).join('\n') : `- ${PLACEHOLDER}`;
    return `## ${section}\n${body}`;
  }).join('\n\n')}\n`;
}

export function profileIsEmpty(markdown: string): boolean {
  const sections = parseProfile(markdown);
  return MEMORY_SECTIONS.every((section) => sections[section].length === 0);
}

export interface RememberResult {
  markdown: string;
  saved: string;
  omittedFinancialNumbers: boolean;
}

// The synchronous write path: prepend a durable fact to a section, de-duping
// case-insensitively, and return the rewritten document. Throws if nothing
// durable survives the financial-number strip.
export function applyRemember(currentMarkdown: string, rawValue: string, section: MemorySection): RememberResult {
  const normalized = normalizeLine(rawValue);
  if (!normalized) throw new AppError('invalid_input', 'A value to remember is required');
  const stripped = normalizeLine(stripFinancialNumbers(normalized));
  const omittedFinancialNumbers = stripped !== normalized;
  const durable = stripped.replace(/\[(?:financial )?number omitted\]/g, '').replace(/\s+/g, ' ').trim();
  if (!durable) {
    throw new AppError(
      'invalid_input',
      'That looks like financial data, not a durable fact. Memory never stores numbers, balances, or amounts.',
    );
  }
  const sections = parseProfile(currentMarkdown);
  const bucket = sections[section];
  const duplicate = bucket.some((line) => line.toLowerCase() === stripped.toLowerCase());
  if (!duplicate) bucket.unshift(stripped);
  return { markdown: renderProfile(sections), saved: stripped, omittedFinancialNumbers };
}

// Cleans up an LLM-produced profile (from reflection): strip numbers again,
// clamp long lines, and de-dupe within each section.
export function normalizeProfileMarkdown(markdown: string): string {
  const sections = parseProfile(markdown);
  for (const section of MEMORY_SECTIONS) {
    const seen = new Set<string>();
    sections[section] = sections[section]
      .map((line) => normalizeLine(stripFinancialNumbers(line)))
      .filter((line) => {
        if (!line) return false;
        const key = line.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }
  return renderProfile(sections);
}

// Reflection output sometimes arrives wrapped in a ```markdown fence.
export function extractMarkdown(reply: string): string {
  const fenced = reply.match(/```(?:markdown)?\s*([\s\S]*?)```/i);
  return (fenced ? (fenced[1] ?? '') : reply).trim();
}

// The block injected into the chat system prompt so the assistant treats the
// profile as background, never as a source of numbers.
export function memoryContext(markdown: string): string {
  return [
    'Durable user memory (slow-changing facts only; never treat it as financial data or a source of numbers):',
    markdown.trim(),
  ].join('\n');
}

export const MEMORY_POLICY = [
  'MEMORY POLICY: A durable user memory profile is provided below. Apply this boundary test before treating anything as memory: if a fact could become wrong tomorrow because a transaction, balance, income, holding, or credit-report row changed, it is DATA, not memory — never store it and never store financial numbers.',
  'Durable memory covers only four kinds of facts: identity/profile, preferences and reporting conventions, goals/background, and behavior patterns.',
  'Use the profile as background about the user. Always read the local finance context for any number; never quote figures from memory.',
].join('\n');

export const REFLECTION_SYSTEM_PROMPT = [
  'You rewrite a single-user finance assistant memory profile from raw interaction logs.',
  'The profile is durable memory only, not financial data. Apply this boundary test: if the information could become wrong tomorrow because a transaction, balance, income, holding, or credit-report row changed, it is data and must not be remembered.',
  'Remember only four categories: identity/profile, preferences and reporting conventions, goals/background, and behavior patterns.',
  'Never store financial numbers, balances, amounts, specific transaction dates, or anything that reads like a figure.',
  'Newer information overrides older information. Remove or rewrite stale facts. If unsure whether something is durable, leave it out.',
  'Output only markdown with exactly these four sections, in this order, and nothing else:',
  '## Identity',
  '## Preferences',
  '## Goals & Background',
  '## Behavior Patterns',
].join('\n');
