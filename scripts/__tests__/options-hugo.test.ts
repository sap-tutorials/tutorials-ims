import { describe, it, expect, vi } from 'vitest'
import { convertOptionBlocks } from '../parsers/options.js'

describe('convertOptionBlocks (hugo target)', () => {
  it('outputs Hugo shortcode syntax', () => {
    const input = `[OPTION BEGIN [Video]]
video content
[OPTION END]
[OPTION BEGIN [Written]]
text content
[OPTION END]`
    const result = convertOptionBlocks(input, 'hugo')
    expect(result).toContain('{{% option-tabs tabs="Video,Written" %}}')
    expect(result).toContain('{{% tab index="0" name="Video" %}}')
    expect(result).toContain('{{% /tab %}}')
    expect(result).toContain('{{% /option-tabs %}}')
  })

  it('preserves existing VitePress output when target is vitepress', () => {
    const input = `[OPTION BEGIN [A]]
content A
[OPTION END]`
    const result = convertOptionBlocks(input, 'vitepress')
    expect(result).toContain('OptionTabs')
  })

  it('preserves existing VitePress output when no target', () => {
    const input = `[OPTION BEGIN [A]]
content A
[OPTION END]`
    const result = convertOptionBlocks(input)
    expect(result).toContain('OptionTabs')
  })

  it('handles multiple option groups for hugo', () => {
    const input = `[OPTION BEGIN [A]]
A content
[OPTION END]
[OPTION BEGIN [B]]
B content
[OPTION END]

Other stuff.

[OPTION BEGIN [X]]
X content
[OPTION END]
[OPTION BEGIN [Y]]
Y content
[OPTION END]`

    const result = convertOptionBlocks(input, 'hugo')
    const tabsCount = (result.match(/\{{% option-tabs/g) ?? []).length
    expect(tabsCount).toBe(2)
    expect(result).toContain('{{% tab index="0" name="A" %}}')
    expect(result).toContain('{{% tab index="1" name="B" %}}')
    expect(result).toContain('{{% tab index="0" name="X" %}}')
    expect(result).toContain('{{% tab index="1" name="Y" %}}')
  })

  it('does not produce Vue syntax for hugo target', () => {
    const input = `[OPTION BEGIN [Test]]
some content
[OPTION END]`
    const result = convertOptionBlocks(input, 'hugo')
    expect(result).not.toContain('OptionTabs')
    expect(result).not.toContain('<template')
  })
})

describe('convertOptionBlocks (hugo) — OS groups', () => {
  it('emits os-options shortcode for an OS-shaped group', () => {
    const input = `[OPTION BEGIN [Windows]]
PowerShell stuff
[OPTION END]

[OPTION BEGIN [Mac and Linux]]
bash stuff
[OPTION END]
`;
    const out = convertOptionBlocks(input, 'hugo');
    expect(out).toContain('{{< os-options >}}');
    expect(out).toContain('{{< os-panel os="Windows" >}}');
    expect(out).toContain('{{< os-panel os="macOS" >}}');
    expect(out).toContain('{{< os-panel os="Linux" >}}');
    expect(out).toContain('{{< /os-options >}}');
    expect(out).not.toContain('option-tabs'); // OS group does NOT use the legacy shortcode
  });

  it('combined-label group duplicates body across canonical OSes', () => {
    const input = `[OPTION BEGIN [Windows]]
WIN_BODY
[OPTION END]

[OPTION BEGIN [Mac and Linux]]
NIX_BODY
[OPTION END]
`;
    const out = convertOptionBlocks(input, 'hugo');
    // macOS and Linux both get the same NIX_BODY content
    expect(out.match(/NIX_BODY/g)?.length).toBe(2);
    expect(out.match(/WIN_BODY/g)?.length).toBe(1);
  });

  it('keeps non-OS groups on the legacy option-tabs shortcode', () => {
    const input = `[OPTION BEGIN [JSON]]
json stuff
[OPTION END]

[OPTION BEGIN [XML]]
xml stuff
[OPTION END]
`;
    const out = convertOptionBlocks(input, 'hugo');
    expect(out).toContain('option-tabs');
    expect(out).not.toContain('os-options');
  });

  it('mixed page: one OS group + one non-OS group → both shortcodes coexist', () => {
    const input = `[OPTION BEGIN [Windows]]
W
[OPTION END]

[OPTION BEGIN [Mac and Linux]]
ML
[OPTION END]

Some prose between groups.

[OPTION BEGIN [JSON]]
J
[OPTION END]

[OPTION BEGIN [XML]]
X
[OPTION END]
`;
    const out = convertOptionBlocks(input, 'hugo');
    expect(out).toContain('os-options');
    expect(out).toContain('option-tabs');
  });

  it('single-OS group (Windows alone, no peer) stays as legacy option-tabs', () => {
    const input = `[OPTION BEGIN [Windows]]
only windows
[OPTION END]
`;
    const out = convertOptionBlocks(input, 'hugo');
    expect(out).toContain('option-tabs');
    expect(out).not.toContain('os-options');
  });
})

describe('convertOptionBlocks (hugo) — osOverrides logging', () => {
  it('warns when osOverrides forces os but classifier rejects a label', () => {
    const input = `### Step One

[OPTION BEGIN [Cloud]]
cloud
[OPTION END]

[OPTION BEGIN [Windows]]
windows
[OPTION END]
`;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = convertOptionBlocks(input, 'hugo', {
        stepSlug: 'step-one',
        osOverrides: { 'step-one': 'os' },
      });
      expect(out).toContain('option-tabs');
      expect(out).not.toContain('os-options');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/step-one/);
      expect(warnSpy.mock.calls[0][0]).toMatch(/Cloud/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does NOT warn for regular OS classification fall-through (no override set)', () => {
    const input = `[OPTION BEGIN [Windows]]
only windows
[OPTION END]
`;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      convertOptionBlocks(input, 'hugo');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
})
