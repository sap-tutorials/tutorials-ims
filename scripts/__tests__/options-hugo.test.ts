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

describe('convertOptionBlocks (hugo) — osOverrides', () => {
  it('respects osOverrides: regular to demote a heuristic-OS group', () => {
    const input = `### My Step

[OPTION BEGIN [Windows]]
W
[OPTION END]

[OPTION BEGIN [Mac and Linux]]
ML
[OPTION END]
`;
    const out = convertOptionBlocks(input, 'hugo', {
      osOverrides: { 'my-step': 'regular' },
    });
    expect(out).toContain('option-tabs');
    expect(out).not.toContain('os-options');
  });

  it('respects osOverrides: os to promote an unrecognized-as-OS group', () => {
    const input = `### Solo Step

[OPTION BEGIN [Windows]]
W
[OPTION END]
`;
    const out = convertOptionBlocks(input, 'hugo', {
      osOverrides: { 'solo-step': 'os' },
    });
    expect(out).toContain('os-options');
    expect(out).toContain('os-panel os="Windows"');
  });

  it('hasOsOptionsOut out-param flips when any OS group is emitted', () => {
    const input = `[OPTION BEGIN [Windows]]
W
[OPTION END]

[OPTION BEGIN [Mac and Linux]]
ML
[OPTION END]
`;
    const flag = { value: false };
    convertOptionBlocks(input, 'hugo', { hasOsOptionsOut: flag });
    expect(flag.value).toBe(true);
  });

  it('hasOsOptionsOut stays false when only non-OS groups are emitted', () => {
    const input = `[OPTION BEGIN [JSON]]
J
[OPTION END]

[OPTION BEGIN [XML]]
X
[OPTION END]
`;
    const flag = { value: false };
    convertOptionBlocks(input, 'hugo', { hasOsOptionsOut: flag });
    expect(flag.value).toBe(false);
  });

  it('routes overrides to the correct step when multiple groups exist', () => {
    const input = `### Step One

[OPTION BEGIN [Windows]]
W1
[OPTION END]

[OPTION BEGIN [Mac and Linux]]
ML1
[OPTION END]

### Step Two

[OPTION BEGIN [Windows]]
W2
[OPTION END]

[OPTION BEGIN [Mac and Linux]]
ML2
[OPTION END]
`;
    const out = convertOptionBlocks(input, 'hugo', {
      osOverrides: { 'step-one': 'regular', 'step-two': 'os' },
    });
    // Step One was demoted to legacy option-tabs
    expect(out).toMatch(/option-tabs[\s\S]*W1[\s\S]*ML1/);
    // Step Two stays os-options
    expect(out).toMatch(/os-options[\s\S]*W2[\s\S]*ML2/);
  });
})

describe('convertOptionBlocks (hugo) — indented OPTION blocks inside list items (#2703, #2820)', () => {
  // When an OPTION block lives inside a numbered substep it is authored
  // indented 4 spaces. Approach A (#2820): the shortcode WRAPPER lines keep that
  // indentation so the block stays inside the surrounding <li> (the list never
  // closes — this is what keeps figures nested, see
  // test/unit/option-figure-list-nesting.test.ts for the render-level proof),
  // while the panel BODY is dedented to column 0 so os-panel.html's
  // `{{ .Inner | markdownify }}` parses the code fences / images / notes as
  // markdown instead of literal indented code.

  it('indents the shortcode wrappers to the substep and dedents the body for an indented OS group', () => {
    const input = [
      '3. Start the installer.',
      '',
      '    [OPTION BEGIN [Windows]]',
      '',
      '    ```Shell',
      '    hdbsetup.exe',
      '    ```',
      '',
      '    [OPTION END]',
      '',
      '    [OPTION BEGIN [Mac and Linux]]',
      '',
      '    ```Shell',
      '    ./hdbsetup',
      '    ```',
      '',
      '    [OPTION END]',
      '',
      '4. Next substep.',
      '',
    ].join('\n');

    const out = convertOptionBlocks(input, 'hugo');

    // Shortcode wrappers carry the substep's 4-space indent so Goldmark keeps
    // the block inside the <li> (list stays open; #2820). The body stays at
    // column 0.
    expect(out).toContain('\n    {{< os-options >}}');
    expect(out).toContain('\n    {{< /os-options >}}');
    expect(out).toContain('    {{< os-panel os="Windows" >}}');

    // The code fence inside the panel is dedented to column 0 so markdownify
    // parses it as a fenced block (not a 4-space indented-code block).
    expect(out).toContain('\n```Shell\n');
    expect(out).not.toContain('    ```Shell');

    // The following substep "4." survives at column 0.
    expect(out).toContain('\n4. Next substep.');
  });

  it('dedents the body of an indented legacy (non-OS) option-tabs group', () => {
    const input = [
      '2. Pick a format.',
      '',
      '    [OPTION BEGIN [JSON]]',
      '',
      '    json body',
      '',
      '    [OPTION END]',
      '',
      '    [OPTION BEGIN [XML]]',
      '',
      '    xml body',
      '',
      '    [OPTION END]',
      '',
      '3. Done.',
      '',
    ].join('\n');

    const out = convertOptionBlocks(input, 'hugo');
    expect(out).toContain('{{% option-tabs tabs="JSON,XML" %}}');
    // Approach A (#2820): wrappers carry the substep indent; body at column 0.
    expect(out).toContain('    {{% option-tabs tabs="JSON,XML" %}}');
    // Body dedented to column 0.
    expect(out).toContain('\njson body\n');
    expect(out).toContain('\n3. Done.');
  });

  it('leaves column-0 OPTION blocks flush-left (unchanged behaviour)', () => {
    const input = [
      '[OPTION BEGIN [Windows]]',
      'W',
      '[OPTION END]',
      '',
      '[OPTION BEGIN [Mac and Linux]]',
      'ML',
      '[OPTION END]',
      '',
    ].join('\n');

    const out = convertOptionBlocks(input, 'hugo');
    expect(out).toContain('{{< os-options >}}');
    // No accidental indentation introduced for the unindented case.
    expect(out).not.toContain('    {{< os-options >}}');
  });
})

describe('convertOptionBlocks (hugo) — real QA substep patterns (#2703 follow-up)', () => {
  // Regression for the hana-clients-install#step-2 report: the first #2703 fix
  // dedented only the FIRST body line (because entry.content was `.trim()`ed
  // before dedentBlock saw it, so dedentBlock measured min-indent = 0 and
  // became a no-op), and never dedented substep content that trails the
  // OPTION group. Both left 4-space indentation that Goldmark renders as a
  // literal indented-code block, detaching later substeps.

  it('dedents EVERY line of a multi-line fence body inside an indented substep', () => {
    const input = [
      '2. Access the install.',
      '',
      '    [OPTION BEGIN [Mac]]',
      '',
      '    ```Shell',
      '    hdiutil attach hanaclient-*.dmg',
      '    cd "/Volumes/SAP HANA Client"',
      '    ```',
      '',
      '    [OPTION END]',
      '',
      '3. Next.',
      '',
    ].join('\n');

    const out = convertOptionBlocks(input, 'hugo');

    // The opening fence, the closing fence, AND every command line must sit at
    // column 0 — otherwise markdownify sees a 4-space indented-code block and
    // shows literal backticks.
    expect(out).toContain('\n```Shell\n');
    expect(out).not.toMatch(/\n {4}```Shell/);
    expect(out).not.toMatch(/\n {4}hdiutil attach/);
    expect(out).not.toMatch(/\n {4}cd "/);
    expect(out).not.toMatch(/\n {4}```\n/);
  });

  it('dedents substep content that trails the OPTION group to column 0 (#2820)', () => {
    const input = [
      '3. Start the installer.',
      '',
      '    [OPTION BEGIN [Windows]]',
      '',
      '    ```Shell',
      '    hdbsetup.exe',
      '    ```',
      '',
      '    [OPTION END]',
      '',
      '    [OPTION BEGIN [Mac and Linux]]',
      '',
      '    ```Shell',
      '    ./hdbsetup',
      '    ```',
      '',
      '    [OPTION END]',
      '',
      '    Set the install directory and complete the installation.',
      '',
      '    ![Client install](download-client.png)',
      '',
      '    > [!TIP]',
      '    > If the install fails, run as administrator.',
      '',
      '4. After installation, verify the environment variables.',
      '',
    ].join('\n');

    const out = convertOptionBlocks(input, 'hugo');

    // #2820: the OPTION shortcode emits a block-level <div> that CLOSES the
    // surrounding tight list (verified against production-pinned Hugo 0.147.7 —
    // regardless of wrapper indent). Once the list closes, trailing content at
    // the authored 4-space indent is measured from column 0 and becomes a literal
    // indented-code block → the raw-markdown leak. So the trailing substep
    // content MUST be dedented to column 0 to render as sibling markdown; the
    // author's `4.` then reopens the list as <ol start="4">. (This reverses the
    // 19db8d027 regression, which left the tail at 4 spaces.) See
    // test/unit/option-tail-leak.test.ts for the render-level leak proof.
    expect(out).toMatch(/\nSet the install directory/);
    expect(out).toMatch(/\n!\[Client install\]/);
    expect(out).toMatch(/\n> \[!TIP\]/);
    // The tail must NOT remain at 4-space indent (that is the leaking shape).
    expect(out).not.toMatch(/\n {4}Set the install directory/);
    expect(out).not.toMatch(/\n {4}> \[!TIP\]/);
    expect(out).toContain('\n4. After installation');
  });
})
