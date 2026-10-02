import { describe, expect, it } from 'vitest';
import { DiscountWithPortfolio, parsePortfolio, saveDiscountPortfolio } from '../src/discountPortfolio.js';
import { portfolio } from '../src/analytics/investments.js';
import { testDb } from './helpers.js';

// Made-up numbers in the shape of Discount's currentSecuritiesPortfolio response (rates in agorot, Tmura in ILS).
const entry = (o: Record<string, unknown>) => ({
  SecurityNumber: 5100000, SecurityName: 'קרן א', PaperNameTitan: 'קרן א כספית', Symbol: '', CurrentUnits: 1000,
  Tmura: 1250, LastOperationRate: 125, AdjustedBuyRate: 100, PercentFromBuyRate: 25, CurrencyCode: 'ILS',
  Currency: { Value: 'ILS', C: '' }, ForeignFlag: 'False', PaperTypeDescriptionTZ: 'קרן נאמנות', ...o,
});
const response = (entries: Record<string, unknown>[], total?: number) => ({
  CurrentSecuritiesPortfolio: { PortfolioValue: total ?? entries.reduce((s, e) => s + Number(e.Tmura), 0), SecuritiesEntry: entries },
});

describe('parsePortfolio', () => {
  it('derives per-unit ILS prices and the buy price from the bank figures', () => {
    const p = parsePortfolio('1234567890', response([
      entry({}),
      entry({ SecurityNumber: 5200000, PaperNameTitan: 'קרן ב', CurrentUnits: 200, Tmura: 300, LastOperationRate: 150, AdjustedBuyRate: 200, PercentFromBuyRate: -25 }),
    ]));
    expect(p.totalValueIls).toBe(1550);
    expect(p.holdings).toHaveLength(2);
    const [a, b] = p.holdings;
    expect(a).toMatchObject({ securityNumber: '5100000', name: 'קרן א כספית', units: 1000, valueIls: 1250, currency: 'ILS', foreign: false });
    expect(a.priceIls).toBeCloseTo(1.25);
    expect(a.buyPriceIls).toBeCloseTo(1.0);
    expect(b.priceIls).toBeCloseTo(1.5);
    expect(b.buyPriceIls).toBeCloseTo(2.0);
  });

  it('skips empty positions and handles a missing buy rate', () => {
    const p = parsePortfolio('1', response([entry({ CurrentUnits: 0, Tmura: 0 }), entry({ SecurityNumber: 7, AdjustedBuyRate: 0, PercentFromBuyRate: 0 })]));
    expect(p.holdings).toHaveLength(1);
    expect(p.holdings[0].buyPriceIls).toBeNull();
  });

  it('rejects an unexpected response', () => {
    expect(() => parsePortfolio('1', { Error: { MsgText: 'x' } })).toThrow();
  });
});

describe('saveDiscountPortfolio', () => {
  it('creates holdings valued by the bank, updates them, keeps user edits and archives sold ones', () => {
    const db = testDb();
    const first = parsePortfolio('1234567890', response([entry({}), entry({ SecurityNumber: 5200000, PaperNameTitan: 'קרן ב' })]));
    expect(saveDiscountPortfolio(db, first, '2026-10-01')).toEqual({ saved: 2, archived: 0 });

    let pf = portfolio(db, '2026-10-01');
    expect(pf.totals.valueIls).toBe(2500);
    expect(pf.totals.costIls).toBe(2000);
    expect(pf.holdings.every(h => h.broker === 'דיסקונט 7890')).toBe(true);

    // the user renames one holding and sets its owner
    db.prepare(`UPDATE holdings SET name = 'הקרן שלי', owner_member_id = 1 WHERE symbol = 'DISCOUNT:5100000'`).run();

    // next scrape: more units and a new price for A; B was sold
    const second = parsePortfolio('1234567890', response([entry({ CurrentUnits: 1100, Tmura: 1430, LastOperationRate: 130, PercentFromBuyRate: 30 })]));
    expect(saveDiscountPortfolio(db, second, '2026-10-02')).toEqual({ saved: 1, archived: 1 });

    const a = db.prepare(`SELECT * FROM holdings WHERE symbol = 'DISCOUNT:5100000'`).get() as Record<string, unknown>;
    expect(a).toMatchObject({ name: 'הקרן שלי', owner_member_id: 1, quantity: 1100, manual_price_date: '2026-10-02', archived: 0 });
    expect(a.manual_price as number).toBeCloseTo(1.3);
    expect((db.prepare(`SELECT archived FROM holdings WHERE symbol = 'DISCOUNT:5200000'`).get() as { archived: number }).archived).toBe(1);

    pf = portfolio(db, '2026-10-02');
    expect(pf.totals.valueIls).toBe(1430);
    expect(db.prepare(`SELECT COUNT(*) FROM holdings`).pluck().get()).toBe(2);
  });
});

describe('DiscountWithPortfolio', () => {
  it('adds the portfolios to a successful bank result and reports a failing one without failing the scrape', async () => {
    const scraper = new DiscountWithPortfolio({ companyId: 'discount', startDate: new Date() });
    const proto = Object.getPrototypeOf(DiscountWithPortfolio.prototype);
    const original = proto.fetchData;
    proto.fetchData = async () => ({ success: true, accounts: [{ accountNumber: '111', txns: [] }, { accountNumber: '222', txns: [] }] });
    const calls: unknown[] = [];
    scraper.page = {
      evaluate: async (_fn: unknown, url: string, data: { AccountNumber: string }) => {
        calls.push({ url, account: data.AccountNumber });
        return data.AccountNumber === '111' ? [JSON.stringify(response([entry({})])), 200] : ['denied', 403];
      },
    };
    try {
      const result = await scraper.fetchData();
      expect(result.success).toBe(true);
      expect(result.accounts).toHaveLength(2);
      expect(result.portfolios).toHaveLength(1);
      expect(result.portfolios[0].holdings[0].valueIls).toBe(1250);
      expect(result.portfolioErrors).toEqual(['222: HTTP 403']);
      expect(calls).toHaveLength(2);
    } finally {
      proto.fetchData = original;
    }
  });
});
