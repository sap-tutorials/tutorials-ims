// scripts/parsers/sync-presets.ts

/**
 * Preset structure: each preset maps canonical values to ordered alias lists.
 * Order matters for multi-value matching (though currently each canonical
 * maps to a single list of aliases).
 */
export interface PresetDefinition {
  [canonical: string]: string[];
}

export interface SyncPresetsMap {
  runtime: PresetDefinition;
  account: PresetDefinition;
  ide: PresetDefinition;
}

export const SYNC_PRESETS: SyncPresetsMap = {
  runtime: {
    'Node.js': ['Node', 'NodeJS', 'Node.js', 'JavaScript', 'TypeScript', 'CAP Node.js'],
    'Java': ['Java', 'CAP Java', 'Spring'],
    'Python': ['Python'],
  },
  account: {
    'Trial': ['Trial', 'BTP Trial', 'Trial account'],
    'Free Tier': ['Free Tier'],
    'Enterprise': ['Enterprise', 'Pay-As-You-Go', 'PAYG', 'CPEA', 'BTPEA'],
  },
  ide: {
    'BAS': ['BAS', 'Business Application Studio', 'SAP BAS'],
    'VS Code': ['VS Code', 'Visual Studio Code', 'VSCode'],
  },
};

/**
 * Look up a label within a preset and return its canonical value.
 * Case-insensitive matching.
 * Returns null if the preset key is unknown or the label doesn't match.
 */
export function canonicalForLabel(
  key: string,
  label: string
): string | null {
  const preset = (SYNC_PRESETS as any)[key];
  if (!preset) return null;

  const lowerLabel = label.trim().toLowerCase();

  for (const [canonical, aliases] of Object.entries(preset)) {
    for (const alias of aliases as string[]) {
      if (alias.toLowerCase() === lowerLabel) {
        return canonical;
      }
    }
  }

  return null;
}

export interface ClassifyResult {
  key: string;
  values: Map<string, string>;
}

/**
 * Classify a group of labels to a single preset.
 * Returns { key, values } if ALL labels resolve to the same preset,
 * where values maps each source label to its canonical value.
 * Returns null if:
 *   - Any label is unresolved (unknown)
 *   - Labels span multiple presets
 *   - The group is empty
 */
export function classifyGroupToPreset(labels: string[]): ClassifyResult | null {
  if (labels.length === 0) return null;

  let assignedPresetKey: string | null = null;
  const values = new Map<string, string>();

  for (const label of labels) {
    let foundPreset: string | null = null;
    let canonical: string | null = null;

    // Try to resolve this label within each preset
    for (const presetKey of Object.keys(SYNC_PRESETS)) {
      const result = canonicalForLabel(presetKey, label);
      if (result !== null) {
        foundPreset = presetKey;
        canonical = result;
        break;
      }
    }

    // If label doesn't match any preset, fail the whole group
    if (foundPreset === null) {
      return null;
    }

    // If this is the first resolved label, set the expected preset
    if (assignedPresetKey === null) {
      assignedPresetKey = foundPreset;
    } else if (assignedPresetKey !== foundPreset) {
      // Label resolved to a different preset, fail
      return null;
    }

    values.set(label, canonical!);
  }

  return assignedPresetKey !== null
    ? { key: assignedPresetKey, values }
    : null;
}
