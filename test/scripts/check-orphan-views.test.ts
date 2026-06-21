/**
 * Unit tests for the artifact-name parser in scripts/check-orphan-views.cjs.
 *
 * The HANA-query path requires a live HDI binding and is exercised by the
 * post-deploy step in .github/workflows/deploy.yml. Here we only test the
 * pure helper that defines the filename → HANA view name contract.
 *
 * Filed alongside the issue follow-up to PR #519 (orphan
 * ANALYTICSSERVICE_TUTORIALREPOSITORIES.hdbview blocking deploy on 2026-06-21).
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error CommonJS import of a script bundled under scripts/
import { artifactToHanaName } from '../../scripts/check-orphan-views.cjs';

describe('artifactToHanaName()', () => {
  it('converts CDS dot-delimited artifacts to HANA underscore-delimited names', () => {
    expect(artifactToHanaName('AdminService.TutorialRepositories.hdbview'))
      .toBe('ADMINSERVICE_TUTORIALREPOSITORIES');
    expect(artifactToHanaName('AnalyticsService.TutorialRepositories.hdbview'))
      .toBe('ANALYTICSSERVICE_TUTORIALREPOSITORIES');
    expect(artifactToHanaName('com.sap.developers.ims.MyTutorialsView.hdbview'))
      .toBe('COM_SAP_DEVELOPERS_IMS_MYTUTORIALSVIEW');
  });

  it('uppercases the whole name (HANA stores identifiers uppercase unless quoted)', () => {
    expect(artifactToHanaName('foo.Bar.Baz.hdbview')).toBe('FOO_BAR_BAZ');
  });

  it('strips the trailing .hdbview suffix only (interior `.hdbview.` survives)', () => {
    // Defensive: the regex anchors to end-of-string so a name like
    // `foo.hdbview.bar.hdbview` collapses dots after stripping only the
    // terminal `.hdbview`.
    expect(artifactToHanaName('foo.hdbview.bar.hdbview')).toBe('FOO_HDBVIEW_BAR');
  });

  it('handles names without the .hdbview suffix gracefully (no-op for the suffix)', () => {
    // Callers pass the bare basename in some code paths.
    expect(artifactToHanaName('AdminService.Foo')).toBe('ADMINSERVICE_FOO');
  });
});
