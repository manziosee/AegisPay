/** ISO 3166 region from the browser locale (for example "en-GB" -> "GB"). */
export function browserCountry(): string {
  if (typeof navigator === "undefined") return "";
  for (const tag of navigator.languages ?? [navigator.language]) {
    try {
      const region = new Intl.Locale(tag).maximize().region;
      if (region && /^[A-Z]{2}$/.test(region)) return region;
    } catch {
      // Ignore malformed locale tags.
    }
  }
  return "";
}

/** Display name for an ISO 3166 region code, falling back to the code. */
export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}
