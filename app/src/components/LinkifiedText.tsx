"use client";

import { Fragment, type ReactNode } from "react";

const URL_RE = /https?:\/\/[^\s<>"'\)\]]+/gi;

function trimTrailingPunctuation(url: string): { href: string; trail: string } {
  let href = url;
  let trail = "";
  while (/[.,;:!?)]$/.test(href)) {
    trail = href.slice(-1) + trail;
    href = href.slice(0, -1);
  }
  return { href, trail };
}

/** Render plain text with http(s) URLs as clickable links; keep newlines. */
export function LinkifiedText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  const re = new RegExp(URL_RE.source, URL_RE.flags);
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      parts.push(
        <Fragment key={`t-${key++}`}>{text.slice(last, match.index)}</Fragment>,
      );
    }
    const { href, trail } = trimTrailingPunctuation(match[0]);
    parts.push(
      <a
        key={`a-${key++}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="chat-link"
      >
        {href}
      </a>,
    );
    if (trail) {
      parts.push(<Fragment key={`p-${key++}`}>{trail}</Fragment>);
    }
    last = match.index + match[0].length;
  }

  if (last < text.length) {
    parts.push(<Fragment key={`t-${key++}`}>{text.slice(last)}</Fragment>);
  }

  return <span className="chat-text">{parts.length ? parts : text}</span>;
}
