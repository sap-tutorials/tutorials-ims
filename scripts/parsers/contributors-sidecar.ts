export interface SidecarContributor { login: string; name: string; email: string; avatarUrl: string }
export interface ContributorsSidecar { slug: string; contributors: SidecarContributor[] }

export function buildContributorsSidecar(
  slug: string,
  contributors: Array<Partial<SidecarContributor>>,
): ContributorsSidecar | null {
  if (!contributors || contributors.length === 0) return null
  return {
    slug: slug.toLowerCase(),
    contributors: contributors.slice(0, 10).map((c) => ({
      login: c.login ?? '', name: c.name ?? '', email: c.email ?? '', avatarUrl: c.avatarUrl ?? '',
    })),
  }
}
