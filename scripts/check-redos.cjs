// ReDoS guard: times every regex literal in the app (server, frontend,
// scripts; not tests) against long runs of each printable character and a few
// multi-character units. A linear regex takes ~1 ms on 20 000 characters; the
// quadratic ones this caught took 100-250 ms there (seconds at 100 KB, on text
// that mail senders control). Exits 1 when one takes more than 50 ms.
//   node scripts/check-redos.cjs
const fs = require('fs'), path = require('path')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')
const files = require('child_process').execSync(
  `find server src scripts -type f \\( -name "*.js" -o -name "*.ts" -o -name "*.svelte" -o -name "*.mjs" -o -name "*.cjs" \\) ! -name "*.test.*" ! -path "*__tests__*" ! -path "*/fixtures/*"`,
  { cwd: root, encoding: 'utf8' }).trim().split('\n')
const regs = []
for (const f of files) {
  let src = fs.readFileSync(path.join(root, f), 'utf8')
  if (f.endsWith('.svelte')) src = [...src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(m => m[1]).join('\n')
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, f.endsWith('.ts') || f.endsWith('.svelte') ? ts.ScriptKind.TS : ts.ScriptKind.JS)
  const visit = (n) => {
    if (n.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const lit = n.getText(sf); const i = lit.lastIndexOf('/')
      try { regs.push({ f, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, re: new RegExp(lit.slice(1, i), lit.slice(i + 1).replace(/g/g, '')) }) } catch {}
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
}
const N = 20_000
// Pieces: every printable ASCII char plus common multi-char units.
const units = []
for (let c = 32; c < 127; c++) units.push(String.fromCharCode(c))
units.push('\n', '\r\n', '\t', '�', 'a.', 'a-', 'a@', 'a ', '<a', '</', '-----', '\\n', 'ab', '=?', '%2', '&#')
const tails = ['', 'x', '!', '\u0000', '\n']
const slow = []
for (const { f, line, re } of regs) {
  let worst = 0, how = ''
  for (const u of units) for (const t of tails) {
    const s = u.repeat(Math.ceil(N / u.length)) + t
    re.lastIndex = 0
    const t0 = performance.now(); re.test(s); const ms = performance.now() - t0
    if (ms > worst) { worst = ms; how = JSON.stringify(u) + '*N+' + JSON.stringify(t) }
    if (ms > 1500) break
  }
  // also 'prefix + repeated unit' for regexes needing a literal start
  if (worst > 50) slow.push({ f, line, re: String(re).slice(0, 90), ms: Math.round(worst), how })
}
console.log(`${regs.length} regexes in ${files.length} files`)
slow.sort((a, b) => b.ms - a.ms)
for (const s of slow) console.log(`${String(s.ms).padStart(6)} ms  ${s.f}:${s.line}  ${s.re}  [${s.how}]`)
if (slow.length) {
  console.error(`check-redos: ${slow.length} regex(es) took > 50 ms on 20 000 characters (likely quadratic)`)
  process.exit(1)
}
console.log('check-redos: ok')
