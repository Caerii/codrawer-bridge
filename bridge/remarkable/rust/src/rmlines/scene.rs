//! From parsed items to the page: order every group's children as a CRDT sequence and walk the
//! scene tree from the root. Top-level groups are layers; nested groups are flattened into
//! their layer. Lines that no walk reaches (should not happen) keep a layer of their own rather
//! than being lost.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};

use super::blocks::{Item, Nodes, BLOCK_LINE_ITEM, BLOCK_TOMBSTONE_ITEM};
use super::{CrdtId, Layer, Page, ROOT_ID};

/// The tree is never walked deeper than this (a malformed file could link groups in a cycle).
const MAX_DEPTH: usize = 32;

/// Fills `page.layers` and `page.deleted` from the items, in file order.
pub(super) fn build(page: &mut Page, nodes: &Nodes, mut items: Vec<Item>) {
    page.deleted = deleted_ids(&items);
    let children = children_in_order(&items);
    let mut walk = Walk { nodes, children: &children, items: &mut items, layers: Vec::new() };
    walk.group(ROOT_ID, None, 0);
    let mut layers = walk.layers;
    layers.extend(orphan_layers(&children, &mut items));
    page.layers = layers;
}

/// Strokes that were erased or undone: tombstones, and line items stored without a value.
fn deleted_ids(items: &[Item]) -> Vec<CrdtId> {
    let mut out = Vec::new();
    for it in items {
        let has_value = it.line.is_some() || it.group.is_some();
        let erased = it.block_type == BLOCK_TOMBSTONE_ITEM || (it.block_type == BLOCK_LINE_ITEM && it.deleted);
        if !has_value && erased {
            out.push(it.id);
        }
    }
    out
}

/// Each parent's children (indices into `items`) in CRDT order. When an id appears in more
/// than one block (rare), the first block is the one that is ordered.
fn children_in_order(items: &[Item]) -> HashMap<CrdtId, Vec<usize>> {
    let mut children: HashMap<CrdtId, Vec<usize>> = HashMap::new();
    let mut seen = HashSet::new();
    for (i, it) in items.iter().enumerate() {
        if seen.insert(it.id) {
            children.entry(it.parent).or_default().push(i);
        }
    }
    for list in children.values_mut() {
        let links: Vec<Links> = list.iter().map(|&i| Links::of(&items[i])).collect();
        *list = order_sequence(&links).into_iter().map(|k| list[k]).collect();
    }
    children
}

/// The scene tree walk. Lines are moved out of `items` into the layer that reaches them.
struct Walk<'a> {
    nodes: &'a Nodes,
    children: &'a HashMap<CrdtId, Vec<usize>>,
    items: &'a mut [Item],
    layers: Vec<Layer>,
}

impl Walk<'_> {
    /// Visits the children of `parent`. `layer` is the index of the layer being filled, or
    /// `None` at the root, where each group starts a new layer.
    fn group(&mut self, parent: CrdtId, layer: Option<usize>, depth: usize) {
        if depth > MAX_DEPTH {
            return;
        }
        let children = self.children; // a shared reference that outlives the borrow of self
        let Some(children) = children.get(&parent) else { return };
        for &i in children {
            if let Some(layer) = layer {
                if let Some(mut line) = self.items[i].line.take() {
                    line.layer = self.layers[layer].id;
                    self.layers[layer].lines.push(line);
                    continue;
                }
            }
            let Some(group) = self.items[i].group else { continue };
            let layer = layer.unwrap_or_else(|| self.new_layer(group));
            self.group(group, Some(layer), depth + 1);
        }
    }

    fn new_layer(&mut self, id: CrdtId) -> usize {
        let mut layer = Layer { id, label: String::new(), visible: true, lines: Vec::new() };
        if let Some(node) = self.nodes.get(&id) {
            layer.label = node.label.clone();
            layer.visible = node.visible;
        }
        self.layers.push(layer);
        self.layers.len() - 1
    }
}

/// Lines the walk did not reach, one visible layer per parent, parents in id order.
fn orphan_layers(children: &HashMap<CrdtId, Vec<usize>>, items: &mut [Item]) -> Vec<Layer> {
    let mut parents: Vec<CrdtId> = Vec::new();
    for (parent, list) in children {
        if list.iter().any(|&i| items[i].line.is_some()) {
            parents.push(*parent);
        }
    }
    parents.sort();
    let mut layers = Vec::new();
    for parent in parents {
        let mut layer = Layer { id: parent, label: String::new(), visible: true, lines: Vec::new() };
        for &i in &children[&parent] {
            if let Some(mut line) = items[i].line.take() {
                line.layer = parent;
                layer.lines.push(line);
            }
        }
        layers.push(layer);
    }
    layers
}

/// What ordering needs from an item: its id and its left/right neighbours at insertion.
#[derive(Clone, Copy, Debug)]
pub(super) struct Links {
    pub(super) id: CrdtId,
    pub(super) left: CrdtId,
    pub(super) right: CrdtId,
}

impl Links {
    fn of(it: &Item) -> Self {
        Links { id: it.id, left: it.left, right: it.right }
    }
}

/// Graph node numbers used by [`order_sequence`]: the start and end markers, then the items.
const START: usize = 0;
const END: usize = 1;
const FIRST_ITEM: usize = 2;

/// Orders a CRDT sequence by its left/right links and returns positions into `items`.
///
/// Each item must come after its left neighbour and before its right one (a missing or zero id
/// means the start or the end of the sequence). This is a topological sort (Kahn's algorithm)
/// with rmscene's tie-break among items that are ready at the same time (concurrent inserts):
/// higher author first, then lower counter. Items left over by a cycle, or placed after the end
/// marker, are appended in id order so no ink is lost.
pub(super) fn order_sequence(items: &[Links]) -> Vec<usize> {
    if items.len() <= 1 {
        return (0..items.len()).collect();
    }
    let graph = SequenceGraph::new(items);
    let mut indegree = graph.indegree.clone();
    let mut ready = BinaryHeap::new();
    for (node, &deg) in indegree.iter().enumerate() {
        if deg == 0 {
            ready.push(Reverse(graph.priority(node)));
        }
    }
    let mut out = Vec::with_capacity(items.len());
    let mut done = vec![false; graph.len()];
    while let Some(Reverse((_, node))) = ready.pop() {
        done[node] = true;
        if node == END {
            break;
        }
        if node >= FIRST_ITEM {
            out.push(node - FIRST_ITEM);
        }
        for &next in &graph.edges[node] {
            indegree[next] -= 1;
            if indegree[next] == 0 {
                ready.push(Reverse(graph.priority(next)));
            }
        }
    }
    if out.len() < items.len() {
        let mut rest: Vec<usize> = (0..items.len()).filter(|&k| !done[k + FIRST_ITEM]).collect();
        rest.sort_by_key(|&k| items[k].id);
        out.extend(rest);
    }
    out
}

/// The "comes before" graph of a sequence: START → item → END, left → item → right.
struct SequenceGraph<'a> {
    items: &'a [Links],
    edges: Vec<Vec<usize>>,
    indegree: Vec<usize>,
}

/// Heap key: start first, end last, items by (higher author, lower counter); then the node.
type Priority = ((u8, Reverse<u8>, u64), usize);

impl<'a> SequenceGraph<'a> {
    fn new(items: &'a [Links]) -> Self {
        let node_of: HashMap<CrdtId, usize> = items.iter().enumerate().map(|(k, it)| (it.id, k + FIRST_ITEM)).collect();
        let neighbour = |id: CrdtId, missing: usize| match node_of.get(&id) {
            Some(&node) if !id.is_zero() => node,
            _ => missing,
        };
        let n = items.len() + FIRST_ITEM;
        let mut graph = SequenceGraph { items, edges: vec![Vec::new(); n], indegree: vec![0; n] };
        for (k, it) in items.iter().enumerate() {
            let me = k + FIRST_ITEM;
            graph.edge(neighbour(it.left, START), me);
            graph.edge(me, neighbour(it.right, END));
        }
        graph
    }

    fn edge(&mut self, from: usize, to: usize) {
        self.edges[from].push(to);
        self.indegree[to] += 1;
    }

    fn len(&self) -> usize {
        self.edges.len()
    }

    fn priority(&self, node: usize) -> Priority {
        let key = match node {
            START => (0, Reverse(0), 0),
            END => (2, Reverse(0), 0),
            _ => {
                let id = self.items[node - FIRST_ITEM].id;
                (1, Reverse(id.author), id.counter)
            }
        };
        (key, node)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(author: u8, counter: u64) -> CrdtId {
        CrdtId { author, counter }
    }

    fn links(me: CrdtId, left: CrdtId, right: CrdtId) -> Links {
        Links { id: me, left, right }
    }

    #[test]
    fn follows_left_right_links_whatever_the_file_order() {
        let z = CrdtId::default();
        let (a, b, c) = (id(1, 10), id(1, 11), id(1, 12));
        // c was inserted between a and b; the file lists them out of order
        let items = [links(c, a, b), links(b, a, z), links(a, z, z)];
        assert_eq!(order_sequence(&items), [2, 0, 1]);
    }

    #[test]
    fn concurrent_inserts_put_the_higher_author_first_then_the_lower_counter() {
        let z = CrdtId::default();
        let items = [links(id(1, 5), z, z), links(id(2, 9), z, z), links(id(2, 3), z, z)];
        assert_eq!(order_sequence(&items), [2, 1, 0]);
    }

    #[test]
    fn a_cycle_keeps_every_item() {
        let (a, b) = (id(1, 1), id(1, 2));
        let items = [links(a, b, CrdtId::default()), links(b, a, CrdtId::default())];
        let mut got = order_sequence(&items);
        got.sort();
        assert_eq!(got, [0, 1]);
    }
}
