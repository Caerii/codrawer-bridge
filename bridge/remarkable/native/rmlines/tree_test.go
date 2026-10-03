package rmlines

import (
	"reflect"
	"testing"
)

func ids(its []*item) []CrdtID {
	var out []CrdtID
	for _, it := range its {
		out = append(out, it.id)
	}
	return out
}

func seqItem(author uint8, counter uint64, left, right CrdtID) *item {
	return &item{id: CrdtID{author, counter}, left: left, right: right}
}

// The sequence follows left/right links, not file order.
func TestOrderItemsFollowsLinks(t *testing.T) {
	a, b, c := CrdtID{1, 10}, CrdtID{1, 11}, CrdtID{1, 12}
	// file order c, a, b; links say a < b < c
	its := []*item{seqItem(1, 12, b, CrdtID{}), seqItem(1, 10, CrdtID{}, b), seqItem(1, 11, a, c)}
	if got, want := ids(orderItems(its)), []CrdtID{a, b, c}; !reflect.DeepEqual(got, want) {
		t.Fatalf("order %v, want %v", got, want)
	}
}

// Two items inserted at the same place concurrently: rmscene puts the higher author first, then
// the lower counter.
func TestOrderItemsTieBreak(t *testing.T) {
	its := []*item{
		seqItem(1, 5, CrdtID{}, CrdtID{}),
		seqItem(2, 9, CrdtID{}, CrdtID{}),
		seqItem(2, 7, CrdtID{}, CrdtID{}),
	}
	want := []CrdtID{{2, 7}, {2, 9}, {1, 5}}
	if got := ids(orderItems(its)); !reflect.DeepEqual(got, want) {
		t.Fatalf("order %v, want %v", got, want)
	}
}

// A cycle (corrupt file) never loses an item: the rest follow in id order.
func TestOrderItemsCycleKeepsEverything(t *testing.T) {
	a, b := CrdtID{1, 1}, CrdtID{1, 2}
	its := []*item{seqItem(1, 2, a, a), seqItem(1, 1, b, b)}
	if got := orderItems(its); len(got) != 2 {
		t.Fatalf("lost items: %v", ids(got))
	}
}

// Lines the walk cannot reach from the root still end up in a layer.
func TestOrphanLinesAreKept(t *testing.T) {
	page := &Page{}
	orphan := &item{id: CrdtID{1, 50}, parent: CrdtID{9, 9}, typ: blockLineItem, line: &Line{ID: CrdtID{1, 50}}}
	build(page, map[CrdtID]*node{}, []*item{orphan})
	if len(page.Layers) != 1 || page.Layers[0].ID != (CrdtID{9, 9}) || len(page.Layers[0].Lines) != 1 {
		t.Fatalf("orphan not adopted: %+v", page.Layers)
	}
	if page.Layers[0].Lines[0].Layer != (CrdtID{9, 9}) {
		t.Fatalf("orphan layer id %v", page.Layers[0].Lines[0].Layer)
	}
}
