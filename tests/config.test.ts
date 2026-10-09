import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config.js';

describe('accounts.json validation', () => {
  it('names a wrong company id and suggests the right one, without printing credentials', () => {
    const problems = validateConfig({ accounts: [
      { companyId: 'cal' as never, credentials: { username: 'secret-user', password: 'secret-pass' } },
      { companyId: 'VisaCal' as never, credentials: { username: 'u', password: 'p' } },
      { companyId: 'discount', credentials: { id: '1', password: 'p' } },
      { companyId: 'visaCal', credentials: { username: 'u', password: 'p' } },
    ] });
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain('"cal" הוא לא שם חברה מוכר — התכוונת ל-"visaCal"?');
    expect(problems[1]).toContain('התכוונת ל-"visaCal"?');
    expect(problems[2]).toContain('חסרים השדות "num"');
    expect(problems.join(' ')).not.toMatch(/secret/);
  });
});
