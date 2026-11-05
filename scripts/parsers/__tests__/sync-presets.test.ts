import { describe, it, expect } from 'vitest';
import {
  canonicalForLabel,
  classifyGroupToPreset,
  SYNC_PRESETS,
} from '../sync-presets.js';

describe('sync-presets', () => {
  describe('SYNC_PRESETS structure', () => {
    it('exports SYNC_PRESETS object with runtime, account, and ide presets', () => {
      expect(SYNC_PRESETS).toBeDefined();
      expect(SYNC_PRESETS.runtime).toBeDefined();
      expect(SYNC_PRESETS.account).toBeDefined();
      expect(SYNC_PRESETS.ide).toBeDefined();
    });
  });

  describe('canonicalForLabel', () => {
    describe('runtime preset', () => {
      it('maps Node → Node.js', () => {
        expect(canonicalForLabel('runtime', 'Node')).toBe('Node.js');
      });

      it('maps Node.js → Node.js', () => {
        expect(canonicalForLabel('runtime', 'Node.js')).toBe('Node.js');
      });

      it('maps NodeJS → Node.js', () => {
        expect(canonicalForLabel('runtime', 'NodeJS')).toBe('Node.js');
      });

      it('maps JavaScript → Node.js', () => {
        expect(canonicalForLabel('runtime', 'JavaScript')).toBe('Node.js');
      });

      it('maps TypeScript → Node.js', () => {
        expect(canonicalForLabel('runtime', 'TypeScript')).toBe('Node.js');
      });

      it('maps CAP Node.js → Node.js', () => {
        expect(canonicalForLabel('runtime', 'CAP Node.js')).toBe('Node.js');
      });

      it('maps Java → Java', () => {
        expect(canonicalForLabel('runtime', 'Java')).toBe('Java');
      });

      it('maps CAP Java → Java', () => {
        expect(canonicalForLabel('runtime', 'CAP Java')).toBe('Java');
      });

      it('maps Spring → Java', () => {
        expect(canonicalForLabel('runtime', 'Spring')).toBe('Java');
      });

      it('maps Python → Python', () => {
        expect(canonicalForLabel('runtime', 'Python')).toBe('Python');
      });

      it('is case-insensitive: "node" → Node.js', () => {
        expect(canonicalForLabel('runtime', 'node')).toBe('Node.js');
      });

      it('is case-insensitive: "JAVA" → Java', () => {
        expect(canonicalForLabel('runtime', 'JAVA')).toBe('Java');
      });

      it('returns null for unknown label', () => {
        expect(canonicalForLabel('runtime', 'Go')).toBeNull();
      });
    });

    describe('account preset', () => {
      it('maps Trial → Trial', () => {
        expect(canonicalForLabel('account', 'Trial')).toBe('Trial');
      });

      it('maps BTP Trial → Trial', () => {
        expect(canonicalForLabel('account', 'BTP Trial')).toBe('Trial');
      });

      it('maps Trial account → Trial', () => {
        expect(canonicalForLabel('account', 'Trial account')).toBe('Trial');
      });

      it('maps Free Tier → Free Tier', () => {
        expect(canonicalForLabel('account', 'Free Tier')).toBe('Free Tier');
      });

      it('maps Enterprise → Enterprise', () => {
        expect(canonicalForLabel('account', 'Enterprise')).toBe('Enterprise');
      });

      it('maps Pay-As-You-Go → Enterprise', () => {
        expect(canonicalForLabel('account', 'Pay-As-You-Go')).toBe('Enterprise');
      });

      it('maps PAYG → Enterprise', () => {
        expect(canonicalForLabel('account', 'PAYG')).toBe('Enterprise');
      });

      it('maps CPEA → Enterprise', () => {
        expect(canonicalForLabel('account', 'CPEA')).toBe('Enterprise');
      });

      it('maps BTPEA → Enterprise', () => {
        expect(canonicalForLabel('account', 'BTPEA')).toBe('Enterprise');
      });

      it('is case-insensitive: "pay-as-you-go" → Enterprise', () => {
        expect(canonicalForLabel('account', 'pay-as-you-go')).toBe('Enterprise');
      });

      it('returns null for unknown label', () => {
        expect(canonicalForLabel('account', 'Academic')).toBeNull();
      });
    });

    describe('ide preset', () => {
      it('maps BAS → BAS', () => {
        expect(canonicalForLabel('ide', 'BAS')).toBe('BAS');
      });

      it('maps Business Application Studio → BAS', () => {
        expect(canonicalForLabel('ide', 'Business Application Studio')).toBe('BAS');
      });

      it('maps SAP BAS → BAS', () => {
        expect(canonicalForLabel('ide', 'SAP BAS')).toBe('BAS');
      });

      it('maps VS Code → VS Code', () => {
        expect(canonicalForLabel('ide', 'VS Code')).toBe('VS Code');
      });

      it('maps Visual Studio Code → VS Code', () => {
        expect(canonicalForLabel('ide', 'Visual Studio Code')).toBe('VS Code');
      });

      it('maps VSCode → VS Code', () => {
        expect(canonicalForLabel('ide', 'VSCode')).toBe('VS Code');
      });

      it('is case-insensitive: "vs code" → VS Code', () => {
        expect(canonicalForLabel('ide', 'vs code')).toBe('VS Code');
      });

      it('returns null for unknown label', () => {
        expect(canonicalForLabel('ide', 'Sublime Text')).toBeNull();
      });
    });

    it('returns null for unknown preset key', () => {
      expect(canonicalForLabel('unknown', 'Node')).toBeNull();
    });
  });

  describe('classifyGroupToPreset', () => {
    it('returns account preset for [Trial, Enterprise]', () => {
      const result = classifyGroupToPreset(['Trial', 'Enterprise']);
      expect(result).not.toBeNull();
      expect(result?.key).toBe('account');
      expect(result?.values.get('Trial')).toBe('Trial');
      expect(result?.values.get('Enterprise')).toBe('Enterprise');
    });

    it('returns account preset for [Pay-As-You-Go, Free Tier]', () => {
      const result = classifyGroupToPreset(['Pay-As-You-Go', 'Free Tier']);
      expect(result).not.toBeNull();
      expect(result?.key).toBe('account');
      expect(result?.values.get('Pay-As-You-Go')).toBe('Enterprise');
      expect(result?.values.get('Free Tier')).toBe('Free Tier');
    });

    it('returns runtime preset for [Node, Java, Python]', () => {
      const result = classifyGroupToPreset(['Node', 'Java', 'Python']);
      expect(result).not.toBeNull();
      expect(result?.key).toBe('runtime');
      expect(result?.values.get('Node')).toBe('Node.js');
      expect(result?.values.get('Java')).toBe('Java');
      expect(result?.values.get('Python')).toBe('Python');
    });

    it('returns runtime preset for [CAP Node.js, CAP Java]', () => {
      const result = classifyGroupToPreset(['CAP Node.js', 'CAP Java']);
      expect(result).not.toBeNull();
      expect(result?.key).toBe('runtime');
      expect(result?.values.get('CAP Node.js')).toBe('Node.js');
      expect(result?.values.get('CAP Java')).toBe('Java');
    });

    it('returns ide preset for [BAS, VS Code]', () => {
      const result = classifyGroupToPreset(['BAS', 'VS Code']);
      expect(result).not.toBeNull();
      expect(result?.key).toBe('ide');
      expect(result?.values.get('BAS')).toBe('BAS');
      expect(result?.values.get('VS Code')).toBe('VS Code');
    });

    it('returns ide preset for [Business Application Studio, Visual Studio Code]', () => {
      const result = classifyGroupToPreset(['Business Application Studio', 'Visual Studio Code']);
      expect(result).not.toBeNull();
      expect(result?.key).toBe('ide');
      expect(result?.values.get('Business Application Studio')).toBe('BAS');
      expect(result?.values.get('Visual Studio Code')).toBe('VS Code');
    });

    it('returns null when labels span multiple presets (Java + Windows)', () => {
      const result = classifyGroupToPreset(['Java', 'Windows']);
      expect(result).toBeNull();
    });

    it('returns null when labels include unresolved (unknown)', () => {
      const result = classifyGroupToPreset(['Trial', 'Unknown']);
      expect(result).toBeNull();
    });

    it('returns null when a label does not match any preset', () => {
      const result = classifyGroupToPreset(['Node', 'Go', 'Java']);
      expect(result).toBeNull();
    });

    it('returns null when labels are from different presets (Trial + Node)', () => {
      const result = classifyGroupToPreset(['Trial', 'Node']);
      expect(result).toBeNull();
    });

    it('handles case-insensitive matching: [node, JAVA]', () => {
      const result = classifyGroupToPreset(['node', 'JAVA']);
      expect(result).not.toBeNull();
      expect(result?.key).toBe('runtime');
      expect(result?.values.get('node')).toBe('Node.js');
      expect(result?.values.get('JAVA')).toBe('Java');
    });

    it('handles single label [Node.js]', () => {
      const result = classifyGroupToPreset(['Node.js']);
      expect(result).not.toBeNull();
      expect(result?.key).toBe('runtime');
      expect(result?.values.get('Node.js')).toBe('Node.js');
    });

    it('handles empty label array', () => {
      const result = classifyGroupToPreset([]);
      expect(result).toBeNull();
    });
  });
});
