const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;

export function assertIsoDate(value: string, field = 'date'): void {
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${field} must use YYYY-MM-DD`);
  }
}

export function normalizeCurrency(value: string): string {
  const currency = value.trim().toUpperCase();
  if (!CURRENCY.test(currency)) {
    throw new Error('currency must be a three-letter ISO 4217 code');
  }
  return currency;
}

export function assertMinorAmount(value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error('amountMinor must be a safe integer');
  }
}

export function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}
