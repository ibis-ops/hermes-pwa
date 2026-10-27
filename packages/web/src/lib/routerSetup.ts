import type { ModelProvider } from '@hermes-pwa/core';

const FAST_RE = /haiku|flash|mini|nano|lite|turbo|fast/i;

function versionOf(model: string): number[] {
  // Version numbers only: a long run of digits is a date stamp, not a version.
  return (model.match(/\d+/g) ?? []).filter((digits) => digits.length <= 3).map(Number);
}

function newerFirst(a: string, b: string): number {
  const x = versionOf(a);
  const y = versionOf(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const diff = (y[i] ?? -1) - (x[i] ?? -1);
    if (diff !== 0) return diff;
  }
  // Same version: the plain alias before a dated snapshot.
  return a.length - b.length;
}

/** The model the router should run on: the newest Haiku, Flash, Mini or similar on that provider. */
export function pickFastModel(provider: ModelProvider | undefined): string | undefined {
  if (!provider) return undefined;
  return [...provider.models.filter((model) => FAST_RE.test(model))].sort(newerFirst)[0];
}
