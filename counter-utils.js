/** Mantém o contador como texto para não perder precisão em números enormes. */
export function normalizeCounter(value) {
  const text = String(value ?? "");
  if (!/^(0|[1-9]\d*)$/.test(text)) {
    throw new TypeError("Valor de contador inválido.");
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
