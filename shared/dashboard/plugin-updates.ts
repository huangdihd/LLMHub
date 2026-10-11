/** What `/api/hub/plugins/<id>/updates` reports for an npm-installed plugin. */
export interface NpmUpdateInfo {
  updates?: Array<{ version: string }>
  latestVersion?: string | null
  latestMatchingVersion?: string | null
}

/**
 * The version to offer, if any. Prefers the newest one inside the saved range, then the
 * registry's latest. A market install saves the exact version it installed as its range,
 * so the range alone would never offer anything newer.
 */
export function npmUpdateTarget(info: NpmUpdateInfo, current: string | undefined): string | undefined {
  const newer = new Set((info.updates ?? []).map(update => update.version))
  for (const candidate of [info.latestMatchingVersion, info.latestVersion]) {
    if (candidate && candidate !== current && newer.has(candidate)) return candidate
  }
  return undefined
}
