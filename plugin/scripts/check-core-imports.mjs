import { readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const core = resolve(process.argv[2] ?? 'src/core')
let failures = 0

function inspect(file) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)

  function reject(node, detail) {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source))
    console.error(`${relative(process.cwd(), file)}:${position.line + 1}:${position.character + 1}: core import outside boundary: ${detail}`)
    failures++
  }

  function check(node, literal) {
    const specifier = literal && (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal))
      ? literal.text : undefined
    if (specifier === 'node:crypto') return
    if (specifier === '.' || specifier === '..' || specifier?.startsWith('./') || specifier?.startsWith('../')) {
      const path = relative(core, resolve(dirname(file), specifier))
      if (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)) return
    }
    reject(node, specifier ?? '(non-literal)')
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) check(node, node.moduleSpecifier)
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      check(node, node.moduleReference.expression)
    } else if (ts.isImportTypeNode(node)) {
      check(node, ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined)
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) reject(node, 'dynamic import() is not allowed')
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') check(node, node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
}

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const file = resolve(directory, entry.name)
    if (entry.isDirectory()) walk(file)
    else if (entry.isFile() && /\.(?:[cm]?ts|tsx)$/.test(entry.name)) inspect(file)
  }
}

walk(core)
if (failures) process.exitCode = 1
else console.log('core imports: OK')
