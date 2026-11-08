/** The trimmed text, or undefined when the value is not a non-blank string. */
export function trimmedText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
