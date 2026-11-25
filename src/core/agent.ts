// Entry point of the rater agent: page text (+ optional user answers) in, extracted facts and a
// deterministic, cited rate result out. Steps: check the text is usable, detect the insurer,
// extract facts with that insurer's layout rules, apply user overrides, resolve against the grid.
// Any failure becomes an explained `unsupported` result - analyse() never throws on bad input.
import { applyOverrides, emptyFacts, fillMissing } from './extract/common';
import { MODULES, moduleFor } from './insurers';
import type { Detection, InsurerModule } from './insurers/module';
import { unsupported, buildResult } from './insurers/module';
import type {
  AnalysisResult,
  ClarifyingQuestion,
  FactOverrides,
  InsurerId,
  PageText,
  PolicyFacts,
  RateResult,
  TraceStep,
} from './types';

export const ENGINE_VERSION = '1.0.0';

const MIN_TEXT_CHARS = 200;
const MIN_DETECTION_SCORE = 0.5;
const LOW_OCR_CONFIDENCE = 60;

function textStep(pages: PageText[]): TraceStep {
  const ocrPages = pages.filter((p) => p.source === 'ocr');
  const weak = ocrPages.filter((p) => (p.confidence ?? 100) < LOW_OCR_CONFIDENCE);
  const chars = pages.reduce((n, p) => n + p.text.trim().length, 0);
  const parts = [
    `${pages.length} page(s), ${chars} characters`,
    ocrPages.length ? `${ocrPages.length} page(s) read by OCR (no text layer)` : 'all pages had a text layer',
  ];
  if (weak.length) parts.push(`low OCR confidence on page(s) ${weak.map((p) => p.page).join(', ')}`);
  return {
    title: 'Read the document',
    detail: parts.join('; ') + '.',
    outcome: chars < MIN_TEXT_CHARS ? 'stop' : weak.length ? 'warn' : 'ok',
  };
}

function insurerQuestion(): ClarifyingQuestion {
  return {
    fact: 'insurer',
    question: 'Which insurer issued this policy?',
    options: MODULES.map((m) => ({ value: m.id, label: m.displayName })),
  };
}

function stopResult(trace: TraceStep[], reason: string, questions: ClarifyingQuestion[] = []): RateResult {
  return buildResult({
    insurer: null,
    grid: null,
    od: unsupported('Own-damage premium', reason),
    tp: unsupported('Third-party premium', reason),
    confidence: { level: 'low', reason },
    trace,
    questions,
    summary: reason,
  });
}

function detectAll(pages: PageText[]): Detection[] {
  const hits: Detection[] = [];
  for (const m of MODULES) {
    try {
      const d = m.detect(pages);
      if (d) hits.push(d);
    } catch {
      // A detector failing on odd text must not stop the others.
    }
  }
  return hits.sort((a, b) => b.score - a.score);
}

function chooseModule(
  pages: PageText[],
  overrides: FactOverrides,
): { module: InsurerModule | null; step: TraceStep; detection: Detection | null } {
  const forced = typeof overrides.insurer === 'string' ? moduleFor(overrides.insurer as InsurerId) : undefined;
  if (forced) {
    return {
      module: forced,
      detection: null,
      step: { title: 'Identify the insurer', detail: `The user selected ${forced.displayName}.`, outcome: 'ok' },
    };
  }
  const hits = detectAll(pages);
  const best = hits[0];
  if (!best || best.score < MIN_DETECTION_SCORE) {
    return {
      module: null,
      detection: null,
      step: {
        title: 'Identify the insurer',
        detail:
          'The document does not match any supported insurer (' +
          MODULES.map((m) => m.displayName).join(', ') +
          '). The agent only resolves rates for insurers whose grid is in the raters corpus.',
        outcome: 'stop',
      },
    };
  }
  const runnerUp = hits[1];
  const close = runnerUp && best.score - runnerUp.score < 0.15;
  const mod = moduleFor(best.insurer)!;
  const quotes = best.evidence.map((e) => `p${e.page ?? '?'} "${e.quote}"`).join('; ');
  return {
    module: mod,
    detection: best,
    step: {
      title: 'Identify the insurer',
      detail:
        `${mod.displayName} (score ${best.score.toFixed(2)}): ${quotes}.` +
        (close ? ` ${moduleFor(runnerUp.insurer)?.displayName} also scored ${runnerUp.score.toFixed(2)}.` : ''),
      outcome: close ? 'warn' : 'ok',
    },
  };
}

function withInsurer(facts: PolicyFacts, mod: InsurerModule, detection: Detection | null): PolicyFacts {
  if (facts.insurer.value) return facts;
  return {
    ...facts,
    insurer: detection
      ? { value: mod.id, status: 'found', evidence: detection.evidence }
      : { value: mod.id, status: 'user', evidence: [{ quote: `Selected by the user: ${mod.displayName}`, source: 'user' }] },
  };
}

const RECOVERED_NOTE = 'Read from the contrast-enhanced OCR pass (faint grey text the plain pass missed)';

/**
 * Second extraction over the contrast-enhanced OCR text, used only to fill facts the plain pass left
 * missing (in place). Returns a trace step when it filled anything, or null.
 */
function recoverFaintFields(mod: InsurerModule, pages: PageText[], facts: PolicyFacts): TraceStep | null {
  if (!pages.some((p) => p.enhancedText)) return null;
  let second: PolicyFacts;
  try {
    second = mod.extract(pages.map((p) => (p.enhancedText ? { ...p, text: p.enhancedText } : p)));
  } catch {
    return null; // the plain extraction stands on its own
  }
  const filled = fillMissing(facts, second, RECOVERED_NOTE);
  if (!filled.length) return null;
  return {
    title: 'Recover faint fields',
    detail: `The plain OCR pass missed ${filled.join(', ')}; read from a contrast-enhanced OCR pass of the same pages.`,
    outcome: 'ok',
  };
}

export function analyse(pages: PageText[], overrides: FactOverrides = {}): AnalysisResult {
  const analysedAt = new Date().toISOString();
  const sorted = [...pages].sort((a, b) => a.page - b.page);
  const trace: TraceStep[] = [textStep(sorted)];
  const done = (facts: PolicyFacts, result: RateResult): AnalysisResult => ({
    engineVersion: ENGINE_VERSION,
    analysedAt,
    facts,
    result,
  });

  if (trace[0].outcome === 'stop') {
    const reason =
      'Not enough readable text to analyse. If the PDF is a scan, OCR could not read it; try a clearer copy.';
    return done(applyOverrides(emptyFacts(), overrides), stopResult(trace, reason));
  }

  const { module: mod, step, detection } = chooseModule(sorted, overrides);
  trace.push(step);
  if (!mod) {
    const reason = 'Unsupported insurer: no commission grid for this policy in the raters corpus.';
    return done(applyOverrides(emptyFacts(), overrides), stopResult(trace, reason, [insurerQuestion()]));
  }

  let facts: PolicyFacts;
  try {
    const extracted = mod.extract(sorted);
    const recovery = recoverFaintFields(mod, sorted, extracted);
    if (recovery) trace.push(recovery);
    facts = applyOverrides(withInsurer(extracted, mod, detection), overrides);
  } catch (err) {
    trace.push({ title: 'Extract policy facts', detail: `Extraction failed: ${String(err)}`, outcome: 'stop' });
    return done(applyOverrides(emptyFacts(), overrides), stopResult(trace, 'Could not extract policy facts.'));
  }

  try {
    const result = mod.resolve(facts);
    return done(facts, { ...result, trace: [...trace, ...result.trace] });
  } catch (err) {
    trace.push({ title: 'Resolve the grid', detail: `Resolution failed: ${String(err)}`, outcome: 'stop' });
    return done(facts, stopResult(trace, 'The grid lookup failed for this policy.'));
  }
}
