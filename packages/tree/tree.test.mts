import { test } from "node:test";
import assert from "node:assert/strict";
import { add, children, path, tip, type Link, type Tree } from "./tree.ts";

// A node as a thread would keep it: a link, plus what was said.
type Said = Link & { from: "user" | "model"; text: string };

const said = (id: string, parent: string | null, text: string): Said => ({
  id,
  parent,
  from: Number(id.slice(1)) % 2 === 1 ? "user" : "model",
  text,
});
const grow = (...nodes: Said[]): Tree<Said> => nodes.reduce<Tree<Said>>(add, []);
const ids = (nodes: readonly Link[]) => nodes.map((node) => node.id);

// One conversation, four nodes long, with nothing forked.
const chain = grow(
  said("n1", null, "name a colour"),
  said("n2", "n1", "blue"),
  said("n3", "n2", "another"),
  said("n4", "n3", "green"),
);

test("a chain is a tree with no forks: the path to the last node is the whole history", () => {
  assert.deepEqual(ids(path(chain, "n4")), ["n1", "n2", "n3", "n4"]);
  assert.deepEqual(ids(path(chain, "n2")), ["n1", "n2"]);
  assert.equal(path(chain, "n4")[2], chain[2]); // the nodes themselves, not copies
});

test("add() returns a new tree and leaves the old one as it was", () => {
  const more = add(chain, said("n5", "n4", "another"));
  assert.equal(chain.length, 4);
  assert.equal(more.length, 5);
  assert.equal(more.at(-1)?.id, "n5");
});

test("add() refuses an id already in use, and a parent that is not there", () => {
  assert.throws(() => add(chain, said("n2", "n1", "again")), /id already in use: n2/);
  assert.throws(() => add(chain, said("n9", "n8", "orphan")), /no such parent: n8/);
  assert.throws(() => add(chain, said("n9", "n9", "its own parent")), /no such parent: n9/);
});

test("the path to a new node is the path to its parent, then the node", () => {
  const node = said("n5", "n2", "a darker one");
  assert.deepEqual(path(add(chain, node), "n5"), [...path(chain, "n2"), node]);
});

test("a fork is a second node after the same parent: nothing is copied and no path changes", () => {
  // Editing the second prompt, n3: the new version follows what n3 followed.
  const forked = add(chain, said("n5", "n2", "a warmer one"));
  assert.deepEqual(ids(children(forked, "n2")), ["n3", "n5"]);
  assert.deepEqual(ids(path(forked, "n5")), ["n1", "n2", "n5"]);
  for (const node of chain) assert.deepEqual(path(forked, node.id), path(chain, node.id));
});

test("the versions of a prompt are its parent's children, which is all a pager needs", () => {
  const forked = grow(...chain, said("n5", "n2", "a warmer one"), said("n7", "n2", "a darker one"));
  const shown = path(forked, "n5").at(-1)!;
  const versions = children(forked, shown.parent);
  assert.deepEqual(ids(versions), ["n3", "n5", "n7"]);
  assert.equal(`${versions.indexOf(shown) + 1}/${versions.length}`, "2/3");
});

test("editing the very first prompt makes a second root", () => {
  const forked = add(chain, said("n5", null, "name a shape"));
  assert.deepEqual(ids(children(forked, null)), ["n1", "n5"]);
  assert.deepEqual(ids(path(forked, "n5")), ["n5"]);
  assert.deepEqual(ids(path(forked, "n4")), ["n1", "n2", "n3", "n4"]);
});

test("children() of a leaf is empty, and of an id that is not there", () => {
  assert.deepEqual(children(chain, "n4"), []);
  assert.deepEqual(children(chain, "nope"), []);
});

test("tip() is where a branch was last worked on, which is always a leaf under it", () => {
  //  n1 ─ n2 ─┬─ n3 ─ n4 ─ n9        the older version, worked on last
  //           └─ n5 ─ n6             the newer version
  const forked = grow(...chain, said("n5", "n2", "a warmer one"), said("n6", "n5", "red"), said("n9", "n4", "why green?"));
  assert.equal(tip(forked, "n3").id, "n9");
  assert.equal(tip(forked, "n5").id, "n6");
  assert.equal(tip(forked, "n2").id, "n9"); // not n6: newest work wins, not the newest version
  assert.equal(tip(forked, "n6").id, "n6"); // a leaf is its own tip
  for (const node of forked) {
    const leaf = tip(forked, node.id);
    assert.deepEqual(children(forked, leaf.id), []);
    assert.ok(ids(path(forked, leaf.id)).includes(node.id));
  }
});

test("path() and tip() throw for an id that is not in the tree", () => {
  assert.throws(() => path(chain, "nope"), /no such node: nope/);
  assert.throws(() => tip(chain, "nope"), /no such node: nope/);
});

test("a node keeps whatever else it carries", () => {
  const node = { id: "a", parent: null, message: { from: "user", content: [{ type: "text", text: "hi" }] }, extra: 1 };
  assert.equal(path(add([], node), "a")[0], node);
});

test("a tree is plain data: it survives JSON unchanged", () => {
  const stored: Tree<Said> = JSON.parse(JSON.stringify(chain));
  assert.deepEqual(stored, chain);
  assert.deepEqual(ids(path(stored, "n4")), ["n1", "n2", "n3", "n4"]);
});

test("path() fails instead of hanging on a tree that add() would never build", () => {
  const loop: Tree<Link> = [{ id: "a", parent: "b" }, { id: "b", parent: "a" }];
  assert.throws(() => path(loop, "a"), /a parent must come before its child/);
  const self: Tree<Link> = [{ id: "a", parent: "a" }];
  assert.throws(() => path(self, "a"), /a parent must come before its child/);
  const orphan: Tree<Link> = [{ id: "a", parent: "gone" }];
  assert.throws(() => path(orphan, "a"), /no such parent: gone/);
  // tip() reads the tree once, front to back, so it finishes on any input.
  assert.equal(tip(loop, "a").id, "b");
});

test("adding stored nodes one at a time is the check that they form a tree", () => {
  const loop: Link[] = [{ id: "a", parent: "b" }, { id: "b", parent: "a" }];
  assert.throws(() => loop.reduce<Tree<Link>>(add, []), /no such parent: b/);
  assert.deepEqual(chain.reduce<Tree<Said>>(add, []), chain);
});
