/**
 * qa-only directive: renders QA-only content blocks.
 *
 * On QA channel: renders as Hugo {{< tut-qa-only reason="..." >}} shortcode
 * On PROD channel: strips entirely (returns empty markdown)
 * toText(): returns '' — body is invisible to AI/MCP pipelines
 *
 * Usage in tutorial markdown:
 *   :::qa-only[Reason for QA-only content]
 *   Content visible only on QA channel.
 *   :::
 */
import { type DirectiveDef, registerDirective } from '../directive-registry.js';
import { DirectiveParseError } from '../directives.js';

const qaOnlyDef: DirectiveDef = {
  name: 'qa-only',
  since: '1.0.0',
  summary: 'Renders QA-only content blocks; stripped entirely on PROD channel.',
  kinds: ['container'],
  label: { required: true, markdown: false },
  attrs: {},

  render(node, ctx) {
    const typedNode = node as { body?: string; label?: string; line: number };
    const typedCtx = ctx as { channel?: string; slug?: string };
    const body = typedNode.body ?? '';

    // Guard: step headings inside qa-only would silently alter step numbering
    // on PROD (where the block is stripped). Reject at parse time.
    const lines = body.split('\n');
    for (const line of lines) {
      if (/^#{1,6} /.test(line)) {
        throw new DirectiveParseError(
          'Step heading inside qa-only block is not allowed — it would alter step numbering on PROD',
          typedCtx.slug ?? '',
          typedNode.line,
          0,
          'qa-only',
          'invalid-content',
        );
      }
    }

    if (typedCtx.channel === 'qa') {
      return { params: { reason: typedNode.label ?? '' }, body };
    }
    // PROD: strip entirely
    return { markdown: '' };
  },

  toText() {
    return '';
  },
};

registerDirective(qaOnlyDef);

export { qaOnlyDef };
