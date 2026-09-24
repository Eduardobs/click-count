/** Keep the counter as text to preserve precision for very large numbers. */
export function normalizeCounter(value) {
  const text = String(value ?? "");
  if (!/^(0|[1-9]\d*)$/.test(text)) {
    throw new TypeError("Invalid counter value.");
  }
  return text;
}

export function formatCounter(value) {
  return normalizeCounter(value).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

export function counterSize(value) {
  const length = normalizeCounter(value).length;
  if (length > 24) return "very-long";
  if (length > 10) return "long";
  return "normal";
}
