/** One or two letters for an account without a picture: from the full name, else the email's first letter. */
export function initials(name: string | null | undefined, email: string | null | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  const fromName = letters.map((word) => Array.from(word)[0]).join('');
  const fromEmail = Array.from((email ?? '').trim())[0] ?? '';
  return (fromName || fromEmail).toLocaleUpperCase();
}
