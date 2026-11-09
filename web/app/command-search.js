export const editorCommands = Object.freeze([
  { id: "section", title: "Insert a section", category: "Structure", path: "Insert › Section", keywords: "heading chapter organize outline", action: "insert:section" },
  { id: "subsection", title: "Insert a subsection", category: "Structure", path: "Insert › Section", keywords: "heading subheading organize outline", action: "insert:subsection" },
  { id: "theorem", title: "Insert a theorem", category: "Structure", path: "Insert › Theorem", keywords: "lemma proposition corollary proof", action: "insert:theorem" },
  { id: "inline-math", title: "Insert inline mathematics", category: "Mathematics", path: "Insert › Mathematics", keywords: "formula equation symbols inline math", action: "insert:inlineMath" },
  { id: "equation", title: "Insert a numbered equation", category: "Mathematics", path: "Insert › Mathematics", keywords: "display formula equation number", action: "insert:equation" },
  { id: "equations", title: "Insert several aligned equations", category: "Mathematics", path: "Insert › Mathematics", keywords: "align equation cases multi-line", action: "insert:equations" },
  { id: "fraction", title: "Insert a fraction", category: "Mathematics", path: "Insert › Mathematics", keywords: "divide numerator denominator ratio", action: "insert:fraction" },
  { id: "root", title: "Insert a square root", category: "Mathematics", path: "Insert › Mathematics", keywords: "radical root sqrt", action: "insert:root" },
  { id: "superscript", title: "Insert a superscript", category: "Mathematics", path: "Insert › Mathematics", keywords: "power exponent upper index", action: "insert:superscript" },
  { id: "subscript", title: "Insert a subscript", category: "Mathematics", path: "Insert › Mathematics", keywords: "lower index variable", action: "insert:subscript" },
  { id: "matrix", title: "Insert a matrix", category: "Mathematics", path: "Insert › Table › Matrix", keywords: "array cells determinant table rows columns", action: "insert:matrix", availability: "Place the cursor in mathematics first." },
  { id: "table", title: "Insert a table", category: "Tables", path: "Insert › Table", keywords: "tabular cells rows columns", action: "insert:table" },
  { id: "bold", title: "Make text bold", category: "Formatting", path: "Format › Text", keywords: "strong emphasis weight", action: "insert:bold" },
  { id: "italic", title: "Make text italic", category: "Formatting", path: "Format › Text", keywords: "emphasis slanted", action: "insert:italic" },
  { id: "label", title: "Insert a label", category: "References", path: "Insert › Link › Label", keywords: "anchor tag identify target", action: "insert:label" },
  { id: "reference", title: "Insert a cross-reference", category: "References", path: "Insert › Link › Reference", keywords: "xref point to equation section figure", action: "insert:reference" },
  { id: "page-reference", title: "Insert a page reference", category: "References", path: "Insert › Link › Page reference", keywords: "page number pageref", action: "insert:pageReference" },
  { id: "citation", title: "Insert a citation", category: "References", path: "Insert › Link › Citation", keywords: "cite bibliography reference source paper", action: "insert:citation" },
  { id: "footnote", title: "Insert a footnote", category: "References", path: "Insert › Link › Footnote", keywords: "note bottom of page", action: "insert:footnote" },
  { id: "macro", title: "Create or edit a macro", category: "Macros", path: "Insert › Macro › New macro", keywords: "custom command reusable notation template parameter", action: "insert:macro" },
  { id: "context-macro", title: "Create a context macro", category: "Macros", path: "Insert › Macro › New context macro", keywords: "custom command reusable context formatting", action: "insert:contextMacro", availability: "Place the cursor inside a structure whose formatting you want to reuse." },
  { id: "table-macro", title: "Create a table macro", category: "Macros", path: "Insert › Macro › New table macro", keywords: "custom table format reusable grid", action: "insert:tableMacro", availability: "Place the cursor inside the table to reuse." },
  { id: "undo", title: "Undo the last edit", category: "Editing", path: "Edit › Undo", keywords: "revert back", action: "insert:undo" },
  { id: "redo", title: "Redo the last edit", category: "Editing", path: "Edit › Redo", keywords: "repeat restore", action: "insert:redo" },
]);

export const editorTutorials = Object.freeze([
  { id: "matrix", title: "Build a matrix", category: "Tutorial", path: "Start here › Mathematics", keywords: "array cells rows columns determinant equation", file: "/tutorials/matrices.tm" },
  { id: "macros", title: "Make a reusable macro", category: "Tutorial", path: "Start here › Custom macros", keywords: "custom command reusable notation parameters", file: "/tutorials/macros.tm" },
  { id: "references", title: "Link equations and citations", category: "Tutorial", path: "Start here › References", keywords: "label xref reference cite bibliography footnote", file: "/tutorials/references.tm" },
  { id: "structure", title: "Work with structured documents", category: "Tutorial", path: "Start here › Sections and tags", keywords: "section heading theorem proof nesting source tree tags cursor", file: "/tutorials/structure.tm" },
  { id: "formatting", title: "Format text and navigate", category: "Tutorial", path: "Start here › Editing basics", keywords: "bold italic shortcuts F2 selection cursor keyboard", file: "/tutorials/formatting.tm" },
  { id: "export", title: "Import and export manuscripts", category: "Tutorial", path: "Start here › File workflows", keywords: "latex tex pdf download import convert save", file: "/tutorials/file-workflows.tm" },
]);

function score(item, query) {
  const fields = [item.title, item.category, item.path, item.keywords].join(" ").toLocaleLowerCase();
  const words = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  let total = 0;
  for (const word of words) {
    if (item.title.toLocaleLowerCase() === word) total += 18;
    else if (item.title.toLocaleLowerCase().startsWith(word)) total += 10;
    else if (item.title.toLocaleLowerCase().includes(word)) total += 7;
    else if (item.category.toLocaleLowerCase().includes(word)) total += 4;
    else if (item.path.toLocaleLowerCase().includes(word)) total += 3;
    else if (item.keywords.toLocaleLowerCase().includes(word)) total += 2;
    else if (fields.includes(word)) total += 1;
    else return 0;
  }
  return total;
}

export function searchEditor(query) {
  const items = [...editorCommands, ...editorTutorials];
  if (!query.trim()) return items.slice(0, 8).map((item, index) => ({ item, score: 8 - index }));
  return items.map(item => ({ item, score: score(item, query) }))
    .filter(result => result.score > 0)
    .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title))
    .slice(0, 12);
}
