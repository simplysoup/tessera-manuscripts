<TeXmacs|2.1.5>

<style|article>

<\body>
  <section|Work with structured documents>

  A TeXmacs page is a nested document tree. Sections, theorems, equations,
  and their contents are separate editable tags. You can write directly on
  the page and move through those structures with the keyboard.

  <subsection|A worked example>

  <section|A named result>

  The heading above is a section tag. The result below is a theorem tag with
  a nested equation in its body.

  <\theorem>
    If <math|a> and <math|b> are positive, then
    <math|<frac|a+b|2>> is positive.
  </theorem>

  <subsection|Build your own structure>

  1. Put the cursor in the document and insert a section from Insert, then
  Section. Type a heading and press Return to continue in the following
  paragraph.

  2. Insert a theorem from the theorem tools. Type its statement, then add a
  displayed equation inside it. Click into the equation to edit its nested
  math.

  3. Move the cursor with the arrow keys. Tab moves between table cells;
  left and right move through adjacent content, including structure edges.
  Click directly on a visible element to place the caret there.

  4. Switch to Source mode to see the same document as structured markup.
  Switch back to Typeset view to continue editing the rendered page.

  <strong|Practice:> add a new section, create a theorem inside it, and put a
  fraction or matrix inside the theorem. Use the cursor context in the footer
  to see which tag contains the caret.
</body>
