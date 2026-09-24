/** Keep the counter as text to preserve precision for very large numbers. */
export function normalizeCounter(value) {
  let text;
  if (typeof value === "string") {
    text = value;
  } else if (typeof value === "bigint" && value >= 0n) {
    text = value.toString();
  } else if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    text = String(value);
  } else {
    throw new TypeError("Invalid counter value.");
  }

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

/** Compare decimal strings without losing precision through Number conversion. */
export function compareCounters(left, right) {
  const normalizedLeft = normalizeCounter(left);
  const normalizedRight = normalizeCounter(right);

  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length < normalizedRight.length ? -1 : 1;
  }
  if (normalizedLeft === normalizedRight) return 0;
  return normalizedLeft < normalizedRight ? -1 : 1;
}
