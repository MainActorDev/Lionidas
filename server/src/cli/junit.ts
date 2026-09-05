/** JUnit XML emitter — one <testcase> per template run (plan decision).
 *  Failure bodies embed: failing step, run note (alert-handled audit lines),
 *  evidence path, run URL. Everything user-controlled is XML-escaped. */
import type { RunSummary } from './runner.ts';

function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export interface JunitInput {
  suiteName: string;
  baseUrl: string;
  runs: RunSummary[];
  properties?: Array<[string, string]>;
  infraMessage?: string;
}

export function junitXml(input: JunitInput): string {
  const { suiteName, baseUrl, runs, properties, infraMessage } = input;
  const total = runs.length;
  const failed = runs.filter((r) => r.status === 'failed').length;
  const skipped = runs.filter((r) => r.status !== 'passed' && r.status !== 'failed').length;
  const props = (properties ?? []).map(([k, v]) => `      <property name="${esc(k)}" value="${esc(v)}"/>`).join('\n');

  const cases = runs.map((r) => {
    const cls = `crucible.${r.templateId ?? 'unknown'}`;
    const name = r.templateName ?? (r.ticketKey && r.ticketKey !== 'TEMPLATE' ? r.ticketKey : r.runId);
    const time = r.startedAt && r.finishedAt ? ((r.finishedAt - r.startedAt) / 1000).toFixed(3) : '0.000';
    const url = `${baseUrl.replace(/\/$/, '')}/runs/${r.runId}`;
    const open = `    <testcase name="${esc(name)}" classname="${esc(cls)}" time="${time}">`;
    if (r.status === 'passed') return `    <testcase name="${esc(name)}" classname="${esc(cls)}" time="${time}"/>`;
    if (r.status === 'failed') {
      const step = r.failedStep;
      const msg = step ? `step ${step.idx + 1} (${step.name}): ${step.reason ?? 'failed'}` : 'run failed';
      const body = [
        `step: ${step ? `${step.idx + 1}. ${step.name} — ${step.reason ?? 'failed'}` : 'n/a'}`,
        r.note ? `note: ${r.note}` : null,
        r.artifactPath ? `evidence: ${r.artifactPath}` : null,
        `run: ${url}`,
      ].filter(Boolean).join('\n');
      return `${open}\n      <failure message="${esc(msg)}" type="assertion"><![CDATA[${body}]]></failure>\n    </testcase>`;
    }
    // aborted / unknown → skipped with the reason as body
    return `${open}\n      <skipped message="${esc(r.note ?? r.status)}"/>\n    </testcase>`;
  }).join('\n');

  const sysErr = infraMessage ? `  <system-out>${esc(infraMessage)}</system-out>\n` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="${esc(suiteName)}" tests="${total}" failures="${failed}" skipped="${skipped}"${props ? '>' : '>'}
${props ? `  <properties>\n${props}\n  </properties>\n` : ''}${cases}
${sysErr}</testsuite>
`.replace('\n\n', '\n');
}
