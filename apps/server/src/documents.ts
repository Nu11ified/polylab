import type { BibliographyEntry, NotebookCell, ResearchDocument } from "@polylab/types";

export function renderDocument(document: Omit<ResearchDocument, "previewHtml" | "buildLog" | "updatedAt">): ResearchDocument {
  const updatedAt = new Date().toISOString();
  const citationKeys = extractCitationKeys(document.source);
  const bibliography = extractBibliography(document.source);
  if (document.kind === "notebook") {
    const cells = (document.cells ?? []).length > 0 ? document.cells : parseNotebookCells(document.source);
    return {
      ...document,
      cells,
      source: serializeNotebookCells(cells),
      previewHtml: renderNotebook(cells),
      buildLog: [`Rendered ${cells.length} notebook cell${cells.length === 1 ? "" : "s"}.`, bibliographyLog(citationKeys, bibliography)],
      citationKeys,
      bibliography,
      updatedAt
    };
  }

  if (document.kind === "latex") {
    const equations = [...document.source.matchAll(/\\begin\{equation\}([\s\S]*?)\\end\{equation\}/g)].map((match) => match[1]?.trim() ?? "");
    const labels = [...document.source.matchAll(/\\label\{([^}]+)\}/g)].map((match) => match[1] ?? "");
    return {
      ...document,
      previewHtml: [
        `<article class="latex-preview">`,
        `<h1>${escapeHtml(document.title)}</h1>`,
        ...equations.map((equation, index) => `<div class="math-block" data-equation="${index + 1}">${escapeHtml(equation)}</div>`),
        renderBibliography(bibliography, citationKeys),
        `<pre>${escapeHtml(document.source)}</pre>`,
        `</article>`
      ].join(""),
      buildLog: [
        equations.length > 0 ? `Rendered ${equations.length} equation block${equations.length === 1 ? "" : "s"}.` : "No equation blocks found.",
        labels.length > 0 ? `Indexed ${labels.length} equation reference${labels.length === 1 ? "" : "s"}.` : "No equation references found.",
        bibliographyLog(citationKeys, bibliography)
      ],
      citationKeys,
      bibliography,
      updatedAt
    };
  }

  return {
    ...document,
    cells: document.cells ?? [],
    previewHtml: renderMarkdown(document.source),
    buildLog: [...markdownBuildLog(document.source), bibliographyLog(citationKeys, bibliography)],
    citationKeys,
    bibliography,
    updatedAt
  };
}

export function renderDocumentPdf(document: ResearchDocument): Uint8Array {
  const lines = [
    document.title,
    `${document.kind.toUpperCase()} / ${document.path}`,
    "",
    ...plainText(document.source).split("\n").slice(0, 42),
    "",
    document.citationKeys.length ? `Citations: ${document.citationKeys.join(", ")}` : "Citations: none",
    document.bibliography.length ? `Bibliography: ${document.bibliography.map((entry) => entry.key).join(", ")}` : "Bibliography: none"
  ];
  return minimalPdf(lines.join("\n"));
}

export function defaultDocuments(): ResearchDocument[] {
  return [
    renderDocument({
      id: "research-note",
      kind: "markdown",
      title: "Research Note",
      path: "notebooks/research-note.md",
      linkedFormulaIds: ["softmax-jacobian"],
      citationKeys: [],
      bibliography: [],
      cells: [],
      source: `# Research Note\n\nLinked formula: {{formula:softmax-jacobian}}\n\nArtifact: {{artifact:artifacts/executions/latest/stdout.txt}}\n\n## Verification\n\n- Symbolic checks\n- Numerical row-sum residual\n- Patch review before mutation\n\n\`\`\`mermaid\ngraph TD\n  Idea --> Formula\n  Formula --> Verification\n\`\`\`\n\n\`\`\`python\nprint(\"PolyLab\")\n\`\`\`\n`
    }),
    renderDocument({
      id: "experiment-notebook",
      kind: "notebook",
      title: "Experiment Notebook",
      path: "notebooks/experiment.polybook.md",
      linkedFormulaIds: ["softmax-jacobian"],
      citationKeys: [],
      bibliography: [],
      source: "",
      cells: [
        notebookCell("markdown", "# Experiment\n\nLinked formula: {{formula:softmax-jacobian}}"),
        notebookCell("code", "print(\"PolyLab notebook ready\")", "python"),
        notebookCell("math", "J_{ij} = s_i(\\delta_{ij} - s_j)", "latex")
      ]
    }),
    renderDocument({
      id: "paper-draft",
      kind: "latex",
      title: "Paper Draft",
      path: "papers/paper-draft.tex",
      linkedFormulaIds: ["softmax-jacobian"],
      citationKeys: ["vaswani2017"],
      bibliography: [],
      cells: [],
      source: `\\section{Softmax Jacobian}\n\\begin{equation}\\label{eq:softmax-jacobian}\nJ_{ij} = s_i(\\delta_{ij} - s_j)\n\\end{equation}\nPrior attention work \\cite{vaswani2017} motivates stable softmax implementations.\n\n@vaswani2017{Attention Is All You Need|Vaswani et al.|2017|NeurIPS}\n`
    })
  ];
}

export function serializeNotebookCells(cells: NotebookCell[]) {
  return cells.map((cell) => [
    `<!-- polylab-cell ${cell.kind} ${cell.language ?? "text"} ${cell.id} -->`,
    cell.source,
    cell.output ? `\n<!-- output -->\n${cell.output}` : ""
  ].join("\n")).join("\n\n");
}

export function parseNotebookCells(source: string): NotebookCell[] {
  if (!source.trim()) return [];
  const parts = source.split(/<!--\s*polylab-cell\s+/g).filter((part) => part.trim());
  if (parts.length === 0) return [notebookCell("markdown", source)];
  return parts.map((part) => {
    const [header = "", ...body] = part.split("-->");
    const [kind = "markdown", language = "text", id = crypto.randomUUID()] = header.trim().split(/\s+/);
    const [cellSource = "", output = ""] = body.join("-->").split(/<!--\s*output\s*-->/);
    return {
      id,
      kind: isCellKind(kind) ? kind : "markdown",
      language: isLanguage(language) ? language : "text",
      source: cellSource.trim(),
      output: output.trim() || undefined,
      executionState: output.trim() ? "succeeded" : "idle",
      artifactPaths: [],
      updatedAt: new Date().toISOString()
    };
  });
}

function renderMarkdown(source: string) {
  const lines = source.split("\n");
  const html: string[] = ['<article class="markdown-preview">'];
  let inCode = false;
  let codeLanguage = "text";
  let code: string[] = [];

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCode) {
        html.push(renderCodeBlock(codeLanguage, code.join("\n")));
        code = [];
        codeLanguage = "text";
        inCode = false;
      } else {
        inCode = true;
        codeLanguage = line.slice(3).trim().toLowerCase() || "text";
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    if (line.startsWith("# ")) html.push(`<h1>${escapeHtml(line.slice(2))}</h1>`);
    else if (line.startsWith("## ")) html.push(`<h2>${escapeHtml(line.slice(3))}</h2>`);
    else if (line.startsWith("- ")) html.push(`<li>${linkInlineReferences(escapeHtml(line.slice(2)))}</li>`);
    else if (line.trim()) html.push(`<p>${linkInlineReferences(escapeHtml(line))}</p>`);
  }
  html.push("</article>");
  const bibliography = extractBibliography(source);
  const citationKeys = extractCitationKeys(source);
  return html.join("").replace("</article>", `${renderBibliography(bibliography, citationKeys)}</article>`);
}

function renderNotebook(cells: NotebookCell[]) {
  return [
    '<article class="notebook-preview">',
    ...cells.map((cell) => {
      if (cell.kind === "markdown") return `<section class="notebook-cell">${renderMarkdown(cell.source)}</section>`;
      if (cell.kind === "math") return `<section class="notebook-cell"><div class="math-block">${escapeHtml(cell.source)}</div></section>`;
      return [
        '<section class="notebook-cell">',
        `<pre><code>${escapeHtml(cell.source)}</code></pre>`,
        cell.output ? `<pre class="cell-output">${escapeHtml(cell.output)}</pre>` : "",
        '</section>'
      ].join("");
    }),
    '</article>'
  ].join("");
}

function notebookCell(kind: NotebookCell["kind"], source: string, language: NotebookCell["language"] = kind === "code" ? "python" : kind === "markdown" ? "markdown" : "text"): NotebookCell {
  return {
    id: crypto.randomUUID(),
    kind,
    language,
    source,
    executionState: "idle",
    artifactPaths: [],
    updatedAt: new Date().toISOString()
  };
}

function isCellKind(value: string): value is NotebookCell["kind"] {
  return value === "markdown" || value === "code" || value === "math" || value === "plot";
}

function isLanguage(value: string): value is NonNullable<NotebookCell["language"]> {
  return value === "markdown" || value === "python" || value === "typescript" || value === "latex" || value === "text";
}

function renderCodeBlock(language: string, source: string) {
  if (language === "mermaid") {
    return `<div class="mermaid-block" data-diagram="mermaid">${escapeHtml(source)}</div>`;
  }
  const executable = language === "python" || language === "typescript" || language === "ts";
  const normalizedLanguage = language === "ts" ? "typescript" : language;
  return `<pre class="${executable ? "executable-code" : "code-block"}" data-language="${escapeHtml(normalizedLanguage)}" data-executable="${executable ? "true" : "false"}"><code>${escapeHtml(source)}</code></pre>`;
}

function markdownBuildLog(source: string) {
  const fences = [...source.matchAll(/^```([a-zA-Z0-9_-]*)/gm)].map((match) => (match[1] ?? "").toLowerCase());
  const mermaidCount = fences.filter((language) => language === "mermaid").length;
  const executableCount = fences.filter((language) => language === "python" || language === "typescript" || language === "ts").length;
  return [
    "Markdown preview rendered.",
    mermaidCount > 0 ? `Rendered ${mermaidCount} Mermaid diagram${mermaidCount === 1 ? "" : "s"}.` : "No Mermaid diagrams found.",
    executableCount > 0 ? `Marked ${executableCount} executable code block${executableCount === 1 ? "" : "s"}.` : "No executable code blocks found."
  ];
}

function linkInlineReferences(value: string) {
  return value
    .replace(/\{\{formula:([a-zA-Z0-9_-]+)\}\}/g, '<span class="formula-ref">$1</span>')
    .replace(/\{\{artifact:([^}]+)\}\}/g, '<span class="artifact-ref">$1</span>')
    .replace(/\{\{benchmark:([^}]+)\}\}/g, '<span class="benchmark-ref">$1</span>')
    .replace(/\[@([a-zA-Z0-9:_-]+)\]/g, '<span class="citation-ref">@$1</span>')
    .replace(/\\cite\{([^}]+)\}/g, '<span class="citation-ref">$1</span>')
    .replace(/\\ref\{([^}]+)\}/g, '<span class="equation-ref">$1</span>');
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function extractCitationKeys(source: string) {
  const markdown = [...source.matchAll(/\[@([a-zA-Z0-9:_-]+)\]/g)].map((match) => match[1] ?? "");
  const latex = [...source.matchAll(/\\cite\{([^}]+)\}/g)].flatMap((match) => (match[1] ?? "").split(",").map((item) => item.trim()));
  return [...new Set([...markdown, ...latex].filter(Boolean))];
}

function extractBibliography(source: string): BibliographyEntry[] {
  return [...source.matchAll(/^@([a-zA-Z0-9:_-]+)\{([^|}]+)(?:\|([^|}]*))?(?:\|([^|}]*))?(?:\|([^}]*))?\}/gm)].map((match) => ({
    key: match[1] ?? "",
    title: (match[2] ?? "Untitled reference").trim(),
    authors: (match[3] ?? "Unknown author").split(/,\s*/).map((author) => author.trim()).filter(Boolean),
    year: match[4]?.trim(),
    source: match[5]?.trim()
  })).filter((entry) => entry.key);
}

function renderBibliography(entries: BibliographyEntry[], citationKeys: string[]) {
  if (entries.length === 0 && citationKeys.length === 0) return "";
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  return [
    '<section class="bibliography">',
    '<h2>Bibliography</h2>',
    ...citationKeys.map((key) => {
      const entry = byKey.get(key);
      return entry
        ? `<p id="ref-${escapeHtml(key)}"><strong>${escapeHtml(key)}</strong> ${escapeHtml(entry.authors.join(", "))}. ${escapeHtml(entry.title)}${entry.year ? ` (${escapeHtml(entry.year)})` : ""}${entry.source ? `. ${escapeHtml(entry.source)}` : ""}.</p>`
        : `<p id="ref-${escapeHtml(key)}"><strong>${escapeHtml(key)}</strong> Missing bibliography entry.</p>`;
    }),
    ...entries.filter((entry) => !citationKeys.includes(entry.key)).map((entry) => `<p id="ref-${escapeHtml(entry.key)}"><strong>${escapeHtml(entry.key)}</strong> ${escapeHtml(entry.title)}</p>`),
    '</section>'
  ].join("");
}

function bibliographyLog(citationKeys: string[], bibliography: BibliographyEntry[]) {
  const missing = citationKeys.filter((key) => !bibliography.some((entry) => entry.key === key));
  if (citationKeys.length === 0 && bibliography.length === 0) return "No citations or bibliography entries found.";
  if (missing.length > 0) return `Resolved ${citationKeys.length - missing.length}/${citationKeys.length} citation${citationKeys.length === 1 ? "" : "s"}; missing ${missing.join(", ")}.`;
  return `Resolved ${citationKeys.length} citation${citationKeys.length === 1 ? "" : "s"} with ${bibliography.length} bibliography entr${bibliography.length === 1 ? "y" : "ies"}.`;
}

function plainText(value: string) {
  return value
    .replace(/^@.+$/gm, "")
    .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, "$1")
    .replace(/[{}]/g, "")
    .trim();
}

function minimalPdf(text: string) {
  const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const lines = escaped.split("\n").map((line, index) => `BT /F1 10 Tf 48 ${760 - index * 14} Td (${line.slice(0, 96)}) Tj ET`).join("\n");
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj",
    "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    `5 0 obj << /Length ${lines.length} >> stream\n${lines}\nendstream endobj`
  ];
  const body = objects.join("\n");
  return new TextEncoder().encode(`%PDF-1.4\n${body}\n%%EOF\n`);
}
