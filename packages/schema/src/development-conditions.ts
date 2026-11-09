export interface DevelopmentConditions {
  readonly files: readonly string[]
  readonly commands: readonly string[]
}

export function normalizedDevelopmentPath(path: string) {
  return path.trim().replaceAll("\\", "/").replace(/^\.\//, "")
}

const fencedBlock = /^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]{0,3}\1[ \t]*\r?$|(?![\s\S]))/gm
const explicitFiles = /^[ \t]*(?:Allowed files|Only edit|改动范围|只允许修改)[：:][ \t]*([^\r\n]+)/gim
const inlineFiles = /(?:\b(?:change|modify|edit) only[ \t]+|(?:只|仅)(?:修改|改动)[ \t]*)((?:`[^`\r\n]+`|[\w./\\-]+)(?:(?:[ \t]*[,、，][ \t]*|[ \t]+(?:and|以及|和|与|及)[ \t]+)(?:`[^`\r\n]+`|[\w./\\-]+)(?=[ \t]*(?:[,、，。.!?;；]|\band\b|以及|和|与|及|$)))*)/gim
const explicitCommands = /^[ \t]*(?:Verification command|Test command|验证命令|验收命令|测试命令)[：:][ \t]*([^\r\n]+)/gim
const inlineCommands = /(?:\brun\s+|运行\s*)((?:`[^`\r\n]+`)|(?:node|bun|npm|pnpm|yarn|pytest|python|cargo|go|dotnet)\s+[^,，。\r\n]+)(?=\s*(?:[,，。\r\n]|$))/gi

function matches(text: string, pattern: RegExp) {
  return [...text.matchAll(pattern)].map(match => match[1].trim())
}

function positiveClauses(text: string, pattern: RegExp) {
  return [...text.matchAll(pattern)].filter(match => {
    const prefix = text.slice(0, match.index).split(/[,，。!?;；\r\n]|\.(?=\s)/).at(-1) ?? ""
    return !/\b(?:not|never|avoid|don't|without|skip)\b|不要|别|禁止|无需|不必|不用|不得/.test(prefix.toLowerCase())
  })
}

function unquote(value: string) {
  return value.startsWith("`") && value.endsWith("`") ? value.slice(1, -1).trim() : value
}

function fileList(value: string) {
  const tokens = value.match(/`[^`]+`|[^`,，、]+/g) ?? []
  const items = tokens.flatMap(token => token.startsWith("`") ? [token] :
    token.split(/(?:\s+|^)(?:and|以及|和|与|及)(?:\s+|$)/i))
    .map(item => item.trim()).filter(Boolean)
    .map(item => normalizedDevelopmentPath(unquote(item.replace(/\.$/, ""))))
  // Recognize explicit workspace-relative file names or directory prefixes only.
  // Ambiguous prose never narrows the review scope.
  return items.every(item =>
    /^(?:[\p{L}\p{N}_@.+ -]+\/)*[\p{L}\p{N}_@.+ -]+\/?$/u.test(item) &&
    !item.split("/").some(segment => segment === "." || segment === "..") &&
    (item.endsWith("/") || /\.[\p{L}\p{N}]+$/u.test(item) || /^(?:README|LICENSE|Makefile|Dockerfile)$/i.test(item)),
  ) ? items : []
}

/** Derive review hints from clear user clauses. These hints grant no tool permissions. */
export function parseDevelopmentConditions(text: string): DevelopmentConditions {
  const prose = text.replace(fencedBlock, "")
  const declared = matches(prose, explicitFiles)
  const inlineScopes = positiveClauses(prose, inlineFiles).flatMap(match => {
    // An unmatched conjunction can be a second file or a qualified instruction.
    // Require a complete clause before presenting a narrow scope.
    const suffix = prose.slice(match.index + match[0].length)
    return /^[ \t]*(?:\band\b|以及|和|与|及)/i.test(suffix) ? [] : [match[1]]
  })
  const scopes = (declared.length ? declared : inlineScopes).map(fileList)
  const declaredCommands = matches(prose, explicitCommands)
  const commandClauses = declaredCommands.length ? declaredCommands : positiveClauses(prose, inlineCommands)
    .map(match => match[1].trim().replace(/(\S)\.$/, "$1"))
  const commands = [...new Set(commandClauses
    .map(unquote).filter(command => command.length > 0 && command.length <= 2048))]
  const uniqueScopes = new Set(scopes.map(files => [...files].sort().join("\n")))
  return { files: uniqueScopes.size === 1 ? [...new Set(scopes[0])] : [], commands }
}
