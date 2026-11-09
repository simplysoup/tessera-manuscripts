<TeXmacs|2.1.5>

<style|article>

<\body>
  <section|Link equations and citations>

  TeXmacs references point to named structures in the document. They follow
  those structures if the text moves or the numbering changes.

  <subsection|Label and cross-reference>

  1. Put the cursor in the equation below and choose Insert, then Link, then
  Label. Give the equation a short label such as <verbatim|eq-energy>.

  <\equation>
    E = mc<rsup|2>
  </equation>

  2. Place the cursor in this sentence and choose Insert, then Link, then
  Reference. Select the label you just made. TeXmacs inserts a live reference
  to the equation.

  3. Add a section or another equation above it. The reference updates with
  the document structure.

  <subsection|Citations and footnotes>

  Use Insert, Link, Citation to add a citation at the cursor. Citations use
  keys from the document bibliography, so choose a bibliography style and
  connect your bibliography file before expecting a formatted citation.

  Use Insert, Link, Footnote to add a note that belongs to the current point
  in the text. Type the note in its own structural slot; the page layout will
  place it as a footnote.

  <strong|Practice:> add a label to the equation, insert its reference into
  this paragraph, then add a footnote explaining one of the symbols. Try
  Source mode to see where labels, references, citations, and notes sit in
  the document tree.
</body>
