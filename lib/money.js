function parseMoneyAmount(value, { allowZero = true } = {}) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || (!allowZero && amount === 0)) return null;
  const rounded = Math.round((amount + Number.EPSILON) * 100) / 100;
  if (!Number.isSafeInteger(Math.round(rounded * 100)) || Math.abs(amount - rounded) > 1e-8) return null;
  return rounded;
}

function parsePaymentAmounts(totalValue, receivedValue) {
  const totalAmount = parseMoneyAmount(totalValue);
  const receivedAmount = parseMoneyAmount(receivedValue);
  if (totalAmount === null || receivedAmount === null || receivedAmount > totalAmount) return null;
  return { totalAmount, receivedAmount };
}

module.exports = { parseMoneyAmount, parsePaymentAmounts };
