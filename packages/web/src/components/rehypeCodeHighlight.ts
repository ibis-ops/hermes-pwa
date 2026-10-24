import { createLowlight } from 'lowlight';
import type { Element, ElementContent, Root } from 'hast';
import langBash from 'highlight.js/lib/languages/bash';
import langCss from 'highlight.js/lib/languages/css';
import langDiff from 'highlight.js/lib/languages/diff';
import langJavascript from 'highlight.js/lib/languages/javascript';
import langJson from 'highlight.js/lib/languages/json';
import langMarkdown from 'highlight.js/lib/languages/markdown';
import langPython from 'highlight.js/lib/languages/python';
import langSql from 'highlight.js/lib/languages/sql';
import langSwift from 'highlight.js/lib/languages/swift';
import langTypescript from 'highlight.js/lib/languages/typescript';
import langXml from 'highlight.js/lib/languages/xml';
import langYaml from 'highlight.js/lib/languages/yaml';
import langPlaintext from 'highlight.js/lib/languages/plaintext';

/**
 * Syntax highlighting for fenced code blocks.
 *
 * A small rehype plugin on purpose: `rehype-highlight` always bundles
 * lowlight's "common" set (~37 grammars, 200 KB) even when given a custom
 * list. This registers only the languages Hermes is likely to print and leaves
 * everything else as plain text. Output is hast built by lowlight, rendered by
 * react-markdown like any other node, so no raw HTML is injected.
 */

const LANGUAGES = {
  bash: langBash,
  css: langCss,
  diff: langDiff,
  javascript: langJavascript,
  json: langJson,
  markdown: langMarkdown,
  python: langPython,
  sql: langSql,
  swift: langSwift,
  typescript: langTypescript,
  xml: langXml,
  yaml: langYaml,
  plaintext: langPlaintext,
};

const ALIASES: Record<string, string[]> = {
  bash: ['sh', 'shell', 'zsh', 'console'],
  javascript: ['js', 'jsx', 'mjs', 'cjs'],
  typescript: ['ts', 'tsx'],
  markdown: ['md'],
  python: ['py'],
  xml: ['html', 'svg', 'xhtml'],
  yaml: ['yml'],
  plaintext: ['text', 'txt'],
};

const lowlight = createLowlight(LANGUAGES);
for (const [name, aliases] of Object.entries(ALIASES)) lowlight.registerAlias(name, aliases);

function textOf(node: ElementContent): string {
  if (node.type === 'text') return node.value;
  if (node.type === 'element') return node.children.map(textOf).join('');
  return '';
}

function languageOf(node: Element): string | undefined {
  const className: unknown = node.properties?.className;
  const classes = Array.isArray(className)
    ? className.map(String)
    : typeof className === 'string'
      ? className.split(/\s+/)
      : [];
  for (const name of classes) {
    if (name.startsWith('language-')) return name.slice('language-'.length).toLowerCase();
  }
  return undefined;
}

function highlightCode(code: Element): void {
  const language = languageOf(code);
  if (!language || !lowlight.registered(language)) return;
  const text = code.children.map(textOf).join('');
  if (!text) return;
  const tree = lowlight.highlight(language, text);
  code.children = tree.children as ElementContent[];
  const classes = Array.isArray(code.properties.className) ? code.properties.className.map(String) : [];
  code.properties.className = ['hljs', ...classes.filter((c) => c !== 'hljs')];
}

function walk(node: Root | Element): void {
  for (const child of node.children) {
    if (child.type !== 'element') continue;
    if (child.tagName === 'pre') {
      for (const inner of child.children) {
        if (inner.type === 'element' && inner.tagName === 'code') highlightCode(inner);
      }
      continue;
    }
    walk(child);
  }
}

export default function rehypeCodeHighlight() {
  return (tree: Root) => {
    walk(tree);
  };
}

/** Exposed for tests. */
export function isHighlightedLanguage(name: string): boolean {
  return lowlight.registered(name);
}
