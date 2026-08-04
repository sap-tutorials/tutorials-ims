import { describe, it, expect } from 'vitest'
import { composeTutorial } from '../parsers/compose.js'
import { renderHugoFrontmatter } from '../parsers/render-frontmatter.js'

const SRC = `---
parser: v2
time: 20
author_name: T
author_profile: https://github.com/t
tags: [tutorial>beginner]
primary_tag: products>x
---

# Create a UI

<!-- description --> Do the thing.

## Prerequisites

- prior tutorial

## Video Version

<iframe width="560" height="315" src="https://www.youtube.com/embed/6WY70LyLS1c" allowfullscreen></iframe>

### Run the services

1. Do it.
`

describe('compose + render intro passthrough', () => {
  it('composeTutorial returns the intro with the iframe', () => {
    const c = composeTutorial(SRC, { repo: 'r', branch: 'b', slug: 's', target: 'hugo', rewriteImages: false })
    expect(c.intro).toContain('6WY70LyLS1c')
    expect(c.intro).toContain('## Video Version')
  })
  it('renderHugoFrontmatter emits a tutorial-intro shortcode with the iframe', () => {
    const c = composeTutorial(SRC, { repo: 'r', branch: 'b', slug: 's', target: 'hugo', rewriteImages: false })
    const md = renderHugoFrontmatter({
      slug: 's', title: c.title, description: c.description, time: 20, level: c.level,
      tags: ['tutorial>beginner'], primaryTag: 'products>x', author: 'T', authorProfile: '',
      youWillLearn: c.youWillLearn, prerequisites: c.prerequisites, steps: c.steps,
      nav: { slug: 's', title: '', description: '', time: 20, level: 'beginner', stepCount: c.steps.length, primaryTag: '', displayTags: [], displayTagSlugs: [], prev: null, next: null },
      lastUpdated: '', createdAt: '', contributors: [], intro: c.intro,
    })
    expect(md).toContain('{{% tutorial-intro %}}')
    expect(md).toContain('6WY70LyLS1c')
    expect(md.indexOf('{{% tutorial-intro %}}')).toBeLessThan(md.indexOf('{{% tutorial-step'))
  })
  it('emits a video frontmatter object when video: is set', () => {
    const md = renderHugoFrontmatter({
      slug: 's', title: 'T', description: '', time: 20, level: 'beginner',
      tags: [], primaryTag: '', author: 'T', authorProfile: '',
      youWillLearn: [], prerequisites: '', steps: [{ number: 1, title: 'A', content: 'x' }],
      nav: { slug: 's', title: '', description: '', time: 20, level: 'beginner', stepCount: 1, primaryTag: '', displayTags: [], displayTagSlugs: [], prev: null, next: null },
      lastUpdated: '', createdAt: '', contributors: [],
      video: { embedUrl: 'https://www.youtube.com/embed/6WY70LyLS1c', title: 'Intro', provider: 'youtube' },
    })
    expect(md).toContain('embedUrl: https://www.youtube.com/embed/6WY70LyLS1c')
    expect(md).toContain('provider: youtube')
  })
})
