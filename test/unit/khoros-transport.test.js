import { describe, it, expect } from 'vitest';
import { buildKhorosUrl, validateApiQuery } from '../../srv/lib/khoros-transport.js';

describe('buildKhorosUrl', () => {
  it('wraps the predicate in parens and appends fixed clauses, URL-encoded', () => {
    const url = buildKhorosUrl("board.id='technology-blog-sap'");
    expect(url.startsWith('https://community.sap.com/api/2.0/search?q=')).toBe(true);
    const q = decodeURIComponent(new URL(url).searchParams.get('q'));
    expect(q).toBe(
      "SELECT subject,post_time,view_href,teaser,author.login FROM messages " +
      "WHERE (board.id='technology-blog-sap') AND depth=0 ORDER BY post_time DESC LIMIT 20"
    );
  });
});

describe('validateApiQuery', () => {
  it('accepts clean board/category predicates', () => {
    expect(validateApiQuery("board.id='technology-blog-sap'")).toBe(true);
    expect(validateApiQuery("category.id='technology' AND conversation.style='blog'")).toBe(true);
  });
  it('rejects injection attempts', () => {
    expect(validateApiQuery("x=1; DROP")).toBe(false);        // semicolon
    expect(validateApiQuery("x=1 LIMIT 999")).toBe(false);    // LIMIT
    expect(validateApiQuery("x=1) SELECT")).toBe(false);      // paren + SELECT
    expect(validateApiQuery("x=1 ORDER BY y")).toBe(false);   // ORDER
    expect(validateApiQuery('x=1\\')).toBe(false);            // backslash
    expect(validateApiQuery('')).toBe(false);                 // empty
    expect(validateApiQuery(null)).toBe(false);
  });
});
