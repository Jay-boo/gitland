/**
 * The section of a CHANGELOG for one version ("## [1.2.0] - 2026-10-01", "## v1.2.0", "# 1.2.0"…),
 * without its heading: up to the next heading of the same or a higher level. Undefined when absent.
 */
export function changelogSection(text: string, tag: string): string | undefined {
  const version = tag.replace(/^v(?=\d)/i, '');
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^(#{1,4})(?=\\s).*?[^\\w.]v?${esc}(?![\\w.-]*\\d)`, 'i');
  const lines = text.split('\n');
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) {
    return undefined;
  }
  const level = /^#+/.exec(lines[start])![0].length;
  const end = lines.findIndex((l, i) => i > start && /^#+\s/.test(l) && /^#+/.exec(l)![0].length <= level);
  const body = lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
  return body || undefined;
}
