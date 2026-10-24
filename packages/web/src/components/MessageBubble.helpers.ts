import { createElement, type AnchorHTMLAttributes, type HTMLAttributes } from 'react';
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

export const MARKDOWN_COMPONENTS = {
  pre: (props: HTMLAttributes<HTMLPreElement>) => createElement(CodeBlock, props),
  a: ({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) =>
    createElement(
      'a',
      {
        ...props,
        href,
        target: '_blank',
        rel: 'noopener noreferrer',
      },
      children,
    ),
};
