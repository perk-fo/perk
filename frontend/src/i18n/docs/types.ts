/**
 * The Docs page's content, one file per locale with the same sections, blocks and table shapes in the same order
 * (scripts/check-i18n.ts compares them). Text may contain `code` spans in backticks.
 */
export type DocBlock =
  | { kind: "p"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "steps"; items: Array<{ title: string; text: string }> }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "note"; text: string }
  /** the deployment's contract addresses with explorer links, rendered from live data */
  | { kind: "contracts" };

export interface DocSection {
  id: string;
  title: string;
  blocks: DocBlock[];
}

export interface DocsContent {
  sections: DocSection[];
}
