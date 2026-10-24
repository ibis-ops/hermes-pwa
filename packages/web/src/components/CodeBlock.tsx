import { isValidElement, useRef, useState, type HTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { Icon } from './Icon';

/**
 * Fenced code block: language label, copy button, horizontal scroll.
 * rehype-highlight has already tokenized the `<code>` child and tagged it with
 * `language-xxx`; this component only adds the chrome around it.
 */

const LANGUAGE_LABELS: Record<string, string> = {
  js: 'JavaScript',
  javascript: 'JavaScript',
  jsx: 'JSX',
  ts: 'TypeScript',
  typescript: 'TypeScript',
  tsx: 'TSX',
  py: 'Python',
  python: 'Python',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  shell: 'Shell',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  toml: 'TOML',
  md: 'Markdown',
  markdown: 'Markdown',
  html: 'HTML',
  xml: 'XML',
  css: 'CSS',
  sql: 'SQL',
  swift: 'Swift',
  go: 'Go',
  rust: 'Rust',
  rs: 'Rust',
  java: 'Java',
  kotlin: 'Kotlin',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  ruby: 'Ruby',
  rb: 'Ruby',
  php: 'PHP',
  diff: 'Diff',
  plaintext: 'Text',
  text: 'Text',
};

function languageFromClassName(className: string | undefined): string | undefined {
  if (!className) return undefined;
  const match = /(?:^|\s)language-([\w+#-]+)/.exec(className);
  return match?.[1]?.toLowerCase();
}

function findCodeElement(children: ReactNode): ReactElement<{ className?: string }> | undefined {
  if (!children) return undefined;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findCodeElement(child);
      if (found) return found;
    }
    return undefined;
  }
  if (isValidElement(children) && children.type === 'code') {
    return children as ReactElement<{ className?: string }>;
  }
  return undefined;
}

export function CodeBlock({ children, className, ...rest }: HTMLAttributes<HTMLPreElement>) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const codeEl = findCodeElement(children);
  const language = languageFromClassName(codeEl?.props.className);
  const label = language ? LANGUAGE_LABELS[language] ?? language : undefined;

  async function copy() {
    const text = preRef.current?.innerText ?? '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text.replace(/\n$/, ''));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be unavailable (insecure context, denied permission); the
      // text is still selectable by hand.
    }
  }

  return (
    <div className="hm-code" data-testid="code-block" data-language={language ?? ''}>
      <div className="hm-code__bar">
        <span className="hm-code__lang">{label ?? 'Code'}</span>
        <button type="button" className="hm-code__copy" onClick={() => void copy()} aria-live="polite">
          <Icon name={copied ? 'check' : 'copy'} size={14} />
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre ref={preRef} className={className} {...rest}>
        {children}
      </pre>
    </div>
  );
}
