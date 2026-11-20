import { readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const core = resolve('src/core')
const app = resolve('src/app')
let failures = 0

function contains(directory, target) {
  const path = relative(directory, target)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function inspect(file, layer) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const directory = dirname(file)

  function reject(node, detail) {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source))
    console.error(`${relative(process.cwd(), file)}:${position.line + 1}:${position.character + 1}: ${layer} import outside boundary: ${detail}`)
    failures++
  }

  function check(node, literal) {
    const specifier = literal && (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal))
      ? literal.text : undefined
    if (specifier === undefined) {
      reject(node, '(non-literal module reference)')
      return
    }
    const path = specifier.replaceAll('\\', '/')
    const local = path === '.' || path === '..' || path.startsWith('./') || path.startsWith('../')
    if (layer === 'core') {
      if (specifier !== 'node:crypto' && !(local && contains(core, resolve(directory, path)))) reject(node, specifier)
    } else if ((local || isAbsolute(path)) && contains(app, resolve(directory, path))) {
      reject(node, specifier)
    }
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) check(node, node.moduleSpecifier)
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      check(node, node.moduleReference.expression)
    } else if (ts.isImportTypeNode(node)) {
      check(node, ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined)
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (layer === 'core') reject(node, 'dynamic import() is not allowed')
        else check(node, node.arguments[0])
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') check(node, node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
}

function walk(directory, layer) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const file = resolve(directory, entry.name)
    if (entry.isDirectory()) walk(file, layer)
    else if (entry.isFile() && /\.(?:[cm]?ts|tsx)$/.test(entry.name)) inspect(file, layer)
  }
}

walk(core, 'core')
walk(resolve('src/sources'), 'sources')
if (failures) process.exitCode = 1
else console.log('import boundaries: OK')
