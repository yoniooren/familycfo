/**
 * Discount Bank securities portfolio (תיק ניירות ערך).
 *
 * israeli-bank-scrapers' Discount scraper reads only the current account. The portfolio comes from the same
 * Titan gateway the bank's own site calls on its "תיק ניירות ערך" screen, so we extend that scraper: after its
 * fetchData (balance + transactions), with the same logged-in page, POST currentSecuritiesPortfolio per account.
 *
 * Units, as the bank returns them (checked against a real response): rates of Israeli securities are in agorot,
 * `Tmura` is the holding's value in ILS (units × rate / 100), the holdings' Tmura add up to `PortfolioValue`,
 * and `PercentFromBuyRate` = (rate / AdjustedBuyRate − 1) × 100. We store per-unit prices in ILS derived from
 * Tmura and PercentFromBuyRate, which doesn't depend on the agorot convention (and so also covers foreign papers,
 * where the buy price then excludes the exchange-rate effect).
 */
import { createRequire } from 'module';
import type { Page } from 'puppeteer';
import type { DB } from './db/connection.js';

// the library's own Discount scraper class (CommonJS, default export) — not exported from its index
const DiscountScraper = createRequire(import.meta.url)('israeli-bank-scrapers/lib/scrapers/discount').default as { new (o: any): any };

const PORTFOLIO_URL = 'https://start.telebank.co.il/Titan/gatewayAPI/securities/portfolioInfo/currentSecuritiesPortfolio';
export const DISCOUNT_BROKER = 'דיסקונט';

export interface PortfolioHolding {
  securityNumber: string;
  name: string;
  /** the bank's own symbol, when it has one */
  bankSymbol: string | null;
  units: number;
  /** value of the whole holding, ILS */
  valueIls: number;
  /** price per unit, ILS */
  priceIls: number;
  /** average buy price per unit, ILS (null when the bank gives none) */
  buyPriceIls: number | null;
  currency: string;
  foreign: boolean;
  type: string | null;
}

export interface Portfolio {
  accountNumber: string;
  totalValueIls: number;
  holdings: PortfolioHolding[];
}

type Raw = Record<string, any>;
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** Turn the bank's response into holdings. Throws when the shape isn't what we expect. */
export function parsePortfolio(accountNumber: string, response: Raw): Portfolio {
  const p = response?.CurrentSecuritiesPortfolio;
  if (!p || typeof p !== 'object') throw new Error('unexpected portfolio response (no CurrentSecuritiesPortfolio)');
  const entries: Raw[] = Array.isArray(p.SecuritiesEntry) ? p.SecuritiesEntry : [];
  const holdings: PortfolioHolding[] = [];
  for (const s of entries) {
    const units = num(s.CurrentUnits);
    const value = num(s.Tmura);
    if (!units || units <= 0 || value == null) continue; // sold today / nothing held
    const priceIls = value / units;
    const pct = num(s.PercentFromBuyRate);
    const hasBuy = (num(s.AdjustedBuyRate) ?? 0) > 0 && pct != null && pct > -100;
    holdings.push({
      securityNumber: String(s.SecurityNumber),
      name: String(s.PaperNameTitan || s.SecurityName || s.SecurityNumber).trim(),
      bankSymbol: typeof s.Symbol === 'string' && s.Symbol.trim() ? s.Symbol.trim() : null,
      units,
      valueIls: value,
      priceIls,
      buyPriceIls: hasBuy ? priceIls / (1 + pct! / 100) : null,
      currency: String(s.CurrencyCode || s.Currency?.Value || 'ILS'),
      foreign: String(s.ForeignFlag).toLowerCase() === 'true',
      type: s.PaperTypeDescriptionTZ ? String(s.PaperTypeDescriptionTZ) : null,
    });
  }
  return { accountNumber, totalValueIls: num(p.PortfolioValue) ?? holdings.reduce((a, h) => a + h.valueIls, 0), holdings };
}

/** POST the portfolio request from inside the logged-in bank page (its cookies authenticate it). */
async function fetchPortfolio(page: Page, accountNumber: string): Promise<Portfolio> {
  const body = {
    AccountNumber: accountNumber, ReutersFlag: 'True', FetchBeginYearReturnFlag: 'True', LoaclRealTimeFlag: 'False',
    SecuritiesListFlag: 'True', ForeignRealTimeFlag: 'False', DailyPortfolioLossOrProfitFlag: 'True',
  };
  const [text, status] = await page.evaluate(async (url, data) => {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*',
        site: 'retail', language: 'HEBREW', AccountNumber: data.AccountNumber, BusinessProcessID: 'CAPITAL_MARKET',
      },
      body: JSON.stringify(data),
    });
    return [await res.text(), res.status] as const;
  }, PORTFOLIO_URL, body);
  if (status === 204 || !text) return { accountNumber, totalValueIls: 0, holdings: [] };
  if (status >= 400) throw new Error(`HTTP ${status}`);
  return parsePortfolio(accountNumber, JSON.parse(text));
}

/** The Discount scraper, plus `portfolios` on a successful result. A portfolio failure never fails the bank scrape. */
export class DiscountWithPortfolio extends DiscountScraper {
  async fetchData() {
    const result = await super.fetchData();
    if (!result?.success) return result;
    const portfolios: Portfolio[] = [];
    const errors: string[] = [];
    for (const acc of result.accounts ?? []) {
      try {
        portfolios.push(await fetchPortfolio(this.page, String(acc.accountNumber)));
      } catch (err) {
        errors.push(`${acc.accountNumber}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { ...result, portfolios, portfolioErrors: errors };
  }
}

/**
 * Save a scraped portfolio as holdings on the investments page: one holding per security
 * (symbol `DISCOUNT:<security number>`, priced by the bank, so no Yahoo quote is looked up).
 * Quantity, price and buy price follow the bank; name / owner / notes the user changed are kept.
 * A security that's no longer in the account is archived (sold); it comes back if it reappears.
 */
export function saveDiscountPortfolio(db: DB, portfolio: Portfolio, asOf: string): { saved: number; archived: number } {
  const brokerKey = `${DISCOUNT_BROKER} ${portfolio.accountNumber.slice(-4)}`;
  const symbolOf = (h: PortfolioHolding) => `DISCOUNT:${h.securityNumber}`;
  let saved = 0;
  const run = db.transaction(() => {
    for (const h of portfolio.holdings) {
      const symbol = symbolOf(h);
      const existing = db.prepare(`SELECT id FROM holdings WHERE symbol = ? AND broker = ?`).get(symbol, brokerKey) as { id: number } | undefined;
      const values = {
        symbol, broker: brokerKey, quantity: h.units, currency: 'ILS', manual_price: h.priceIls, manual_price_date: asOf,
        buy_price: h.buyPriceIls, baseline_price: h.buyPriceIls == null ? h.priceIls : null, baseline_date: h.buyPriceIls == null ? asOf : null,
      };
      if (existing) {
        db.prepare(`UPDATE holdings SET quantity = @quantity, currency = @currency, manual_price = @manual_price,
          manual_price_date = @manual_price_date, buy_price = COALESCE(@buy_price, buy_price), archived = 0,
          updated_at = CURRENT_TIMESTAMP WHERE id = @id`).run({ ...values, id: existing.id });
      } else {
        db.prepare(`INSERT INTO holdings (symbol, name, broker, quantity, currency, manual_price, manual_price_date,
          buy_price, baseline_price, baseline_date, notes)
          VALUES (@symbol, @name, @broker, @quantity, @currency, @manual_price, @manual_price_date,
          @buy_price, @baseline_price, @baseline_date, @notes)`)
          .run({ ...values, name: h.name, notes: `מתעדכן אוטומטית מתיק ניירות הערך בדיסקונט (נייר ${h.securityNumber})` });
      }
      saved++;
    }
    const keep = portfolio.holdings.map(symbolOf);
    const res = db.prepare(`UPDATE holdings SET archived = 1, updated_at = CURRENT_TIMESTAMP
      WHERE broker = ? AND symbol LIKE 'DISCOUNT:%' AND archived = 0
      AND symbol NOT IN (SELECT value FROM json_each(?))`).run(brokerKey, JSON.stringify(keep));
    return res.changes;
  });
  const archived = run();
  return { saved, archived };
}
