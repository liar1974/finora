import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { FinanceService } from '../src/application/finance-service.js';
import {
  DEFAULT_PROFILE,
  applyRemember,
  normalizeProfileMarkdown,
  parseProfile,
  renderProfile,
  sectionFromKind,
  stripFinancialNumbers,
} from '../src/application/memory.js';
import { CsvStatementParser } from '../src/infrastructure/parsers/csv-parser.js';
import { OfxStatementParser } from '../src/infrastructure/parsers/ofx-parser.js';
import { SqliteFinanceRepository } from '../src/infrastructure/sqlite-repository.js';
import { missingModelEngine } from './helpers.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newService(): FinanceService {
  return new FinanceService(
    new SqliteFinanceRepository(':memory:'),
    [new OfxStatementParser(), new CsvStatementParser()],
    missingModelEngine(),
  );
}

describe('memory helpers', () => {
  it('strips currency, percentages, and bare numbers', () => {
    expect(stripFinancialNumbers('spent $1,200.50 on rent')).not.toContain('1,200');
    expect(stripFinancialNumbers('utilization is 42%')).not.toContain('42');
    expect(stripFinancialNumbers('balance 3000')).not.toContain('3000');
    expect(stripFinancialNumbers('prefers concise summaries')).toBe('prefers concise summaries');
  });

  it('maps loose kinds and sections onto the four canonical sections', () => {
    expect(sectionFromKind('preference')).toBe('Preferences');
    expect(sectionFromKind('goal')).toBe('Goals & Background');
    expect(sectionFromKind('behaviour')).toBe('Behavior Patterns');
    expect(sectionFromKind(undefined, 'Identity')).toBe('Identity');
    expect(sectionFromKind('nonsense')).toBe('Identity');
  });

  it('round-trips parse/render and de-dupes on normalize', () => {
    const sections = parseProfile(DEFAULT_PROFILE);
    expect(sections.Identity).toEqual([]);
    const doc = renderProfile({
      Identity: ['freelancer', 'freelancer'],
      Preferences: [],
      'Goals & Background': [],
      'Behavior Patterns': [],
    });
    const normalized = normalizeProfileMarkdown(doc);
    expect(parseProfile(normalized).Identity).toEqual(['freelancer']);
  });

  it('applyRemember prepends, de-dupes case-insensitively, and rejects pure numbers', () => {
    const first = applyRemember(DEFAULT_PROFILE, 'is a freelancer', 'Identity');
    expect(parseProfile(first.markdown).Identity).toEqual(['is a freelancer']);
    const dupe = applyRemember(first.markdown, 'Is A Freelancer', 'Identity');
    expect(parseProfile(dupe.markdown).Identity).toEqual(['is a freelancer']);
    expect(() => applyRemember(DEFAULT_PROFILE, '$4,200', 'Identity')).toThrow(/financial data/i);
  });
});

describe('memory service', () => {
  it('seeds the default profile and persists remembered facts', () => {
    const service = newService();
    try {
      expect(service.recallMemory().markdown).toBe(DEFAULT_PROFILE);
      const result = service.remember({ value: 'prefers monthly summaries', kind: 'preference' });
      expect(result).toMatchObject({ ok: true, section: 'Preferences', saved: 'prefers monthly summaries' });
      expect(parseProfile(service.recallMemory().markdown).Preferences).toContain('prefers monthly summaries');
    } finally {
      service.close();
    }
  });

  it('omits financial numbers but keeps the durable remainder', () => {
    const service = newService();
    try {
      const result = service.remember({ value: 'saving for a house, budget is $600k', kind: 'goal' });
      expect(result.omittedFinancialNumbers).toBe(true);
      expect(result.saved).not.toContain('600');
      expect(result.saved.toLowerCase()).toContain('saving for a house');
    } finally {
      service.close();
    }
  });

  it('rejects a financial-only fact and refuses targeted forget', () => {
    const service = newService();
    try {
      expect(() => service.remember({ value: '$4,200.00' })).toThrow(/financial data/i);
      expect(() => service.forgetMemory()).toThrow(/not supported/i);
    } finally {
      service.close();
    }
  });

  it('reflection with no events advances the cursor and reports no-events', async () => {
    const service = newService();
    try {
      await expect(service.runReflection()).resolves.toEqual({ status: 'no-events' });
    } finally {
      service.close();
    }
  });
});

describe('agent memory repository', () => {
  it('applies migration v2 and creates the memory tables', () => {
    const path = ':memory:';
    const repo = new SqliteFinanceRepository(path);
    try {
      expect(repo.getUserProfileMarkdown()).toBeNull();
      repo.saveUserProfileMarkdown('## Identity\n- test\n');
      expect(repo.getUserProfileMarkdown()).toBe('## Identity\n- test\n');
      expect(repo.getReflectionCursor()).toBeNull();
      repo.setReflectionCursor('2026-01-01T00:00:00.000Z');
      expect(repo.getReflectionCursor()).toBe('2026-01-01T00:00:00.000Z');
    } finally {
      repo.close();
    }
  });

  it('records agent events and filters by cursor', () => {
    const repo = new SqliteFinanceRepository(':memory:');
    try {
      repo.appendAgentEvent({ turnId: 't1', eventType: 'user_message', role: 'user', content: 'hello' });
      repo.appendAgentEvent({ turnId: 't1', eventType: 'assistant_message', role: 'assistant', content: 'hi' });
      const all = repo.listAgentEventsSince(null, new Date().toISOString());
      expect(all).toHaveLength(2);
      expect(all[0]?.content).toBe('hello');
      const none = repo.listAgentEventsSince(new Date(Date.now() + 1000).toISOString(), new Date(Date.now() + 2000).toISOString());
      expect(none).toHaveLength(0);
    } finally {
      repo.close();
    }
  });
});

describe('agent_events append-only trigger', () => {
  it('blocks UPDATE and DELETE at the database level', () => {
    // A file-backed database lets a second connection observe the trigger the
    // repository's (private) connection created during migration.
    const dir = mkdtempSync(join(tmpdir(), 'finora-mem-'));
    tempDirs.push(dir);
    const path = join(dir, 'finora.db');
    const repo = new SqliteFinanceRepository(path);
    repo.appendAgentEvent({ turnId: 't1', eventType: 'user_message', content: 'keep me' });
    repo.close();

    const db = new DatabaseSync(path);
    try {
      expect(() => db.exec("UPDATE agent_events SET content = 'changed'")).toThrow(/append-only/i);
      expect(() => db.exec('DELETE FROM agent_events')).toThrow(/append-only/i);
      const rows = db.prepare('SELECT content FROM agent_events').all() as { content: string }[];
      expect(rows[0]?.content).toBe('keep me');
    } finally {
      db.close();
    }
  });
});
