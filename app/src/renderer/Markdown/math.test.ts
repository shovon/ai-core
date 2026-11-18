import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dollarMath } from './math.ts';

test('mathematics within a line: \\(…\\) becomes $…$', () => {
  assert.equal(dollarMath(String.raw`The roots of \(ax^2 + bx + c = 0\) are real.`), 'The roots of $ax^2 + bx + c = 0$ are real.');
  assert.equal(dollarMath(String.raw`\(a\) and \(b\)`), '$a$ and $b$');
});

test('a formula on its own: \\[…\\] becomes $$…$$, each delimiter where it stood', () => {
  assert.equal(dollarMath(String.raw`\[x = \frac{-b}{2a}\]`), String.raw`$$x = \frac{-b}{2a}$$`);
  // On lines of their own, they stay on lines of their own, indentation and all.
  assert.equal(
    dollarMath(['1. The formula:', '', '   \\[', '   x = 1', '   \\]', '', '2. Next'].join('\n')),
    ['1. The formula:', '', '   $$', '   x = 1', '   $$', '', '2. Next'].join('\n'),
  );
});

test('text with no such mathematics, and mathematics already in dollars, is returned as it is', () => {
  for (const text of ['Blue.', 'f(x) and [a link](https://example.com)', String.raw`$a$ and $$\int_0^1 x\,dx$$`, String.raw`A coffee costs \$5.`])
    assert.equal(dollarMath(text), text);
});

test('code is left as it is, in a line and in a block', () => {
  const inLine = String.raw`Write ` + '`\\(x\\)`' + String.raw` to get \(x\).`;
  assert.equal(dollarMath(inLine), 'Write `\\(x\\)` to get $x$.');
  const block = ['```tex', '\\[ x \\]', '\\(y\\)', '```'].join('\n');
  assert.equal(dollarMath(block), block);
  assert.equal(dollarMath(`${block}\n\\(z\\)`), `${block}\n$z$`);
  const tildes = ['~~~', '\\(y\\)', '~~~'].join('\n');
  assert.equal(dollarMath(tildes), tildes);
});

test('a code block still arriving is code to its end', () => {
  const arriving = ['Here:', '```tex', '\\(y\\) and \\[z\\]'].join('\n');
  assert.equal(dollarMath(arriving), arriving);
});

test('only a pair is rewritten: an opening with no closing yet is not touched', () => {
  assert.equal(dollarMath(String.raw`The roots of \(ax^2 + bx`), String.raw`The roots of \(ax^2 + bx`);
  assert.equal(dollarMath('\\[\nx = 1'), '\\[\nx = 1');
  assert.equal(dollarMath(String.raw`\(a\) then \(b`), String.raw`$a$ then \(b`);
});

test('a line break with spacing inside a formula is not an opening or a closing', () => {
  const matrix = String.raw`$$\begin{aligned} a &= b \\[2pt] c &= d \\(e) \end{aligned}$$`;
  assert.equal(dollarMath(matrix), matrix);
  assert.equal(dollarMath(String.raw`\[ a \\[2pt] b \]`), String.raw`$$ a \\[2pt] b $$`);
});

test('mathematics within a line does not reach across a blank line', () => {
  const apart = String.raw`an opening \( here` + '\n\n' + String.raw`and a closing \) there`;
  assert.equal(dollarMath(apart), apart);
  // Across a single line break it does, as a paragraph may be wrapped.
  assert.equal(dollarMath('\\(a +\nb\\)'), '$a +\nb$');
});
