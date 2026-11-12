/** Topic names are compared and stored trimmed, with inner whitespace collapsed to one space. */
export function normalizeTopic(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/** Link that opens a Teams chat with the person. */
export function teamsChatUrl(email: string): string {
  return `https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(email.trim())}`;
}

/** mailto: link; the "@" stays readable, every other special character is encoded. */
export function mailtoUrl(email: string, subject?: string): string {
  const address = email
    .trim()
    .split("@")
    .map((part) => encodeURIComponent(part))
    .join("@");
  return subject ? `mailto:${address}?subject=${encodeURIComponent(subject)}` : `mailto:${address}`;
}
