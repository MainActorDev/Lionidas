# 029 — builds page (Jenkins style)

CI surface for the build jobs (server shipped: builds table, transport C
pick, job model with streamed logs, incremental log polling — commit bca4199).

One axis: **the page's primary shape**.

| dir | stance |
|---|---|
| `a-jenkins-table/` | flat Jenkins job table — # / status ball / project / transport / duration / artifact; console opens per row |
| `b-jobs-console-split/` | jobs left (per-project card w/ history), live console right — the Jenkins job+console pairing |
| `c-timeline-log/` | runs-page idiom: time-ordered rows grouped by day, click expands the inline console |

All real tokens; Jenkins conventions throughout: status ball (● pass ember,
✕ fail, ◐ running spin), per-project build numbers, duration column,
console log. ▶ build… triggers the project picker (admin).
