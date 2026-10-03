package rmlines

// From items to layers: the scene tree and CRDT order.
//
// Every item names the group it belongs to (its parent) and the neighbours it was inserted
// between (left, right; 0:0 means the start or end of the sequence). build groups items by
// parent, orders each group's children, and walks the tree from RootID: the root's group items
// are the layers, groups nested deeper are flattened into their layer, and lines land in the
// layer they are reached from. Tombstones and deleted lines still take part in ordering (a live
// item may have been inserted next to one), but they never become Lines.

import "sort"

// maxTreeDepth bounds the walk; real pages nest a few levels, a cycle in a corrupt file would
// otherwise recurse forever.
const maxTreeDepth = 32

// build fills page.Layers and page.Deleted from the parsed items.
func build(page *Page, nodes map[CrdtID]*node, items []*item) {
	children := groupByParent(page, items)
	walkLayers(page, nodes, children)
	adoptOrphans(page, children)
}

// groupByParent indexes items by parent group and records deleted lines and tombstones in
// page.Deleted (file order). If an id appears twice (rare), the first block is the one ordered.
func groupByParent(page *Page, items []*item) map[CrdtID][]*item {
	children := map[CrdtID][]*item{}
	seen := map[CrdtID]bool{}
	for _, it := range items {
		if it.line == nil && it.group == nil && (it.typ == blockTombstoneItem || (it.typ == blockLineItem && it.deleted)) {
			page.Deleted = append(page.Deleted, it.id)
		}
		if seen[it.id] {
			continue
		}
		seen[it.id] = true
		children[it.parent] = append(children[it.parent], it)
	}
	return children
}

// walkLayers walks the tree from the root, making each top-level group a Layer (with its
// TreeNode label and visibility) and appending lines to the layer they are reached from.
func walkLayers(page *Page, nodes map[CrdtID]*node, children map[CrdtID][]*item) {
	var walk func(parent CrdtID, layer *Layer, depth int)
	walk = func(parent CrdtID, layer *Layer, depth int) {
		if depth > maxTreeDepth {
			return
		}
		for _, it := range orderItems(children[parent]) {
			switch {
			case it.line != nil && layer != nil:
				it.line.Layer = layer.ID
				layer.Lines = append(layer.Lines, it.line)
			case it.group != nil:
				if layer == nil {
					n := nodes[*it.group]
					l := &Layer{ID: *it.group, Visible: true}
					if n != nil {
						l.Label, l.Visible = n.label, n.visible
					}
					page.Layers = append(page.Layers, l)
					walk(*it.group, l, depth+1)
				} else {
					walk(*it.group, layer, depth+1)
				}
			}
		}
	}
	walk(RootID, nil, 0)
}

// adoptOrphans keeps lines the walk did not reach (under a node not reachable from the root, or
// directly under the root; neither should happen) in a visible layer of their own, one per
// parent in id order, rather than lose ink.
func adoptOrphans(page *Page, children map[CrdtID][]*item) {
	reached := map[CrdtID]bool{}
	for _, l := range page.Layers {
		for _, ln := range l.Lines {
			reached[ln.ID] = true
		}
	}
	var orphanParents []CrdtID
	for p, its := range children {
		for _, it := range its {
			if it.line != nil && !reached[it.id] {
				orphanParents = append(orphanParents, p)
				break
			}
		}
	}
	sort.Slice(orphanParents, func(i, j int) bool { return less(orphanParents[i], orphanParents[j]) })
	for _, p := range orphanParents {
		l := &Layer{ID: p, Visible: true}
		for _, it := range orderItems(children[p]) {
			if it.line != nil && !reached[it.id] {
				it.line.Layer = p
				l.Lines = append(l.Lines, it.line)
			}
		}
		page.Layers = append(page.Layers, l)
	}
}

// less orders CRDT ids by author, then counter.
func less(a, b CrdtID) bool {
	if a.Author != b.Author {
		return a.Author < b.Author
	}
	return a.Counter < b.Counter
}

// ── CRDT sequence order ─────────────────────────────────────────────────────

// Graph vertices for orderItems: the sequence's start and end markers, then its items.
const (
	vStart = 0
	vEnd   = 1
	vFirst = 2 // its[i] is vertex vFirst+i
)

// orderItems sorts a CRDT sequence by its left/right links: every item comes after its left
// neighbour and before its right one, a topological sort (Kahn's algorithm) with rmscene's
// tie-break for concurrent inserts (higher author first, then lower counter), so the drawing
// order matches rmscene's exactly.
func orderItems(its []*item) []*item {
	if len(its) <= 1 {
		return its
	}
	n := len(its) + vFirst
	indeg, deps := sequenceGraph(its)
	h := &intHeap{less: tieBreak(its)}
	for j := 0; j < n; j++ {
		if indeg[j] == 0 {
			h.push(j)
		}
	}
	out := make([]*item, 0, len(its))
	done := make([]bool, n)
	for h.len() > 0 {
		j := h.pop()
		done[j] = true
		if j >= vFirst {
			out = append(out, its[j-vFirst])
		}
		if j == vEnd {
			break
		}
		for _, d := range deps[j] {
			indeg[d]--
			if indeg[d] == 0 {
				h.push(d)
			}
		}
	}
	if len(out) < len(its) {
		// a cycle or items after the end marker: append the rest in id order, never lose ink
		var rest []*item
		for j := vFirst; j < n; j++ {
			if !done[j] {
				rest = append(rest, its[j-vFirst])
			}
		}
		sort.Slice(rest, func(a, b int) bool { return less(rest[a].id, rest[b].id) })
		out = append(out, rest...)
	}
	return out
}

// sequenceGraph builds the edges left → item → right. A neighbour outside this sequence (or the
// 0:0 marker) stands for the start (as a left) or the end (as a right).
func sequenceGraph(its []*item) (indeg []int, deps [][]int) {
	idx := make(map[CrdtID]int, len(its))
	for i, it := range its {
		idx[it.id] = i + vFirst
	}
	n := len(its) + vFirst
	indeg = make([]int, n)
	deps = make([][]int, n)
	side := func(id CrdtID, isLeft bool) int {
		if j, ok := idx[id]; ok && !id.IsZero() {
			return j
		}
		if isLeft {
			return vStart
		}
		return vEnd
	}
	for i, it := range its {
		me := i + vFirst
		l, r := side(it.left, true), side(it.right, false)
		indeg[me]++
		deps[l] = append(deps[l], me)
		indeg[r]++
		deps[me] = append(deps[me], r)
	}
	return indeg, deps
}

// tieBreak orders ready vertices: the start first, the end last, items by higher author then
// lower counter (rmscene's rule for concurrent inserts).
func tieBreak(its []*item) func(a, b int) bool {
	key := func(j int) (int, int, uint64) {
		switch j {
		case vStart:
			return 0, 0, 0
		case vEnd:
			return 2, 0, 0
		}
		id := its[j-vFirst].id
		return 1, -int(id.Author), id.Counter
	}
	return func(a, b int) bool {
		a0, a1, a2 := key(a)
		b0, b1, b2 := key(b)
		if a0 != b0 {
			return a0 < b0
		}
		if a1 != b1 {
			return a1 < b1
		}
		return a2 < b2
	}
}

// intHeap is a binary min-heap of vertex indices under less (container/heap without the
// interface boxing).
type intHeap struct {
	a    []int
	less func(a, b int) bool
}

func (h *intHeap) len() int { return len(h.a) }

func (h *intHeap) push(x int) {
	h.a = append(h.a, x)
	i := len(h.a) - 1
	for i > 0 {
		p := (i - 1) / 2
		if !h.less(h.a[i], h.a[p]) {
			break
		}
		h.a[i], h.a[p] = h.a[p], h.a[i]
		i = p
	}
}

func (h *intHeap) pop() int {
	top := h.a[0]
	last := len(h.a) - 1
	h.a[0] = h.a[last]
	h.a = h.a[:last]
	i := 0
	for {
		l, r, m := 2*i+1, 2*i+2, i
		if l < len(h.a) && h.less(h.a[l], h.a[m]) {
			m = l
		}
		if r < len(h.a) && h.less(h.a[r], h.a[m]) {
			m = r
		}
		if m == i {
			return top
		}
		h.a[i], h.a[m] = h.a[m], h.a[i]
		i = m
	}
}
