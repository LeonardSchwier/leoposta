/**
 * `html` without its tags, exactly as html.replace(/<[^>]*>/g, '') did, by
 * index: that regex was quadratic on a mail full of "<" without ">".
 */
export function stripTags(html: string): string {
  let out = ''
  let i = 0
  for (;;) {
    const lt = html.indexOf('<', i)
    const gt = lt < 0 ? -1 : html.indexOf('>', lt + 1)
    if (gt < 0) return out + html.slice(i)
    out += html.slice(i, lt)
    i = gt + 1
  }
}
