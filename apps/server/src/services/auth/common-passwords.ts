/**
 * Refuses passwords from public breach top lists. Passwords must have 12 characters, so most of the
 * classic top 1000 (123456, qwerty, dragon ...) are already refused by length; what remains of those
 * lists are long variants: a common word or keyboard run padded with digits and symbols, repeats of
 * a short word, and a few well-known phrases. Those are caught by the rules below instead of a word
 * list with thousands of entries (the list is not shipped to browsers either way).
 */

/** Words that make up the bulk of the common password lists (lowercase, letters only). */
const COMMON_WORDS = new Set([
  "password",
  "passwort",
  "passw",
  "qwerty",
  "qwertz",
  "azerty",
  "asdf",
  "asdfgh",
  "zxcvbn",
  "iloveyou",
  "letmein",
  "welcome",
  "admin",
  "administrator",
  "dragon",
  "monkey",
  "football",
  "baseball",
  "soccer",
  "hockey",
  "sunshine",
  "princess",
  "master",
  "shadow",
  "superman",
  "batman",
  "trustno",
  "michael",
  "jennifer",
  "jordan",
  "hunter",
  "ranger",
  "buster",
  "harley",
  "charlie",
  "thomas",
  "robert",
  "daniel",
  "jessica",
  "ashley",
  "nicole",
  "tigger",
  "freedom",
  "whatever",
  "secret",
  "starwars",
  "pokemon",
  "computer",
  "internet",
  "samsung",
  "google",
  "abc",
  "abcdef",
  "abcdefgh",
  "abcdefghijkl",
  "login",
  "access",
  "flower",
  "lovely",
  "loveme",
  "love",
  "hello",
  "helloworld",
  "changeme",
  "default",
  "guest",
  "test",
  "tester",
  "testing",
  "user",
  "root",
  "toor",
  "pass",
  "summer",
  "winter",
  "spring",
  "autumn",
  "monday",
  "sommer",
  "hallo",
  "schatz",
  "fussball",
  "liverpool",
  "chelsea",
  "arsenal",
  "barcelona",
  "mustang",
  "ferrari",
  "porsche",
  "matrix",
  "killer",
  "ninja",
  "cookie",
  "chocolate",
  "banana",
  "orange",
  "apple",
  "purple",
  "yellow",
  "silver",
  "golden",
  "diamond",
  "angel",
  "baby",
  "family",
  "forever",
  "friends",
  "jesus",
  "christ",
  "blessed",
  "money",
  "maggie",
  "ginger",
  "pepper",
  "cheese",
  "biteme",
  "fuckyou",
  "fuckoff",
  "asshole",
  "sloppanizer",
  "organizer",
]);

/** Well-known long entries of the breach lists that the rules below do not cover. */
const KNOWN = new Set([
  "correcthorsebatterystaple",
  "thequickbrownfox",
  "thequickbrownfoxjumpsoverthelazydog",
  "iloveyouforever",
  "letmeinplease",
  "opensesame",
  "passwordpassword",
  "mypasswordis",
  "trustnoone",
  "ihateyou",
  "iloveyoubaby",
  "ilovemymom",
  "ilovemyself",
  "nopassword",
  "blink182",
  "1q2w3e4r5t6y",
  "1qaz2wsx3edc",
  "q1w2e3r4t5y6",
  "zaq12wsxcde3",
  "1qazxsw23edc",
  "qazwsxedcrfv",
  "1234qwerasdf",
  "qwer1234asdf",
  "abcd1234efgh",
  "a1b2c3d4e5f6",
  "p4ssw0rd",
  "p@ssw0rd",
  "passw0rd",
]);

/** Keyboard rows and alphabet/digit runs, forwards and backwards. */
const RUNS = [
  "1234567890",
  "0987654321",
  "qwertyuiop",
  "asdfghjkl",
  "zxcvbnm",
  "qwertzuiop",
  "yxcvbnm",
  "azertyuiop",
  "abcdefghijklmnopqrstuvwxyz",
  "zyxwvutsrqponmlkjihgfedcba",
  "1qaz2wsx3edc4rfv",
  "qazwsxedcrfvtgb",
];

const LEET: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
  $: "s",
};

const unleet = (text: string): string => [...text].map((char) => LEET[char] ?? char).join("");

/** True when the text is a substring of a keyboard or alphabet run (at least 4 long). */
function isRun(text: string): boolean {
  return text.length >= 4 && RUNS.some((run) => run.includes(text));
}

/** The text is one short piece repeated ("abcabcabcabc", "passpasspass"). */
function isRepeat(text: string): boolean {
  for (let size = 1; size <= text.length / 2; size++) {
    if (text.length % size === 0 && text.slice(0, size).repeat(text.length / size) === text) return true;
  }
  return false;
}

/** Whether the password is one of the common ones or a trivial variant of them. */
export function isCommonPassword(password: string): boolean {
  const lower = password.toLowerCase();
  const compact = lower.replace(/[\s._-]+/g, "");
  if (KNOWN.has(compact) || KNOWN.has(unleet(compact))) return true;
  if (isRepeat(compact) || isRun(compact)) return true;
  // Digits and symbols only: dates, phone pads, runs.
  if (/^[^a-z]+$/.test(compact)) {
    const digits = compact.replace(/[^0-9]/g, "");
    if (digits.length === 0 || isRun(digits) || isRepeat(digits) || new Set(digits).size <= 3) return true;
  }
  // A common word (or keyboard run) plus padding of digits and symbols, also in leetspeak.
  for (const candidate of [compact, unleet(compact)]) {
    const core = candidate.replace(/^[^a-z]+|[^a-z]+$/g, "");
    if (core.length === 0) continue;
    if (!/^[a-z]+$/.test(core)) continue;
    if (COMMON_WORDS.has(core) || isRun(core) || isRepeat(core)) return true;
    // Two common words ("iloveyoumonkey", "passwordadmin").
    for (let i = 3; i <= core.length - 3; i++) {
      const head = core.slice(0, i);
      const tail = core.slice(i);
      if (COMMON_WORDS.has(head) && (COMMON_WORDS.has(tail) || isRepeat(tail))) return true;
    }
  }
  return false;
}
