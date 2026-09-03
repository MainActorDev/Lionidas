## Variant: A · split panel (stay in context)

### Design stance
The YAML editor opens inline under the case table — outline left, editor right — so you never lose the list you were browsing.

### Key choices
- Layout: table stays visible above; 300px outline column + fluid editor
- Feedback: outline re-parses live (300ms debounce); error bar under editor with line numbers; inline squiggle on the offending token
- Entry: row hover action `yaml`; esc closes with unsaved guard

### Trade-offs
- Strong at: multi-case editing sessions (open A, glance at B, back to A); matches the page's existing inline-expansion idiom (env disclosure, step expander)
- Weak at: long cases push the table far up; editor width competes with the outline column

### Best for
QA editing several cases in one sitting, referencing neighbors.
