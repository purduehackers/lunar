export const MAX_NAME_LENGTH = 24;

export function normalizeName(value: unknown): string {
  if (typeof value !== "string") return "";
  return Array.from(
    value
      .replace(/\s+/g, " ")
      .replace(/[\p{Cc}\p{Cf}]/gu, "")
      .trim(),
  )
    .slice(0, MAX_NAME_LENGTH)
    .join("");
}
