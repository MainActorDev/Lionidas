import { describe, it, expect } from 'vitest';
import { junitXml } from '../src/cli/junit.ts';
import type { RunSummary } from '../src/cli/runner.ts';

const mk = (over: Partial<RunSummary>): RunSummary => ({
  runId: 'run_x', status: 'passed', note: null, templateId: 'tpl_1', ticketKey: 'T-1',
  artifactPath: null, startedAt: 1000, finishedAt: 2500, ...over,
});

describe('junitXml', () => {
  it('pass-only: no failure nodes, testcase per run, time from ms', () => {
    const xml = junitXml({ suiteName: 'smoke', baseUrl: 'http://x', runs: [mk({}), mk({ runId: 'run_y', ticketKey: 'T-2', startedAt: 0, finishedAt: 1000 })] });
    expect(xml).toContain('<testsuite name="smoke" tests="2" failures="0" skipped="0"');
    expect(xml).toContain('<testcase name="T-1" classname="crucible.tpl_1" time="1.500"/>');
    expect(xml).not.toContain('<failure');
    expect(xml).not.toContain('<skipped');
  });

  it('failure embeds step, note (alert audit), evidence, URL', () => {
    const xml = junitXml({
      suiteName: 's', baseUrl: 'http://x/',
      runs: [mk({
        status: 'failed', note: 'alert-handled (dismiss): "Sign in" @ start',
        artifactPath: 'artifacts/run_x/screenshot.png',
        failedStep: { idx: 2, name: 'expect contains: DATA', reason: 'not found: DATA' },
      })],
    });
    expect(xml).toContain('<failure message="step 3 (expect contains: DATA): not found: DATA"');
    expect(xml).toContain('alert-handled (dismiss)');
    expect(xml).toContain('evidence: artifacts/run_x/screenshot.png');
    expect(xml).toContain('run: http://x/runs/run_x'); // baseUrl trailing slash normalized
    expect(xml).toContain('<![CDATA[');
  });

  it('aborted → skipped with reason; not a failure', () => {
    const xml = junitXml({ suiteName: 's', baseUrl: 'http://x', runs: [mk({ status: 'aborted', note: 'stream gate failed' })] });
    expect(xml).toContain('skipped="1"');
    expect(xml).toContain('<skipped message="stream gate failed"/>');
    expect(xml).not.toContain('<failure');
  });

  it('escapes XML-hostile characters in names/reasons', () => {
    const xml = junitXml({
      suiteName: 'a<b>&"s"', baseUrl: 'http://x',
      runs: [mk({ status: 'failed', ticketKey: 'T<1>&"q"', failedStep: { idx: 0, name: 'expect', reason: "contains '<script>' & \"quotes\"" } })],
    });
    expect(xml).not.toContain('T<1>');
    expect(xml).toContain('&lt;script&gt;');
    expect(xml).toContain('&amp;');
  });

  it('properties render inside <properties>', () => {
    const xml = junitXml({ suiteName: 's', baseUrl: 'http://x', runs: [], properties: [['git.sha', 'abc123']] });
    expect(xml).toContain('<property name="git.sha" value="abc123"/>');
  });
});
