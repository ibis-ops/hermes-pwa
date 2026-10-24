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
  liveStatus?: string;
  liveFace?: string | undefined;
  pendingApprovals?: Approval[] | undefined;
  activeSessionIds?: string[] | undefined;
}

export function areMessageBubblePropsEqual(prev: MessageBubbleProps, next: MessageBubbleProps): boolean {
  return (
    prev.message === next.message &&
    prev.rpc === next.rpc &&
    prev.rest === next.rest &&
    prev.isLast === next.isLast &&
    prev.streaming === next.streaming &&
    prev.liveStatus === next.liveStatus &&
    prev.liveFace === next.liveFace &&
    prev.pendingApprovals === next.pendingApprovals &&
    prev.activeSessionIds === next.activeSessionIds
  );
}

/** GitHub-flavored markdown: tables, task lists, strikethrough, autolinks. */
export const REMARK_PLUGINS = [remarkGfm];

/** Syntax highlighting for fenced code; unknown languages pass through untouched. */
export const REHYPE_PLUGINS: PluggableList = [rehypeCodeHighlight];

/**
 * Model output may contain `![](https://...)`. Loading that would let injected
 * instructions exfiltrate transcript text through the image URL with no
 * approval step, so only same-origin sources render as pictures; anything
 * else shows as its alt text.
 */
function isSameOriginImage(src: string | undefined): boolean {
  if (!src) return false;
  const value = src.trim();
  if (value.startsWith('//')) return false;
  if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) return true;
  return /^(blob:|data:image\/)/i.test(value);
}

export const MARKDOWN_COMPONENTS = {
  pre: (props: HTMLAttributes<HTMLPreElement>) => createElement(CodeBlock, props),
  img: ({ src, alt, ...rest }: ImgHTMLAttributes<HTMLImageElement> & { node?: unknown }) => {
    const { node: _hast, ...props } = rest;
    void _hast;
    return isSameOriginImage(typeof src === 'string' ? src : undefined)
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
