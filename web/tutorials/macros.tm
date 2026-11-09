<TeXmacs|2.1.5>

<style|article>

<\body>
  <section|Make a reusable macro>

  A macro is a named TeXmacs structure you can reuse. The editor keeps its
  definition in the document preamble, so the macro travels with this
  manuscript.

  <subsection|Build a macro from a selection>

  1. Select a short expression or phrase in the document. For example, select
  the expression <math|<frac|a+b|c>> in the worked line below.

  <\equation*>
    <frac|a+b|c> = <frac|a|c> + <frac|b|c>
  </equation*>

  2. Choose Insert, then Macro, then New macro. TeXmacs opens its macro
  editor with your selected structure as the starting definition.

  3. Give the macro a memorable name. Choose Mathematics if the body is a
  formula, or Text if it is prose. Press Apply to update the definition and
  Ok to close the editor.

  4. Open Insert, then Macro again. The new name appears in the list. Choose
  it to insert the structure wherever you need it.

  <subsection|Change the definition>

  Insert your macro once, then open its editor again from Insert, Macro. Edit
  the body and press Apply. Every use of the macro in this manuscript now
  uses the new definition. Use Source mode in the macro editor when you want
  to inspect or adjust the structured definition itself.

  <subsection|Advanced: contextual macros>

  Put the cursor inside a structure you want to reuse, such as a formatted
  phrase or a table cell. Choose Insert, Macro, New context macro. TeXmacs
  creates a one-argument macro from the surrounding tags. The content at the
  cursor becomes its input slot, so the same formatting can wrap other text.

  <strong|Worked exercise:> make the words <strong|important idea> bold. Put
  the cursor in those words and create a context macro. Insert the new macro
  around the words <em|another idea>. The second phrase should inherit the
  same bold structure.

  For a table whose borders, alignment, and spacing you want to reuse, choose
  Insert, Macro, New table macro while the cursor is in that table.

  <strong|Practice:> make a custom notation for a recurring symbol, insert it
  twice, then change the macro and see both instances update. Rename this
  lesson and keep it as a macro notebook if useful.
</body>
