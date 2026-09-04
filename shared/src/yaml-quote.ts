/** The serializer's quoting rule, exposed for the autocomplete layer.
 *  A separate module (not a case-yaml re-export) so no load-order hazards;
 *  it IS the same underlying function — one quoting rule forever. */
export { yamlScalar as yamlQuote } from './case-yaml.ts';
