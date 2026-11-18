// No dependencies. Everything here is plain values and functions.
//
// A tree is an array of nodes in the order they were added. Each node names
// the node it follows, so a history is the path from a node back to a root,
// and a fork is nothing more than a second node that follows the same parent.
// Nothing is copied to fork, and nothing already in the tree ever changes.
//
// The order of the array is the only chronology there is: a parent always
// comes before its children, and later means newer. A store has to keep that
// order and nothing else; JSON.stringify followed by JSON.parse gives back an
// equal tree.
//
// There may be several roots. Two nodes with no parent are two ways to begin,
// the same as two nodes with one parent are two ways to go on.

/**
 * The least a node has to be: its own name and the name of the node it
 * follows, or null if it follows nothing. Whatever else a node carries is the
 * caller's, and is kept as given.
 */
export type Link = { readonly id: string; readonly parent: string | null };

export type Tree<N extends Link> = readonly N[];

/**
 * The tree with one more node, at the end. Pure: returns a new tree.
 * The id must be new and the parent must already be there, so a tree built
 * only with `add` has no cycles and no missing parents. To check nodes that
 * came from storage, add them one at a time.
 */
export const add = <N extends Link>(tree: Tree<N>, node: N): Tree<N> => {
  if (tree.some((n) => n.id === node.id)) throw new Error(`tree: id already in use: ${node.id}`);
  if (node.parent !== null && !tree.some((n) => n.id === node.parent))
    throw new Error(`tree: no such parent: ${node.parent}`);
  return [...tree, node];
};

/**
 * The nodes from a root down to `id`, in order. Adding to a tree never changes
 * the path to a node already in it.
 *
 * Always finishes, even on a tree that was not built with `add`: a parent that
 * is missing, or that comes after its child, is an error.
 */
export const path = <N extends Link>(tree: Tree<N>, id: string): readonly N[] => {
  const at = new Map(tree.map((node, i) => [node.id, i]));
  let i = at.get(id);
  if (i === undefined) throw new Error(`tree: no such node: ${id}`);
  const up: N[] = [];
  for (;;) {
    const node = tree[i] as N;
    up.push(node);
    if (node.parent === null) return up.reverse();
    const parent = at.get(node.parent);
    if (parent === undefined) throw new Error(`tree: no such parent: ${node.parent}`);
    if (parent >= i) throw new Error(`tree: a parent must come before its child: ${node.id}`);
    i = parent;
  }
};

/**
 * The nodes that follow `id`, oldest first; with null, the roots. More than
 * one is a fork. The alternatives to a node are the children of its parent,
 * the node itself among them.
 */
export const children = <N extends Link>(tree: Tree<N>, id: string | null): readonly N[] =>
  tree.filter((node) => node.parent === id);

/**
 * Where a branch was last worked on: the newest node among `id` and everything
 * under it. It is always a leaf, and `id` is always on the path to it.
 */
export const tip = <N extends Link>(tree: Tree<N>, id: string): N => {
  // One pass is enough, because a parent comes before its children.
  const under = new Set<string>();
  let newest: N | undefined;
  for (const node of tree) {
    if (node.id !== id && (node.parent === null || !under.has(node.parent))) continue;
    under.add(node.id);
    newest = node;
  }
  if (!newest) throw new Error(`tree: no such node: ${id}`);
  return newest;
};
