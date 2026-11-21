import { AppError, toMinor, TRIGGER_TYPES, CURRENCIES, DECREMENT_TYPES, VISIBILITY } from './rules.js';

const isNonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const toMs = (v) => (typeof v === 'number' ? v : Date.parse(v));
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const isPosInt = (v) => v !== '' && v !== null && Number.isInteger(Number(v)) && Number(v) > 0;

function fail(errors) {
  if (Object.keys(errors).length) throw new AppError(400, 'Validation failed', errors);
}

/** Returns a normalized RFQ payload ready for the database. */
export function validateRfq(input) {
  const e = {};
  if (!isNonEmpty(input.name)) e.name = 'RFQ name is required';
  else if (input.name.length > 200) e.name = 'RFQ name is too long';
  if (!isNonEmpty(input.referenceId)) e.referenceId = 'Reference ID is required';
  const start = toMs(input.bidStartAt);
  const close = toMs(input.bidCloseAt);
  const forced = toMs(input.forcedCloseAt);
  if (!Number.isFinite(start)) e.bidStartAt = 'Valid bid start time is required';
  if (!Number.isFinite(close)) e.bidCloseAt = 'Valid bid close time is required';
  if (!Number.isFinite(forced)) e.forcedCloseAt = 'Valid forced close time is required';
  if (Number.isFinite(start) && Number.isFinite(close) && close <= start) e.bidCloseAt = 'Bid close time must be after bid start time';
  if (Number.isFinite(close) && Number.isFinite(forced) && forced <= close) e.forcedCloseAt = 'Forced close time must be later than bid close time';
  if (!isDate(input.pickupDate)) e.pickupDate = 'Pickup / service date is required (YYYY-MM-DD)';
  if (!CURRENCIES.includes(input.currency)) e.currency = `Currency must be one of ${CURRENCIES.join(', ')}`;
  if (!isPosInt(input.triggerWindowMinutes)) e.triggerWindowMinutes = 'Trigger window (X) must be a positive whole number of minutes';
  if (!isPosInt(input.extensionMinutes)) e.extensionMinutes = 'Extension duration (Y) must be a positive whole number of minutes';
  if (!TRIGGER_TYPES.includes(input.triggerType)) e.triggerType = `Trigger type must be one of ${TRIGGER_TYPES.join(', ')}`;

  const decType = input.minDecrementType ?? 'AMOUNT';
  let decValue = 0;
  if (!DECREMENT_TYPES.includes(decType)) e.minDecrementType = 'Decrement type must be AMOUNT or PERCENT';
  else {
    const raw = input.minDecrementValue ?? 0;
    const minor = toMinor(raw); // both "100.50" (amount) and "0.5" (percent) have ≤ 2 decimals
    if (minor === null) e.minDecrementValue = 'Minimum decrement must be a non-negative number with up to 2 decimals';
    else if (decType === 'PERCENT' && minor > 5000) e.minDecrementValue = 'Percentage decrement cannot exceed 50%';
    else decValue = minor; // AMOUNT → minor units; PERCENT → basis points (0.5% → 50)
  }
  const visibility = input.supplierVisibility ?? 'RANK_ONLY';
  if (!VISIBILITY.includes(visibility)) e.supplierVisibility = 'Visibility must be RANK_ONLY or RANK_AND_L1_PRICE';

  const supplierIds = Array.isArray(input.invitedSupplierIds) ? [...new Set(input.invitedSupplierIds.map(Number))] : [];
  if (!supplierIds.length || supplierIds.some((n) => !Number.isInteger(n) || n <= 0)) e.invitedSupplierIds = 'Invite at least one supplier';

  fail(e);
  return {
    referenceId: input.referenceId.trim(), name: input.name.trim(), pickupDate: input.pickupDate, currency: input.currency,
    start, close, forced,
    triggerWindowMinutes: Number(input.triggerWindowMinutes), extensionMinutes: Number(input.extensionMinutes),
    triggerType: input.triggerType, minDecrementType: decType, minDecrementValue: decValue,
    supplierVisibility: visibility, supplierIds,
  };
}

/** Returns a normalized bid with all money in minor units. */
export function validateBid(input) {
  const e = {};
  if (!isNonEmpty(input.carrierName)) e.carrierName = 'Carrier name is required';
  const money = {};
  for (const f of ['freightCharges', 'originCharges', 'destinationCharges']) {
    money[f] = toMinor(input[f]);
    if (money[f] === null) e[f] = 'Must be a non-negative amount with up to 2 decimals';
  }
  if (!isPosInt(input.transitTimeDays)) e.transitTimeDays = 'Transit time must be a positive whole number of days';
  if (!isDate(input.quoteValidUntil)) e.quoteValidUntil = 'Quote validity date is required (YYYY-MM-DD)';
  fail(e);
  const totalMinor = money.freightCharges + money.originCharges + money.destinationCharges;
  if (totalMinor <= 0) fail({ freightCharges: 'Total quote must be greater than zero' });
  return {
    carrierName: input.carrierName.trim(),
    freightMinor: money.freightCharges, originMinor: money.originCharges, destinationMinor: money.destinationCharges,
    totalMinor, transitTimeDays: Number(input.transitTimeDays), quoteValidUntil: input.quoteValidUntil,
  };
}

export function validateRegistration(input) {
  const e = {};
  if (!isNonEmpty(input.name)) e.name = 'Name is required';
  if (typeof input.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) e.email = 'A valid email is required';
  if (typeof input.password !== 'string' || input.password.length < 8) e.password = 'Password must be at least 8 characters';
  if (!['BUYER', 'SUPPLIER'].includes(input.role)) e.role = 'Role must be BUYER or SUPPLIER';
  if (input.role === 'SUPPLIER' && !isNonEmpty(input.companyName)) e.companyName = 'Company name is required for suppliers';
  fail(e);
  return {
    name: input.name.trim(), email: input.email.trim().toLowerCase(), password: input.password, role: input.role,
    companyName: input.companyName?.trim() || null,
  };
}
