/** Preserve historical copy while displaying the current trademark treatment. */
export function withBrandTrademarks(text: string): string {
  return text.replace(
    /\bThe Elevated Beauty (Method|Experience)(?:\s*™)?(?![a-z])/gi,
    (_match, name: string) => `The Elevated Beauty ${name} ™`,
  );
}