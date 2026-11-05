## ADDED Requirements

### Requirement: Figures with captions and sizing
The `:::figure[Caption]` container SHALL render its images as a single figure with a numbered caption, an anchor, optional width/alignment, and a grid layout when it contains more than one image. The inline `:image[alt]{src}` directive SHALL render a sized inline image using the same URL resolution and CDN routing as block images. Existing standalone image attributes SHALL keep working.

#### Scenario: Multi-image figure
- **WHEN** a figure container holds two screenshots with caption "Old vs new cockpit"
- **THEN** both images render side by side under the caption "Figure N: Old vs new cockpit" with anchor `#figure-N`

#### Scenario: Inline sized image
- **WHEN** an author writes `Click :image[the gear icon]{src=gear.png width=16}`
- **THEN** a 16px-wide inline image resolved from the tutorial's image folder renders in the sentence

### Requirement: Before/after compare
The `::compare` directive SHALL render two images as an overlay controlled by an accessible slider that works with keyboard input, and SHALL degrade to side-by-side labelled images without JavaScript.

#### Scenario: Keyboard control
- **WHEN** a reader focuses the slider and presses the right arrow key
- **THEN** more of the "after" image is revealed

### Requirement: Image hotspots
A standalone image with a `hotspots` attribute SHALL render numbered markers at the given percentage positions, each linked to the corresponding item of the immediately following ordered list. The build SHALL fail when the list is missing or has fewer items than the highest marker number.

#### Scenario: Linked highlight
- **WHEN** a reader focuses marker 2
- **THEN** list item 2 is highlighted, and focusing list item 2 highlights marker 2

#### Scenario: Missing list
- **WHEN** an image declares hotspots 1–3 but is followed by a two-item list
- **THEN** the build fails naming the image and step

### Requirement: Terminal recordings
The `::cast[file]` directive SHALL embed an asciicast v2 recording with a static poster frame, lazily load the player, allow text selection, and expose a text transcript. Invalid or oversized (> 2 MB) cast files SHALL fail the build.

#### Scenario: Lazy loading
- **WHEN** a tutorial page with a cast is loaded and the cast is not yet in view
- **THEN** the player script has not been downloaded

#### Scenario: Transcript fallback
- **WHEN** MCP returns a step containing a cast
- **THEN** the output contains the recording's final terminal text in a code block

### Requirement: Diagram embeds
The `::diagram[file.svg]` directive SHALL render the diagram as a non-scriptable image with required alt text, zoom and pan in the lightbox, and dark-mode handling via an author-supplied dark variant or an automatic adaptation that the author can disable.

#### Scenario: Dark variant
- **WHEN** `src-dark` is set and the reader uses dark mode
- **THEN** the dark variant is displayed

#### Scenario: Missing alt
- **WHEN** a diagram directive lacks `alt`
- **THEN** the build fails with `directive/missing-attr`

### Requirement: Interactive tables
Markdown tables followed by a `{.sortable}`, `{.filterable}`, or `{.sticky}` attribute line SHALL gain column sorting with `aria-sort`, a filter input that hides non-matching rows, and/or a sticky header respectively. Tables without these classes SHALL render unchanged.

#### Scenario: Sort numeric column
- **WHEN** a reader activates the header of a numeric column in a sortable table
- **THEN** rows are ordered numerically and the header exposes `aria-sort="ascending"`

#### Scenario: Filter rows
- **WHEN** a reader types "hana" into a filterable table's filter box
- **THEN** only rows containing "hana" remain visible
