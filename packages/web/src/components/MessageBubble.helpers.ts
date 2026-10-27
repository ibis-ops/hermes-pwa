import { createElement, type AnchorHTMLAttributes, type HTMLAttributes, type ImgHTMLAttributes } from 'react';
import remarkGfm from 'remark-gfm';
import rehypeCodeHighlight from './rehypeCodeHighlight';
import type { Approval, Message, RestClient, RpcClient } from '@hermes-pwa/core';
import { CodeBlock } from './CodeBlock';
import type { PluggableList } from 'unified';

export interface MessageBubbleProps {
  message: Message;
  rpc: RpcClient;
  /** Optional: lets file cards look up size and type of files the message mentions. */
  rest?: RestClient | undefined;
  isLast?: boolean;
  streaming?: boolean;
  /** The gateway's one-line status for the reply in progress ("Calling tool"). */
  liveStatus?: string;
  pendingApprovals?: Approval[] | undefined;
  activeSessionIds?: string[] | undefined;
  /** Epoch seconds of the prompt this reply answers; the elapsed time counts from it. */
  elapsedFrom?: number | undefined;
  /** For a message steered into a turn that is still running: stop the turn and send this as a fresh prompt. */
  onInterruptSteer?: (() => void) | undefined;
}

export function areMessageBubblePropsEqual(prev: MessageBubbleProps, next: MessageBubbleProps): boolean {
  return (
    prev.message === next.message &&
    prev.rpc === next.rpc &&
    prev.rest === next.rest &&
    prev.isLast === next.isLast &&
    prev.streaming === next.streaming &&
    prev.liveStatus === next.liveStatus &&
    prev.pendingApprovals === next.pendingApprovals &&
    prev.activeSessionIds === next.activeSessionIds &&
    prev.elapsedFrom === next.elapsedFrom &&
    prev.onInterruptSteer === next.onInterruptSteer
  );
}

/** GitHub-flavored markdown: tables, task lists, strikethrough, autolinks. */
export const REMARK_PLUGINS = [remarkGfm];

/** Syntax highlighting for fenced code; unknown languages pass through untouched. */
export const REHYPE_PLUGINS: PluggableList = [rehypeCodeHighlight];

/**
 * Model output may contain `![](https://...)`. Loading that would let injected
 * instructions exfiltrate transcript text through the image URL with no
 * approval step, so only the plugin's own file route (a file Hermes wrote on
 * the Mac) and inline data render as pictures; anything else shows as its alt
 * text. Other same-origin paths are refused too: an image tag is an
 * authenticated GET, and a path like the dashboard's logout must not be one
 * a reply can trigger.
 */
const PLUGIN_FILE_ROUTE = /^(?:\.{0,2}\/)*api\/plugins\/hermes-pwa\/file\?/i;

function isAllowedImageSource(src: string | undefined): boolean {
  if (!src) return false;
  const value = src.trim();
  if (value.startsWith('//')) return false;
  if (PLUGIN_FILE_ROUTE.test(value)) return true;
  return /^(blob:|data:image\/(?:png|jpe?g|gif|webp|avif);)/i.test(value);
}

export const MARKDOWN_COMPONENTS = {
  pre: (props: HTMLAttributes<HTMLPreElement>) => createElement(CodeBlock, props),
  img: ({ src, alt, ...rest }: ImgHTMLAttributes<HTMLImageElement> & { node?: unknown }) => {
    const { node: _hast, ...props } = rest;
    void _hast;
    return isAllowedImageSource(typeof src === 'string' ? src : undefined)
      ? createElement('img', { ...props, src, alt: alt ?? '', loading: 'lazy' })
      : createElement('span', { className: 'hm-message__blocked-image', title: 'External images are not loaded' }, alt || 'image');
  },
  a: ({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) => {
    const { node: _hast, ...props } = rest;
    void _hast;
    return createElement(
      'a',
      {
        ...props,
        href,
        target: '_blank',
        rel: 'noopener noreferrer',
      },
      children,
    );
  },
};
