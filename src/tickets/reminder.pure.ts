/** Branches that are never tied to one ticket. */
const PROTECTED = /^(main|master|dev|develop)$|^(release|hotfix)\//;

/**
 * Whether to offer linking a ticket before committing: reminder on, a named non-protected branch, no ticket linked
 * to it, not skipped for this branch, and no ticket reference in the message.
 */
export function needsTicketReminder(o: { enabled: boolean; branch?: string; linkedTicket?: string; skipped: boolean; message: string; prefix: string }): boolean {
  if (!o.enabled || o.skipped || !o.branch || o.linkedTicket || PROTECTED.test(o.branch)) {
    return false;
  }
  const ref = new RegExp(`${o.prefix.replace(/[#]/g, '\\#')}\\d+\\b`, 'i');
  return !ref.test(o.message);
}

/** The message with " <ref>" at the end of its first line. */
export function withTicketRef(message: string, ref: string): string {
  const nl = message.indexOf('\n');
  const subject = (nl < 0 ? message : message.slice(0, nl)).trimEnd();
  const rest = nl < 0 ? '' : message.slice(nl);
  return `${subject ? `${subject} ` : ''}${ref}${rest}`;
}
