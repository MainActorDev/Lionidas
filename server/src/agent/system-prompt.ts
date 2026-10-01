/** Lionidas domain prompt (breakdown steps_005 §5c fills the real content). */
/** composed in steps_005 from grammar sections; constant so routes can compile in steps_004 */
export const LIONIDAS_SYSTEM_PROMPT: string = 'You are a Lionidas test-case author. (steps_005 replaces this placeholder with the grammar-grounded prompt.)';
export function buildSystemPrompt(): string {
  return LIONIDAS_SYSTEM_PROMPT;
}
